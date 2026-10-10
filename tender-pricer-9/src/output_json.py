"""priced_output.json: every LV row with its price, status, flag and price source.

Built on the organisers' expected_output_example.json (schema 2.0): each entry starts with exactly their keys,
in their order, then adds what the estimator needs to trace it (flag, reason, system, description, estimate).

    price_source   catalog            firm catalogue price
                   supplier_package   firm catalogue budget price, supplier quote required
                   estimate           side estimate (size scaling, category median, hours x rate), with range
                   none               not priced (out of scope, no quantity, no basis)

Summaries keep firm and estimated money apart:
    example_subset_summary   firm rows only, their formula: direct x (1 + transport) x (1 + overhead)
    cost_summary             firm, estimated (low / high), indicative total, counts by status and source
    recommended_bid_range    Aggressive / Target / Conservative on the firm baseline

strict=True writes only the organisers' keys for the firm rows: on the 22 reference rows the file is
byte-identical to data/expected_output_example.json (tests/test_output_json.py).
"""
from __future__ import annotations
import json
import pandas as pd

from pricing import Ref, price_position, subset_summary, bid_scenarios, PositionResult
from status import STATUSES

SCHEMA_VERSION = "2.0"
SELECTION_LOGIC = "Compare bid price, margin, estimated win probability and expected contribution."
PRICE_SOURCES = ["catalog", "supplier_package", "estimate", "none"]


def plain(x):
    """numpy / NaN -> plain JSON values (417.3, 426000, null)."""
    if isinstance(x, dict):
        return {k: plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [plain(v) for v in x]
    if hasattr(x, "item"):              # numpy scalar
        x = x.item()
    if isinstance(x, float) and x != x:
        return None
    return x


def _v(x):
    if isinstance(x, (list, tuple)):
        return [round(float(v), 1) for v in x]
    if isinstance(x, str):
        return x or None
    return None if x is None or pd.isna(x) else x


def _firm(ref: Ref, r, lv_id) -> PositionResult:
    return price_position(ref, lv_id, r.suggested_product_id, float(r.quantity), r.expected_install_code,
                          status=r.status)


def entry(ref: Ref, r, lv_id: str, strict: bool = False) -> tuple[dict, PositionResult | None]:
    firm = None
    if _v(r.suggested_product_id) and _v(r.quantity) is not None:
        firm = _firm(ref, r, lv_id)
        price = dict(matched_product_id=firm.matched_product_id, install_code=firm.install_code,
                     unit=firm.unit, net_unit_cost_chf=firm.net_unit_cost_chf,
                     material_cost_chf=firm.material_cost_chf, adjusted_install_hours=firm.adjusted_install_hours,
                     labour_cost_chf=firm.labour_cost_chf, direct_position_cost_chf=firm.direct_position_cost_chf,
                     price_source=firm.price_source)
        low = high = firm.direct_position_cost_chf
    elif _v(r.get("est_direct_cost_chf")) is not None:
        price = dict(matched_product_id=None, install_code=_v(r.get("est_install_code")), unit=r.unit,
                     net_unit_cost_chf=_v(r.est_unit_cost_chf), material_cost_chf=_v(r.est_material_chf),
                     adjusted_install_hours=_v(r.est_labour_hours), labour_cost_chf=_v(r.est_labour_chf),
                     direct_position_cost_chf=_v(r.est_direct_cost_chf), price_source="estimate")
        low, high = _v(r.est_low_chf), _v(r.est_high_chf)
    else:
        price = dict(matched_product_id=None, install_code=None, unit=_v(r.unit), net_unit_cost_chf=None,
                     material_cost_chf=None, adjusted_install_hours=None, labour_cost_chf=None,
                     direct_position_cost_chf=None, price_source="none")
        low = high = None

    e = {
        "lv_id": lv_id,
        "source_page": int(r.source_page),
        "matched_product_id": price["matched_product_id"],
        "install_code": price["install_code"],
        "quantity": None if _v(r.quantity) is None else float(r.quantity),
        "unit": price["unit"],
        "net_unit_cost_chf": price["net_unit_cost_chf"],
        "material_cost_chf": price["material_cost_chf"],
        "adjusted_install_hours": price["adjusted_install_hours"],
        "labour_cost_chf": price["labour_cost_chf"],
        "direct_position_cost_chf": price["direct_position_cost_chf"],
        "price_source": price["price_source"],
        "match_confidence": _v(r.match_confidence),
        "review_required": r.status != "calculated",
        "status": r.status,
    }
    if strict:
        return e, firm
    e.update({
        "price_flag": r.price_flag,
        "status_reason": r.status_reason,
        "price_range_chf": None if low is None else {"low": low, "high": high},
        "row_id": _v(r.row_id),
        "system": _v(r.system),
        "chapter": _v(r.get("chapter")),
        "category": _v(r.category),
        "subcategory": _v(r.get("subcategory")),
        "description": _v(r.description),
        "description_source": _v(r.get("description_source")) or "rules",
        "description_de": _v(r.get("description_de")),
        "estimate": None if price["price_source"] != "estimate" else {
            "method": _v(r.est_method),
            "basis": _v(r.est_basis),
            "reference_product_id": _v(r.get("estimate_product_id")),
            "reference_size": _v(r.est_reference_size),
            "requested_size": _v(r.est_requested_size),
            "size_difference_pct": _v(r.est_size_diff_pct),
            "range_pct": _v(r.est_range_pct),
        },
        "understanding": {
            "source": _v(r.get("description_source")) or "rules",
            "llm_check": _v(r.get("llm_check")),
            "llm_confidence": _v(r.get("llm_confidence")),
            "evidence": _v(r.get("llm_evidence")),
            "quantity_seen_in_image": _v(r.get("llm_quantity_seen")),
            "unit_seen_in_image": _v(r.get("llm_unit_seen")),
            "rules_category": _v(r.get("rules_category")) or _v(r.category),
            "rules_description": _v(r.get("rules_description")) or _v(r.description),
        },
        "alternatives": _v(r.get("alternatives")),
        "bbox": _v(r.get("bbox")),
    })
    return e, firm


def _bids(ref: Ref, baseline: float) -> list[dict]:
    out = bid_scenarios(ref, baseline)
    for sc in out:
        sc["bid_price_chf"] = int(sc["bid_price_chf"])          # rounded to whole francs
    return out


def priced_output(df: pd.DataFrame, ref: Ref, source_tender_file: str, id_col: str = "lv_id",
                  scope: str | None = None, strict: bool = False, tender: dict | None = None,
                  inputs: dict | None = None, understanding: dict | None = None) -> dict:
    rows = df[df[id_col].notna()]
    if strict:
        rows = rows[rows.suggested_product_id.notna() & rows.quantity.notna()]
    rows = rows.sort_values(id_col)
    entries, firm = [], []
    for _, r in rows.iterrows():
        e, f = entry(ref, r, r[id_col], strict)
        entries.append(e)
        if f is not None:
            firm.append(f)
    summary = subset_summary(ref, firm)

    if strict:
        return plain({
            "schema_version": SCHEMA_VERSION, "scope": scope, "source_tender_file": source_tender_file,
            "position_results": entries, "example_subset_summary": summary,
            "recommended_bid_range": {"scenarios": _bids(ref, summary["cost_baseline_chf"]),
                                      "selection_logic": SELECTION_LOGIC},
        })

    a, c = ref.params["allowances"], ref.params["commercial"]
    uplift = (1 + a["transport_equipment_pct"] / 100) * (1 + c["overhead_pct"] / 100)
    est = [e for e in entries if e["price_source"] == "estimate"]
    s = lambda es, k: round(sum(e[k] or 0 for e in es), 2)
    est_direct, est_low = s(est, "direct_position_cost_chf"), round(sum(e["price_range_chf"]["low"] for e in est), 2)
    est_high = round(sum(e["price_range_chf"]["high"] for e in est), 2)
    firm_direct = summary["direct_cost_chf"]
    cost_summary = {
        "by_status": {k: sum(e["status"] == k for e in entries) for k in STATUSES},
        "by_price_source": {k: sum(e["price_source"] == k for e in entries) for k in PRICE_SOURCES},
        "firm": {
            "rows": len(firm),
            "material_cost_chf": summary["material_cost_chf"],
            "labour_cost_chf": summary["labour_cost_chf"],
            "direct_cost_chf": firm_direct,
            "of_which_supplier_packages_chf": round(sum(f.direct_position_cost_chf for f in firm
                                                        if f.price_source == "supplier_package"), 2),
        },
        "estimated": {
            "rows": len(est),
            "material_cost_chf": s(est, "material_cost_chf"),
            "labour_cost_chf": s(est, "labour_cost_chf"),
            "direct_cost_chf": est_direct,
            "low_chf": est_low, "high_chf": est_high,
        },
        "not_priced_rows": sum(e["price_source"] == "none" for e in entries),
        "indicative_total": {
            "direct_cost_chf": round(firm_direct + est_direct, 2),
            "direct_cost_low_chf": round(firm_direct + est_low, 2),
            "direct_cost_high_chf": round(firm_direct + est_high, 2),
            "cost_baseline_chf": round((firm_direct + est_direct) * uplift, 2),
            "cost_baseline_low_chf": round((firm_direct + est_low) * uplift, 2),
            "cost_baseline_high_chf": round((firm_direct + est_high) * uplift, 2),
        },
        "note": "firm = catalogue prices only; estimated = side estimates, never mixed into firm prices; "
                "indicative_total = firm + estimated, for orientation",
    }
    return plain({
        "schema_version": SCHEMA_VERSION,
        "scope": scope or "Full tender: every extracted LV position with its outcome, price and price source.",
        "source_tender_file": source_tender_file,
        "inputs": inputs or {},
        "tender": tender or {},
        "understanding": understanding or {"mode": "rules"},
        "position_results": entries,
        "example_subset_summary": summary,
        "cost_summary": cost_summary,
        "recommended_bid_range": {
            "basis": "indicative cost baseline: firm + estimated (cost_summary.indicative_total.cost_baseline_chf)",
            "scenarios": _bids(ref, cost_summary["indicative_total"]["cost_baseline_chf"]),
            "selection_logic": SELECTION_LOGIC,
        },
    })


def write(obj: dict, path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(obj, indent=2, ensure_ascii=False))   # same layout as the reference file
