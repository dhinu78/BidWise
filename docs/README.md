# BIDWISE Estimation Tool (web app, no backend)

From tender to first price, entirely in the browser: upload the tender PDF, `catalog.csv` and
`productivity.csv`, click **Re-compute**, and get a structured, reviewable price with a
**Recommended Bid Range** (Aggressive / Target / Conservative).

Firebase provides Google sign-in (Authentication), project data and version history (Firestore)
and file storage (Cloud Storage). Every **Re-compute** freezes the inputs into a new version:

```
users/<uid>/projects/<project-id>/
  working/<kind>/...               latest uploads
  versions/v0001/
    tender/BKP_244_LV_Lueftung_260804.pdf
    catalog/catalog.csv
    productivity/productivity.csv
    project_parameters.json        incl. your position edits (position_overrides)
    manifest.json                  who, when, note, original file names, sha256, what changed
    results.json                   the calculation (also stored on the Firestore version document)
  versions/v0002/ ...
```

## How the estimate is made

1. **Read the tender** (`js/tender-parser.js`): pdf.js reads every page. Pages with the
   `SH Erlenstrasse Oberglatt <system> Seite n / m` header are LV pages; every line with a unit in
   the *Mass-Gattg.* column is a quantity position. Item heading, section, system, Fabrikat/Typ
   hints, airflow (`Luftmenge … m3/h`) and the source page are attached. This is a port of
   `lv_extractor.py` from the starter package and gives the same 254 positions from 6 systems.
2. **Match** (`js/matcher.js`): German keyword rules plus size parsing (Ø, B x H, DN, MS-F/…)
   pick the catalogue item or supplier package and the install code. Exact size → *calculated*;
   nearest size → *assumption applied*; supplier package → *supplier quote required*; no
   catalogue item → *review required*; no quantity → *insufficient information*; AHU
   sub-components and specification lines → *non-priceable*. The 22 verified positions of
   `example_lv_positions.csv` (`js/reference.js`) override the rules.
3. **Calculate** (`js/compute.js`):
   ```
   material cost   = quantity × net unit cost × (1 + material waste %)
   install hours   = quantity × base hours × factors   (site_efficiency as 1 / x;
                                                        Turnhalle uses mounting_height_sports_hall)
   labour cost     = install hours × hourly rate
   project direct  = positions + small material + supplier contingency
                     + engineering, commissioning, hygiene, documentation + transport/equipment
   cost baseline   = project direct × (1 + overhead)
   bid price       = baseline / (1 − scenario margin), rounded up to round_to_chf
   win probability = reference + appetite + competition − sensitivity × (bid / reference price − 1) in %
                     (reference price = baseline at the target margin), clamped to min/max
   contribution    = (bid − baseline) × win probability
   ```
   Only *calculated*, *assumption applied* and *supplier quote required* positions count in the totals.

The dashboard switch **Full tender / Verified subset** chooses the view. *Verified subset* uses the
golden-example rule (direct × (1 + transport) × (1 + overhead)) and reproduces
`expected_output_example.json` exactly: CHF 414.489,12 baseline, bids 426k / 432k / 444k.

## The three pages

- **Dashboard:** uploads, version, status donut, counts, cost estimation and bid cards.
- **Edit parameters** (`#/parameters`): every parameter in editable cards; **+** adds your own.
  Custom allowances (`_pct`) are applied to the position costs, custom project costs (`_chf`, or
  `X_hours` + `X_rate_chf_per_h`) are added to the project costs, custom commercial `_pct` values are
  added to the overhead. Each bid scenario becomes a bid card.
- **Detailed summary** (`#/summary`): pick a version and scope. Cost build-up, bid range, systems,
  and a searchable, sortable table of all positions with the match reason. Click a **page number**
  to open the tender PDF at that page. **Edit** replaces the proposed product, quantity or status;
  the change is applied on the next Re-compute and saved with that version. **Export CSV** gives
  Excel-friendly output (`;` and decimal comma).

## Run it

The page must be served over http (not opened as a file), e.g. VS Code **Live Server**, or:

```
python -m http.server 5500 --bind 127.0.0.1
```

Then open http://127.0.0.1:5500. On GitHub Pages it runs from this `docs/` folder. The Google
sign-in domain must be listed under Firebase **Authentication → Settings → Authorized domains**.

The page reads saved files back from Storage when you Re-compute after a reload without picking
the files again; that needs CORS on the bucket for the site's address.

## Where to change things

| What | File |
|---|---|
| Firebase connection, allowed email domains | `js/firebase-config.js` |
| Default parameters for new projects | `js/defaults.js` |
| Verified example positions | `js/reference.js` |
| PDF extraction rules | `js/tender-parser.js` |
| Matching rules (German text → product, status) | `js/matcher.js` |
| Cost, price and bid calculation | `js/compute.js` |
| Required CSV columns, parameter checks | `js/validate.js` |
| Status categories and colours (donut, summary) | `js/categories.js` |
| Logo | `assets/logo.png` |
| Layout and colours | `index.html` |
