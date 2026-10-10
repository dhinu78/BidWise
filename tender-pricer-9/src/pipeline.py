"""One entry point: uploaded files in, two files out.

    from pipeline import run
    result = run("tender.pdf", "catalog.csv", "productivity.csv", "project_parameters.json", out_dir="out/job1")
    result["lv_positions_csv"], result["priced_output_json"], result["priced_output"]

Inputs (paths; productivity and parameters fall back to data/ when not given):
    tender_pdf          the LV (Leistungsverzeichnis) PDF
    catalog_csv         product_id, category, subcategory, description, unit, net_cost_chf (or list_price_chf
                        + discount_pct), install_code, source_type
    productivity_csv    install_code, work_type, unit, base_hours_per_unit, labour_role,
                        default_hourly_rate_chf, factor_keys
    params_json         project_parameters.json (allowances, project_costs, commercial, productivity_factors,
                        stretch_bid_optimization)
Outputs (in out_dir):
    lv_positions.csv     every row: LV id, system, page, category, description, quantity, product, status,
                         flag, reason, firm price, side estimate, parsed sizes, traceability
    priced_output.json   the same rows in the organisers' JSON schema + summaries and bid range
"""
from __future__ import annotations
import json, os
from pathlib import Path

import pandas as pd

from build_positions import build
from estimate import make_ref
from output_json import priced_output, write

ROOT = Path(__file__).resolve().parent.parent

REQUIRED = {
    "catalog": {"product_id", "category", "subcategory", "description", "unit", "install_code", "source_type"},
    "productivity": {"install_code", "unit", "base_hours_per_unit", "default_hourly_rate_chf", "factor_keys"},
    "params": {"allowances", "project_costs", "commercial"},
}


class InputError(ValueError):
    """An uploaded file is missing or does not have the expected columns / keys."""


def check_inputs(catalog: pd.DataFrame, productivity: pd.DataFrame, params: dict) -> None:
    """Clear message for the frontend when an uploaded file is not what we expect."""
    cat = set(catalog.columns)
    miss = sorted(REQUIRED["catalog"] - cat) + ([] if {"net_cost_chf", "list_price_chf"} & cat else ["net_cost_chf"])
    if miss:
        raise InputError(f"catalog: missing columns {miss}")
    miss = sorted(REQUIRED["productivity"] - set(productivity.columns))
    if miss:
        raise InputError(f"productivity: missing columns {miss}")
    miss = sorted(REQUIRED["params"] - set(params))
    if miss:
        raise InputError(f"project parameters: missing keys {miss}")


def _load(path, kind):
    try:
        if kind == "params":
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        return pd.read_csv(path)
    except Exception as e:
        raise InputError(f"{kind}: could not read {Path(path).name} ({type(e).__name__}: {e})")


def llm_default() -> bool:
    """The LLM is on unless BIDWISE_LLM=off (environment or .env)."""
    from llm_understand import load_env
    load_env()
    return os.environ.get("BIDWISE_LLM", "on").strip().lower() not in ("off", "0", "false", "no")


def run(tender_pdf, catalog_csv, productivity_csv=None, params_json=None, out_dir="out",
        trade: str | None = None, llm=None) -> dict:
    """llm None -> default (on). True: the LLM reads the page images and writes category, subcategory and
    description of every row; vocab.py only for rows the LLM could not answer. False: vocab.py only."""
    if llm is None:
        llm = llm_default()
    tender_pdf = Path(tender_pdf)
    if not tender_pdf.exists():
        raise InputError(f"tender PDF not found: {tender_pdf}")
    cat = _load(catalog_csv, "catalog")
    prod = _load(productivity_csv if productivity_csv is not None else ROOT / "data/productivity.csv", "productivity")
    par = _load(params_json if params_json is not None else ROOT / "data/project_parameters.json", "params")
    check_inputs(cat, prod, par)
    ref = make_ref(cat, prod, par)

    df, report = build(tender_pdf, cat, trade, prod, par, llm=llm)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    csv_path = out / "lv_positions.csv"
    df.to_csv(csv_path, index=False, encoding="utf-8")

    tender = {"trade": report["trade"], "pages": report["pages"], "positions": report["positions"],
              "systems": [{"name": n, "first_page": p[0], "last_page": p[1]} for n, p in report["systems"].items()],
              "layout_confidence": report["layout"].get("confidence")}
    name = lambda p: Path(p).name if p is not None else "data/ default"
    inputs = {"tender": tender_pdf.name, "catalog": name(catalog_csv),
              "productivity": name(productivity_csv), "project_parameters": name(params_json)}
    result = priced_output(df, ref, tender_pdf.name, tender=tender, inputs=inputs,
                           understanding=report.get("understanding"))
    json_path = out / "priced_output.json"
    write(result, json_path)
    return {"lv_positions_csv": csv_path, "priced_output_json": json_path, "priced_output": result, "df": df}
