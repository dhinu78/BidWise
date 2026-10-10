"""Match extracted LV rows to catalogue products and number the matched rows LV0001.. by page.

Works with any catalog.csv that has the columns
    product_id, category, subcategory, description, unit, install_code, source_type
(ventilation, heating or sanitary). Nothing here is specific to one tender or catalogue.

Decision per row:
  1. candidates   same category (or alias) and same unit; fallback: any product with a strong name match
  2. name         overlap of English name / subcategory words; keep candidates close to the best name
  3. size         exact > sized up (airflow) > generic product > nearest (<= 30 %) > row without size;
                  shape conflict or size too far -> dropped
  4. ambiguity    two equally good candidates -> no match (review), alternatives listed
  5. status       six outcomes, see status.py
"""
from __future__ import annotations
import difflib, re
from dataclasses import dataclass

import pandas as pd

from normalize import parse_size
from vocab import CATEGORY_ALIASES
from status import apply as status_apply

STOP = {"with", "and", "for", "mm", "approx", "the", "of", "set", "unit", "incl", "a", "per", "type"}
SYN = {"ahu": ["air", "handling"], "vav": ["variable", "volume"], "cav": ["constant", "volume"],
       "circular": ["round"], "round": ["circular"], "wc": ["toilet"], "toilet": ["wc"],
       "washbasin": ["basin", "lavatory"], "rectangular": ["rect"], "transmitter": ["sensor"]}
RE_AIRFLOW = re.compile(r"(\d{1,3}(?:[',]\d{3})+|\d+)\s*m3/h", re.I)
RE_THICK = re.compile(r"(\d{2,3})\s*mm\b")
NEAREST_TOL = 0.30


def _stem(w: str) -> str:
    for suf in ("ing", "ers", "er", "es", "s"):
        if len(w) > 4 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def tokens(text: str) -> set[str]:
    out = set()
    for w in re.findall(r"[a-z][a-z0-9-]*", str(text).lower()):
        for part in w.split("-"):
            if part and part not in STOP and not re.match(r"^(dn|ei)?\d", part):
                out.add(_stem(part))
                out.update(_stem(x) for x in SYN.get(part, []))
    return out


def name_score(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return 2 * inter / (len(a) + len(b))                 # Dice coefficient


def same_category(row_cat: str, prod_cat: str) -> bool:
    a, b = str(row_cat).strip().lower(), str(prod_cat).strip().lower()
    if a == b:
        return True
    aliases = {x.lower() for x in CATEGORY_ALIASES.get(row_cat, [])}
    return b in aliases or difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


@dataclass
class Product:
    pid: str
    category: str
    subcategory: str
    description: str
    unit: str
    install_code: str
    source_type: str
    toks: set
    size: dict | None
    airflow: int | None
    thickness: int | None
    angle: int | None
    power_kw: float | None = None
    volume_l: int | None = None


def load_catalog(catalog: pd.DataFrame) -> list[Product]:
    out = []
    for r in catalog.itertuples():
        desc = str(r.description)
        af = RE_AIRFLOW.search(desc)
        th = RE_THICK.search(desc) if "insulation" in f"{r.category} {desc}".lower() else None
        kw = re.search(r"(\d+(?:[.,]\d+)?)\s*kW\b", desc, re.I)
        vol = re.search(r"(\d{2,5})\s*(?:l|liter|litre)\b", desc, re.I)
        size = parse_size(desc, "mm", "heating")          # pipe mode: DN15, d110, 28 x 1.2 mm ...
        out.append(Product(r.product_id, r.category, r.subcategory, desc, str(r.unit), str(r.install_code),
                           str(getattr(r, "source_type", "catalog")),
                           tokens(f"{r.subcategory} {desc}"), size,
                           int(re.sub(r"\D", "", af.group(1))) if af else None,
                           int(th.group(1)) if th and not parse_size(desc, "mm") else None,
                           int(a.group(1)) if (a := re.search(r"(\d{2,3})\s*°", desc)) else None,
                           float(kw.group(1).replace(",", ".")) if kw else None,
                           int(vol.group(1)) if vol else None))
    return out


# ------------------------------------------------------------------ size comparison
def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(a, b)


def compare_size(row: dict, p: Product) -> tuple[str, float]:
    """-> (kind, distance) kind in exact | sized | unsized | nearest | unknown | conflict"""
    ra = row.get("angle_deg")
    if p.angle and ra is not None and not pd.isna(ra) and int(ra) != p.angle:
        return "conflict", 9                                    # 45° bend is not a 90° bend
    for p_cap, r_cap in ((p.power_kw, row.get("power_kw")), (p.volume_l, row.get("volume_l"))):
        if p_cap:                                      # heat pumps by kW, tanks / water heaters by litres
            if r_cap is None or pd.isna(r_cap):
                return "unknown", 1.0
            if float(r_cap) == p_cap:
                return "exact", 0.0
            return ("sized", (p_cap - float(r_cap)) / float(r_cap)) if p_cap > float(r_cap) else ("conflict", 9)
    r_air = row.get("airflow_m3h")
    if p.airflow:
        if not r_air or pd.isna(r_air):
            return "unknown", 1.0
        return ("sized", (p.airflow - r_air) / r_air) if p.airflow >= r_air else ("conflict", 9)
    r_th = row.get("insulation_thickness_mm")
    if p.thickness:
        if r_th is None or pd.isna(r_th):
            return "unknown", 1.0
        d = _rel(p.thickness, float(r_th))
        return ("exact", 0) if d == 0 else (("nearest", d) if d <= NEAREST_TOL else ("conflict", d))
    if p.size is None:
        return "unsized", 0.0
    shape = row.get("shape")
    if not isinstance(shape, str):
        return "unknown", 1.0
    if shape != p.size["shape"]:
        return "conflict", 9
    if shape == "round":
        d = _rel(float(row["dn_mm"]), p.size["dn_mm"])
    else:
        rw = sorted([float(row["width_mm"]), float(row["height_mm"])])
        pw = sorted([p.size["width_mm"], p.size["height_mm"]])
        d = max(_rel(rw[0], pw[0]), _rel(rw[1], pw[1]))
        rl, pl = row.get("length_mm"), p.size.get("length_mm")
        if d == 0 and rl is not None and not pd.isna(rl) and pl:
            d = _rel(float(rl), pl)
    if d == 0:
        return "exact", 0.0
    return ("nearest", d) if d <= NEAREST_TOL else ("conflict", d)


RANK = {"exact": 5, "sized": 4, "unsized": 3, "nearest": 2, "unknown": 1}


TYPE_WORDS = {"compact", "rectangular", "circular", "weatherproof", "external", "condensing", "concealed",
              "wall-hung", "air-to-water", "brine-to-water", "self-closing", "touchless", "single-lever",
              "stainless steel", "copper", "steel", "pe", "pp", "multilayer", "cast iron"}


def row_tokens(row: dict) -> tuple[set[str], set[str]]:
    """core: English name + subcategory. bonus: air side, shape and type words (count only if the product has them)."""
    parts = [x.strip() for x in str(row.get("description", "")).split(",")]
    extra = [x for x in parts[1:] if x.lower() in TYPE_WORDS]
    if row.get("air_side") in ("supply", "exhaust"):
        extra.append(row["air_side"])
    if row.get("shape") == "round":
        extra.append("circular")
    elif row.get("shape") == "rect":
        extra.append("rectangular")
    if str(row.get("expected_install_code", "")) == "INSULATION_EXT":
        extra += ["external", "cladding", "weatherproof"]
    return tokens(f"{parts[0]} {row.get('subcategory', '')}"), tokens(" ".join(extra))


def score_name(core: set[str], bonus: set[str], p_toks: set[str]) -> float:
    """Dice overlap of the row's name words with the product's. Type words (supply, compact, external,
    rectangular ...) count fully when the product has them and cost nothing when it does not."""
    if not core & p_toks:
        return 0.0                  # shape/type words alone never make a match ("circular" duct != circular bend)
    return round(name_score(core | (bonus & p_toks), p_toks), 4)


FIRM = ("exact", "sized", "unsized")      # the only kinds that give a firm catalogue price


def match_row(row: dict, products: list[Product]) -> dict:
    """Firm match only when the catalogue really has this product (exact size, generic product,
    or equipment sized up by airflow / kW / litres). Otherwise no product, but an
    `estimate_product_id` (closest product of the same type) for the side estimate."""
    if str(row.get("subcategory", "")).endswith("section"):
        return {"match_type": "part_of_package", "match_reason": "part of a unit priced as one package"}
    rt, bonus = row_tokens(row)
    unit = row.get("unit")
    cands = [p for p in products if same_category(row.get("category"), p.category) and p.unit == unit]
    via = "category"
    if not cands:   # catalogue may name the category differently: strong name match anywhere
        cands = [p for p in products if p.unit == unit and score_name(rt, bonus, p.toks) >= 0.6]
        via = "name"
    if not cands:
        return {"match_type": "not_in_catalogue", "match_reason": "no product with this category and unit"}

    # 1) the name decides the product TYPE (CAV vs VAV, supply vs exhaust) ...
    names = {p.pid: score_name(rt, bonus, p.toks) for p in cands}
    best_name = max(names.values())
    floor = 0.34 if len({p.subcategory for p in cands}) > 1 or via == "name" else 0.2
    typed = [p for p in cands if names[p.pid] >= max(best_name - 0.1, floor)]
    if not typed:
        return {"match_type": "not_in_catalogue",
                "match_reason": f"no product of this type in the catalogue (best name score {best_name:.2f})"}
    # 2) ... the size picks the VARIANT within that type
    sized = [(p, *compare_size(row, p), names[p.pid]) for p in typed]       # (p, kind, dist, name)
    firm = sorted([s for s in sized if s[1] in FIRM], key=lambda s: (-RANK[s[1]], -s[3], s[2]))
    if firm:
        top = firm[0]
        if len(firm) > 1 and (RANK[firm[1][1]], round(firm[1][3], 3), round(firm[1][2], 3)) == \
                (RANK[top[1]], round(top[3], 3), round(top[2], 3)):
            return {"match_type": "ambiguous", "match_reason": "several products fit equally",
                    "alternatives": ",".join(s[0].pid for s in firm[:4]), "estimate_product_id": top[0].pid}
        p, kind, dist, ns = top
        if not (kind == "unsized" and ns < 0.6 and len(typed) > 1):
            return {"suggested_product_id": p.pid, "match_type": kind, "match_name_score": round(ns, 2),
                    "match_size_distance": round(dist, 3),
                    "alternatives": ",".join(s[0].pid for s in firm[1:4]), "price_source": p.source_type,
                    "product_install_code": p.install_code,
                    "match_reason": f"{kind} match, name {ns:.2f} via {via}: {p.description}"}
    # no firm match: the closest product of the same type becomes the estimate reference
    ref = min(sized, key=lambda s: (s[2] >= 9, s[2], -s[3]))
    kind = "size_not_in_catalogue" if ref[1] in ("nearest", "conflict") else "size_unknown"
    why = {"size_not_in_catalogue": "this size is not in the catalogue",
           "size_unknown": "row has no size to compare"}[kind]
    return {"match_type": kind, "estimate_product_id": ref[0].pid,
            "alternatives": ",".join(s[0].pid for s in sorted(sized, key=lambda s: s[2])[:4]),
            "match_reason": f"{why}; closest of this type: {ref[0].description}"}


def status_and_flag(row: dict, m: dict) -> tuple[str, str, float | None]:
    """First pass (before the side estimate). Final status: status.apply after estimate.price_all."""
    from status import decide
    st, flag, conf, _ = decide({**row, **m})
    return st, flag, conf


def match_all(df: pd.DataFrame, catalog: pd.DataFrame, params: dict | None = None) -> pd.DataFrame:
    products = load_catalog(catalog)
    df = df.copy()
    res = [match_row(r, products) for r in df.to_dict("records")]
    for col in ("suggested_product_id", "match_type", "match_name_score", "match_size_distance",
                "alternatives", "price_source", "product_install_code", "match_reason", "estimate_product_id"):
        df[col] = [m.get(col) for m in res]
    # authoritative install code = the matched product's
    df["expected_install_code"] = [m.get("product_install_code") or c
                                   for m, c in zip(res, df.expected_install_code)]
    df = status_apply(df.drop(columns=["product_install_code"]), params)
    return df


def assign_lv_ids(df: pd.DataFrame, prefix: str = "LV") -> pd.DataFrame:
    """Every row gets a unique id LV0001.. in tender order: ascending page, then position on the page."""
    df = df.copy()
    y = df.bbox.map(lambda b: (eval(b) if isinstance(b, str) else b)[1] if b is not None else 0)
    order = df.assign(_y=y).sort_values(["source_page", "_y"], kind="stable").index
    width = max(4, len(str(len(df))))
    df["lv_id"] = None
    for k, i in enumerate(order, 1):
        df.at[i, "lv_id"] = f"{prefix}{k:0{width}d}"
    return df
