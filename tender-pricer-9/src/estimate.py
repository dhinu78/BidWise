"""Firm prices for catalogue matches + a separate side estimate for everything else.

Firm (status calculated, or supplier_quote_required for a catalogue supplier package):
    pricing.price_position with the matched catalogue product -> unit_cost, material, labour, direct cost

Side estimate (every other row except out_of_scope, never mixed into the firm price):
    1. same-type reference product (estimate_product_id), unit cost scaled by size
         round: DN ratio   rect: perimeter ratio (x length ratio)   insulation: thickness ratio
         airflow / kW / litres: ratio ** 0.7 (bigger units cost less per unit of capacity)
       scale clamped to 0.5 .. 2.5, range +-25 %
    2. otherwise the median unit cost of catalogue products in the same category and unit, range +-50 %
    3. labour from productivity.csv when the install code is known (also for service rows)
"""
from __future__ import annotations
import json
from pathlib import Path

import pandas as pd

from pricing import Ref, price_position
from matcher import load_catalog
from status import apply as status_apply, STATUSES

ROOT = Path(__file__).resolve().parent.parent


def _read_csv(x) -> pd.DataFrame:
    return x.copy() if isinstance(x, pd.DataFrame) else pd.read_csv(x)


def _read_json(x) -> dict:
    if isinstance(x, dict):
        return x
    with open(x, encoding="utf-8") as f:
        return json.load(f)


def make_ref(catalog, productivity=None, params=None) -> Ref:
    """Pricing inputs, usually the files uploaded with the tender (DataFrame, dict or path).
    Missing productivity / parameters fall back to the files in data/."""
    cat = _read_csv(catalog)
    if "net_cost_chf" not in cat:                       # other catalogues may only have list prices
        disc = cat["discount_pct"] if "discount_pct" in cat else 0
        cat["net_cost_chf"] = cat["list_price_chf"] * (1 - disc / 100)
    prod = _read_csv(productivity if productivity is not None else ROOT / "data/productivity.csv")
    par = _read_json(params if params is not None else ROOT / "data/project_parameters.json")
    return Ref(catalog=cat.set_index("product_id"), productivity=prod.set_index("install_code"), params=par)


def _num(v):
    return None if v is None or pd.isna(v) else float(v)


# How price follows size, per kind of size (exponent of the size ratio):
#   diameter, perimeter, thickness -> material grows ~linearly           exponent 1.0
#   airflow, kW, litres (capacity)  -> bigger units are cheaper per unit  exponent 0.7
EXPONENT = {"dn": 1.0, "perimeter": 1.0, "sheet": 1.0, "thickness": 1.0, "airflow": 0.7, "power": 0.7, "volume": 0.7}
LABEL = {"dn": "DN {:g}", "perimeter": "W+H {:g} mm", "sheet": "(W+H)xL {:g}", "thickness": "{:g} mm",
         "airflow": "{:g} m3/h", "power": "{:g} kW", "volume": "{:g} l"}


def size_metric(obj: dict | None, p=None) -> tuple[str, float] | None:  # noqa: C901
    """One number that describes the size: from a row (dict) or a catalogue product (p)."""
    if p is not None:
        if p.airflow: return "airflow", float(p.airflow)
        if p.power_kw: return "power", float(p.power_kw)
        if p.volume_l: return "volume", float(p.volume_l)
        if p.thickness: return "thickness", float(p.thickness)
        if p.size and p.size["shape"] == "round": return "dn", float(p.size["dn_mm"])
        if p.size and p.size["shape"] == "rect":
            wh = p.size["width_mm"] + p.size["height_mm"]
            return ("sheet", wh * p.size["length_mm"] / 1000) if p.size.get("length_mm") else ("perimeter", float(wh))
        return None
    r = obj
    for kind, key in (("airflow", "airflow_m3h"), ("power", "power_kw"), ("volume", "volume_l"),
                      ("thickness", "insulation_thickness_mm"), ("dn", "dn_mm")):
        if _num(r.get(key)):
            return kind, float(r[key])
    if _num(r.get("width_mm")):
        wh = float(r["width_mm"]) + float(r["height_mm"])
        return ("sheet", wh * float(r["length_mm"]) / 1000) if _num(r.get("length_mm")) else ("perimeter", wh)
    return None


def row_value(row: dict, kind: str) -> tuple[float | None, str]:
    """The row's size expressed in the product's kind of size, converting shapes when needed.
    -> (value, note)"""
    g = lambda k: _num(row.get(k))
    direct = {"airflow": "airflow_m3h", "power": "power_kw", "volume": "volume_l", "thickness": "insulation_thickness_mm"}
    if kind in direct:
        return g(direct[kind]), ""
    w, h, l, d = g("width_mm"), g("height_mm"), g("length_mm"), g("dn_mm")
    if kind == "dn":
        if d:
            return d, ""
        if w and h:            # equivalent diameter of a rectangular section (same flow resistance)
            return 1.30 * (w * h) ** 0.625 / (w + h) ** 0.25, f" (equivalent diameter of {w:g}x{h:g})"
    if kind == "perimeter":
        if w and h:
            return w + h, ""
        if d:
            return 3.1416 * d / 2, f" (DN {d:g} as W+H)"
    if kind == "sheet" and w and h and l:
        return (w + h) * l / 1000, ""
    return None, ""


def size_estimate(row: dict, ref_p, peers: list, net: dict) -> dict:
    """Unit cost for a size that is not in the catalogue, from the size difference in %.
    2+ catalogue sizes of the same type -> follow the catalogue's own price curve (inter/extrapolate);
    1 size -> scale the price by the size difference (exponent per kind of size).
    The +- range grows with the size difference: 10 % + half the difference, max 50 %."""
    base = net[ref_p.pid]
    pm = size_metric(None, ref_p)
    note = ""
    if pm and pm[0] == "sheet" and not _num(row.get("length_mm")):   # row has no length: compare W+H only
        pm = ("perimeter", float(ref_p.size["width_mm"] + ref_p.size["height_mm"]))
    rv, note = row_value(row, pm[0]) if pm else (None, "")
    if not pm or rv is None:
        return {"unit_cost": base, "method": "same type, size unknown", "ref_size": None, "req_size": None,
                "diff_pct": None, "band": 0.30, "basis": f"price of {ref_p.pid} (row size unknown)"}
    kind, pv = pm
    diff = (rv - pv) / pv * 100
    lab = LABEL[kind]
    def peer_metric(q):
        m = size_metric(None, q)
        if m and kind == "perimeter" and m[0] == "sheet":
            return q.size["width_mm"] + q.size["height_mm"]
        return m[1] if m and m[0] == kind else None
    curve = sorted({(peer_metric(q), net[q.pid]) for q in peers if peer_metric(q) is not None})
    if len({m for m, _ in curve}) >= 2:
        pts = sorted(curve, key=lambda t: abs(t[0] - rv))[:2]
        (m1, c1), (m2, c2) = sorted(pts)
        cost = c1 + (rv - m1) * (c2 - c1) / (m2 - m1)
        cost = max(cost, 0.25 * min(c for _, c in curve))
        near = min(curve, key=lambda t: abs(t[0] - rv))[0]
        d_near = abs(rv - near) / near * 100
        return {"unit_cost": cost, "method": "catalogue price curve", "ref_size": lab.format(near),
                "req_size": lab.format(round(rv)) + note, "diff_pct": round((rv - near) / near * 100, 1),
                "band": min(0.5, 0.10 + d_near / 200),
                "basis": (f"price curve {lab.format(m1)} = {c1:.2f} / {lab.format(m2)} = {c2:.2f} CHF "
                          f"-> {lab.format(rv)}")}
    factor = min(4.0, max(0.25, (rv / pv) ** EXPONENT[kind]))
    return {"unit_cost": base * factor, "method": "scaled by size difference", "ref_size": lab.format(pv),
            "req_size": lab.format(round(rv)) + note, "diff_pct": round(diff, 1), "band": min(0.5, 0.10 + abs(diff) / 200),
            "basis": (f"{ref_p.pid} {lab.format(pv)} = {base:.2f} CHF; size {diff:+.0f} %{note} -> price "
                      f"{(factor - 1) * 100:+.0f} %")}


UNIT_COMPAT = {("system", "LS"), ("system", "system"), ("pc", "pc"), ("m", "m"), ("m2", "m2")}


def labour_estimate(ref: Ref, r, q: float, code) -> tuple[float, float, str | None, str | None]:
    """-> (labour CHF, hours, note, install code used).
    Labour only when the productivity rule's unit fits the row's unit:
    rows in hours are already labour (qty x hourly rate); a per-piece rule is never applied per metre."""
    has_rule = isinstance(code, str) and code in ref.productivity.index and code != "UNKNOWN"
    if r.unit == "h":
        roles = ref.productivity.get("labour_role", pd.Series(dtype=str))
        rate_code = code if has_rule else next((c for c, rl in roles.items() if rl == "installer"),
                                               ref.productivity.index[0])
        rate = float(ref.productivity.loc[rate_code, "default_hourly_rate_chf"])
        return q * rate, q, f"labour {q:g} h x {rate:g} CHF/h", (code if has_rule else None)
    if has_rule and (ref.productivity.loc[code, "unit"], r.unit) in UNIT_COMPAT:
        res = price_position(ref, r.row_id, None, q, code)
        return res.labour_cost_chf, res.adjusted_install_hours, f"labour {code}", code
    return 0.0, 0.0, None, None


def price_all(df: pd.DataFrame, ref: Ref) -> tuple[pd.DataFrame, dict]:
    products = {p.pid: p for p in load_catalog(ref.catalog.reset_index())}
    waste = 1 + ref.params["allowances"]["material_waste_pct"] / 100
    df = df.copy()
    firm_cols = ["unit_cost_chf", "material_chf", "labour_hours", "labour_chf", "direct_cost_chf"]
    est_cols = ["est_method", "est_basis", "est_reference_size", "est_requested_size", "est_size_diff_pct",
                "est_unit_cost_chf", "est_material_chf", "est_labour_hours", "est_labour_chf", "est_direct_cost_chf",
                "est_range_pct", "est_low_chf", "est_high_chf"]
    for c in firm_cols + est_cols + ["est_install_code"]:
        df[c] = None
    net = ref.catalog.net_cost_chf.astype(float).to_dict()

    for i, r in df.iterrows():
        q = _num(r.quantity)
        if q is None:
            continue
        pid = r.suggested_product_id if isinstance(r.suggested_product_id, str) else None
        if pid:                                                     # firm catalogue price
            res = price_position(ref, r.row_id, pid, q, r.expected_install_code)
            df.loc[i, firm_cols] = [res.net_unit_cost_chf, res.material_cost_chf, res.adjusted_install_hours,
                                    res.labour_cost_chf, res.direct_position_cost_chf]
            continue
        if r.status == "out_of_scope":
            continue                          # priced with its package or at project level: no double count
        # ---- side estimate
        unit_cost, est = None, {}
        epid = r.estimate_product_id if isinstance(r.estimate_product_id, str) else None
        if epid in products:
            p = products[epid]
            peers = [q for q in products.values() if q.subcategory == p.subcategory and q.unit == p.unit
                     and q.category == p.category]
            est = size_estimate(r.to_dict(), p, peers, net)
            unit_cost = est["unit_cost"]
            code = r.expected_install_code if r.expected_install_code in ref.productivity.index else p.install_code
        else:
            same = ref.catalog[(ref.catalog.category == r.category) & (ref.catalog.unit == r.unit)]
            if len(same):
                unit_cost = float(same.net_cost_chf.median())
                est = {"method": "category median", "band": 0.5,
                       "basis": f"median of {len(same)} {r.category} products"}
            code = r.expected_install_code
        labour, hours, note, used_code = labour_estimate(ref, r, q, code)
        if note:
            est["basis"] = (est.get("basis") + " + " if est.get("basis") else "") + note
            est.setdefault("method", "labour only")
            est.setdefault("band", 0.3)
        if unit_cost is None and not labour:
            df.loc[i, "est_basis"] = "no basis for an estimate"
            continue
        df.loc[i, "est_install_code"] = used_code
        material = q * (unit_cost or 0) * waste
        direct = material + labour
        band = est["band"]
        df.loc[i, est_cols] = [est["method"], est["basis"], est.get("ref_size"), est.get("req_size"),
                               est.get("diff_pct"), round(unit_cost, 2) if unit_cost else None,
                               round(material, 2), round(hours, 2), round(labour, 2), round(direct, 2), round(band * 100),
                               round(direct * (1 - band), 2), round(direct * (1 + band), 2)]

    df = status_apply(df, ref.params)                                 # final six-way status
    firm = df.direct_cost_chf.notna()
    df["price_source"] = ["estimate" if (not f and pd.notna(e)) else (ps if f else "none")
                          for f, e, ps in zip(firm, df.est_direct_cost_chf, df.price_source)]
    f = lambda c: float(pd.to_numeric(df[c], errors="coerce").fillna(0).sum())
    report = {
        "by_status": df.status.value_counts().reindex(STATUSES, fill_value=0).to_dict(),
        "estimate_methods": df.est_method.value_counts().to_dict(),
        "firm_rows": int(df.direct_cost_chf.notna().sum()),
        "firm_direct_cost_chf": round(f("direct_cost_chf"), 2),
        "firm_of_which_supplier_packages_chf": round(float(pd.to_numeric(
            df.loc[df.price_flag == "supplier_package", "direct_cost_chf"]).fillna(0).sum()), 2),
        "estimated_rows": int(df.est_direct_cost_chf.notna().sum()),
        "estimated_direct_cost_chf": round(f("est_direct_cost_chf"), 2),
        "estimated_range_chf": [round(f("est_low_chf"), 2), round(f("est_high_chf"), 2)],
        "rows_without_price": int((df.direct_cost_chf.isna() & df.est_direct_cost_chf.isna()).sum()),
        "indicative_direct_total_chf": round(f("direct_cost_chf") + f("est_direct_cost_chf"), 2),
        "note": "firm = catalogue prices; estimated = side estimates for items not in the catalogue, "
                "shown separately and never mixed into firm prices",
    }
    return df, report
