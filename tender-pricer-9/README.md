# Bidwise

Tender PDF + catalogue + productivity rules (+ project parameters) → every LV position extracted, matched,
priced and given one of six outcomes, traceable to its page.

## Inputs (uploaded by the frontend)

| Input | Required | Columns / keys |
|---|---|---|
| Tender PDF | yes | the LV (Leistungsverzeichnis) |
| `catalog.csv` | yes | product_id, category, subcategory, description, unit, install_code, source_type, net_cost_chf (or list_price_chf + discount_pct) |
| `productivity.csv` | yes | install_code, unit, base_hours_per_unit, default_hourly_rate_chf, factor_keys (labour_role optional) |
| `project_parameters.json` | no, default `data/` | allowances, project_costs, commercial, productivity_factors, stretch_bid_optimization |

Nothing is hardcoded to Oberglatt: every price, hour, factor and margin comes from these files.
A factor key missing from the parameters counts as 1.0.

## Outputs (exactly two files)

| File | Contents |
|---|---|
| `lv_positions.csv` | Every row with a unique `lv_id` (LV0001… by page, then position on the page). The 12 columns of `example_lv_positions.csv` first, then `price_flag`, `status_reason`, `price_source`, firm price, side estimate, sizes, traceability |
| `priced_output.json` | The same rows in the schema of `expected_output_example.json` (their keys first, same order) plus flag, reason, range, estimate details; `cost_summary` and the bid range |

`price_source`: `catalog` / `supplier_package` (firm) · `estimate` (side estimate with low/high) · `none` (not priced).

## Run

```bash
pip install -r requirements.txt

# 1) API for the frontend
uvicorn api:app --app-dir src --reload --port 8000          # docs: http://localhost:8000/docs
#    POST /price  (multipart: tender, catalog, productivity, [parameters], [trade])
#      -> {"job_id", "downloads": {...}, "priced_output": {...}}
#    GET  /jobs/{job_id}/lv_positions.csv | priced_output.json

# 2) Command line, same pipeline
python src/build_positions.py tender.pdf --catalog catalog.csv --productivity productivity.csv \
       --params project_parameters.json --out out/job1
python src/build_positions.py                                # Oberglatt with the files in data/

# 3) From Python
from pipeline import run
run("tender.pdf", "catalog.csv", "productivity.csv", "project_parameters.json", out_dir="out/job1")

python -m pytest -q tests                                    # 68 tests
```

### priced_output.json

| Key | Contents |
|---|---|
| `inputs`, `tender` | File names used; trade, pages, systems with page ranges |
| `position_results[]` | lv_id, source_page, matched_product_id, install_code, quantity, unit, net_unit_cost_chf, material_cost_chf, adjusted_install_hours, labour_cost_chf, direct_position_cost_chf, price_source, match_confidence, review_required, status (organisers' keys) + price_flag, status_reason, price_range_chf, row_id, system, chapter, category, subcategory, description, description_de, estimate, alternatives, bbox |
| `example_subset_summary` | Firm rows only, organisers' formula: direct × (1 + transport) × (1 + overhead) |
| `cost_summary` | Counts by status and price source; firm; estimated (low/high); indicative total (firm + estimated) |
| `recommended_bid_range` | Aggressive / Target / Conservative on the firm baseline |

On the 22 reference rows `output_json.priced_output(..., strict=True)` is byte-identical to
`expected_output_example.json`, and inside the full file those rows carry exactly the organisers' numbers.

## The LLM reads the page images (default)

**By default** the LLM (OpenAI `gpt-5-mini`, or Anthropic) **looks at every tender page as an image** and writes
the category, subcategory and English description of each row. `vocab.py` is only used for rows the LLM could
not answer, or when you ask for it: `--no-llm` (CLI), `llm=false` (API) or `BIDWISE_LLM=off` (.env).
Every row says who wrote its description: `description_source` = `llm_vision` or `rules`.

| Step | Who |
|---|---|
| Rows, quantities, units, pages, positions on the page | PyMuPDF (exact, unchanged) |
| Page image with a red box + label (R1, R2 …) on every row | `llm_understand.render_page` |
| Category, subcategory, English description, material, features, sizes, fire class, evidence | LLM, one call per page, strict JSON schema |
| Quantity + unit read from the image | LLM, used **only as a check** |
| Matching, prices, statuses | code |

| No loss of data | How |
|---|---|
| Rows can't appear or vanish | labels are a JSON schema `enum`; answers map back by label; missing → fallback |
| Quantities never from the LLM | PyMuPDF's numbers are kept |
| Misread or missed quantity | image ≠ PDF text (number or unit), or image shows a quantity the text lacks → `review_required`, flag `quantity_check` |
| Sizes | regex parser wins; LLM only fills gaps (`parse_notes`: "size from LLM") |
| LLM unreachable | rows fall back to `vocab.py` (`llm_check = fallback`) |
| Repeatable | answers cached in `cache/llm_cache.json`; re-runs make no API calls |
| Privacy | page images + labels only; no prices, costs or margins |

**vocab.py learns.** Every confident reading (confidence ≥ 0.8, quantity check passed) is written to
`vocab_learned.json` (title phrase + evidence keywords → category, subcategory, English name, install code).
`vocab.classify()` checks it before the hand-written rules, so offline runs reuse what the LLM taught it.

| Variable | Default | Meaning |
|---|---|---|
| `BIDWISE_LLM` | `on` | `off` = vocab.py rules only (offline) |
| `BIDWISE_PROVIDER` | `openai` | `openai` or `anthropic` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | | key for that provider |
| `BIDWISE_MODEL` | `gpt-5-mini` / `claude-haiku-5-5` | must accept images and structured outputs |
| `BIDWISE_REASONING` | model default | OpenAI gpt-5 models: `minimal`, `low`, `medium`, `high` |
| `BIDWISE_DPI` | `130` | page image resolution |
| `BIDWISE_LEARNED` | `vocab_learned.json` | where the learned vocabulary lives |

New columns: `description_source` (llm_vision / rules), `llm_check` (ok / quantity_mismatch / fallback),
`llm_confidence`, `llm_evidence`, `llm_quantity_seen`, `llm_unit_seen`, `rules_category`, `rules_subcategory`,
`rules_description`, `context_de`, `title_de`.

## Three trades (ventilation, heating, sanitary)

```bash
python src/build_positions.py tender.pdf --catalog catalog.csv            # trade detected automatically
python src/build_positions.py tender.pdf --catalog catalog.csv --trade heating   # or force it
```

| Step | File | What happens |
|---|---|---|
| Trade | `normalize.detect_trade` | BKP 244/245 → ventilation, 242/243 → heating, 25x → sanitary; keyword counts as fallback |
| Category | `vocab.py` RULES | Own trade's rules first (incl. shared), then the other trades; first keyword match wins |
| English | `vocab.ATTRIBUTES` | Name + material + features + kW / litres / PN + size: "Supply air valve, plastic, airflow adjustable, DN100" |
| Sizes | `normalize.parse_size` | Ø/cm (ventilation), DN, inches (1 1/4" → DN32), d110, 28 x 1.2 mm, W x H x L, kW, litres, airflow, angle |
| Match | `matcher.py` | Category (+ aliases) and unit → name decides the type → size picks the variant → no match if ambiguous |
| LV ids | `matcher.assign_lv_ids` | Every row gets LV0001… by page, then position on the page |
| Prices | `estimate.py` | Firm price for catalogue matches; separate side estimate (with low/high) for everything else |

### Six statuses (slide 11: "every relevant position gets a clear outcome")

Decided in `src/status.py`, rules checked top to bottom, first hit wins. `price_flag` says which rule fired,
`status_reason` says it in a sentence (with product id, size difference or project cost item).

| # | Rule | `status` | `price_flag` | Price |
|---|---|---|---|---|
| 1 | No quantity printed | `insufficient_information` | `no_quantity` | none |
| 2 | Component of a unit priced as one package (AHU sections) | `out_of_scope` | `part_of_package` | none (in the package) |
| 3 | Catalogue product, supplier package | `supplier_quote_required` | `supplier_package` | firm (budget price), conf. 0.72 |
| 4 | Catalogue product: exact size, generic product, sized up by airflow / kW / litres | `calculated` | `catalogue` | firm, conf. 0.92 |
| 5 | Service already carried once in `project_parameters.json` (transport, commissioning, testing, documentation, labelling ...) | `out_of_scope` | `covered_by_project_costs` | none (project level) |
| 6 | Several catalogue products fit equally | `review_required` | `ambiguous_match` | side estimate |
| 7 | Position could not be classified | `review_required` | `unclassified` | none |
| 8 | Product type known, tender gives no size | `insufficient_information` | `no_size` | side estimate ±30 % |
| 9 | Size not in catalogue, price scaled from the same product type | `assumption_applied` | `size_scaled` | side estimate |
| 10 | Hours (daywork) priced at the productivity hourly rate | `assumption_applied` | `labour_rate` | side estimate |
| 11 | Other service without project cost item or rule | `review_required` | `needs_review` | none |
| 12 | Product type not in catalogue (or size could not be scaled) | `supplier_quote_required` | `not_in_catalogue` | side estimate (category median ±50 %) |

A project cost item only counts if it exists in that tender's `project_parameters.json`; otherwise the row
falls through to `review_required`. Out of scope rows get no price at all, so nothing is counted twice.

Oberglatt: calculated 56, supplier quote 65, assumption 49, review 34, insufficient information 12, out of scope 35.

### Side estimate (never mixed into the firm price)

| `est_method` | How | Range |
|---|---|---|
| catalogue price curve | 2+ sizes of the same product: inter/extrapolate the catalogue's own price per size | 10 % + half the gap to the nearest size |
| scaled by size difference | 1 size: price × (requested / catalogue size)^k; k = 1 for DN, W+H, (W+H)×L, thickness; 0.7 for m³/h, kW, litres | 10 % + half the size difference |
| same type, size unknown | row has no size: price of the same product type | ±30 % |
| category median | no product of that type: median of the category | ±50 % |
| labour only | rows in hours, or services with a productivity rule | ±30 % |

Rectangular vs round is compared via the equivalent diameter 1.30·(a·b)^0.625/(a+b)^0.25. Columns:
`est_method, est_basis, est_reference_size, est_requested_size, est_size_diff_pct, est_unit_cost_chf,
est_material_chf, est_labour_chf, est_direct_cost_chf, est_range_pct, est_low_chf, est_high_chf`.
`priced_output.json → cost_summary` shows firm total, estimated total + range and the indicative sum separately.

Validation on the Oberglatt tender (judges' file used only to check): all 22 reference rows get the same
product, status and install code. Synthetic heating and sanitary tenders: `tests/make_trades.py`.

## Pipeline

| Step | File | Tender specific? |
|---|---|---|
| 1. Learn layout: unit and quantity columns, header/footer, title style, page kinds, systems | `src/layout.py` | No, measured from the PDF |
| 2. Cut pages into position blocks and quantity rows | `src/extract.py` | No |
| 3. Category, English description, size, hints, install code | `src/normalize.py` + `src/vocab.py`, optionally `src/llm_understand.py` (LLM) | Only the vocabulary |
| 4. Match catalogue products, LV ids | `src/matcher.py` | No |
| 4b. Six statuses | `src/status.py` | No (project cost items read from the parameters) |
| 5. Firm prices + side estimates | `src/estimate.py` (uses `src/pricing.py`) | No |
| 6. Project summaries, bid scenarios | `src/pricing.py` | No |
| 7. Priced JSON in the organisers' schema | `src/output_json.py` | No |
| 8. Inputs in, two files out | `src/pipeline.py` (`run`), `src/api.py` (HTTP) | No |

## Output columns

`lv_positions.csv` (all rows): the 12 example columns first, then

| Column | Meaning |
|---|---|
| `row_id` | Every row: the tender's own position number (e.g. `111.101`) or `<system>-<chapter>-<n>` (e.g. `244.01-C-006`) |
| `lv_id` | Every row, unique: `LV0001…` ascending by page, then position on the page |
| `status` | calculated / supplier_quote_required / assumption_applied / review_required / insufficient_information / out_of_scope |
| `status_reason` | One sentence: why this status (product id, size difference, project cost item ...) |
| `price_flag` | Which rule fired: catalogue / supplier_package / size_scaled / labour_rate / not_in_catalogue / ambiguous_match / unclassified / needs_review / no_size / no_quantity / part_of_package / covered_by_project_costs |
| `unit_cost_chf`, `material_chf`, `labour_hours`, `labour_chf`, `direct_cost_chf` | Firm price (catalogue matches only) |
| `estimate_product_id`, `est_method`, `est_basis`, `est_reference_size`, `est_requested_size`, `est_size_diff_pct`, `est_unit_cost_chf`, `est_material_chf`, `est_labour_chf`, `est_direct_cost_chf`, `est_range_pct`, `est_low_chf`, `est_high_chf` | Side estimate (everything else) |
| `trade`, `subcategory`, `air_side`, `shape`, `dn_mm`, `width_mm`, `height_mm`, `length_mm`, `insulation_thickness_mm`, `airflow_m3h`, `power_kw`, `volume_l`, `angle_deg`, `fire_class` | Parsed attributes |
| `match_type`, `match_confidence`, `match_reason`, `alternatives`, `price_source` | How the product was chosen |
| `chapter`, `position_no`, `description_de`, `block_id`, `block_pages`, `bbox`, `parse_notes` | Traceability to the PDF |


## Tests

| File | Checks |
|---|---|
| `tests/test_golden.py` | Pricing formulas reproduce `expected_output_example.json` |
| `tests/test_output_json.py` | Reference subset byte-identical; all 251 rows in the JSON with unique ids, status, source; summaries add up; only two output files |
| `tests/test_llm.py` | Vision LLM step with a fake client: page images + labels, OpenAI and Anthropic shapes, no prices sent, nothing lost, quantity check → review, fallback, cache, vocab learning works offline |
| `tests/test_api.py` | Upload → JSON + downloads; optional parameters; clear 400 for bad files |
| `tests/test_extract.py` | Systems, chapters, every printed quantity captured, other layouts |
| `tests/test_trades.py` | 3-trade vocabulary, pipe sizes, translation, synthetic heating/sanitary tenders, 22 reference products, output format, six statuses (rule by rule and one real row each) |
