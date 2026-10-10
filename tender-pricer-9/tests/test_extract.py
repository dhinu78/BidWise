import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT / "tests"))
import pandas as pd
import pymupdf
from build_positions import build, attach_golden
from normalize import parse_size
from layout import page_spans, unit_key

PDF = ROOT / "data/BKP_244_LV_Lueftung_260804.pdf"
_cache = {}


def positions():
    if "df" not in _cache:
        df, rep = build(PDF)
        _cache["df"] = attach_golden(df, ROOT / "data/example_lv_positions.csv")
        _cache["rep"] = rep
    return _cache["df"], _cache["rep"]


def test_systems_found():
    _, rep = positions()
    assert list(rep["systems"]) == ["244.01 LA01 Nebenräume", "244.02 LA02 Essenräume EG",
                                    "244.03 LA03 Küche/Abwaschen", "244.04 Schulzimmer OG",
                                    "244.05 LA05 Turnhalle", "244.06 Montagesystem Flachdach"]
    assert rep["systems"]["244.05 LA05 Turnhalle"] == [174, 195]   # despite the wrong header on 181-195


def test_golden_rows_match():
    df, _ = positions()
    g = pd.read_csv(ROOT / "data/example_lv_positions.csv")
    bad = []
    for r in g.itertuples():
        m = df[df.reference_lv_id == r.lv_id]
        if len(m) != 1:
            bad.append((r.lv_id, "not found")); continue
        o = m.iloc[0]
        if o.category != r.category or o.expected_install_code != r.expected_install_code:
            bad.append((r.lv_id, o.category, o.expected_install_code))
        gs = parse_size(r.description, "mm")
        if gs and gs["shape"] == "round" and o.dn_mm != gs["dn_mm"]:
            bad.append((r.lv_id, "dn", o.dn_mm, gs["dn_mm"]))
        if gs and gs["shape"] == "rect" and (o.width_mm, o.height_mm) != (gs["width_mm"], gs["height_mm"]):
            bad.append((r.lv_id, "wxh", o.width_mm, o.height_mm))
    assert not bad, bad


def test_every_unit_cell_captured():
    df, _ = positions()
    doc = pymupdf.open(PDF)
    got = set(zip(df.source_page, df.bbox.map(lambda b: round(eval(b)[1]) if isinstance(b, str) else round(b[1]))))
    miss = []
    for p in range(67, 200):
        if "Bauteilliste" in doc[p - 1].get_text()[:300]:
            continue
        for s in page_spans(doc[p - 1]):
            if unit_key(s.text) and 360 <= s.x0 < 395 and 62 <= s.y0 < 790:
                if not any(pp == p and abs(y - s.y0) < 5 for pp, y in got):
                    miss.append((p, round(s.y0), s.text))
    assert not miss, miss


def test_other_layout(tmp_path):
    from make_synthetic import make
    pdf = tmp_path / "t.pdf"; make(pdf)
    df, rep = build(pdf)
    assert rep["layout"]["qty_side"] == "left"
    assert list(df.row_id) == ["111.101", "111.102", "111.103", "112.101", "112.102", "112.103"]
    assert list(df.category) == ["Air terminal", "Fire protection", "Insulation", "Flow controller",
                                 "Silencer", "Service"]
    assert list(df.quantity) == [12, 3, 85, 7, 4, 1]
    assert list(df.unit) == ["pc", "pc", "m2", "pc", "pc", "LS"]
    assert list(df.dn_mm.fillna(0).astype(int)) == [160, 0, 0, 200, 250, 0]


def test_chapters_found_in_every_system():
    """Each of the 5 main systems uses chapters A..F (LA03 indents them differently)."""
    df, _ = positions()
    for sysname, g in df.groupby("system"):
        if sysname.startswith("244.06"):
            continue
        letters = {c.split()[0] for c in g.chapter.dropna()}
        assert {"A", "B", "C", "D", "E", "F"} <= letters, (sysname, sorted(letters))
