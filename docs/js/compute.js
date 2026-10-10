// The estimation: tender PDF -> positions -> matches -> costs -> price -> bid range.
//
// Two ways to get priced positions, same result format (see README "Results format"):
//   - computeEstimation(): built-in browser engine (tender-parser.js + matcher.js)
//   - js/backend.js: the external extraction/pricing service, when BACKEND_URL is set
// Both then go through finalizeResults(), which applies the user's position edits, adds the
// project costs, overhead, totals per system and the Recommended Bid Range.
//
// Core calculation:
//   material cost        = quantity × net unit cost × (1 + material waste %)
//   installation hours   = quantity × base hours per unit × project factors (site_efficiency as 1 / x)
//   labour cost          = installation hours × hourly rate
//   direct position cost = material cost + labour cost
//   project direct cost  = positions + small material + supplier contingency + custom allowances
//                          + project costs (hours × rate, lump sums) + transport & equipment
//   cost baseline        = project direct cost × (1 + overhead)
//   bid price            = baseline / (1 − scenario margin), rounded up to commercial.round_to_chf
import { parseTender } from "./tender-parser.js";
import { matchPosition } from "./matcher.js";
import { toNumber } from "./validate.js";

export const PRICED = new Set(["calculated", "assumption_applied", "supplier_quote_required"]);
const r2 = (v) => (v == null || !Number.isFinite(+v) ? null : Math.round((+v + Number.EPSILON) * 100) / 100);
const sum = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);

// ---- inputs ------------------------------------------------------------------------------------

/** Parameters + parsed catalog.csv / productivity.csv rows -> lookup context. */
export function buildContext(parameters, catalogRows, productivityRows) {
  const catalog = catalogRows.map((r) => ({
    ...r,
    net_cost_chf: toNumber(r.net_cost_chf) || toNumber(r.list_price_chf) * (1 - (toNumber(r.discount_pct) || 0) / 100),
  }));
  const rules = Object.fromEntries(productivityRows.map((r) => [r.install_code, {
    ...r,
    base_hours_per_unit: toNumber(r.base_hours_per_unit),
    default_hourly_rate_chf: toNumber(r.default_hourly_rate_chf),
    factors: String(r.factor_keys || "").split("|").map((s) => s.trim()).filter(Boolean),
  }]));
  return { params: parameters, catalog, products: Object.fromEntries(catalog.map((p) => [p.product_id, p])), rules };
}

/** Product of the project factors listed for the install code; site_efficiency counts as 1 / x. */
function factorFor(rule, factors) {
  let f = 1;
  const applied = [];
  for (const key of rule.factors) {
    const v = factors[key];
    if (!(v > 0)) continue;
    f *= key === "site_efficiency" ? 1 / v : v;
    applied.push(key);
  }
  return { f, applied };
}

/** Cost one position. `m` = match (product, install code, labour-only role, unit conversion). */
function costPosition(quantity, unit, m, ctx) {
  const { products, rules, params } = ctx;
  const waste = (params.allowances?.material_waste_pct || 0) / 100;
  const qty = quantity == null ? null : quantity * (m.quantity_factor || 1);
  const product = m.matched_product_id ? products[m.matched_product_id] : null;
  const manual = m.unit_price_chf != null && Number.isFinite(+m.unit_price_chf);   // price set by the user
  const price = manual ? +m.unit_price_chf : product?.net_cost_chf;
  const out = {
    quantity: qty, unit: m.unit_override || unit,
    net_unit_cost_chf: manual || product ? price : null,
    material_cost_chf: null, adjusted_install_hours: null, labour_cost_chf: null, direct_position_cost_chf: null,
    price_source: manual ? "manual" : product ? (product.source_type || "catalog") : m.labour_only_role ? "labour_rate" : null,
    applied_factors: [],
  };
  if (qty == null) return out;
  if (m.labour_only_role && !manual) {               // hours stated in the tender
    const rate = m.labour_only_role === "project_engineer"
      ? params.project_costs?.engineering_rate_chf_per_h
        ?? Object.values(rules).find((r) => r.labour_role === "project_engineer")?.default_hourly_rate_chf ?? 0
      : Object.values(rules).find((r) => r.labour_role === "installer")?.default_hourly_rate_chf ?? 0;
    out.material_cost_chf = 0;
    out.adjusted_install_hours = qty;
    out.labour_cost_chf = qty * rate;
  } else if (manual || product) {
    out.material_cost_chf = qty * price * (1 + waste);
    const rule = rules[m.install_code || product?.install_code];
    if (rule) {
      const { f, applied } = factorFor(rule, params.productivity_factors || {});
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

function roundCosts(c) {
  for (const k of ["net_unit_cost_chf", "material_cost_chf", "adjusted_install_hours", "labour_cost_chf", "direct_position_cost_chf"]) c[k] = r2(c[k]);
  return c;
}

// ---- user edits (detailed summary -> Edit) ---------------------------------------------------

/** Apply parameters.position_overrides to positions (from either engine) and re-cost edited ones. */
export function applyOverrides(positions, ctx) {
  const overrides = ctx.params.position_overrides || {};
  const warnings = [];
  const out = positions.map((p) => {
    const o = overrides[p.lv_id];
    if (!o) return { ...p, overridden: false };
    const m = {
      matched_product_id: p.matched_product_id, install_code: p.install_code, status: p.status,
      match_confidence: p.match_confidence, match_note: p.match_note || "",
      labour_only_role: p.labour_only_role, quantity_factor: p.quantity_factor, unit_override: p.unit_override,
    };
    if (o.product_id !== undefined) {
      const prod = o.product_id ? ctx.products[o.product_id] : null;
      if (o.product_id && !prod) warnings.push(`${p.lv_id}: product ${o.product_id} is not in the catalogue.`);
      Object.assign(m, {
        matched_product_id: prod?.product_id ?? null, install_code: prod?.install_code ?? m.install_code,
        labour_only_role: undefined,
        status: prod ? (prod.source_type === "supplier_package" ? "supplier_quote_required" : "calculated") : "review_required",
        match_confidence: prod ? 1 : 0, match_note: `Product set by user${prod ? `: ${prod.description}` : ""}`,
      });
      if (prod?.unit !== p.unit) { m.quantity_factor = undefined; m.unit_override = undefined; }
    }
    const tenderQty = p.tender_quantity !== undefined ? p.tender_quantity : p.quantity;
    const quantity = o.quantity != null && o.quantity !== "" ? Number(o.quantity) : tenderQty;
    if (o.status) m.status = o.status;
    else if (quantity != null && tenderQty == null && m.status === "insufficient_information") {
      m.status = m.matched_product_id ? "assumption_applied" : "review_required";
    }
    if (o.unit_price_chf != null && o.unit_price_chf !== "" && Number.isFinite(+o.unit_price_chf)) {
      m.unit_price_chf = +o.unit_price_chf;
      if (!o.status) m.status = "calculated";
      m.match_confidence = 1;
      m.match_note = `Unit price set by user: CHF ${(+o.unit_price_chf).toFixed(2)}${o.price_source ? ` (${o.price_source})` : ""}`;
    }
    if (o.note) m.match_note = `${m.match_note} · ${o.note}`.replace(/^ · /, "");
    const c = roundCosts(costPosition(quantity, p.tender_unit || p.unit, m, ctx));
    return {
      ...p, ...c, tender_quantity: tenderQty,
      matched_product_id: m.matched_product_id, install_code: m.install_code, status: m.status,
      match_confidence: m.match_confidence, match_note: m.match_note, overridden: true,
    };
  });
  return { positions: out, warnings };
}

// ---- totals & bids -----------------------------------------------------------------------------

const customValues = (params, section) => (params.custom_parameters || [])
  .filter((p) => p.startsWith(section + "."))
  .map((p) => p.slice(section.length + 1))
  .map((k) => [k, Number(params[section]?.[k])])
  .filter(([, v]) => Number.isFinite(v));
const overheadPct = (params) => (params.commercial?.overhead_pct || 0)
  + customValues(params, "commercial").filter(([k]) => k.endsWith("_pct") && k !== "overhead_pct" && k !== "target_margin_pct")
    .reduce((s, [, v]) => s + v, 0);

/** Positions + allowances + project costs + transport, then overhead. */
export function projectSummary(list, params) {
  const a = params.allowances || {}, pc = params.project_costs || {};
  const pkg = (p) => p.price_source === "supplier_package";
  const catalogMaterial = sum(list.filter((p) => !pkg(p)), (p) => p.material_cost_chf);
  const supplierPackages = sum(list.filter(pkg), (p) => p.material_cost_chf);
  const labour = sum(list, (p) => p.labour_cost_chf);
  const smallMaterial = catalogMaterial * (a.small_material_pct || 0) / 100;
  const contingency = supplierPackages * (a.supplier_package_contingency_pct || 0) / 100;

  // project costs: X_hours × X_rate_chf_per_h pairs, plus every lump sum ending in _chf
  const lines = [];
  for (const [k, v] of Object.entries(pc)) {
    if (k.endsWith("_hours")) {
      const base = k.slice(0, -"_hours".length);
      const rate = pc[`${base}_rate_chf_per_h`];
      if (rate != null && v) lines.push({ key: base, label: base, hours: v, rate, chf: v * rate });
    } else if (k.endsWith("_chf") && !k.endsWith("_chf_per_h") && v) {
      lines.push({ key: k.slice(0, -4), label: k.slice(0, -4), chf: v });
    }
  }
  const projectCosts = sum(lines, (l) => l.chf);
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
export function bidRange(baseline, params) {
  const sb = params.stretch_bid_optimization || {};
  const c = params.commercial || {};
  if (!(baseline > 0)) return null;
  const step = c.round_to_chf || 1;
  const reference = baseline / (1 - (c.target_margin_pct || 0) / 100);
  const names = sb.enabled === false || !sb.scenario_names?.length ? ["Target"] : sb.scenario_names;
  const scenarios = names.map((name) => {
    const margin = sb.scenario_margins_pct?.[name] ?? c.target_margin_pct ?? 0;
    const bid = Math.ceil(baseline / (1 - margin / 100) / step) * step;
    const deltaPct = (bid / reference - 1) * 100;
    let p = (sb.reference_win_probability ?? 0.5) + (sb.strategic_appetite_adjustment || 0) + (sb.competition_adjustment || 0)
      - (sb.price_sensitivity_probability_points_per_1pct_price || 0) * deltaPct;
    p = Math.min(sb.maximum_probability ?? 1, Math.max(sb.minimum_probability ?? 0, p));
    return {
      scenario: name, bid_price_chf: bid, margin_pct: margin,
      estimated_win_probability: Math.round(p * 100) / 100,
      expected_contribution_chf: r2((bid - baseline) * p),
      price_vs_reference_pct: r2(deltaPct),
    };
  });
  const best = scenarios.reduce((a, b) => (b.expected_contribution_chf > a.expected_contribution_chf ? b : a), scenarios[0]);
  return {
    name: sb.output_name || "Recommended Bid Range",
    reference_price_chf: r2(reference),
    low_chf: Math.min(...scenarios.map((s) => s.bid_price_chf)),
    high_chf: Math.max(...scenarios.map((s) => s.bid_price_chf)),
    best_expected_contribution: best?.scenario,
    scenarios,
  };
}

export function kpis(list) {
  const counts = {};
  for (const p of list) counts[p.status] = (counts[p.status] || 0) + 1;
  return {
    positions: list.length,
    status_counts: counts,
    priceable_positions: list.length,                      // every position of the bill, non-priceable included
    materials_found: list.filter((p) => p.matched_product_id && p.status === "calculated").length,
    priced_positions: list.filter((p) => p.included_in_total).length,
  };
}

/**
 * Turn priced positions (from either engine) into the stored results:
 * edits applied, totals, per-system and per-category costs, bid range, KPIs.
 * `raw` = { position_results, systems?, tender?, warnings?, engine? }
 */
export function finalizeResults(raw, ctx, meta = {}) {
  const { positions: edited, warnings: editWarnings } = applyOverrides(raw.position_results || [], ctx);
  const positions = edited.map((p) => {
    const { labour_only_role, quantity_factor, unit_override, tender_unit, ...rest } = p;
    const included = PRICED.has(p.status) && p.direct_position_cost_chf != null;
    return { ...rest, included_in_total: included, price_basis: included ? "firm" : "none" };
  });
  const priced = positions.filter((p) => p.included_in_total);
  const summary = projectSummary(priced, ctx.params);

  // systems: from the engine if given, otherwise grouped from the positions
  const sysList = raw.systems?.length ? raw.systems
    : [...new Set(positions.map((p) => p.system || "General"))].map((name) => ({ code: name.split(" ")[0], name }));
  const systems = sysList.map((s) => {
    const list = positions.filter((p) => (p.system_code ?? p.system?.split(" ")[0]) === s.code || p.system === s.name);
    const pr = list.filter((p) => p.included_in_total);
    const pages = list.map((p) => p.source_page).filter(Number.isFinite);
    return {
      first_page: pages.length ? Math.min(...pages) : null, last_page: pages.length ? Math.max(...pages) : null, ...s,
      positions: list.length, priced: pr.length,
      material_cost_chf: r2(sum(pr, (p) => p.material_cost_chf)), labour_cost_chf: r2(sum(pr, (p) => p.labour_cost_chf)),
      direct_cost_chf: r2(sum(pr, (p) => p.direct_position_cost_chf)),
    };
  });
  const categories = {};
  for (const p of priced) categories[p.category || "Other"] = r2((categories[p.category || "Other"] || 0) + p.direct_position_cost_chf);

  return {
    schema_version: "3.0",
    engine: raw.engine || "browser",
    generated_at: new Date().toISOString(),
    version: meta.version,
    source_tender_file: meta.tenderName || null,
    tender: raw.tender || { pages: null, lv_pages: null, extracted_positions: positions.length },
    systems,
    cost_by_category: categories,
    position_results: positions,
    summary,
    recommended_bid_range: bidRange(summary.cost_baseline_chf, ctx.params),
    kpis: kpis(positions),
    // for the "Edit position" dialog in the detailed summary
    productivity: rulesList(ctx),
    catalog: ctx.catalog.map((p) => ({
      product_id: p.product_id, category: p.category, description: p.description, unit: p.unit,
      net_cost_chf: p.net_cost_chf, source_type: p.source_type, install_code: p.install_code,
    })),
    warnings: [...(raw.warnings || []), ...editWarnings],
  };
}

// ---- edits saved without re-computing ------------------------------------------------------------

/** Productivity rules carried in the results, so edits can be priced later without the files. */
export function rulesList(ctx) {
  return Object.values(ctx.rules).map((r) => ({
    install_code: r.install_code, base_hours_per_unit: r.base_hours_per_unit, default_hourly_rate_chf: r.default_hourly_rate_chf,
    labour_role: r.labour_role, factors: r.factors,
  }));
}

// the engine's values of a position, kept on first edit so an edit can be undone
const SNAPSHOT = ["quantity", "unit", "matched_product_id", "install_code", "net_unit_cost_chf", "material_cost_chf",
  "adjusted_install_hours", "labour_cost_chf", "direct_position_cost_chf", "price_source", "price_basis", "status",
  "match_confidence", "match_note", "status_reason", "included_in_total", "review_required", "price_range_chf"];
const snapshot = (p) => Object.fromEntries(SNAPSHOT.map((k) => [k, p[k] ?? null]));
const isNum = (v) => v !== null && v !== "" && v !== undefined && Number.isFinite(+v);

function editPosition(p, o, catalog, rules, params, warnings) {
  const orig = p.original || snapshot(p);
  const waste = (params.allowances?.material_waste_pct || 0) / 100;
  const q0 = orig.quantity;
  const qty = isNum(o.quantity) ? +o.quantity : q0;
  const prodChanged = o.product_id !== undefined && (o.product_id || null) !== (orig.matched_product_id || null);
  const productId = prodChanged ? o.product_id || null : orig.matched_product_id;
  const product = productId ? catalog[productId] : null;
  if (prodChanged && productId && !product) warnings.push(`${p.lv_id}: product ${productId} is not in the catalogue.`);
  const installCode = prodChanged ? product?.install_code ?? null : orig.install_code;
  const manual = isNum(o.unit_price_chf);
  const unitPrice = manual ? +o.unit_price_chf : prodChanged ? product?.net_cost_chf ?? null : orig.net_unit_cost_chf;
  const ratio = q0 > 0 && qty != null ? qty / q0 : null;
  const notes = [];

  let material = null, hours = null, labour = null;
  if (qty != null) {
    // material: keep the engine's own figure scaled by quantity, unless the price or product changed
    if (!manual && !prodChanged && ratio != null && orig.material_cost_chf != null) material = orig.material_cost_chf * ratio;
    else if (unitPrice != null) material = qty * unitPrice * (1 + waste);
    // labour: scale the engine's hours, or price them from the productivity rule
    const rule = rules[installCode];
    if (!prodChanged && ratio != null && orig.labour_cost_chf != null) {
      labour = orig.labour_cost_chf * ratio;
      hours = (orig.adjusted_install_hours ?? 0) * ratio;
    } else if (rule) {
      const { f } = factorFor(rule, params.productivity_factors || {});
      hours = qty * rule.base_hours_per_unit * f;
      labour = hours * rule.default_hourly_rate_chf;
    } else if (material != null) {
      hours = 0; labour = 0;
      notes.push("installation labour not included (no productivity rule for this item)");
    }
  }
  const direct = material == null ? null : material + (labour || 0);

  // the status (classification) stays the engine's; only a status the user sets explicitly changes it
  const status = o.status || orig.status;
  const priceSource = manual ? "manual" : prodChanged ? (product ? product.source_type || "catalog" : "none") : orig.price_source;
  const basis = direct == null ? "none"
    : manual || (prodChanged && product) ? "firm"
    : orig.price_basis === "none" || !orig.price_basis ? "firm" : orig.price_basis;
  const range = basis === "estimate" && orig.price_range_chf && ratio != null
    ? { low: r2(orig.price_range_chf.low * ratio), high: r2(orig.price_range_chf.high * ratio) } : null;

  const what = [];
  if (isNum(o.quantity) && +o.quantity !== q0) what.push(`quantity ${q0 ?? "–"} → ${+o.quantity}`);
  if (manual) what.push(`unit price CHF ${(+o.unit_price_chf).toFixed(2)}${o.price_source ? ` (${o.price_source})` : ""}`);
  if (prodChanged) what.push(`product ${productId || "none"}`);
  if (o.status) what.push(`status ${o.status}`);
  const note = `Edited by user: ${what.join(", ") || "note"}${o.note ? ` · ${o.note}` : ""}${notes.length ? ` · ${notes.join("; ")}` : ""}`;

  return {
    ...p,
    quantity: qty, matched_product_id: productId, install_code: installCode,
    net_unit_cost_chf: r2(unitPrice), material_cost_chf: r2(material), adjusted_install_hours: r2(hours),
    labour_cost_chf: r2(labour), direct_position_cost_chf: r2(direct),
    price_source: priceSource, price_basis: basis, price_range_chf: range, status,
    match_confidence: orig.match_confidence,
    review_required: orig.review_required ?? (status !== "calculated" && status !== "non_priceable"),
    // a price the user entered counts in the totals, unless the user marked the position as not priced
    included_in_total: basis === "firm" && (PRICED.has(status) || ((manual || (prodChanged && product)) && !o.status)),
    match_note: note, status_reason: note,
    original: orig, edited: true, edit: o,
  };
}

/**
 * Apply the user's edits (parameters.position_overrides, and changed commercial parameters) to an
 * existing results object without re-running the engine: edited positions are re-priced, totals,
 * estimates, systems, KPIs and the bid range are updated. Positions whose edit was removed get
 * their engine values back. `prevParams` = the parameters the previous results were made with.
 */
export function applyEditsToResults(prev, params, prevParams = {}) {
  const r = structuredClone(prev);
  const overrides = params.position_overrides || {};
  const catalog = Object.fromEntries((r.catalog || []).map((c) => [c.product_id, c]));
  const rules = Object.fromEntries((r.productivity || []).map((x) => [x.install_code, x]));
  const warnings = [];
  r.position_results = r.position_results.map((p) => {
    const o = overrides[p.lv_id];
    if (o) return editPosition(p, o, catalog, rules, params, warnings);
    if (!p.original) return p;
    const { original, edited, edit, ...rest } = { ...p, ...p.original };   // edit removed: engine values back
    return rest;
  });

  const pos = r.position_results;
  const firm = pos.filter((p) => p.included_in_total);
  const est = pos.filter((p) => p.price_basis === "estimate");
  const oldFirm = (prev.position_results || []).filter((p) => p.included_in_total);

  const prevSummary = prev.summary || prev.project_summary || prev.example_subset_summary || {};
  const builtIn = !prev.engine || prev.engine === "browser";       // older built-in results have no engine field
  if (builtIn) {
    r.summary = projectSummary(firm, params);                  // same rules as the built-in engine
  } else {
    // backend totals: shift by the change in firm rows; the baseline keeps the backend's own
    // mark-up, adjusted if overhead or transport were changed
    const s = { ...prevSummary };
    const d = (k) => sum(firm, (p) => p[k]) - sum(oldFirm, (p) => p[k]);
    const dMat = d("material_cost_chf"), dLab = d("labour_cost_chf"), dDir = d("direct_position_cost_chf");
    const markUp = (pp) => (1 + (pp.allowances?.transport_equipment_pct || 0) / 100) * (1 + (pp.commercial?.overhead_pct || 0) / 100);
    const ratio = prevSummary.direct_cost_chf ? prevSummary.cost_baseline_chf / prevSummary.direct_cost_chf : markUp(params);
    if (prevSummary.direct_cost_chf == null) {                      // no totals given: start from the firm rows
      s.material_cost_chf = sum(oldFirm, (p) => p.material_cost_chf);
      s.labour_cost_chf = sum(oldFirm, (p) => p.labour_cost_chf);
      s.direct_cost_chf = sum(oldFirm, (p) => p.direct_position_cost_chf);
    }
    if (s.material_cost_chf != null) s.material_cost_chf = r2(s.material_cost_chf + dMat);
    if (s.labour_cost_chf != null) s.labour_cost_chf = r2(s.labour_cost_chf + dLab);
    s.direct_cost_chf = r2((s.direct_cost_chf ?? 0) + dDir);
    s.cost_baseline_chf = r2(s.direct_cost_chf * ratio * (markUp(params) / markUp(prevParams.commercial ? prevParams : params)));
    r.summary = s;
    if (r.example_subset_summary) r.example_subset_summary = s;
    if (r.project_summary) r.project_summary = s;
  }

  if (est.length || prev.estimated) {
    r.estimated = {
      ...(prev.estimated || {}), rows: est.length,
      material_cost_chf: r2(sum(est, (p) => p.material_cost_chf)), labour_cost_chf: r2(sum(est, (p) => p.labour_cost_chf)),
      direct_cost_chf: r2(sum(est, (p) => p.direct_position_cost_chf)),
      low_chf: r2(sum(est, (p) => p.price_range_chf?.low ?? p.direct_position_cost_chf)),
      high_chf: r2(sum(est, (p) => p.price_range_chf?.high ?? p.direct_position_cost_chf)),
    };
  }
  if (prev.indicative_total && r.estimated) {
    const dir = r.summary.direct_cost_chf, k = dir ? r.summary.cost_baseline_chf / dir : 1;
    r.indicative_total = {
      direct_cost_chf: r2(dir + r.estimated.direct_cost_chf),
      direct_cost_low_chf: r2(dir + r.estimated.low_chf), direct_cost_high_chf: r2(dir + r.estimated.high_chf),
      cost_baseline_chf: r2((dir + r.estimated.direct_cost_chf) * k),
      cost_baseline_low_chf: r2((dir + r.estimated.low_chf) * k), cost_baseline_high_chf: r2((dir + r.estimated.high_chf) * k),
    };
  }
  const bids = bidRange(r.summary.cost_baseline_chf, params);
  r.recommended_bid_range = bids && prev.recommended_bid_range?.basis ? { ...bids, basis: prev.recommended_bid_range.basis } : bids;
  r.systems = (r.systems || []).map((s) => {
    const list = pos.filter((p) => (p.system_code ?? String(p.system || "General").split(" ")[0]) === s.code || p.system === s.name);
    const f = list.filter((p) => p.included_in_total), e = list.filter((p) => p.price_basis === "estimate");
    return { ...s, positions: list.length, priced: f.length, estimated: e.length,
      direct_cost_chf: r2(sum(f, (p) => p.direct_position_cost_chf)), estimated_cost_chf: r2(sum(e, (p) => p.direct_position_cost_chf)) };
  });
  r.kpis = { ...(prev.kpis || {}), ...kpis(pos), firm_positions: firm.length, estimated_positions: est.length,
    not_priced_positions: pos.filter((p) => p.price_basis === "none").length };
  const edited = pos.filter((p) => p.edited).length;
  r.edited_in_app = { at: new Date().toISOString(), positions: edited };
  r.warnings = [...new Set([...(prev.warnings || []).filter((w) => !w.startsWith("Edited in the app")),
    `Edited in the app: ${edited} position(s) re-priced and the totals updated without re-computing. A Re-compute recalculates everything from the files.`,
    ...warnings])];
  return r;
}

// ---- backend output ----------------------------------------------------------------------------

/**
 * Price basis of a position: "firm" (catalogue / supplier package / labour rate, counted in the
 * totals), "estimate" (side estimate with a range, never mixed into firm totals) or "none".
 */
export function priceBasis(p) {
  if (p.price_basis) return p.price_basis;
  if (p.direct_position_cost_chf == null || p.price_source === "none" || p.price_source == null) return "none";
  return p.price_source === "estimate" ? "estimate" : "firm";
}

/**
 * Show the backend's output file as it is: positions, firm summary, estimates, indicative total
 * and bid range are used unchanged (no re-calculation). Only display helpers the file leaves out
 * are derived from its own values (price basis, status counts, per-system sums, bid range low/high).
 * Accepts the expected_output_example.json shape (example_subset_summary = firm summary).
 */
export function normalizeBackendOutput(output, ctx, meta = {}) {
  if (!output || !Array.isArray(output.position_results)) throw new Error("The backend output has no position_results.");
  const warnings = [...(output.warnings || [])];
  const positions = output.position_results.map((p) => {
    const basis = priceBasis(p);
    return { ...p, price_basis: basis, included_in_total: p.included_in_total ?? basis === "firm" };
  });
  const firm = positions.filter((p) => p.included_in_total);
  const est = positions.filter((p) => p.price_basis === "estimate");

  let summary = output.summary || output.project_summary || output.example_subset_summary;
  if (!summary) {
    summary = {
      material_cost_chf: r2(sum(firm, (p) => p.material_cost_chf)),
      labour_cost_chf: r2(sum(firm, (p) => p.labour_cost_chf)),
      direct_cost_chf: r2(sum(firm, (p) => p.direct_position_cost_chf)),
      cost_baseline_chf: null,
    };
    warnings.push("The backend output has no summary; firm totals are summed from its positions and the baseline is missing.");
  }

  // estimates and indicative total: as given by the backend, else summed from its rows
  const cs = output.cost_summary || {};
  const estimated = cs.estimated || (est.length ? {
    rows: est.length,
    material_cost_chf: r2(sum(est, (p) => p.material_cost_chf)),
    labour_cost_chf: r2(sum(est, (p) => p.labour_cost_chf)),
    direct_cost_chf: r2(sum(est, (p) => p.direct_position_cost_chf)),
    low_chf: r2(sum(est, (p) => p.price_range_chf?.low ?? p.direct_position_cost_chf)),
    high_chf: r2(sum(est, (p) => p.price_range_chf?.high ?? p.direct_position_cost_chf)),
  } : null);

  let bids = output.recommended_bid_range || null;
  if (bids?.scenarios?.length) {
    const prices = bids.scenarios.map((s) => s.bid_price_chf).filter(Number.isFinite);
    const best = bids.scenarios.reduce((a, b) => ((b.expected_contribution_chf ?? -Infinity) > (a.expected_contribution_chf ?? -Infinity) ? b : a));
    bids = {
      name: "Recommended Bid Range", low_chf: Math.min(...prices), high_chf: Math.max(...prices),
      best_expected_contribution: best.scenario, ...bids,
    };
  }

  const codeOf = (name) => String(name || "General").split(" ")[0];
  const sysNames = (output.systems?.length ? output.systems : output.tender?.systems?.length ? output.tender.systems
    : [...new Set(positions.map((p) => p.system || "General"))].map((name) => ({ name })))
    .map((s) => ({ code: s.code ?? codeOf(s.name), ...s }));
  const systems = sysNames.map((s) => {
    const list = positions.filter((p) => (p.system_code ?? codeOf(p.system)) === s.code || p.system === s.name);
    const pages = list.map((p) => p.source_page).filter(Number.isFinite);
    const f = list.filter((p) => p.included_in_total), e = list.filter((p) => p.price_basis === "estimate");
    return {
      first_page: pages.length ? Math.min(...pages) : null, last_page: pages.length ? Math.max(...pages) : null,
      positions: list.length, priced: f.length, estimated: e.length,
      direct_cost_chf: r2(sum(f, (p) => p.direct_position_cost_chf)),
      estimated_cost_chf: r2(sum(e, (p) => p.direct_position_cost_chf)), ...s,
    };
  });

  return {
    ...output,
    schema_version: output.schema_version || "3.0",
    engine: output.engine || "backend",
    generated_at: output.generated_at || new Date().toISOString(),
    version: meta.version,
    source_tender_file: output.source_tender_file || meta.tenderName || null,
    tender: { extracted_positions: positions.length, ...(output.tender || {}) },
    position_results: positions,
    summary,
    estimated,
    indicative_total: cs.indicative_total || null,
    cost_note: cs.note || null,
    recommended_bid_range: bids,
    systems,
    kpis: {
      ...kpis(positions), ...(output.kpis || {}),
      firm_positions: firm.length, estimated_positions: est.length,
      not_priced_positions: positions.filter((p) => p.price_basis === "none").length,
    },
    productivity: rulesList(ctx),
    catalog: ctx.catalog.map((p) => ({
      product_id: p.product_id, category: p.category, description: p.description, unit: p.unit,
      net_cost_chf: p.net_cost_chf, source_type: p.source_type, install_code: p.install_code,
    })),
    warnings,
  };
}

// ---- built-in browser engine -------------------------------------------------------------------

/**
 * inputs = { version, parameters, catalog, productivity (parsed CSV rows), tenderPdf (Blob),
 *            tenderName, onProgress(text) }
 */
export async function computeEstimation(inputs) {
  const { onProgress } = inputs;
  const ctx = buildContext(inputs.parameters, inputs.catalog, inputs.productivity);
  const warnings = [];

  onProgress?.("Reading tender PDF…");
  const tender = await parseTender(inputs.tenderPdf, (i, n) => onProgress?.(`Reading tender PDF… page ${i} / ${n}`));
  if (!tender.positions.length) {
    warnings.push("No bill-of-quantities positions found in the tender PDF. The built-in reader expects pages with "
      + "unit and quantity columns (e.g. \"Mass-Gattg.\" / \"Massbetrag\"). Check the PDF or use the backend engine.");
  }

  onProgress?.("Matching positions…");
  // the airflow is often stated below the AHU's quantity line -> fall back to the system's airflow
  const sysAirflow = Object.fromEntries(tender.systems.map((s) => [s.code, s.airflow_m3h]));
  const positions = tender.positions.map((pos) => {
    pos.airflow_hint_m3h ??= sysAirflow[pos.system_code] ?? null;
    const m = matchPosition(pos, ctx.catalog);
    const c = roundCosts(costPosition(pos.quantity, pos.unit, m, ctx));
    return {
      lv_id: pos.lv_id,
      system: pos.system,
      system_code: pos.system_code,
      section: pos.section,
      source_page: pos.source_page,
      description: pos.description_de,
      category: m.category || null,
      manufacturer_hint: pos.manufacturer_hint,
      model_hint: pos.model_hint,
      matched_product_id: m.matched_product_id,
      install_code: m.install_code || (m.matched_product_id ? ctx.products[m.matched_product_id]?.install_code : null),
      ...c,
      tender_quantity: pos.quantity,
      tender_unit: pos.unit,
      match_confidence: m.match_confidence ?? null,
      review_required: m.status !== "calculated" && m.status !== "non_priceable",
      status: m.status,
      match_note: m.match_note || "",
      warning: pos.warning || "",
      bbox: pos.bbox,                                  // line position on the page (for the priced tender PDF)
      // kept so user edits can be re-costed; removed in finalizeResults
      labour_only_role: m.labour_only_role, quantity_factor: m.quantity_factor, unit_override: m.unit_override,
    };
  });

  onProgress?.("Calculating price…");
  return finalizeResults({
    engine: "browser",
    tender: { pages: tender.pageCount, lv_pages: tender.lvPages, extracted_positions: tender.positions.length },
    systems: tender.systems,
    position_results: positions,
    warnings,
  }, ctx, { version: inputs.version, tenderName: inputs.tenderName });
}
