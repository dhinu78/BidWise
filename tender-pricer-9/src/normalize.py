"""Turn raw quantity rows into structured LV positions (example_lv_positions.csv schema).

Pure rules, no LLM. Every value carries a note saying where it came from, so a
reviewer (or the optional LLM pass) can see what was guessed.
"""
from __future__ import annotations
import re

from vocab import RULES, AIR_SIDE, ALL, V, H, S, TRADE_BKP, TRADE_WORDS, ATTRIBUTES, SPEC_PATTERNS, INCH_TO_DN, learned_lookup

N = r"(\d+(?:[.,]\d+)?)"
RE_ROUND = [re.compile(rf"Ø\s*{N}\s*(mm|cm)?", re.I),
            re.compile(rf"{N}\s*Ø\s*(mm|cm)", re.I),
            re.compile(rf"\b(?:DN|NW)\s*{N}\s*(mm|cm)?", re.I)]
RE_RECT = re.compile(rf"{N}\s*[x×]\s*{N}(?:\s*[x×]\s*{N})?\s*(mm|cm)?", re.I)
RE_INS = re.compile(r"(\d{2,3})\s*/\s*\d{1,2}\b")
RE_FIRE = re.compile(r"\bEI\s?(\d{2,3})(-S)?\b")
SIZE_LINE = re.compile(r"^\s*(Grösse|Größe|B\s*x\s*H|BxH|Abmessung|Dimension|Ø|DN|NW|Durchmesser|Anschlussdimension)", re.I)
HEADER_DIM = {"DN": "round", "NW": "round", "Ø": "round", "BXH": "rect", "B×H": "rect"}


def _f(s: str) -> float:
    return float(s.replace(",", "."))


RE_INCH = re.compile(r'(\d\s\d/\d|\d/\d|\d)\s*(?:"|″|\'\'|zoll)', re.I)
RE_OUTER_D = re.compile(r"\b(?:d|da|ø?aussen-?ø?)\s*=?\s*(\d{2,3})\s*(?:mm)?\b", re.I)
RE_PIPE_WALL = re.compile(rf"\b(\d{{1,3}})\s*[x×]\s*(\d(?:[.,]\d+)?)\s*mm", re.I)   # 28 x 1.5 mm
RE_AIRFLOW = re.compile(r"(\d{1,3}(?:['’]\d{3})+|\d+)\s*m\s*[3³]\s*/\s*h", re.I)


def _to_mm(vals: list[float], unit: str | None, trade: str | None = None) -> list[int]:
    if unit is None:
        # no unit written: in ventilation duct sizes below 100 are cm (nobody builds a 30 mm duct);
        # in heating/sanitary small numbers are pipe sizes in mm
        unit = "cm" if (max(vals) < 100 and trade in (None, V)) else "mm"
    f = 10 if unit.lower() == "cm" else 1
    return [int(round(v * f)) for v in vals]


def parse_size(text: str, unit_hint: str | None = None, trade: str | None = None) -> dict | None:
    if not text:
        return None
    pipes = trade in (H, S)
    lo = 6 if pipes else 50
    m = re.search(rf"\b(?:DN|NW)\s*{N}", text, re.I)           # DN is always mm
    if m and lo <= _f(m.group(1)) <= 2000:
        return {"shape": "round", "dn_mm": int(_f(m.group(1))), "raw": m.group(0)}
    if pipes:
        m = RE_PIPE_WALL.search(text)
        if m and _f(m.group(2)) < 10:
            return {"shape": "round", "dn_mm": int(m.group(1)), "raw": m.group(0)}
    for rx in RE_ROUND[:2]:
        m = rx.search(text)
        if m:
            dn = _to_mm([_f(m.group(1))], m.group(2) or unit_hint, trade)[0]
            if lo <= dn <= 2000:
                return {"shape": "round", "dn_mm": dn, "raw": m.group(0)}
    if pipes:
        m = RE_INCH.search(text)
        if m and m.group(1) in INCH_TO_DN:
            return {"shape": "round", "dn_mm": INCH_TO_DN[m.group(1)], "raw": m.group(0)}
        m = RE_OUTER_D.search(text)
        if m:
            return {"shape": "round", "dn_mm": int(m.group(1)), "raw": m.group(0)}
    m = RE_RECT.search(text)
    if m:
        vals = [_f(g) for g in m.groups()[:3] if g]
        mm = _to_mm(vals, m.group(4) or unit_hint, trade)
        if all(50 <= v <= 5000 for v in mm[:2]):
            d = {"shape": "rect", "width_mm": mm[0], "height_mm": mm[1], "raw": m.group(0)}
            if len(mm) == 3:
                d["length_mm"] = mm[2]
            return d
    return None


def size_from_table(lines: list[str], row_idx: int, variant: str) -> dict | None:
    """Rows like 'TVR-D 12.5 60 200 150' under a header 'Mod. DN Vmin. Vmax. P' + unit row 'cm ...'."""
    for k in range(row_idx - 1, max(-1, row_idx - 12), -1):
        toks = lines[k].replace("B x H", "BxH").split()
        up = [t.upper().rstrip(".") for t in toks]
        hit = [i for i, t in enumerate(up) if t in HEADER_DIM]
        numeric = sum(bool(re.match(r"^[\d.,x]+$", t)) for t in toks)
        if hit and len(toks) >= 3 and numeric <= len(toks) * 0.3:
            unit_row = lines[k + 1].split() if k + 1 < len(lines) else []
            unit = next((u for u in unit_row[:2] if u in ("cm", "mm")), None)
            vt = variant.split()
            i = hit[0]
            if i < len(vt):
                val = vt[i]
                if "x" in val.lower():
                    return parse_size(val, unit)
                try:
                    dn = _to_mm([_f(val)], unit)[0]
                    return {"shape": "round", "dn_mm": dn, "raw": f"{toks[i]} {val} {unit or ''}".strip()}
                except ValueError:
                    return None
    return None


def classify(text: str, trade: str | None = None, other_trades: bool = True):
    """-> (category, subcategory, english name, install code hint) or None.
    Own trade's rules first (incl. shared ones), then (optionally) the other trades."""
    hit = learned_lookup(text, trade)          # what the LLM taught us comes first
    if hit:
        return hit
    t = " " + text.lower() + " "
    order = [r for r in RULES if trade is None or trade in r.trades]
    if trade is not None and other_trades:
        order += [r for r in RULES if trade not in r.trades]
    for r in order:
        for words in r.keywords:
            if all(w in t for w in words):
                return r.category, r.subcategory, r.english, r.install_code
    return None


def detect_trade(page_texts: list[str]) -> tuple[str, dict]:
    """Which trade is this tender? BKP numbers on the first pages count most, then keyword counts."""
    head = " ".join(page_texts[:10])
    score = {V: 0.0, H: 0.0, S: 0.0}
    for rx, trade in TRADE_BKP:
        score[trade] += 50 * len(rx.findall(head))
    body = " ".join(page_texts).lower()
    for trade, words in TRADE_WORDS.items():
        score[trade] += sum(body.count(w) for w in words) / 10
    best = max(score, key=score.get)
    return best, {k: round(v, 1) for k, v in score.items()}


def english_attributes(text: str) -> list[str]:
    """German position text -> short English attributes: material, features, specs."""
    t = text.lower()
    out = []
    for group in ("material", "feature"):
        for rx, en in ATTRIBUTES[group]:
            if re.search(rx, t) and en not in out:
                out.append(en)
                if group == "material":
                    break                       # one material is enough
    for rx, fmt in SPEC_PATTERNS:
        m = rx.search(text)
        if m:
            out.append(fmt.format(m.group(1).replace(",", ".")))
    return out


def air_side(text: str) -> str | None:
    t = " " + text.lower() + " "
    for side, words in AIR_SIDE:
        if any(w in t for w in words):
            return side
    return None


def hint_values(lines: list[str], key: str) -> list[str]:
    """All values of 'Fabrikat z.B. X' / 'Typ z.B. Y', line start first, then inline."""
    out = []
    for rx in (re.compile(rf"^{key}\s*:?\s*(?:z\.?\s*B\.?)?\s*(.+)$", re.I),
               re.compile(rf"\b{key}\s*:?\s*(?:z\.?\s*B\.?)\s*(.+)$", re.I)):
        for l in lines:
            m = rx.search(l.strip())
            if m:
                v = m.group(1).strip()
                v = re.sub(r"/\d+\s*x\s*\d+.*$", "", v)          # MS-F/300x400x1250/... -> MS-F
                v = re.sub(r"\s+(AG|GmbH|SA)\b.*$", "", v).strip(" .")
                if v and not set(v) <= set(". ") and v not in out:
                    out.append(v)
        if out:
            break
    return out


def system_hint(lines: list[str]) -> str | None:
    for l in lines:
        m = re.search(r"z\.?\s*B\.?\s*System\s+([A-ZÄÖÜ][\w-]+)", l)
        if m:
            return m.group(1)
    return None


def install_code(code: str, cat: str, size: dict | None, text: str) -> str:
    shape = size["shape"] if size else None
    if code == "FIRE_SEAL":
        return "FIRE_SEAL_ROUND" if shape == "round" else "FIRE_SEAL_RECT"
    if code == "DUCT":
        return "DUCT_ROUND" if shape == "round" else "DUCT_RECT"
    if code == "INSULATION":
        m = RE_INS.search(text)
        th = int(m.group(1)) if m else None
        if "ummantelung" in text.lower() or "wetterfest" in text.lower() or (th and th >= 100):
            return "INSULATION_EXT"
        if re.search(r"\bEI\s?\d", text):
            return "UNKNOWN"
        return {30: "INSULATION_30", 60: "INSULATION_60"}.get(th, "UNKNOWN")
    return code


NEEDS_SIZE = {"Air terminal", "Fire protection", "Flow controller", "Silencer", "Damper", "Ductwork"}


def normalize_row(block, row, row_no: int, parent: str, parent_lines: list[str] | None = None,
                  trade: str | None = None) -> dict:
    notes = []
    lines = block.text_lines
    title, variant = block.title, row.variant

    # category: title first, parent heading only if the title alone says nothing
    c = classify(parent, trade, other_trades=False) if parent else None
    if c:
        notes.append("category from parent heading")
    else:
        c = classify(f"{title} {variant}", trade)
    if c is None:
        c = classify(" ".join(lines[:4]), trade); c and notes.append("category from block text")
    cat, sub, en, code = c if c else ("Other", "Unclassified", "Unclassified item", "UNKNOWN")
    if c is None:
        notes.append("no category rule matched")

    # size: own row first, then table header mapping, then title, then size lines of the block
    size, src = None, None
    for s_src, fn in (("table", lambda: size_from_table(lines, row.line_idx, variant)),
                      ("row", lambda: parse_size(variant, None, trade)),
                      ("title", lambda: parse_size(title, None, trade))):
        size = fn()
        if size:
            src = s_src; break
    if not size:
        is_size = lambda l: SIZE_LINE.match(l) or re.search(r"\b(DN|NW)\s*\d", l)
        cand = [l for l in lines[:max(row.line_idx, 1)] if is_size(l)] or [l for l in lines if is_size(l)]
        for l in cand:
            size = parse_size(l, None, trade)
            if size:
                src = "block"; break
        if size and len(block.qty_rows) > 1:
            notes.append("size taken from block text, shared by several rows")
    if size:
        notes.append(f"size from {src}: '{size['raw']}'")

    full = f"{parent} {title} {variant}"
    ins = RE_INS.search(f"{title} {parent}") if cat == "Insulation" else None
    if cat == "Insulation" and not ins:
        ins = re.search(r"(\d{2,3})\s*mm", f"{title} {variant}")
    before = [l for l in lines[:max(row.line_idx, 1) + 1] if not re.match(r"^(Fabrikat|Typ)\b", l.strip(), re.I)]
    af = next((RE_AIRFLOW.search(l) for l in lines if RE_AIRFLOW.search(l)), None)
    airflow = int(af.group(1).replace("'", "").replace("’", "")) if af else None
    fire = RE_FIRE.search(full + " " + " ".join(lines[:8]))
    code = install_code(code, cat, size, f"{parent} {title} {variant}")

    # english description: name, attributes (material / features / kW / litres / PN), fire class, size
    size_txt = ""
    if size and size["shape"] == "round":
        outer = re.match(r"^(d|da)\b|^\d{1,3}\s*[x×]", size["raw"], re.I)    # d110 / 28 x 1.2 = outer diameter
        size_txt = f"d{size['dn_mm']}" if outer else f"DN{size['dn_mm']}"
    elif size:
        size_txt = f"{size['width_mm']}x{size['height_mm']}" + (f"x{size['length_mm']}" if "length_mm" in size else "") + " mm"
    attr_src = " ".join([parent, title, variant] + before[:8])
    parts = [en] + [a for a in english_attributes(attr_src) if a.lower() not in en.lower()][:4]
    if fire and cat == "Fire protection" and "EI" not in en:
        parts.append(f"EI{fire.group(1)}{fire.group(2) or ''}")
    if ins:
        parts.append(f"{ins.group(1)} mm")
    if size_txt:
        parts.append(size_txt)
    description = ", ".join(parts)

    makers, models = hint_values(lines, "Fabrikat"), hint_values(lines, "Typ")
    first_tok = variant.split()[0] if variant.split() else ""
    model = first_tok if first_tok in models else (models[0] if models else None)
    maker = makers[0] if makers else system_hint(lines + (parent_lines or []))

    conf = 1.0
    if row.quantity is None:
        conf = 0.0
    if c is None:
        conf *= 0.4
    if cat in NEEDS_SIZE and not size:
        conf *= 0.7; notes.append("no size found")
    if src == "block" and len(block.qty_rows) > 1:
        conf *= 0.8
    status = ("insufficient_information" if row.quantity is None
              else "review_required" if conf < 0.6 else "pending_match")

    return {
        "system": block.system,
        "source_page": row.page,
        "category": cat,
        "description": description,
        "quantity": row.quantity,
        "unit": row.unit,
        "manufacturer_hint": maker,
        "model_hint": model,
        "expected_install_code": code,
        "suggested_product_id": None,
        "status": status,
        # extra columns
        "subcategory": sub,
        "trade": trade,
        "airflow_m3h": airflow,
        "power_kw": float(pk.group(1).replace(",", ".")) if (pk := re.search(r"(\d+(?:[.,]\d+)?)\s*kW\b", attr_src, re.I)) else None,
        "volume_l": int(vl.group(1)) if (vl := re.search(r"(\d{2,5})\s*(?:l|liter|litre)\b", attr_src, re.I)) else None,
        "angle_deg": int(an.group(1)) if (an := re.search(r"(\d{2,3})\s*°", f"{title} {variant}")) else None,
        "air_side": air_side(full),
        "shape": size["shape"] if size else None,
        "dn_mm": size.get("dn_mm") if size else None,
        "width_mm": size.get("width_mm") if size else None,
        "height_mm": size.get("height_mm") if size else None,
        "length_mm": size.get("length_mm") if size else None,
        "insulation_thickness_mm": int(ins.group(1)) if ins else None,
        "fire_class": f"EI{fire.group(1)}{fire.group(2) or ''}" if fire else None,
        "chapter": block.chapter,
        "position_no": block.position_no,
        "description_de": " | ".join(x for x in (parent, title, variant) if x),
        "context_de": " / ".join(before[:8])[:600],       # block text above the row (for the LLM and reviewers)
        "title_de": title,
        "block_id": block.block_id,
        "block_pages": block.pages,
        "bbox": [round(v, 1) for v in row.bbox],
        "extraction_confidence": round(conf, 2),
        "parse_notes": "; ".join(notes),
    }
