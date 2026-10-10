import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import pandas as pd
from pricing import Ref, price_position, subset_summary, bid_scenarios

ref = Ref.load()
gold = json.load(open(ROOT / "data/expected_output_example.json"))
ex = pd.read_csv(ROOT / "data/example_lv_positions.csv").set_index("lv_id")
FIELDS = ["net_unit_cost_chf", "material_cost_chf", "adjusted_install_hours",
          "labour_cost_chf", "direct_position_cost_chf"]


def _results():
    return [price_position(ref, g["lv_id"], ex.loc[g["lv_id"], "suggested_product_id"],
                           float(ex.loc[g["lv_id"], "quantity"]),
                           ex.loc[g["lv_id"], "expected_install_code"])
            for g in gold["position_results"]]


def test_positions():
    for r, g in zip(_results(), gold["position_results"]):
        for f in FIELDS:
            assert abs(getattr(r, f) - g[f]) <= 0.011, (g["lv_id"], f, getattr(r, f), g[f])
        assert r.status == g["status"], (g["lv_id"], r.status)
        assert r.price_source == g["price_source"]


def test_summary():
    s = subset_summary(ref, _results())
    for k, v in gold["example_subset_summary"].items():
        assert abs(s[k] - v) <= 0.05, (k, s[k], v)


def test_bid():
    base = gold["example_subset_summary"]["cost_baseline_chf"]
    for mine, g in zip(bid_scenarios(ref, base), gold["recommended_bid_range"]["scenarios"]):
        assert mine["bid_price_chf"] == g["bid_price_chf"]
        assert mine["estimated_win_probability"] == g["estimated_win_probability"]
        assert abs(mine["expected_contribution_chf"] - g["expected_contribution_chf"]) <= 1.0, (mine, g)
