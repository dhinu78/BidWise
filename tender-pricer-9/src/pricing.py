"""Pure pricing functions. Reproduces expected_output_example.json exactly.

Reverse engineered from the golden file:
  material      = qty * net_unit_cost * (1 + waste%)               (no rounding inside)
  hours         = qty * base_h * prod(factors), site_efficiency as 1/x
  labour        = hours(unrounded) * hourly_rate
  subset baseline = direct * (1 + transport%) * (1 + overhead%)
  bid price     = ceil(baseline / (1 - margin), 1000)
  P(win)        = ref + appetite + competition
                  + sens * (%-points the bid is below the target-margin price)
  expected contribution = P(win) * (bid - baseline)
"""
from __future__ import annotations
import json, math
from dataclasses import dataclass, asdict
from pathlib import Path
import pandas as pd

DATA = Path(__file__).resolve().parent.parent / "data"


@dataclass
class Ref:
    catalog: pd.DataFrame
    productivity: pd.DataFrame
    params: dict

    @classmethod
    def load(cls, data_dir: Path = DATA) -> "Ref":
        return cls(
            catalog=pd.read_csv(data_dir / "catalog.csv").set_index("product_id"),
            productivity=pd.read_csv(data_dir / "productivity.csv").set_index("install_code"),
            params=json.load(open(data_dir / "project_parameters.json")),
        )


def factor_product(factor_keys: str, factors: dict) -> float:
    f = 1.0
    if not isinstance(factor_keys, str) or not factor_keys:
        return f
    for k in factor_keys.split("|"):
        v = factors.get(k, 1.0)          # a factor key missing from the parameters counts as neutral
        f *= (1.0 / v) if k == "site_efficiency" else v
    return f


@dataclass
class PositionResult:
    lv_id: str
    matched_product_id: str | None
    install_code: str | None
    quantity: float
    unit: str
    net_unit_cost_chf: float
    material_cost_chf: float
    adjusted_install_hours: float
    labour_cost_chf: float
    direct_position_cost_chf: float
    price_source: str
    status: str


def price_position(ref: Ref, lv_id: str, product_id: str | None, quantity: float,
                   install_code: str | None = None, factor_overrides: dict | None = None,
                   status: str | None = None) -> PositionResult:
    p = ref.params
    factors = {**p["productivity_factors"], **(factor_overrides or {})}
    waste = p["allowances"]["material_waste_pct"] / 100

    net = 0.0
    source = "none"
    unit = "pc"
    if product_id:
        item = ref.catalog.loc[product_id]
        net = float(item.net_cost_chf)
        source = item.source_type
        unit = item.unit
        install_code = install_code or item.install_code
    material = quantity * net * (1 + waste)

    hours = labour = 0.0
    if install_code and install_code in ref.productivity.index:
        r = ref.productivity.loc[install_code]
        hours = quantity * r.base_hours_per_unit * factor_product(r.factor_keys, factors)
        labour = hours * r.default_hourly_rate_chf

    if status is None:
        status = "supplier_quote_required" if source == "supplier_package" else "calculated"

    return PositionResult(
        lv_id=lv_id, matched_product_id=product_id, install_code=install_code,
        quantity=quantity, unit=unit, net_unit_cost_chf=round(net, 2),
        material_cost_chf=round(material, 2), adjusted_install_hours=round(hours, 2),
        labour_cost_chf=round(labour, 2), direct_position_cost_chf=round(material + labour, 2),
        price_source=source, status=status,
    )


def subset_summary(ref: Ref, results: list[PositionResult]) -> dict:
    """Golden-file definition: only transport and overhead on top of position costs."""
    a, c = ref.params["allowances"], ref.params["commercial"]
    mat = sum(r.material_cost_chf for r in results)
    lab = sum(r.labour_cost_chf for r in results)
    direct = mat + lab
    baseline = direct * (1 + a["transport_equipment_pct"] / 100) * (1 + c["overhead_pct"] / 100)
    return {"material_cost_chf": round(mat, 2), "labour_cost_chf": round(lab, 2),
            "direct_cost_chf": round(direct, 2), "cost_baseline_chf": round(baseline, 2)}


def project_summary(ref: Ref, results: list[PositionResult], n_systems: int = 0) -> dict:
    """Full project roll up per README categories. Allowances the golden subset omits
    (small material, supplier contingency, project costs) are added here as separate lines."""
    a, pc, c = ref.params["allowances"], ref.params["project_costs"], ref.params["commercial"]
    cat_mat = sum(r.material_cost_chf for r in results if r.price_source == "catalog")
    sup_mat = sum(r.material_cost_chf for r in results if r.price_source == "supplier_package")
    lab = sum(r.labour_cost_chf for r in results)
    lines = {
        "material": cat_mat,
        "small_material": cat_mat * a["small_material_pct"] / 100,
        "supplier_packages": sup_mat,
        "supplier_contingency": sup_mat * a["supplier_package_contingency_pct"] / 100,
        "installation_labour": lab,
        "engineering_pm": pc["engineering_hours"] * pc["engineering_rate_chf_per_h"],
        "commissioning": pc["commissioning_hours"] * pc["commissioning_rate_chf_per_h"],
        "special_costs": pc["hygiene_inspection_chf"] + pc["documentation_chf"],
    }
    pre_transport = sum(lines.values())
    lines["transport_equipment"] = pre_transport * a["transport_equipment_pct"] / 100
    direct = sum(lines.values())
    overhead = direct * c["overhead_pct"] / 100
    baseline = direct + overhead
    price = baseline / (1 - c["target_margin_pct"] / 100)
    return {"lines": {k: round(v, 2) for k, v in lines.items()},
            "project_direct_cost_chf": round(direct, 2), "overhead_chf": round(overhead, 2),
            "cost_baseline_chf": round(baseline, 2),
            "indicative_price_chf": round_up(price, c["round_to_chf"])}


def round_up(x: float, step: int) -> float:
    return float(math.ceil(x / step) * step)


def bid_scenarios(ref: Ref, baseline: float, margins: dict | None = None) -> list[dict]:
    b, c = ref.params["stretch_bid_optimization"], ref.params["commercial"]
    margins = margins or b["scenario_margins_pct"]
    ref_price = baseline / (1 - c["target_margin_pct"] / 100)  # unrounded market reference
    out = []
    for name, m in margins.items():
        bid = round_up(baseline / (1 - m / 100), c["round_to_chf"])
        below_pct = (ref_price - bid) / ref_price * 100
        prob = (b["reference_win_probability"] + b["strategic_appetite_adjustment"]
                + b["competition_adjustment"]
                + b["price_sensitivity_probability_points_per_1pct_price"] * below_pct)
        prob = min(max(prob, b["minimum_probability"]), b["maximum_probability"])
        out.append({"scenario": name, "bid_price_chf": bid, "margin_pct": m,
                    "estimated_win_probability": round(prob, 2),
                    "expected_contribution_chf": round(prob * (bid - baseline), 2)})
    return out


def margin_sweep(ref: Ref, baseline: float, lo=0.0, hi=12.0, step=0.25) -> pd.DataFrame:
    ms = {f"{m:.2f}": m for m in [lo + i * step for i in range(int((hi - lo) / step) + 1)]}
    return pd.DataFrame(bid_scenarios(ref, baseline, ms))
