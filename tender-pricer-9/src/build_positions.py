"""Tender PDF -> structured, priced LV rows.  CLI writes out/lv_positions.csv + out/priced_output.json.

    python src/build_positions.py                                   # Oberglatt with the files in data/
    python src/build_positions.py tender.pdf --catalog catalog.csv --productivity productivity.csv \
                                  --params project_parameters.json --out out/job1
"""
from __future__ import annotations
import argparse, json, re, sys
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

import pandas as pd
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import learn_layout
from extract import extract
from normalize import normalize_row, detect_trade
from matcher import match_all, assign_lv_ids
from estimate import price_all, make_ref

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_COLS = ["lv_id", "system", "source_page", "category", "description", "quantity", "unit",
                "manufacturer_hint", "model_hint", "expected_install_code", "suggested_product_id", "status"]


def system_code(name: str | None, idx: int) -> str:
    m = re.match(r"\s*(\d+(?:\.\d+)?)", name or "")
    return m.group(1) if m else f"S{idx:02d}"


def build(pdf: Path, catalog_csv=None, trade: str | None = None,
          productivity_csv=None, params_json=None, llm=None) -> tuple[pd.DataFrame, dict]:
    """Tender PDF + catalogue + productivity + project parameters (paths, DataFrames or dict).
    Anything not given falls back to the matching file in data/.
    llm: None/False -> vocab.py rules only; True -> the LLM reads every row (rules check it);
         or an llm_understand.Understander instance (custom model / client / cache)."""
    doc = pymupdf.open(pdf)
    lp = learn_layout(doc)
    lp, blocks = extract(pdf, lp)
    trade_scores = None
    if trade is None:
        trade, trade_scores = detect_trade([p.get_text() for p in doc])

    rows, counters, sys_idx = [], defaultdict(int), {}
    for k, b in enumerate(blocks):
        prev = blocks[k - 1] if k else None
        # a short heading without quantities right before this block is its parent
        parent = prev.title if (prev and not prev.qty_rows and prev.chapter == b.chapter
                                and prev.system == b.system and len(prev.text_lines) <= 5) else ""
        sys_idx.setdefault(b.system, len(sys_idx) + 1)
        for j, q in enumerate(b.qty_rows):
            rec = normalize_row(b, q, j + 1, parent, prev.text_lines if parent else None, trade)
            sc = system_code(b.system, sys_idx[b.system])
            ch = (b.chapter.split()[0] if b.chapter else "X")[:3]
            counters[(sc, ch)] += 1
            rec["row_id"] = b.position_no or f"{sc}-{ch}-{counters[(sc, ch)]:03d}"
            rows.append(rec)
    df = pd.DataFrame(rows)

    ref = make_ref(catalog_csv if catalog_csv is not None else ROOT / "data/catalog.csv",
                   productivity_csv, params_json)
    understanding = {"mode": "rules"}
    df["description_source"], df["llm_check"] = "rules", None
    if llm:                                     # the LLM reads the page images; vocab.py is the fallback
        from llm_understand import apply_llm, Understander
        und = llm if isinstance(llm, Understander) else None
        df, understanding = apply_llm(df, ref.catalog.reset_index(), trade, pdf, und)
    df = match_all(df, ref.catalog.reset_index(), ref.params)
    df, pricing_report = price_all(df, ref)
    df = assign_lv_ids(df)
    first = EXAMPLE_COLS + [c for c in ("price_flag", "status_reason", "price_source", "description_source",
                                        "llm_check") if c in df]
    df = df[first + [c for c in df.columns if c not in first]]

    report = {
        "pdf": str(pdf), "pages": doc.page_count, "trade": trade, "trade_scores": trade_scores,
        "layout": {k: v for k, v in lp.to_dict().items() if k not in ("page_kind", "page_system", "header_text")},
        "page_kinds": dict(Counter(lp.page_kind.values())),
        "systems": {s: [min(p for p, v in lp.page_system.items() if v == s),
                        max(p for p, v in lp.page_system.items() if v == s)]
                    for s in dict.fromkeys(v for v in lp.page_system.values() if v)},
        "blocks": len(blocks), "blocks_without_quantity": sum(not b.qty_rows for b in blocks),
        "positions": len(df),
        "by_category": df.category.value_counts().to_dict(),
        "by_status": df.status.value_counts().to_dict(),
        "missing_size_where_needed": int(((df.category.isin(
            ["Air terminal", "Fire protection", "Flow controller", "Silencer", "Damper", "Ductwork"]))
            & df["shape"].isna()).sum()),
        "mean_extraction_confidence": round(float(df.extraction_confidence.mean()), 3),
        "catalogue_matched_rows": int(df.lv_id.notna().sum()),
        "by_match_type": df.match_type.value_counts().to_dict() if "match_type" in df else {},
        "by_price_flag": df.price_flag.value_counts().to_dict() if "price_flag" in df else {},
        "pricing": pricing_report,
        "understanding": understanding,
    }
    return df, report


def attach_golden(df: pd.DataFrame, golden_csv: Path) -> pd.DataFrame:
    """Validation only: map the organisers' LV ids (if that file exists) onto our rows."""
    if not golden_csv.exists():
        return df
    g = pd.read_csv(golden_csv)
    df["reference_lv_id"] = None
    from normalize import parse_size
    for r in g.itertuples():
        m = df[(df.source_page == r.source_page) & (df.quantity == float(r.quantity))
               & (df.unit == r.unit) & (df.category == r.category)]
        if len(m) > 1:   # tie: use the size written in the golden description
            gs = parse_size(r.description, "mm") or {}
            m = m[(m.dn_mm == gs.get("dn_mm")) | ((m.width_mm == gs.get("width_mm")) & (m.height_mm == gs.get("height_mm")))]
        if len(m) == 1:
            df.loc[m.index, "reference_lv_id"] = r.lv_id
    return df


def main():
    """Command line version of what the frontend does: pass the uploaded files, get the two outputs."""
    ap = argparse.ArgumentParser(description="Tender PDF -> lv_positions.csv + priced_output.json")
    ap.add_argument("pdf", nargs="?", default=str(ROOT / "data/BKP_244_LV_Lueftung_260804.pdf"))
    ap.add_argument("--catalog", default=str(ROOT / "data/catalog.csv"))
    ap.add_argument("--productivity", default=str(ROOT / "data/productivity.csv"))
    ap.add_argument("--params", default=str(ROOT / "data/project_parameters.json"), help="project_parameters.json")
    ap.add_argument("--out", default=str(ROOT / "out"))
    ap.add_argument("--trade", choices=["ventilation", "heating", "sanitary"], help="override detection")
    ap.add_argument("--llm", dest="llm", action="store_true", default=None,
                    help="LLM reads the page images (default, unless BIDWISE_LLM=off)")
    ap.add_argument("--no-llm", dest="llm", action="store_false", help="vocab.py rules only (offline)")
    a = ap.parse_args()
    from pipeline import run
    res = run(a.pdf, a.catalog, a.productivity, a.params, a.out, a.trade, llm=a.llm)
    po = res["priced_output"]
    cs = po["cost_summary"]
    print(f"tender      {po['source_tender_file']}  ({po['tender']['trade']}, {po['tender']['positions']} positions)")
    for s_ in po["tender"]["systems"]:
        print(f"  system    {s_['name']}  p.{s_['first_page']}-{s_['last_page']}")
    u = po.get("understanding", {})
    if u.get("mode") == "llm_vision":
        print(f"llm         {u['provider']} {u['model']} (page images): ok {u['ok']}, "
              f"quantity_mismatch {u['quantity_mismatch']}, fallback {u['fallback']}")
        print(f"            pages sent {u['pages_sent']}, api calls {u['api_calls']}, cache hits {u['cache_hits']}, "
              f"tokens in {u['input_tokens']:,} / out {u['output_tokens']:,}, vocab learned {u['learned']}")
        for e in u.get("errors", [])[:3]:
            print("  llm error", e)
    print("status     ", cs["by_status"])
    print("source     ", cs["by_price_source"])
    print(f"firm        CHF {cs['firm']['direct_cost_chf']:,.0f}   estimated CHF {cs['estimated']['direct_cost_chf']:,.0f} "
          f"({cs['estimated']['low_chf']:,.0f} to {cs['estimated']['high_chf']:,.0f})")
    for sc in po["recommended_bid_range"]["scenarios"]:
        print(f"bid         {sc['scenario']:<13} CHF {sc['bid_price_chf']:,}  margin {sc['margin_pct']} %  "
              f"P(win) {sc['estimated_win_probability']}")
    print("wrote      ", res["lv_positions_csv"], "and", res["priced_output_json"])


if __name__ == "__main__":
    main()
