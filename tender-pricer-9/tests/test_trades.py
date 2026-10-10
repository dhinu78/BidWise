"""3 trades: vocabulary, translation, catalogue matching and golden-style LV ids."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src")); sys.path.insert(0, str(ROOT / "tests"))
import pandas as pd
import pytest
from normalize import classify, parse_size, english_attributes
from build_positions import build, attach_golden, EXAMPLE_COLS
from make_trades import make

PHRASES = [  # (German, trade, category, subcategory)
    ("Zuluft - Tellerventil aus Kunststoff", "ventilation", "Air terminal", "Supply valve"),
    ("Spiro Rohr Ø 250 mm", "ventilation", "Ductwork", "Duct"),
    ("Brandschutzdämmungen EI30", "ventilation", "Insulation", "Fire insulation"),
    ("Wärmepumpe Luft/Wasser 45 kW", "heating", "Heat generation", "Heat pump"),
    ("Umwälzpumpe Heizgruppe", "heating", "Pumps", "Circulation pump"),
    ("Heizgruppe gemischt", "heating", "Heat distribution", "Manifold"),
    ("Thermostatventil gerade", "heating", "Heat emitters", "Radiator valve"),
    ("Plattenheizkörper Typ 22", "heating", "Heat emitters", "Radiator"),
    ("Stahlrohr 1 1/4\"", "heating", "Pipework", "Steel pipe"),
    ("Kugelhahn DN 25", "heating", "Valves", "Shut-off valve"),
    ("Rohrisolation 30 mm", "heating", "Insulation", "Pipe insulation"),
    ("Wand-WC Keramik", "sanitary", "Sanitary fixtures", "WC"),
    ("Einhebelmischer Waschtisch", "sanitary", "Tapware", "Mixer tap"),
    ("Selbstschlussarmatur Urinal", "sanitary", "Tapware", "Mixer tap"),
    ("Urinal mit Spülauslösung", "sanitary", "Sanitary fixtures", "Urinal"),
    ("Verteilbatterie Kaltwasser", "sanitary", "Water supply", "Distribution manifold"),
    ("Fallleitung PE d 110", "sanitary", "Pipework", "Drainage pipe"),
    ("Brandschutzmanschette d 110", "sanitary", "Fire protection", "Fire collar"),
    ("Wassererwärmer 500 Liter", "sanitary", "Water heating", "Water heater"),
    ("Druckprobe", "sanitary", "Service", "Pressure test"),
]


@pytest.mark.parametrize("text,trade,cat,sub", PHRASES)
def test_vocabulary(text, trade, cat, sub):
    assert classify(text, trade)[:2] == (cat, sub)


def test_pipe_sizes_and_translation():
    assert parse_size('Stahlrohr 1 1/4"', None, "heating")["dn_mm"] == 32
    assert parse_size("Inox 28 x 1.2 mm", None, "sanitary")["dn_mm"] == 28
    assert parse_size("PE d 110", None, "sanitary")["dn_mm"] == 110
    assert parse_size("Ø 10 cm", None, "ventilation")["dn_mm"] == 100
    assert english_attributes("Zuluft - Tellerventil aus Kunststoff, mit Luftmengeneinstellung") == \
        ["plastic", "airflow adjustable"]
    assert "air-to-water" in english_attributes("Wärmepumpe Luft/Wasser 45 kW")


@pytest.mark.parametrize("which,n_matched", [("heating", 7), ("sanitary", 8)])
def test_synthetic_trade_tenders(tmp_path, which, n_matched):
    pdf, cat = make(tmp_path, which)
    df, rep = build(pdf, catalog_csv=cat)
    assert rep["trade"] == which
    assert (df.category != "Other").all()
    matched = df[df.suggested_product_id.notna()]
    assert len(matched) == n_matched
    ordered = df.sort_values("lv_id")                                   # every row numbered in page order
    assert list(ordered.lv_id) == [f"LV{i:04d}" for i in range(1, len(df) + 1)]
    assert ordered.source_page.is_monotonic_increasing
    for pid in matched.suggested_product_id:
        assert pid in set(pd.read_csv(cat).product_id)
    if which == "heating":
        assert df.set_index("row_id").loc["242.101", "suggested_product_id"] == "H-HP-45"    # 45 kW, not 60
        assert df.set_index("row_id").loc["243.103", "suggested_product_id"] == "H-PIPE-ST-25"
    else:
        assert df.set_index("row_id").loc["254.101", "suggested_product_id"] == "S-PE-110"   # d110, not d125
        assert df.set_index("row_id").loc["254.104", "status"] == "supplier_quote_required"


def test_ventilation_reproduces_all_22_reference_products():
    df, rep = build(ROOT / "data/BKP_244_LV_Lueftung_260804.pdf")
    assert rep["trade"] == "ventilation"
    df = attach_golden(df, ROOT / "data/example_lv_positions.csv")
    ref = pd.read_csv(ROOT / "data/example_lv_positions.csv").set_index("lv_id")
    got = df[df.reference_lv_id.notna()].set_index("reference_lv_id")
    assert len(got) == 22
    for lv, r in got.iterrows():
        assert r.suggested_product_id == ref.loc[lv, "suggested_product_id"], lv
        assert r.status == ref.loc[lv, "ground_truth_status"], lv
        assert r.expected_install_code == ref.loc[lv, "expected_install_code"], lv
        assert isinstance(r.lv_id, str) and r.lv_id.startswith("LV")         # we numbered it too
    # our numbering keeps the reference order (both ascend by page)
    order = got.sort_index().lv_id.tolist()
    assert order == sorted(order)


def test_cli_writes_only_the_two_outputs(tmp_path):
    import subprocess
    subprocess.run([sys.executable, str(ROOT / "src/build_positions.py"), "--out", str(tmp_path)],
                   check=True, capture_output=True)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["lv_positions.csv", "priced_output.json"]
    csv = pd.read_csv(tmp_path / "lv_positions.csv")
    assert list(csv.columns[:12]) == EXAMPLE_COLS                       # the example file's columns first
    assert list(csv.columns[12:15]) == ["price_flag", "status_reason", "price_source"]
    assert csv.lv_id.is_unique and csv.lv_id.iloc[0] == "LV0001" and csv.source_page.is_monotonic_increasing


# ---------------------------------------------------------------- six statuses: firm price, or flag + side estimate
@pytest.fixture(scope="module")
def vent():
    return build(ROOT / "data/BKP_244_LV_Lueftung_260804.pdf")


def test_six_statuses_cover_every_row(vent):
    from status import STATUSES
    df, rep = vent
    assert set(df.status) == set(STATUSES)                                   # all six occur in Oberglatt
    assert df.status.notna().all() and df.status_reason.notna().all()       # every row gets an outcome + why
    assert set(df[df.quantity.isna()].status) == {"insufficient_information"}
    assert set(df[df.quantity.isna()].price_flag) == {"no_quantity"}
    assert rep["pricing"]["by_status"] == df.status.value_counts().reindex(STATUSES, fill_value=0).to_dict()


def test_each_status_on_a_real_row(vent):
    df, _ = vent
    one = lambda m: df[m].iloc[0]
    r = one((df.source_page == 78) & (df.dn_mm == 100) & df.description.str.startswith("Supply air valve"))
    assert (r.status, r.price_flag) == ("calculated", "catalogue")
    r = one(df.suggested_product_id == "P-SIL-001")
    assert (r.status, r.price_flag) == ("supplier_quote_required", "supplier_package")
    r = one(df.subcategory == "Weather louvre")
    assert (r.status, r.price_flag) == ("supplier_quote_required", "not_in_catalogue")
    r = one((df.source_page == 79) & (df.dn_mm == 125) & df.description.str.startswith("Exhaust air valve"))
    assert (r.status, r.price_flag) == ("assumption_applied", "size_scaled") and "+25" in r.status_reason
    r = one((df.unit == "h") & (df.subcategory == "Labour"))
    assert (r.status, r.price_flag) == ("assumption_applied", "labour_rate")
    r = one(df.match_type == "ambiguous")
    assert (r.status, r.price_flag) == ("review_required", "ambiguous_match")
    r = one(df.match_type == "size_unknown")
    assert (r.status, r.price_flag) == ("insufficient_information", "no_size")
    r = one(df.subcategory == "AHU section")
    assert (r.status, r.price_flag) == ("out_of_scope", "part_of_package")
    for sub in ("Transport", "Commissioning", "Labelling"):
        r = one(df.subcategory == sub)
        assert (r.status, r.price_flag) == ("out_of_scope", "covered_by_project_costs"), sub
    # out of scope rows carry no price at all: no double counting with the package or project costs
    oos = df[df.status == "out_of_scope"]
    assert oos.direct_cost_chf.isna().all() and oos.est_direct_cost_chf.isna().all()


def test_status_rules_in_order():
    from status import decide
    P = {"allowances": {"transport_equipment_pct": 2.5}, "project_costs": {}}
    base = {"quantity": 3.0, "unit": "pc", "category": "Damper", "subcategory": "Damper"}
    s = lambda **k: decide({**base, **k}, P)[:2]
    assert s(quantity=None) == ("insufficient_information", "no_quantity")
    assert s(match_type="part_of_package") == ("out_of_scope", "part_of_package")
    assert s(suggested_product_id="X", match_type="exact", price_source="catalog") == ("calculated", "catalogue")
    assert s(suggested_product_id="X", price_source="supplier_package") == ("supplier_quote_required", "supplier_package")
    assert s(category="Service", subcategory="Transport") == ("out_of_scope", "covered_by_project_costs")
    assert s(category="Service", subcategory="Documentation") == ("review_required", "needs_review")  # not in P
    assert s(match_type="ambiguous") == ("review_required", "ambiguous_match")
    assert s(category=None) == ("review_required", "unclassified")
    assert s(match_type="size_unknown") == ("insufficient_information", "no_size")
    assert s(match_type="size_not_in_catalogue", est_method="scaled by size difference",
             est_size_diff_pct=25.0) == ("assumption_applied", "size_scaled")
    assert s(match_type="size_not_in_catalogue", est_method=None) == ("supplier_quote_required", "not_in_catalogue")
    assert s(match_type="not_in_catalogue", est_method="category median") == ("supplier_quote_required", "not_in_catalogue")
    assert s(category="Service", subcategory="Labour", unit="h", est_method="labour only") == \
        ("assumption_applied", "labour_rate")


def test_firm_rows_have_catalogue_product_and_price(vent):
    df, _ = vent
    firm = df[df.suggested_product_id.notna() & df.quantity.notna()]
    assert set(firm.match_type) <= {"exact", "sized", "unsized"}
    assert firm.direct_cost_chf.notna().all() and firm.est_direct_cost_chf.isna().all()
    assert set(firm.price_source) <= {"catalog", "supplier_package"}
    assert df.lv_id.notna().all() and df.lv_id.is_unique          # every row has its own LV id


def test_firm_prices_equal_golden_calculation(vent):
    import json
    df, _ = vent
    df = attach_golden(df, ROOT / "data/example_lv_positions.csv")
    gold = {g["lv_id"]: g for g in json.load(open(ROOT / "data/expected_output_example.json"))["position_results"]}
    for _, r in df[df.reference_lv_id.notna()].iterrows():
        assert abs(r.direct_cost_chf - gold[r.reference_lv_id]["direct_position_cost_chf"]) < 0.02, r.reference_lv_id


def test_size_not_in_catalogue_gets_assumption_and_side_estimate(vent):
    df, _ = vent
    r = df[(df.source_page == 79) & (df.description.str.startswith("Exhaust air valve")) & (df.dn_mm == 125)].iloc[0]
    assert pd.isna(r.suggested_product_id) and r.price_source == "estimate"
    assert r.status == "assumption_applied" and r.price_flag == "size_scaled"
    assert r.match_type == "size_not_in_catalogue" and r.estimate_product_id == "P-AIR-003"
    assert abs(r.est_unit_cost_chf - 72.16 * 1.25) < 0.01               # DN100 -> DN125 scaled
    assert r.est_low_chf < r.est_direct_cost_chf < r.est_high_chf
    assert pd.isna(r.direct_cost_chf)                                    # never mixed into firm price


def test_labour_units_respected(vent):
    df, _ = vent
    hours = df[(df.unit == "h") & df.est_direct_cost_chf.notna()]
    assert len(hours) and (hours.est_basis.str.contains(" h x ")).all()  # hours rows = qty x rate
    rails = df[(df.unit == "m") & (df.category == "Support")]
    assert not rails.est_basis.fillna("").str.contains("SUPPORT_SET").any()   # per-piece rule not per metre


def test_report_separates_firm_and_estimate(vent):
    _, rep = vent
    p = rep["pricing"]
    assert p["firm_direct_cost_chf"] > 0 and p["estimated_direct_cost_chf"] > 0
    lo, hi = p["estimated_range_chf"]
    assert lo < p["estimated_direct_cost_chf"] < hi
    assert abs(p["indicative_direct_total_chf"] - p["firm_direct_cost_chf"] - p["estimated_direct_cost_chf"]) < 0.05


def _row(df, page, starts, **kw):
    m = df[(df.source_page == page) & df.description.str.startswith(starts)]
    for k, v in kw.items():
        m = m[m[k] == v]
    return m.iloc[0]


def test_estimate_follows_catalogue_price_curve(vent):
    df, _ = vent
    r = _row(df, 105, "Supply air valve", dn_mm=160)          # catalogue: DN100 = 74.80, DN125 = 86.24
    assert r.est_method == "catalogue price curve"
    assert abs(r.est_unit_cost_chf - (86.24 + 35 * (86.24 - 74.80) / 25)) < 0.01      # 102.26
    assert r.est_size_diff_pct == 28.0


def test_estimate_scales_with_size_difference(vent):
    df, _ = vent
    r = _row(df, 79, "Exhaust air valve", dn_mm=125)           # only DN100 exists
    assert r.est_method == "scaled by size difference" and r.est_size_diff_pct == 25.0
    assert abs(r.est_unit_cost_chf - 72.16 * 1.25) < 0.01


def test_equivalent_diameter_for_rectangular_vs_round(vent):
    df, _ = vent
    r = _row(df, 80, "Air grille")
    assert "equivalent diameter" in r.est_requested_size


def test_range_grows_with_size_difference(vent):
    df, _ = vent
    e = df[df.est_size_diff_pct.notna()]
    small = e[e.est_size_diff_pct.abs() < 15].est_range_pct
    big = e[e.est_size_diff_pct.abs() > 50].est_range_pct
    assert len(small) and len(big) and small.max() < big.min()
