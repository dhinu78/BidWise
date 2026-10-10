"""priced_output.json: every row, organisers' keys first; strict mode on the 22 reference rows IS their file."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import pandas as pd
import pytest

from build_positions import build, attach_golden
from estimate import make_ref
from output_json import priced_output, PRICE_SOURCES
from pipeline import run
from status import STATUSES

D = ROOT / "data"
GOLD = D / "expected_output_example.json"
GOLD_KEYS = list(json.loads(GOLD.read_text(encoding="utf-8"))["position_results"][0])


@pytest.fixture(scope="module")
def result(tmp_path_factory):
    out = tmp_path_factory.mktemp("job")
    return run(D / "BKP_244_LV_Lueftung_260804.pdf", D / "catalog.csv", D / "productivity.csv",
               D / "project_parameters.json", out)


def test_reference_subset_is_byte_identical():
    df, _ = build(D / "BKP_244_LV_Lueftung_260804.pdf")
    df = attach_golden(df, D / "example_lv_positions.csv")
    gold_txt = GOLD.read_text(encoding="utf-8")
    mine = priced_output(df, make_ref(D / "catalog.csv"), "BKP_244_LV_Lueftung_260804.pdf",
                         id_col="reference_lv_id", strict=True, scope=json.loads(gold_txt)["scope"])
    assert json.dumps(mine, indent=2, ensure_ascii=False) == gold_txt


def test_only_two_files(result):
    assert sorted(p.name for p in result["priced_output_json"].parent.iterdir()) == \
        ["lv_positions.csv", "priced_output.json"]


def test_every_row_is_in_the_json_with_a_unique_id(result):
    po = json.loads(result["priced_output_json"].read_text(encoding="utf-8"))
    csv = pd.read_csv(result["lv_positions_csv"])
    ids = [p["lv_id"] for p in po["position_results"]]
    assert len(ids) == len(csv) == 251 and len(set(ids)) == 251
    assert ids == sorted(ids) == list(csv.lv_id)
    for p in po["position_results"]:
        assert list(p)[:len(GOLD_KEYS)] == GOLD_KEYS                    # organisers' keys first, same order
        assert p["status"] in STATUSES and p["price_source"] in PRICE_SOURCES
        assert p["price_flag"] and p["status_reason"]
        assert p["review_required"] == (p["status"] != "calculated")
        if p["price_source"] in ("catalog", "supplier_package"):
            assert p["matched_product_id"] and p["estimate"] is None
            assert abs(p["material_cost_chf"] + p["labour_cost_chf"] - p["direct_position_cost_chf"]) <= 0.011
        elif p["price_source"] == "estimate":
            assert p["matched_product_id"] is None and p["estimate"]["method"]
            assert p["price_range_chf"]["low"] <= p["direct_position_cost_chf"] <= p["price_range_chf"]["high"]
        else:
            assert p["direct_position_cost_chf"] is None and p["price_range_chf"] is None
        if p["status"] == "out_of_scope":
            assert p["price_source"] == "none"                           # never counted twice


def test_summaries_add_up(result):
    po = result["priced_output"]
    pr, cs = po["position_results"], po["cost_summary"]
    assert sum(cs["by_status"].values()) == sum(cs["by_price_source"].values()) == len(pr)
    firm = [p for p in pr if p["price_source"] in ("catalog", "supplier_package")]
    est = [p for p in pr if p["price_source"] == "estimate"]
    assert cs["firm"]["rows"] == len(firm) == 69 and cs["estimated"]["rows"] == len(est)
    assert cs["firm"]["direct_cost_chf"] == po["example_subset_summary"]["direct_cost_chf"]
    assert abs(sum(p["direct_position_cost_chf"] for p in firm) - cs["firm"]["direct_cost_chf"]) < 0.5
    assert abs(sum(p["direct_position_cost_chf"] for p in est) - cs["estimated"]["direct_cost_chf"]) < 0.5
    assert [s["scenario"] for s in po["recommended_bid_range"]["scenarios"]] == ["Aggressive", "Target", "Conservative"]
    assert po["tender"]["trade"] == "ventilation" and len(po["tender"]["systems"]) == 6


def test_reference_rows_keep_their_exact_prices(result):
    """the 22 reference positions sit inside the full JSON with the organisers' numbers"""
    df = attach_golden(result["df"].copy(), D / "example_lv_positions.csv")
    ours = {p["lv_id"]: p for p in result["priced_output"]["position_results"]}
    gold = {g["lv_id"]: g for g in json.loads(GOLD.read_text(encoding="utf-8"))["position_results"]}
    for _, r in df[df.reference_lv_id.notna()].iterrows():
        o, g = ours[r.lv_id], gold[r.reference_lv_id]
        for k in GOLD_KEYS[2:]:                                          # everything except the id itself
            assert o[k] == g[k], (r.reference_lv_id, k, o[k], g[k])
