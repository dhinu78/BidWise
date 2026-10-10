// The estimation: tender PDF -> positions -> matches -> costs -> price -> bid range.
//
// Called on every Re-compute, after the version folder has been saved.
// `inputs` = {
//   version,          // number, e.g. 3
//   parameters,       // project_parameters.json as an object (incl. position_overrides)
//   catalog,          // catalog.csv rows: [{column: "text", ...}, ...]
//   productivity,     // productivity.csv rows
//   tenderPdf,        // the tender PDF as a Blob
//   tenderName,       // original file name
//   onProgress,       // optional (text) => void
// }
// Returns an object shaped like expected_output_example.json (position_results,
// example_subset_summary, recommended_bid_range) plus `views.full` / `views.verified` for the
// dashboard and the extracted systems. Saved as results.json in the version folder.
//
// Core calculation (README of the starter package):
//   material cost        = quantity × net unit cost × (1 + material waste %)
//   installation hours   = quantity × base hours per unit × factors (site_efficiency as 1 / x)
//   labour cost          = installation hours × hourly rate
//   direct position cost = material cost + labour cost
//   project direct cost  = positions + small material + supplier contingency
//                          + engineering / commissioning / special costs + transport & equipment
//   cost baseline        = project direct cost × (1 + overhead)
//   selling price        = cost baseline / (1 - margin), rounded up to commercial.round_to_chf
import { parseTender } from "./tender-parser.js";
import { matchPosition, linkVerified } from "./matcher.js";
import { toNumber } from "./validate.js";

export const PRICED = new Set(["calculated", "assumption_applied", "supplier_quote_required"]);
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);

function prepCatalog(rows) {
  return rows.map((r) => ({
    ...r,
    net_cost_chf: toNumber(r.net_cost_chf) || toNumber(r.list_price_chf) * (1 - (toNumber(r.discount_pct) || 0) / 100),
  }));
}
function prepProductivity(rows) {
  return Object.fromEntries(rows.map((r) => [r.install_code, {
    ...r,
    base_hours_per_unit: toNumber(r.base_hours_per_unit),
    default_hourly_rate_chf: toNumber(r.default_hourly_rate_chf),
    factors: String(r.factor_keys || "").split("|").map((s) => s.trim()).filter(Boolean),
  }]));
}

/** Product of the project factors; site_efficiency counts as 1 / x. Sports hall uses its own height factor. */
function factorFor(rule, factors, systemName) {
  let f = 1;
  const applied = [];
  for (let key of rule.factors) {
    if (key === "mounting_height_school" && /turnhalle/i.test(systemName || "") && factors.mounting_height_sports_hall) {
      key = "mounting_height_sports_hall";
    }
    const v = factors[key];
    if (!(v > 0)) continue;
    f *= key === "site_efficiency" ? 1 / v : v;
    applied.push(key);
  }
  return { f, applied };
}

function costPosition(pos, match, ctx) {
  const { products, rules, params } = ctx;
  const waste = (params.allowances?.material_waste_pct || 0) / 100;
  const qty = pos.quantity == null ? null : pos.quantity * (match.quantity_factor || 1);
  const product = match.matched_product_id ? products[match.matched_product_id] : null;
  const out = {
    quantity: qty,
    unit: match.unit_override || pos.unit,
    net_unit_cost_chf: product ? product.net_cost_chf : null,
    material_cost_chf: null, adjusted_install_hours: null, labour_cost_chf: null, direct_position_cost_chf: null,
    price_source: product ? (product.source_type || "catalog") : match.labour_only_role ? "labour_rate" : null,
    applied_factors: [],
  };
  if (qty == null) return out;

  if (match.labour_only_role) {                     // hours given in the tender
    const rate = match.labour_only_role === "project_engineer"
      ? params.project_costs?.engineering_rate_chf_per_h ?? 145
      : Object.values(rules).find((r) => r.labour_role === "installer")?.default_hourly_rate_chf ?? 96;
    out.material_cost_chf = 0;
    out.adjusted_install_hours = qty;
    out.labour_cost_chf = qty * rate;
  } else if (product) {
    out.material_cost_chf = qty * product.net_cost_chf * (1 + waste);
    const rule = rules[match.install_code || product.install_code];
    if (rule) {
      const { f, applied } = factorFor(rule, params.productivity_factors || {}, pos.system);
      out.adjusted_install_hours = qty * rule.base_hours_per_unit * f;
      out.labour_cost_chf = out.adjusted_install_hours * rule.default_hourly_rate_chf;
      out.applied_factors = applied;
    } else {
      out.adjusted_install_hours = 0;
      out.labour_cost_chf = 0;
    }
  } else return out;
  out.direct_position_cost_chf = out.material_cost_chf + out.labour_cost_chf;
  return out;
}

// ---- totals & bids -------------------------------------------------------------------------

/** Verified-subset rule (reproduces expected_output_example.json): direct × (1 + transport) × (1 + overhead). */
function subsetSummary(list, params) {
  const material = sum(list, (p) => p._material);
  const labour = sum(list, (p) => p._labour);
  const direct = material + labour;
  const transport = direct * (params.allowances?.transport_equipment_pct || 0) / 100;
  const overhead = (direct + transport) * overheadPct(params) / 100;
  return {
    positions: list.length,
    material_cost_chf: r2(material), labour_cost_chf: r2(labour), direct_cost_chf: r2(direct),
    transport_equipment_chf: r2(transport), overhead_chf: r2(overhead), cost_baseline_chf: r2(direct + transport + overhead),
  };
}

const overheadPct = (params) => (params.commercial?.overhead_pct || 0)
  + customValues(params, "commercial").filter(([k]) => k.endsWith("_pct") && k !== "overhead_pct" && k !== "target_margin_pct")
    .reduce((s, [, v]) => s + v, 0);
const customValues = (params, section) => (params.custom_parameters || [])
  .filter((p) => p.startsWith(section + "."))
  .map((p) => p.slice(section.length + 1))
  .map((k) => [k, Number(params[section]?.[k])])
  .filter(([, v]) => Number.isFinite(v));

/** Full tender: positions + allowances + project costs + transport, then overhead. */
function projectSummary(list, params) {
  const a = params.allowances || {}, pc = params.project_costs || {};
  const pkg = (p) => p.price_source === "supplier_package";
  const catalogMaterial = sum(list.filter((p) => !pkg(p)), (p) => p._material);
  const supplierPackages = sum(list.filter(pkg), (p) => p._material);
  const labour = sum(list, (p) => p._labour);
  const smallMaterial = catalogMaterial * (a.small_material_pct || 0) / 100;
  const contingency = supplierPackages * (a.supplier_package_contingency_pct || 0) / 100;

  // project costs: X_hours × X_rate_chf_per_h pairs, plus every lump sum ending in _chf
  const lines = [];
  for (const [k, v] of Object.entries(pc)) {
    if (k.endsWith("_hours")) {
      const base = k.slice(0, -"_hours".length);
      const rate = pc[`${base}_rate_chf_per_h`];
      if (rate != null) lines.push({ key: base, label: base, hours: v, rate, chf: v * rate });
    } else if (k.endsWith("_chf") && !k.endsWith("_chf_per_h")) {
      lines.push({ key: k.slice(0, -4), label: k.slice(0, -4), chf: v });
    }
  }
  const projectCosts = sum(lines, (l) => l.chf);
  // custom allowances (added on the Edit parameters page) are applied to the position costs
  const customAllow = customValues(params, "allowances").filter(([k]) => k.endsWith("_pct"));
  const customAllowChf = sum(customAllow, ([, v]) => (catalogMaterial + supplierPackages + labour) * v / 100);

  const beforeTransport = catalogMaterial + supplierPackages + labour + smallMaterial + contingency + customAllowChf + projectCosts;
  const transport = beforeTransport * (a.transport_equipment_pct || 0) / 100;
  const direct = beforeTransport + transport;
  const overhead = direct * overheadPct(params) / 100;
  return {
    positions: list.length,
    material_cost_chf: r2(catalogMaterial + supplierPackages + smallMaterial + contingency),
    catalog_material_chf: r2(catalogMaterial),
    supplier_packages_chf: r2(supplierPackages),
    small_material_chf: r2(smallMaterial),
    supplier_contingency_chf: r2(contingency),
    labour_cost_chf: r2(labour),
    custom_allowances_chf: r2(customAllowChf),
    project_costs: lines.map((l) => ({ ...l, chf: r2(l.chf) })),
    project_costs_chf: r2(projectCosts),
    transport_equipment_chf: r2(transport),
    direct_cost_chf: r2(direct),
    overhead_chf: r2(overhead),
    cost_baseline_chf: r2(direct + overhead),
  };
}

/**
 * Recommended Bid Range. Win probability moves by `price_sensitivity` per 1 % the bid is above /
 * below the reference price (baseline at the target margin):
 *   p = clamp(reference + strategic_appetite + competition − sensitivity × Δprice%)
 *   expected contribution = (bid − baseline) × p
 */
function bidRange(baseline, params) {
  const sb = params.stretch_bid_optimization || {};
  const c = params.commercial || {};
  const step = c.round_to_chf || 1;
  const reference = baseline / (1 - (c.target_margin_pct || 0) / 100);
  const names = sb.scenario_names?.length ? sb.scenario_names : ["Target"];
  const scenarios = names.map((name) => {
    const margin = sb.scenario_margins_pct?.[name] ?? c.target_margin_pct ?? 0;
    const bid = Math.ceil(baseline / (1 - margin / 100) / step) * step;
    const deltaPct = (bid / reference - 1) * 100;
    let p = (sb.reference_win_probability ?? 0.5) + (sb.strategic_appetite_adjustment || 0) + (sb.competition_adjustment || 0)
      - (sb.price_sensitivity_probability_points_per_1pct_price || 0) * deltaPct;
    p = Math.min(sb.maximum_probability ?? 1, Math.max(sb.minimum_probability ?? 0, p));
    return {
      scenario: name,
      bid_price_chf: bid,
      margin_pct: margin,
      estimated_win_probability: Math.round(p * 100) / 100,
      expected_contribution_chf: r2((bid - baseline) * p),
      price_vs_reference_pct: r2(deltaPct),
    };
  });
  const best = scenarios.reduce((a, b) => (b.expected_contribution_chf > a.expected_contribution_chf ? b : a), scenarios[0]);
  return {
    name: sb.output_name || "Recommended Bid Range",
    enabled: sb.enabled !== false,
    reference_price_chf: r2(reference),
    low_chf: Math.min(...scenarios.map((s) => s.bid_price_chf)),
    high_chf: Math.max(...scenarios.map((s) => s.bid_price_chf)),
    best_expected_contribution: best?.scenario,
    scenarios,
    selection_logic: "Compare bid price, margin, estimated win probability and expected contribution.",
  };
}

function kpis(list) {
  const counts = {};
  for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;
  return {
    positions: list.length,
    status_counts: counts,
    priceable_positions: list.filter((p) => p.status !== "non_priceable" && p.status !== "out_of_scope").length,
    materials_found: list.filter((p) => p.matched_product_id && p.status !== "non_priceable").length,
    priced_positions: list.filter((p) => p.included_in_total).length,
  };
}

// ---- main ----------------------------------------------------------------------------------

export async function computeEstimation(inputs) {
  const { parameters: params, onProgress } = inputs;
  const catalog = prepCatalog(inputs.catalog);
  const products = Object.fromEntries(catalog.map((p) => [p.product_id, p]));
  const rules = prepProductivity(inputs.productivity);
  const overrides = params.position_overrides || {};
  const warnings = [];

  onProgress?.("Reading tender PDF…");
  const tender = await parseTender(inputs.tenderPdf, (i, n) => onProgress?.(`Reading tender PDF… page ${i} / ${n}`));
  if (!tender.positions.length) {
    warnings.push("No LV positions found in the tender PDF (expected page header 'SH Erlenstrasse Oberglatt … Seite n / m').");
  }

  onProgress?.("Matching positions…");
  // the airflow is often stated below the AHU's quantity line -> fall back to the system's airflow
  const sysAirflow = Object.fromEntries(tender.systems.map((s) => [s.code, s.airflow_m3h]));
  for (const pos of tender.positions) pos.airflow_hint_m3h ??= sysAirflow[pos.system_code] ?? null;
  const items = tender.positions.map((pos) => ({ pos, match: matchPosition(pos, catalog) }));
  const verified = linkVerified(items);
  const missingVerified = 22 - verified.size;
  if (tender.positions.length && missingVerified > 0) warnings.push(`${missingVerified} verified example position(s) were not found in the tender.`);

  const ctx = { products, rules, params };
  const positions = items.map(({ pos, match }) => {
    let m = { ...match };
    const v = verified.get(pos.lv_id);
    if (v) {                                         // verified ground truth wins over the rules
      const p = products[v.suggested_product_id];
      m = {
        ...m, matched_product_id: v.suggested_product_id, install_code: v.expected_install_code,
        status: v.ground_truth_status, category: v.category,
        match_confidence: v.ground_truth_status === "calculated" ? 0.92 : 0.72,
        match_note: `Verified example ${v.lv_id}: ${v.description}`,
      };
      if (!p) warnings.push(`Verified product ${v.suggested_product_id} is not in the catalogue.`);
    }
    const o = overrides[pos.lv_id];
    let quantity = pos.quantity;
    if (o) {                                         // user corrections from the detailed summary
      if (o.product_id !== undefined) {
        const p = o.product_id ? products[o.product_id] : null;
        m = {
          ...m, matched_product_id: p ? p.product_id : null, install_code: p ? p.install_code : m.install_code,
          labour_only_role: undefined, quantity_factor: p?.unit === m.unit_override ? m.quantity_factor : undefined,
          unit_override: p?.unit === m.unit_override ? m.unit_override : undefined,
          status: p ? (p.source_type === "supplier_package" ? "supplier_quote_required" : "calculated") : "review_required",
          match_confidence: p ? 1 : 0, match_note: `Product set by user${p ? `: ${p.description}` : ""}`,
        };
        if (o.product_id && !p) warnings.push(`${pos.lv_id}: product ${o.product_id} is not in the catalogue.`);
      }
      if (o.quantity != null && o.quantity !== "") quantity = Number(o.quantity);
      if (o.status) m.status = o.status;
      if (o.note) m.match_note = `${m.match_note || ""} · ${o.note}`.replace(/^ · /, "");
    }
    if (quantity != null && pos.quantity == null && m.status === "insufficient_information") {
      m.status = m.matched_product_id ? "assumption_applied" : "review_required";
    }

    const c = costPosition({ ...pos, quantity }, m, ctx);
    const included = PRICED.has(m.status) && c.direct_position_cost_chf != null;
    const rounded = (v) => (v == null ? null : r2(v));
    return {
      lv_id: pos.lv_id,
      verified_ref: v?.lv_id || null,
      system: pos.system,
      system_code: pos.system_code,
      section: pos.section,
      source_page: pos.source_page,
      description: pos.description_de,
      category: m.category || null,
      manufacturer_hint: pos.manufacturer_hint,
      model_hint: pos.model_hint,
      matched_product_id: m.matched_product_id,
      install_code: m.install_code || (m.matched_product_id ? products[m.matched_product_id]?.install_code : null),
      quantity: c.quantity,
      tender_quantity: pos.quantity,
      unit: c.unit,
      net_unit_cost_chf: rounded(c.net_unit_cost_chf),
      material_cost_chf: rounded(c.material_cost_chf),
      adjusted_install_hours: rounded(c.adjusted_install_hours),
      labour_cost_chf: rounded(c.labour_cost_chf),
      direct_position_cost_chf: rounded(c.direct_position_cost_chf),
      price_source: c.price_source,
      match_confidence: m.match_confidence ?? null,
      review_required: m.status !== "calculated" && m.status !== "non_priceable",
      status: m.status,
      included_in_total: included,
      match_note: m.match_note || "",
      applied_factors: c.applied_factors,
      overridden: !!o,
      warning: pos.warning || "",
      // unrounded values for the totals (stripped before saving)
      _material: included ? c.material_cost_chf : 0,
      _labour: included ? c.labour_cost_chf : 0,
    };
  });

  onProgress?.("Calculating price…");
  const priced = positions.filter((p) => p.included_in_total);
  const subsetList = positions.filter((p) => p.verified_ref);
  const subset = subsetSummary(subsetList.filter((p) => p.included_in_total), params);
  const full = projectSummary(priced, params);

  const systems = tender.systems.map((s) => {
    const list = positions.filter((p) => p.system_code === s.code);
    const pr = list.filter((p) => p.included_in_total);
    return {
      ...s, positions: list.length, priced: pr.length,
      material_cost_chf: r2(sum(pr, (p) => p._material)), labour_cost_chf: r2(sum(pr, (p) => p._labour)),
      direct_cost_chf: r2(sum(pr, (p) => p._material + p._labour)),
    };
  });
  const categories = {};
  for (const p of priced) {
    const k = p.category || "Other";
    categories[k] = r2((categories[k] || 0) + p._material + p._labour);
  }

  for (const p of positions) { delete p._material; delete p._labour; }

  const fullBids = bidRange(full.cost_baseline_chf, params);
  const subsetBids = bidRange(subset.cost_baseline_chf, params);
  return {
    schema_version: "2.0",
    generated_at: new Date().toISOString(),
    version: inputs.version,
    source_tender_file: inputs.tenderName || params.project?.source_tender_file || null,
    tender: { pages: tender.pageCount, lv_pages: tender.lvPages, extracted_positions: tender.positions.length },
    systems,
    cost_by_category: categories,
    position_results: positions,
    example_subset_summary: subset,
    project_summary: full,
    recommended_bid_range: fullBids,
    views: {
      full: { label: "Full tender", summary: full, recommended_bid_range: fullBids, kpis: kpis(positions) },
      verified: { label: "Verified subset", summary: subset, recommended_bid_range: subsetBids, kpis: kpis(subsetList), only: "verified_ref" },
    },
    // for the "Edit position" dialog in the detailed summary
    catalog: catalog.map((p) => ({
      product_id: p.product_id, category: p.category, description: p.description, unit: p.unit,
      net_cost_chf: p.net_cost_chf, source_type: p.source_type, install_code: p.install_code,
    })),
    warnings,
  };
}
