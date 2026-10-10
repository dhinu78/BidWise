# BIDWISE Estimation Tool

From tender to first price: the user uploads a tender PDF, a product catalogue (`catalog.csv`) and
installation productivity rules (`productivity.csv`), clicks **Compute**, and gets a reviewable
price with a **Recommended Bid Range**.

```
 Browser app (GitHub Pages, this docs/ folder)               Estimation backend (separate)
 ┌──────────────────────────────────────────┐   POST files   ┌──────────────────────────────┐
 │ sign-in, projects, versions, file storage │ ─────────────► │ reads the PDF, matches,      │
 │ (Firebase: frontend only)                 │ ◄───────────── │ prices, builds the bid range │
 │ dashboard, detailed summary, parameters   │  parameters +  │ (no Firebase, no database)   │
 └──────────────────────────────────────────┘     output      └──────────────────────────────┘
```

The backend is a plain HTTP service: it receives files, computes, and answers with JSON. It never
talks to Firebase and needs no login, database or storage of its own; everything is kept by the
frontend.

---

# Part 1 – For the backend developer

## What happens when the user clicks Compute

1. The browser sends **one POST** with five parts: the tender PDF, the two CSV files, the project
   parameters and some metadata.
2. The backend either answers right away with the result (**200**), or accepts the job (**202**)
   and the browser asks for the status every 2 seconds (**GET**) until it is done.
3. The result has two parts:
   - `parameters` – the updated `project_parameters.json`. It replaces the project's parameters, so
     the **Edit parameters** page shows exactly these values.
   - `output` – the output file. The dashboard and the **Detailed summary** show it exactly as
     returned; the frontend does not recalculate anything.

```
Browser                                             Backend
   │  POST /v1/estimates  (5 parts, multipart)          │
   │ ─────────────────────────────────────────────────► │
   │  202 {"job_id": "7f3a…"}                           │  starts working
   │ ◄───────────────────────────────────────────────── │
   │  GET /v1/estimates/7f3a…            (every 2 s)    │
   │ ─────────────────────────────────────────────────► │
   │  200 {"status": "running", "progress": 0.4, …}     │
   │ ◄───────────────────────────────────────────────── │
   │  …                                                 │
   │  200 {"status": "done", "result": {"parameters": {…}, "output": {…}}}
   │ ◄───────────────────────────────────────────────── │
```

## Endpoint 1 – `POST /v1/estimates`

Content type `multipart/form-data`. **All five parts are sent as files** (each has a file name), so
read every part as an uploaded file:

| Part | File name sent | Content |
|---|---|---|
| `tender` | original name, e.g. `BKP_244_LV_Lueftung_260804.pdf` | the tender PDF |
| `catalog` | original name, e.g. `catalog.csv` | product catalogue (see "Input files") |
| `productivity` | original name, e.g. `productivity.csv` | installation rules |
| `parameters` | `project_parameters.json` | project parameters, JSON (see "Input files") |
| `meta` | `meta.json` | `{"project_id": "a1b2c3d4e5f6", "version": 3, "tender_file": "BKP_244_LV_Lueftung_260804.pdf"}` |

No authentication headers are sent.

**Answer – either:**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"parameters": { … }, "output": { … }}
```

finished within the request (fine for runs well under a minute), **or**

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"job_id": "7f3a9c"}
```

accepted; the browser then polls endpoint 2. **Use 202 when a run can take more than ~60 seconds**:
browsers, tunnels (ngrok, Cloudflare) and proxies cut long requests.

**Errors:** any 4xx/5xx with a JSON body `{"error": "what went wrong"}`. The text is shown to the
user, e.g. `Backend error 400: catalog.csv has no product_id column`.

## Endpoint 2 – `GET /v1/estimates/{job_id}`

Called every 2 seconds after a 202 until the status is `done` or `failed` (the browser gives up
after 20 minutes). Always answer **200** with:

| Field | When | Meaning |
|---|---|---|
| `status` | always | `"queued"`, `"running"`, `"done"` or `"failed"` |
| `progress` | optional | number 0…1, shown as a percentage |
| `message` | optional | short text shown under the spinner, e.g. `"Matching positions"` |
| `result` | when `done` | `{"parameters": {…}, "output": {…}}`, same as the 200 answer above |
| `error` | when `failed` | text shown to the user |

```json
{"status": "running", "progress": 0.4, "message": "Matching positions"}
{"status": "done", "progress": 1, "result": {"parameters": {"…": "…"}, "output": {"…": "…"}}}
{"status": "failed", "error": "Could not read page 17 of the PDF"}
```

Unknown `job_id` → `404 {"error": "Unknown job"}`.

## Input files

**`catalog.csv`** (comma-separated, UTF-8) – the frontend checks that these columns exist:
`product_id, category, subcategory, description, unit, net_cost_chf, install_code, source_type`.
The starter-package file also has `manufacturer, model, list_price_chf, discount_pct,
supplier_quote_required`.

**`productivity.csv`** – `install_code, work_type, unit, base_hours_per_unit, labour_role,
default_hourly_rate_chf, factor_keys` (`factor_keys` = factor names separated by `|`).

**`project_parameters.json`** – what the user set on the Edit parameters page:

```jsonc
{
  "schema_version": "3.0",
  "project": {"name": "Schulhaus Oberglatt", "id": "", "client": "", "currency": "CHF",
              "source_tender_file": "BKP_244_LV_Lueftung_260804.pdf"},
  "productivity_factors": {"site_efficiency": 1.0, "mounting_height_school": 1.0, "school_logistics": 1.0,
                           "timber_interface": 1.0},   // keys from productivity.csv factor_keys
  "allowances": {"material_waste_pct": 3.0, "small_material_pct": 3.0, "transport_equipment_pct": 2.0,
                 "supplier_package_contingency_pct": 3.0},
  "project_costs": {"engineering_hours": 0, "engineering_rate_chf_per_h": 145,
                    "commissioning_hours": 0, "commissioning_rate_chf_per_h": 155, "documentation_chf": 0},
  "commercial": {"overhead_pct": 8.5, "target_margin_pct": 5.0, "round_to_chf": 1000},
  "stretch_bid_optimization": {"enabled": true, "output_name": "Recommended Bid Range",
    "scenario_names": ["Aggressive", "Target", "Conservative"],
    "scenario_margins_pct": {"Aggressive": 2.5, "Target": 4.0, "Conservative": 6.5},
    "reference_win_probability": 0.5, "price_sensitivity_probability_points_per_1pct_price": 0.05,
    "strategic_appetite_adjustment": 0, "competition_adjustment": 0,
    "minimum_probability": 0.05, "maximum_probability": 0.95},
  "custom_parameters": ["allowances.risk_pct"],        // keys the user added themselves (optional)
  "position_overrides": {                               // the user's corrections per position
    "LV0013": {"product_id": "P-AIR-002", "quantity": 7, "unit_price_chf": 80.0,
               "price_source": "Quote Trox 12.10.2026", "status": "calculated", "note": "DN125 priced as supply valve"}
  }
}
```

`position_overrides` is keyed by the `lv_id` of the backend's previous output. Every field is
optional: `product_id` (a catalogue id, or `""` = no product), `quantity`, `unit_price_chf` (net
unit price to use, e.g. from a supplier quote: treat the position as a firm price), `price_source`,
`status`, `note`.
Please apply them, so the user's edits show up in the next output.

## The answer: `parameters`

- Return the **whole** parameters object (the one you received, with your changes). It replaces
  the project's parameters.
- Changed values are listed to the user after Compute ("overhead_pct 8.5 → 9.2") and in the
  Detailed summary.
- New keys are welcome. New sections (e.g. `"backend_info": {"model_version": "1.3"}`) get their own
  card on the Edit parameters page.
- If `position_overrides` or `custom_parameters` are missing, the frontend keeps the user's.
- Return `"parameters": null` (or leave it out) if you don't change anything.

## The answer: `output`

Same shape as the starter package's `expected_output_example.json`, with optional extras (all
present in `priced_output.json`). Required: `position_results`, `summary` (or
`example_subset_summary`) and `recommended_bid_range`.

```jsonc
{
  "position_results": [{
    "lv_id": "LV0001",                   // stable id; position_overrides use it
    "source_page": 78,                   // page in the PDF; the app links to it
    "matched_product_id": "P-AIR-001",   // catalog.csv product_id or null
    "install_code": "DIFFUSER",
    "quantity": 5.0, "unit": "pc",
    "net_unit_cost_chf": 74.8,
    "material_cost_chf": 388.96,
    "adjusted_install_hours": 4.35,
    "labour_cost_chf": 417.3,
    "direct_position_cost_chf": 806.26,
    "price_source": "catalog",           // catalog | supplier_package = firm price
                                         // estimate = side estimate | none = not priced
    "match_confidence": 0.92,            // 0…1; "calculated" ≥ 0.9 shows as Perfectly Matched
    "review_required": false,
    "status": "calculated"               // calculated | assumption_applied | supplier_quote_required |
                                         // review_required | insufficient_information | out_of_scope | non_priceable
  }],
  "summary": {                           // firm totals: shown on the dashboard, basis of the bids
    "material_cost_chf": 661369.03, "labour_cost_chf": 220779.3,
    "direct_cost_chf": 882148.33, "cost_baseline_chf": 981059.21
  },
  "recommended_bid_range": {
    "scenarios": [{"scenario": "Aggressive", "bid_price_chf": 1007000, "margin_pct": 2.5,
                   "estimated_win_probability": 0.7, "expected_contribution_chf": 18160.2}]
  }
}
```

Optional fields, shown when present:

| Field | Shown as |
|---|---|
| position `system`, `chapter`, `row_id` | System column and tooltips; systems table |
| position `description` (English), `description_de` (tender text), `category`, `subcategory` | Description and Tender text columns, Edit dialog |
| position `price_flag` + `status_reason` (or `match_note`) | Price flag and Reason columns; "Why positions are priced this way" card |
| position `price_range_chf: {"low", "high"}` + `estimate: {"method", "basis", "range_pct"}` | Estimate range column; method and basis on hover |
| position `alternatives: "P-AHU-3500,P-AHU-6200"` | Suggested alternatives in the Edit dialog |
| position `included_in_total` | Overrides the default (firm rows count, estimates and not-priced rows don't) |
| `cost_summary.estimated` `{rows, material_cost_chf, labour_cost_chf, direct_cost_chf, low_chf, high_chf}` | Estimated block (never mixed into firm totals) |
| `cost_summary.indicative_total` `{direct_cost_chf, direct_cost_low_chf, direct_cost_high_chf, cost_baseline_chf, cost_baseline_low_chf, cost_baseline_high_chf}` | Indicative total (firm + estimated) |
| `cost_summary.note` | Note under the cost build-up |
| `summary` detail lines: `catalog_material_chf`, `supplier_packages_chf`, `small_material_chf`, `supplier_contingency_chf`, `transport_equipment_chf`, `overhead_chf`, `project_costs: [{"label", "hours", "rate", "chf"}]` | Lines in the cost build-up |
| `recommended_bid_range.basis`, `reference_price_chf` | Under the bid table |
| `tender: {"pages", "trade", "layout_confidence", "systems": [{"name", "first_page", "last_page"}]}` | Header line (confidence < 80 % is highlighted); systems table |
| `warnings: ["…"]` | Shown to the user after Compute and on the Detailed summary |
| `engine: "estimator 1.3"` | Shown as the engine name |

Keep `firm` totals consistent: the sum of the firm rows' `direct_position_cost_chf` should equal
`summary.direct_cost_chf` (the table footer shows the row sum, the cards show the summary).

## Server requirements

- **CORS:** answer with `Access-Control-Allow-Origin` for `https://dhinu78.github.io` and
  `http://localhost:5500` (local testing). Both requests are plain (no custom headers), so no
  special preflight handling is needed beyond the usual framework CORS middleware.
- **HTTPS:** the app runs on https, so the backend must be reachable over **https**, except
  `http://localhost` while testing on the same PC. A tunnel (`ngrok http 8000`) or a server with a
  certificate (e.g. Caddy) provides that.
- **Uploads:** tender PDFs are a few MB up to ~50 MB; allow request bodies of at least 100 MB.
- **No storage needed:** delete the uploaded files after a run. Keeping jobs in memory is fine; if
  the backend restarts, the user simply clicks Compute again.
- **Access:** the endpoint has no login. Share the URL only with the app; add an API key later if needed.

## Minimal server around an existing script (Python, FastAPI)

```python
# api.py  —  pip install fastapi "uvicorn[standard]" python-multipart
# run:       uvicorn api:app --port 8000
import json, os, shutil, subprocess, sys, tempfile, uuid
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["https://dhinu78.github.io", "http://localhost:5500"],
                   allow_methods=["GET", "POST"])
pool = ThreadPoolExecutor(max_workers=1)
jobs = {}

@app.exception_handler(HTTPException)
def http_error(request, exc):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

@app.post("/v1/estimates", status_code=202)
def create(tender: UploadFile = File(...), catalog: UploadFile = File(...), productivity: UploadFile = File(...),
           parameters: UploadFile = File(...), meta: UploadFile = File(...)):
    work = tempfile.mkdtemp()
    for name, part in [("tender.pdf", tender), ("catalog.csv", catalog),
                       ("productivity.csv", productivity), ("project_parameters.json", parameters)]:
        with open(os.path.join(work, name), "wb") as f:
            shutil.copyfileobj(part.file, f)
    job_id = uuid.uuid4().hex
    jobs[job_id] = {"status": "queued", "progress": 0, "message": "Queued"}

    def run():
        job = jobs[job_id]
        job.update(status="running", message="Computing")
        try:
            # ↓ call the existing script the way it runs today (adjust name and arguments)
            subprocess.run([sys.executable, os.path.abspath("estimator.py"), "tender.pdf", "catalog.csv",
                            "productivity.csv", "project_parameters.json"],
                           cwd=work, check=True, capture_output=True, text=True, timeout=1800)
            # ↓ the two files the script writes (adjust names)
            params_out = json.load(open(os.path.join(work, "project_parameters_updated.json"), encoding="utf-8"))
            output = json.load(open(os.path.join(work, "priced_output.json"), encoding="utf-8"))
            job.update(status="done", progress=1, message="Done", result={"parameters": params_out, "output": output})
        except subprocess.CalledProcessError as e:
            job.update(status="failed", error=(e.stderr or str(e))[-500:])
        except Exception as e:
            job.update(status="failed", error=str(e))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    pool.submit(run)
    return {"job_id": job_id}

@app.get("/v1/estimates/{job_id}")
def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Unknown job")
    return jobs[job_id]
```

If the script is importable, call its main function instead of `subprocess` and update
`job["progress"]` / `job["message"]` while it runs; the user sees those messages.

## Testing without the app

```bash
echo '{"project_id": "test", "version": 1, "tender_file": "BKP.pdf"}' > meta.json
curl -F tender=@BKP_244_LV_Lueftung_260804.pdf -F catalog=@catalog.csv -F productivity=@productivity.csv \
     -F parameters=@project_parameters.json -F meta=@meta.json http://localhost:8000/v1/estimates
# -> {"job_id":"7f3a9c…"}
curl http://localhost:8000/v1/estimates/7f3a9c…
# -> {"status":"done", "result": {"parameters": {…}, "output": {…}}}
```

Checklist before connecting the app:

- [ ] POST returns 200 with `{parameters, output}`, or 202 with `job_id`
- [ ] GET returns `status` and, when done, `result.parameters` + `result.output`
- [ ] `output.position_results`, `output.summary` (or `example_subset_summary`) and
      `output.recommended_bid_range.scenarios` are present
- [ ] every position has a unique `lv_id` and its `source_page`
- [ ] errors come back as `{"error": "…"}`
- [ ] CORS allows `https://dhinu78.github.io` and `http://localhost:5500`
- [ ] reachable over https (or `http://localhost` for local tests)

Then send the URL to the frontend owner; it goes into `BACKEND_URL` in `js/backend.js`.

---

# Part 2 – Frontend

## Using the app

1. Sign in with Google. You land on the start page; a project is only created when you click **New**.
2. Upload the tender PDF, `catalog.csv` and `productivity.csv`. Every factor key used in the
   productivity file is added to the project's productivity factors with 1.0 (no effect).
3. Set the tender-specific values under **Edit parameters**.
4. **Compute** (later **Re-compute**) creates a version and prices it. **View detailed summary**
   shows the cost build-up, bid range, price flags, systems and every position; **Edit** a
   position to replace product, quantity or status (sent with the next Re-compute). Page numbers
   open the tender PDF at that page.

## Engines

| Engine | When | What it does |
|---|---|---|
| **Backend** | `BACKEND_URL` in `js/backend.js` is set | Part 1. The app stores the answer and shows the output exactly as returned. |
| **Built-in** | `BACKEND_URL` is empty | `js/tender-parser.js` reads Swiss bills of quantities (pages with unit and quantity columns such as "Mass-Gattg." / "Massbetrag"), `js/matcher.js` matches German HVAC/ventilation terms, `js/compute.js` prices and builds the bid range. |

Built-in calculation:

```
material cost   = quantity × net unit cost × (1 + material waste %)
install hours   = quantity × base hours × factors listed in factor_keys (site_efficiency as 1 / x)
labour cost     = install hours × hourly rate
project direct  = positions + small material + supplier contingency + custom allowances
                  + project costs (X_hours × X_rate_chf_per_h, lump sums *_chf) + transport/equipment
cost baseline   = project direct × (1 + overhead)
bid price       = baseline / (1 − scenario margin), rounded up to round_to_chf
win probability = reference + appetite + competition − sensitivity × (bid / reference price − 1) in %
                  (reference price = baseline at the target margin), clamped to min/max
contribution    = (bid − baseline) × win probability
```

## Firebase (frontend only)

Google sign-in (Authentication), project data and version history (Firestore, database `bidwise`)
and files (Cloud Storage). Every Compute freezes the inputs and results into a new version:

```
users/<uid>/projects/<project-id>/
  working/<kind>/...               latest uploads
  versions/v0001/
    tender/<tender>.pdf
    catalog/catalog.csv
    productivity/productivity.csv
    project_parameters.json        parameters sent to the backend (incl. position_overrides)
    manifest.json                  who, when, note, original file names, sha256, what changed
    results.json                   what the app shows (also on the Firestore version document)
    output.json                    backend output, as received
    project_parameters_out.json    parameters returned by the backend
```

## Run locally

Serve this folder over http, e.g. `python -m http.server 5500`, then open http://localhost:5500.
The sign-in domain must be listed under Firebase **Authentication → Settings → Authorized domains**
(`localhost` is by default).

## Where to change things

| What | File |
|---|---|
| Firebase connection, Firestore database ID, allowed email domains | `js/firebase-config.js` |
| Backend URL and requests | `js/backend.js` |
| Default parameters for new projects | `js/defaults.js` |
| Built-in PDF reader | `js/tender-parser.js` |
| Built-in matching rules | `js/matcher.js` |
| Built-in calculation, handling of the backend output | `js/compute.js` |
| Required CSV columns, parameter checks | `js/validate.js` |
| Status categories and colours | `js/categories.js` |
| Layout and colours | `index.html` |
