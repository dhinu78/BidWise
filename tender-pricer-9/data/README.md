# From Tender to First Price

## The challenge
Build an AI-powered pricing assistant that processes the **full** ventilation tender `BKP_244_LV_Lueftung_260804.pdf` and turns it into a structured, reviewable first price.

A useful prototype should:
1. ingest the full tender;
2. identify systems and priceable positions;
3. extract descriptions, quantities, units and technical attributes;
4. match catalogue items or supplier packages;
5. estimate installation hours and labour cost;
6. calculate an indicative project price;
7. show uncertainty and source-page traceability.

## Files
- `catalog.csv`: curated HVAC products and supplier packages.
- `productivity.csv`: installation rules, base hours and labour rates.
- `project_parameters.json`: school-specific factors, allowances, overhead, margin and Bid Optimization settings.
- `example_lv_positions.csv`: 22 verified LV positions linked to PDF pages.
- `expected_output_example.json`: golden position calculations and bid scenarios.
- `README.md`: this quick-start guide.

Add the public tender PDF beside these files before the event.

## Quick start
```python
import pandas as pd, json
catalog = pd.read_csv('catalog.csv')
productivity = pd.read_csv('productivity.csv')
examples = pd.read_csv('example_lv_positions.csv')
parameters = json.load(open('project_parameters.json'))
```

## Common keys
- `lv_id`: extracted tender position
- `product_id`: catalogue or supplier-package item
- `install_code`: productivity rule
- accepted units: `pc`, `m`, `m2`, `h`, `LS`, `system`

## Core calculation
```text
material cost = quantity × net unit cost × (1 + material waste %)
installation hours = quantity × base hours per unit × project factors
labour cost = installation hours × hourly rate
direct position cost = material cost + labour cost

project direct cost = material + supplier packages + installation labour
                    + engineering/project management + transport/equipment + special costs
cost baseline = project direct cost + overhead
indicative selling price = cost baseline / (1 - target margin)
```

Apply `site_efficiency` as `1 / site_efficiency`; multiply the other project factors directly.

## Full-LV expectation
The prototype should attempt the full tender. The verified examples provide ground truth for onboarding, testing and judging. A position does not need a forced price, but it needs a clear status:

- `calculated`
- `supplier_quote_required`
- `assumption_applied`
- `review_required`
- `insufficient_information`
- `out_of_scope`
- `non_priceable`

## Minimum viable solution
- process the full PDF and identify its main systems;
- extract a meaningful share of priceable positions;
- complete at least one calculation end to end;
- show source pages and uncertainty;
- provide a usable review interface.

## Target solution
- process most relevant positions;
- handle catalogue products, supplier packages and labour-based services;
- aggregate costs by system and category;
- let users replace proposed matches and assumptions;
- generate an indicative project price.

## Stretch goal: Bid Optimization
Go beyond one calculated price and generate a **Recommended Bid Range**.

Create three scenarios:
- **Aggressive**: lower margin, higher estimated win probability
- **Target**: balanced margin and win probability
- **Conservative**: higher margin, lower estimated win probability

Each scenario should show:
- bid price;
- margin;
- estimated win probability;
- expected contribution.

Potential inputs include historical bids, similar projects, relative price position, competitive intensity, client price sensitivity, strategic appetite and available capacity.

The objective is not one perfect price. It is a better bid decision.

## Golden example
Start with `LV0001` on PDF page 78. Match the five DN100 supply-air valves to `P-AIR-001`, apply `DIFFUSER`, and reproduce the first result in `expected_output_example.json`.
