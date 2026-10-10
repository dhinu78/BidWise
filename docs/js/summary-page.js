// Detailed summary of one version's results, shown below the dashboard.
//
// Shows the output as computed (built-in engine or backend). Backend outputs can separate
// firm prices (catalogue / supplier package, counted in the totals and the bid range) from side
// estimates (with a low–high range, never mixed into firm totals) and not-priced rows, and give a
// price flag + reason per row; the page shows those when present.
import { $, esc, chf, num, pct, busy, toast, downloadText, openDialog, closeDialog, stableJson, editKey } from "./ui.js";
import { CATEGORIES, CATEGORY, STATUSES, categorize, breakdown, viewOf, recommendedScenario, RECOMMENDATION_RULE, userStatus } from "./categories.js";

const BASIS = {
  firm: { label: "Firm", cls: "firm", title: "Catalogue or supplier-package price, counted in the totals" },
  estimate: { label: "Estimate", cls: "est", title: "Side estimate with a range, not in the firm totals" },
  none: { label: "Not priced", cls: "none", title: "No price (see reason)" },
};
const FLAG_LABELS = {
  catalogue: "Catalogue price", supplier_package: "Supplier package", size_scaled: "Scaled from nearest size",
  not_in_catalogue: "Not in catalogue", ambiguous_match: "Ambiguous match", covered_by_project_costs: "Covered by project costs",
  part_of_package: "Part of a package", no_size: "No size given", no_quantity: "No quantity", labour_rate: "Labour rate",
};
const flagLabel = (f) => (f ? FLAG_LABELS[f] || f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "–");
const reasonOf = (p) => p.status_reason || p.match_note || "";
const rangeText = (r) => (r && (r.low != null || r.high != null) ? `${chf(r.low)} – ${chf(r.high)}` : "–");
const isEst = (p) => p.price_basis === "estimate";

// `has` = column is shown only when some row has a value for it
const COLUMNS = [
  { key: "lv_id", label: "LV pos." },
  { key: "source_page", label: "Page", num: true },
  { key: "system", label: "System" },
  { key: "description", label: "Description", cls: "desc" },
  { key: "description_de", label: "Tender text", cls: "desc", has: (p) => p.description_de },
  { key: "matched_product_id", label: "Product" },
  { key: "install_code", label: "Install code" },
  { key: "quantity", label: "Qty", num: true, fmt: (v) => num(v) },
  { key: "unit", label: "Unit" },
  { key: "net_unit_cost_chf", label: "Unit cost CHF", num: true, fmt: chf, money: true },
  { key: "material_cost_chf", label: "Material CHF", num: true, fmt: chf, total: true, money: true },
  { key: "adjusted_install_hours", label: "Hours", num: true, fmt: (v) => num(v), total: true, money: true },
  { key: "labour_cost_chf", label: "Labour CHF", num: true, fmt: chf, total: true, money: true },
  { key: "direct_position_cost_chf", label: "Direct CHF", num: true, fmt: chf, total: true, money: true },
  { key: "price_basis", label: "Price basis" },
  { key: "_range", label: "Estimate range CHF", num: true, has: (p) => p.price_range_chf },
  { key: "match_confidence", label: "Confidence", num: true, fmt: (v) => (v == null ? "–" : pct(v * 100, 0)) },
  { key: "_category", label: "Status" },
  { key: "price_flag", label: "Price flag", has: (p) => p.price_flag },
  { key: "_reason", label: "Reason / assumption", cls: "note" },
  { key: "_edit", label: "" },
];

let ctx;
const view = { version: null, results: null, filter: "all", basis: "all", flag: null, q: "", sort: { key: "lv_id", dir: 1 } };

export function initSummaryPage(context) {
  ctx = context;
  initColumnResize();
  $("summaryVersion").onchange = (e) => busy(() => loadVersion(+e.target.value));
  const body = $("summaryBody");
  body.addEventListener("input", (e) => { if (e.target.id === "sumSearch") { view.q = e.target.value; renderTable(); } });
  body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) { view.filter = chip.dataset.filter; refreshList(); }
    const basis = e.target.closest("[data-basis]");
    if (basis) { view.basis = basis.dataset.basis; refreshList(); }
    const flag = e.target.closest("[data-flag]");
    if (flag) {
      view.flag = flag.dataset.flag === view.flag || flag.dataset.flag === "" ? null : flag.dataset.flag;
      refreshList();
      if (!flag.closest(".chips")) $("sumTable").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const th = e.target.closest("th[data-sort]");
    if (th && !e.target.closest(".col-grip") && Date.now() - resizedAt > 300) {
      const k = th.dataset.sort;
      view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : 1 };
      renderTable();
    }
    const page = e.target.closest("[data-src-page]");      // not [data-page]: <body> carries that one
    if (page) { e.preventDefault(); openSourcePage(+page.dataset.srcPage); }
    const edit = e.target.closest("[data-edit]");
    if (edit) editPosition(edit.dataset.edit);
    if (e.target.closest("#sumExport")) exportCsv();
    if (e.target.closest("#sumOutput")) openStorageFile(`${view.version.folder}/output.json`);
  });
}

export async function showSummaryPage({ keepView = false } = {}) {
  const versions = await ctx.store.listVersions(ctx.state.user.uid, ctx.state.project.id);
  const ok = versions.filter((v) => v.files);
  $("summaryVersion").innerHTML = ok.length
    ? ok.map((v) => `<option value="${v.version}">v${v.version} · ${new Date(v.createdAt).toLocaleDateString()}${v.results ? "" : " (no results)"}</option>`).join("")
    : `<option value="">no versions yet</option>`;
  const current = ok.find((v) => v.version === ctx.state.project.currentVersion) || ok[0];
  if (!keepView) Object.assign(view, { filter: "all", basis: "all", flag: null, q: "" });
  if (current) { $("summaryVersion").value = current.version; await loadVersion(current.version, current); }
  else { view.version = null; view.results = null; renderBody(); }
}

async function loadVersion(n, doc) {
  const v = doc || await ctx.store.getVersion(ctx.state.user.uid, ctx.state.project.id, n);
  view.version = v;
  view.results = v?.results || null;
  renderBody();
}

const overrides = () => ctx.state.project.parameters.position_overrides || {};
/** Position edits saved on the project but not yet in the shown version (ids). */
function pendingEdits() {
  const now = overrides();
  const sent = (view.version?.input_parameters || view.version?.parameters || {}).position_overrides || {};
  const ids = new Set([...Object.keys(now), ...Object.keys(sent)]);
  return new Set([...ids].filter((id) => editKey(now[id]) !== editKey(sent[id])));
}

// ---- cards -----------------------------------------------------------------------------------

function costCard(r, s) {
  const label = (k) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const line = (text, v, cls = "") => (v == null ? "" : `<tr class="${cls}"><td>${text}</td><td class="num">${chf(v)}</td></tr>`);
  const lineRange = (text, v, lo, hi, cls = "") => (v == null ? "" : `<tr class="${cls}"><td>${text}</td><td class="num">${chf(v)}${lo != null ? `<br><small>${chf(lo)} – ${chf(hi)}</small>` : ""}</td></tr>`);
  const detailed = s.catalog_material_chf != null || s.supplier_packages_chf != null;
  const est = r.estimated, ind = r.indicative_total;
  return `<div class="card"><h3>Cost build-up</h3>
    ${est ? `<p class="card-sub">Firm prices (catalogue and supplier packages): basis of the totals and the bid range.</p>` : ""}
    <table class="mini"><tbody>
      ${detailed ? line("Catalogue material (incl. waste)", s.catalog_material_chf) + line("Supplier packages", s.supplier_packages_chf)
        + line("Small material", s.small_material_chf) + line("Supplier package contingency", s.supplier_contingency_chf)
        : line("Material", s.material_cost_chf)}
      ${(() => {
        const firm = (r.position_results || []).filter((p) => p.included_in_total);
        const h = firm.reduce((a, p) => a + (+p.adjusted_install_hours || 0), 0);
        return line(h ? `Installation labour <small>(${num(h, 0)} h${s.labour_cost_chf ? ` · avg CHF ${chf(s.labour_cost_chf / h)}/h` : ""})</small>` : "Installation labour", s.labour_cost_chf);
      })()}
      ${s.custom_allowances_chf ? line("Custom allowances", s.custom_allowances_chf) : ""}
      ${(s.project_costs || []).map((l) => `<tr><td>${esc(label(l.label || l.key || ""))}${l.hours != null ? ` <small>(${num(l.hours)} h × ${chf(l.rate)})</small>` : ""}</td><td class="num">${chf(l.chf)}</td></tr>`).join("")}
      ${line("Transport &amp; equipment", s.transport_equipment_chf)}
      ${line(detailed ? "Project direct cost" : est ? "Firm direct cost" : "Direct cost", s.direct_cost_chf, "total")}
      ${line("Overhead", s.overhead_chf)}
      ${line(est ? "Firm cost baseline" : "Cost baseline", s.cost_baseline_chf, "total")}
    </tbody></table>
    ${est ? `<h4 class="card-h4">Estimated <small>(${num(est.rows ?? r.kpis?.estimated_positions, 0)} positions, side estimates – not in the firm totals)</small></h4>
      <table class="mini"><tbody>
        ${line("Material", est.material_cost_chf)}${line(`Labour${(() => {
          const h = (r.position_results || []).filter(isEst).reduce((a, p) => a + (+p.adjusted_install_hours || 0), 0);
          return h ? ` <small>(${num(h, 0)} h)</small>` : "";
        })()}`, est.labour_cost_chf)}
        ${lineRange("Direct cost", est.direct_cost_chf, est.low_chf, est.high_chf, "total")}
      </tbody></table>` : ""}
    ${ind ? `<h4 class="card-h4">Indicative total <small>(firm + estimated, for orientation)</small></h4>
      <table class="mini"><tbody>
        ${lineRange("Direct cost", ind.direct_cost_chf, ind.direct_cost_low_chf, ind.direct_cost_high_chf)}
        ${lineRange("Cost baseline", ind.cost_baseline_chf, ind.cost_baseline_low_chf, ind.cost_baseline_high_chf, "total")}
      </tbody></table>` : ""}
    ${r.kpis?.not_priced_positions ? `<p class="card-sub">${num(r.kpis.not_priced_positions, 0)} positions not priced (see price flags).</p>` : ""}
    ${r.cost_note ? `<p class="card-sub">${esc(r.cost_note)}</p>` : ""}
  </div>`;
}

function bidCard(range) {
  if (!range) return "";
  const rec = recommendedScenario(range);
  return `<div class="card"><h3>${esc(range.name || "Recommended Bid Range")}</h3>
    <table class="mini"><thead><tr><th>Scenario</th><th class="num">Bid CHF</th><th class="num">Margin</th><th class="num">Win prob.</th><th class="num">Exp. contribution</th></tr></thead><tbody>
    ${(range.scenarios || []).map((s) => `<tr${s.scenario === rec ? ' style="font-weight:700"' : ""}>
      <td>${esc(s.scenario)}${s.scenario === rec ? ` <small title="Current rule: ${RECOMMENDATION_RULE}">· recommended</small>` : ""}</td><td class="num">${chf(s.bid_price_chf)}</td><td class="num">${pct(s.margin_pct, 1)}</td>
      <td class="num">${pct(s.estimated_win_probability * 100, 0)}</td><td class="num">${chf(s.expected_contribution_chf)}</td></tr>`).join("")}
    ${range.reference_price_chf != null ? `<tr class="sub"><td colspan="5">Reference price at target margin: ${chf(range.reference_price_chf)} CHF</td></tr>` : ""}
    ${range.basis ? `<tr class="sub"><td colspan="5">Basis: ${esc(range.basis)}</td></tr>` : ""}
    ${rec ? `<tr class="sub"><td colspan="5">Recommended: the scenario with the ${RECOMMENDATION_RULE}.</td></tr>` : ""}
    </tbody></table></div>`;
}

function flagsCard(list) {
  const groups = {};
  for (const p of list) {
    const k = p.price_flag;
    if (!k) continue;
    const g = (groups[k] ??= { n: 0, basis: {}, chf: 0 });
    g.n++;
    g.basis[p.price_basis] = (g.basis[p.price_basis] || 0) + 1;
    g.chf += Number(p.direct_position_cost_chf) || 0;
  }
  const entries = Object.entries(groups).sort((a, b) => b[1].n - a[1].n);
  if (!entries.length) return "";
  return `<div class="card"><h3>Why positions are priced this way</h3>
    <p class="card-sub">Price flag per position. Click a row to list those positions.</p>
    <table class="mini why"><thead><tr><th>Price flag</th><th>Basis</th><th class="num">Positions</th><th class="num">Direct CHF</th></tr></thead><tbody>
    ${entries.map(([k, g]) => `<tr data-flag="${esc(k)}" class="${view.flag === k ? "on" : ""}"><td>${esc(flagLabel(k))}</td>
      <td>${Object.keys(g.basis).map((b) => `<span class="badge ${BASIS[b]?.cls || ""}">${BASIS[b]?.label || b}</span>`).join(" ")}</td>
      <td class="num">${g.n}</td><td class="num">${g.chf ? chf(g.chf) : "–"}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function systemsCard(r) {
  const systems = r.systems || [];
  if (!systems.length) return "";
  const est = systems.some((s) => s.estimated);
  // installation hours of the counted positions per system (same system match as the totals)
  const pos = r.position_results || [];
  const hoursOf = (s) => pos.filter((p) => p.included_in_total
      && ((p.system_code ?? String(p.system || "").split(" ")[0]) === s.code || p.system === s.name))
    .reduce((a, p) => a + (+p.adjusted_install_hours || 0), 0);
  for (const s of systems) s._hours = hoursOf(s);
  const tot = (k) => systems.reduce((a, s) => a + (s[k] || 0), 0);
  return `<div class="card"><h3>Systems in the tender</h3>
    <table class="mini"><thead><tr><th>System</th><th class="num">Pages</th><th class="num">Positions</th><th class="num">${est ? "Firm" : "Priced"}</th>
      ${est ? '<th class="num">Est.</th>' : ""}<th class="num">Hours</th><th class="num">${est ? "Firm CHF" : "Direct CHF"}</th>${est ? '<th class="num">Estimated CHF</th>' : ""}</tr></thead><tbody>
    ${systems.map((s) => `<tr><td>${esc(s.name)}${s.airflow_m3h ? ` <small>· ${num(s.airflow_m3h, 0)} m³/h</small>` : ""}</td>
      <td class="num">${s.first_page ?? "–"}–${s.last_page ?? "–"}</td><td class="num">${s.positions}</td><td class="num">${s.priced}</td>
      ${est ? `<td class="num">${s.estimated}</td>` : ""}<td class="num">${num(s._hours, 0)}</td><td class="num">${chf(s.direct_cost_chf)}</td>${est ? `<td class="num">${chf(s.estimated_cost_chf)}</td>` : ""}</tr>`).join("")}
    <tr class="total"><td>Total</td><td></td><td class="num">${tot("positions")}</td><td class="num">${tot("priced")}</td>
      ${est ? `<td class="num">${tot("estimated")}</td>` : ""}<td class="num">${num(tot("_hours"), 0)}</td><td class="num">${chf(tot("direct_cost_chf"))}</td>${est ? `<td class="num">${chf(tot("estimated_cost_chf"))}</td>` : ""}</tr>
    </tbody></table></div>`;
}

// ---- page ------------------------------------------------------------------------------------

function renderBody() {
  const body = $("summaryBody");
  const r = view.results;
  if (!r) {
    body.innerHTML = `<div class="empty-state card">
      <h3>${view.version ? `Version ${view.version.version} has no calculated results` : "No versions yet"}</h3>
      <p>${view.version
        ? (view.version.computeError ? `The calculation failed: ${esc(view.version.computeError)}` : "Click Re-compute on the dashboard to calculate it.")
        : "Upload the tender, catalog and productivity files on the dashboard, then click Compute."}</p></div>`;
    return;
  }
  const v = viewOf(r);
  const b = breakdown(v);
  const s = v.summary;
  const range = v.bids;
  const all = v.positions;
  const nBasis = (k) => all.filter((p) => p.price_basis === k).length;
  const hasEst = nBasis("estimate") > 0;
  const pendingOverrides = pendingEdits().size;
  const warnings = [...(r.warnings || [])];
  if (pendingOverrides) warnings.push(`${pendingOverrides} position edit(s) are saved but not in this version yet – click Re-compute on the dashboard.`);
  const t = r.tender || {};
  const info = [r.source_tender_file, t.pages ? `${num(t.pages, 0)} pages` : "", t.trade ? `trade: ${t.trade}` : "",
    `computed ${new Date(r.generated_at || view.version.createdAt).toLocaleString()}`, r.engine === "backend" ? "backend engine" : r.engine && r.engine !== "browser" ? r.engine : ""]
    .filter(Boolean).map(esc).join(" · ");
  const lowConf = Number.isFinite(t.layout_confidence) && t.layout_confidence < 0.8;

  body.innerHTML = `
    ${warnings.length ? `<div class="warn-box">${warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="toolbar">
      <span style="color:var(--muted);font-size:13px">${info}${Number.isFinite(t.layout_confidence)
        ? ` · <span class="${lowConf ? "conf-warn" : ""}" title="How sure the backend is that it read the tender layout correctly">layout confidence ${pct(t.layout_confidence * 100, 0)}</span>` : ""}</span>
    </div>
    <div class="tiles">
      <div class="tile"><small>Positions</small><b>${num(b.total, 0)}</b></div>
      <div class="tile"><small>${hasEst ? "Firm prices" : "Priced positions"}</small><b>${num(hasEst ? nBasis("firm") : all.filter((p) => p.included_in_total).length, 0)}</b></div>
      ${hasEst ? `<div class="tile"><small>Estimated</small><b>${num(nBasis("estimate"), 0)}</b></div>`
        : `<div class="tile"><small>Materials found</small><b>${num(b.materials, 0)}</b></div>`}
      <div class="tile"><small>Not priced</small><b>${num(all.filter((p) => !p.included_in_total && p.price_basis !== "estimate").length, 0)}</b></div>
      <div class="tile"><small>Supplier quotes needed</small><b>${num(b.counts.supplier_quote_required, 0)}</b></div>
      <div class="tile"><small>Manual review</small><b>${pct(b.manual, 0)}</b></div>
    </div>
    <div class="cost-strip">
      <div class="tile"><small>${hasEst ? "Firm material" : "Material"} CHF</small><b>${chf(s.material_cost_chf)}</b></div>
      <div class="tile"><small>${hasEst ? "Firm labour" : "Labour"} CHF</small><b>${chf(s.labour_cost_chf)}</b></div>
      <div class="tile"><small>${hasEst ? "Firm direct" : "Direct"} CHF</small><b>${chf(s.direct_cost_chf)}</b></div>
      <div class="tile"><small>${hasEst ? "Firm baseline" : "Baseline"} CHF</small><b>${chf(s.cost_baseline_chf)}</b></div>
      <div class="tile"><small>${esc(range?.name || "Recommended bid range")} CHF</small><b>${range?.low_chf != null ? `${chf(range.low_chf)} – ${chf(range.high_chf)}` : "–"}</b></div>
    </div>
    ${r.indicative_total ? `<div class="cost-strip ind">
      <div class="tile"><small>Estimated direct CHF (side estimates)</small><b>${chf(r.estimated?.direct_cost_chf)}</b>
        ${r.estimated?.low_chf != null ? `<em>${chf(r.estimated.low_chf)} – ${chf(r.estimated.high_chf)}</em>` : ""}</div>
      <div class="tile"><small>Indicative direct CHF (firm + estimated)</small><b>${chf(r.indicative_total.direct_cost_chf)}</b>
        <em>${chf(r.indicative_total.direct_cost_low_chf)} – ${chf(r.indicative_total.direct_cost_high_chf)}</em></div>
      <div class="tile"><small>Indicative baseline CHF</small><b>${chf(r.indicative_total.cost_baseline_chf)}</b>
        <em>${chf(r.indicative_total.cost_baseline_low_chf)} – ${chf(r.indicative_total.cost_baseline_high_chf)}</em></div>
    </div>` : ""}
    <div class="split">
      ${costCard(r, s)}
      <div style="display:flex;flex-direction:column;gap:16px">
        ${bidCard(range)}
        ${flagsCard(all)}
        ${systemsCard(r)}
        ${r.parameter_changes?.length ? `<div class="card"><h3>Parameters updated by the backend</h3><table class="mini"><tbody>
          ${r.parameter_changes.map((c) => `<tr><td>${esc(c.path)}</td><td class="num">${esc(c.from ?? "–")} → <b>${esc(c.to ?? "–")}</b></td></tr>`).join("")}
        </tbody></table></div>` : ""}
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="sumSearch" placeholder="Search position, text, product, reason…" value="${esc(view.q)}">
      <span class="spacer"></span>
      ${r.engine === "backend" && view.version?.folder ? `<button class="btn ghost small" id="sumOutput">Backend output (JSON)</button>` : ""}
      <button class="btn ghost small" id="sumExport">Export CSV</button>
    </div>
    <div class="toolbar"><div class="chips" id="sumChips"></div></div>
    <div class="toolbar" id="sumBasisBar"><div class="chips" id="sumBasis"></div></div>
    <div class="table-wrap"><table id="sumTable"></table></div>`;
  $("sumBasisBar").hidden = !hasEst;
  renderChips();
  renderTable();
}

function refreshList() {
  renderChips();
  renderTable();
  document.querySelectorAll(".why tr[data-flag]").forEach((tr) => tr.classList.toggle("on", tr.dataset.flag === view.flag));
}

function rows() {
  return viewOf(view.results).positions.map((p) => ({
    ...p, _category: categorize(p), _reason: reasonOf(p), _range: p.price_range_chf?.low ?? null,
  }));
}

function renderChips() {
  const all = rows();
  const count = (k) => all.filter((p) => p._category === k).length;
  $("sumChips").innerHTML = [`<button class="chip ${view.filter === "all" ? "on" : ""}" data-filter="all">All statuses ${all.length}</button>`]
    .concat(CATEGORIES.filter((c) => count(c.key)).map((c) =>
      `<button class="chip ${view.filter === c.key ? "on" : ""}" data-filter="${c.key}"><i style="background:${c.color}"></i>${c.label} ${count(c.key)}</button>`))
    .join("");
  const nb = (k) => all.filter((p) => p.price_basis === k).length;
  $("sumBasis").innerHTML = [`<button class="chip ${view.basis === "all" ? "on" : ""}" data-basis="all">All prices</button>`]
    .concat(Object.entries(BASIS).filter(([k]) => nb(k)).map(([k, d]) =>
      `<button class="chip ${view.basis === k ? "on" : ""}" data-basis="${k}" title="${esc(d.title)}"><span class="badge ${d.cls}">${d.label}</span> ${nb(k)}</button>`))
    .concat(view.flag ? [`<button class="chip on" data-flag="" title="Clear the price-flag filter">Flag: ${esc(flagLabel(view.flag))} ×</button>`] : [])
    .join("");
  if (view.flag && $("sumBasisBar")) $("sumBasisBar").hidden = false;
}

function filtered() {
  const q = view.q.trim().toLowerCase();
  const { key, dir } = view.sort;
  return rows()
    .filter((p) => view.filter === "all" || p._category === view.filter)
    .filter((p) => view.basis === "all" || p.price_basis === view.basis)
    .filter((p) => !view.flag || p.price_flag === view.flag)
    .filter((p) => !q || [p.lv_id, p.row_id, p.matched_product_id, p.install_code, p.description, p.description_de, p.system,
      p.chapter, p.subcategory, p._reason, flagLabel(p.price_flag), p.alternatives]
      .some((v) => String(v ?? "").toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? ""), "de", { numeric: true }) * dir;
    });
}

function visibleColumns() {
  const all = viewOf(view.results).positions;
  return COLUMNS.filter((c) => !c.has || all.some((p) => c.has(p)));
}

function cellHtml(p, c, pending) {
  switch (c.key) {
    case "_category": {
      const cat = CATEGORY[p._category];
      const label = cat.label;
      return `<td><span class="status"><i style="background:${cat.color}"></i>${label}</span></td>`;
    }
    case "lv_id":
      return `<td title="${esc(p.row_id || "")}">${esc(p.lv_id)}${pending ? '<span class="pending" title="Edited – Re-compute to apply">edited</span>' : ""}</td>`;
    case "source_page":
      return `<td class="num"><a href="#" data-src-page="${p.source_page}" title="Open the tender PDF at page ${p.source_page}">${p.source_page ?? "–"}</a></td>`;
    case "system":
      return `<td title="${esc([p.system, p.chapter].filter(Boolean).join(" · "))}">${esc((p.system || "").replace(/^\d{3}\.\d{1,2}\s*/, ""))}</td>`;
    case "description":
      return `<td class="desc" title="${esc([p.description, p.subcategory, p.chapter].filter(Boolean).join(" · "))}">${esc(p.description || p.description_de || "–")}</td>`;
    case "price_basis": {
      const d = BASIS[p.price_basis] || BASIS.none;
      return `<td><span class="badge ${d.cls}" title="${esc(d.title)}">${d.label}</span></td>`;
    }
    case "_range": {
      const e = p.estimate;
      const title = e ? [e.method, e.basis, e.range_pct != null ? `±${e.range_pct} %` : ""].filter(Boolean).join(" · ") : "";
      return `<td class="num" title="${esc(title)}">${rangeText(p.price_range_chf)}</td>`;
    }
    case "price_flag":
      return `<td>${esc(flagLabel(p.price_flag))}</td>`;
    case "_reason":
      return `<td class="note" title="${esc(p._reason)}">${esc(p._reason || "–")}</td>`;
    case "_edit":
      return `<td><button class="edit" data-edit="${esc(p.lv_id)}">Edit</button></td>`;
    default: {
      const v = p[c.key];
      const text = c.fmt ? c.fmt(v) : esc(v ?? "–");
      const est = c.money && isEst(p) && v != null ? " est" : "";
      return `<td class="${c.num ? "num" : ""} ${c.cls || ""}${est}"${c.cls ? ` title="${esc(v ?? "")}"` : ""}>${text}</td>`;
    }
  }
}

function renderTable() {
  const list = filtered();
  const cols = visibleColumns();
  const ov = overrides();
  const pending = pendingEdits();
  const arrow = (k) => (view.sort.key === k ? (view.sort.dir > 0 ? " ▲" : " ▼") : "");
  const head = `<thead><tr>${cols.map((c) => `<th ${c.key === "_edit" ? "" : `data-sort="${c.key}"`} class="${c.num ? "num" : ""}">${c.label}${arrow(c.key)}${c.key === "_edit" ? ""
    : `<span class="col-grip" data-grip="${c.key}" title="Drag to resize · double-click to reset"></span>`}</th>`).join("")}</tr></thead>`;
  const body = list.map((p) => `<tr class="${p.overridden || ov[p.lv_id] ? "overridden" : ""}${isEst(p) ? " est-row" : ""}">${cols.map((c) => cellHtml(p, c, pending.has(p.lv_id))).join("")}</tr>`).join("");

  // footer: firm (counted) total, plus a separate line for side estimates
  const totalRow = (label, items, extraCls = "", withRange = false) => `<tr class="${extraCls}">${cols.map((c, i) => {
    if (i === 0) return `<td colspan="2">${label}</td>`;
    if (i === 1) return "";
    if (c.key === "_range" && withRange) {
      const lo = items.reduce((s, p) => s + (p.price_range_chf?.low ?? 0), 0), hi = items.reduce((s, p) => s + (p.price_range_chf?.high ?? 0), 0);
      return `<td class="num">${chf(lo)} – ${chf(hi)}</td>`;
    }
    if (!c.total) return "<td></td>";
    return `<td class="num">${c.fmt(items.reduce((s, p) => s + (Number(p[c.key]) || 0), 0))}</td>`;
  }).join("")}</tr>`;
  const included = list.filter((p) => p.included_in_total);
  const estimates = list.filter(isEst);
  const hasEst = viewOf(view.results).positions.some(isEst);
  const foot = `<tfoot>${totalRow(`${hasEst ? "Firm total" : "Total priced"} (${included.length} / ${list.length})`, included)}
    ${estimates.length ? totalRow(`Estimated, not in total (${estimates.length})`, estimates, "est-total", true) : ""}</tfoot>`;
  $("sumTable").innerHTML = head + `<tbody>${body || `<tr><td colspan="${cols.length}" class="empty-state">No positions match.</td></tr>`}</tbody>` + foot;
  applyColumnWidths(cols);
}

// ---- resizable columns -----------------------------------------------------------------------------
// Drag the right edge of a heading; double-click it to go back to the automatic width. Widths are
// kept per column in this browser.

const WIDTHS_KEY = "bidwise.summaryColumnWidths";
let widths = {};
try { widths = JSON.parse(localStorage.getItem(WIDTHS_KEY)) || {}; } catch {}
let resizedAt = 0;                                        // a drag must not also sort the column

function applyColumnWidths(cols = visibleColumns()) {
  let style = document.getElementById("sumColWidths");
  if (!style) { style = document.createElement("style"); style.id = "sumColWidths"; document.head.append(style); }
  style.textContent = cols.map((c, i) => (widths[c.key]
    ? `#sumTable thead th:nth-child(${i + 1}), #sumTable tbody td:nth-child(${i + 1}) { width: ${widths[c.key]}px; min-width: ${widths[c.key]}px; max-width: ${widths[c.key]}px; overflow: hidden; text-overflow: ellipsis; }`
    : "")).join("\n");
}

function initColumnResize() {
  const body = $("summaryBody");
  body.addEventListener("pointerdown", (e) => {
    const grip = e.target.closest(".col-grip");
    if (!grip) return;
    e.preventDefault();
    const th = grip.parentElement, key = grip.dataset.grip;
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    const move = (ev) => { widths[key] = Math.max(48, Math.round(w0 + ev.clientX - x0)); applyColumnWidths(); };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      document.body.classList.remove("col-resizing");
      resizedAt = Date.now();
      try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); } catch {}
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  body.addEventListener("dblclick", (e) => {
    const grip = e.target.closest(".col-grip");
    if (!grip) return;
    delete widths[grip.dataset.grip];
    resizedAt = Date.now();
    applyColumnWidths();
    try { localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths)); } catch {}
  });
}

// ---- source traceability -------------------------------------------------------------------

async function openStorageFile(path, hash = "") {
  const win = window.open("", "_blank");
  try {
    const url = await ctx.store.fileUrl(path);
    if (win) win.location.href = url + hash;
    else window.open(url + hash, "_blank", "noopener");
  } catch (e) {
    win?.close();
    toast(e.message || String(e), true);
  }
}

function openSourcePage(page) {
  const path = view.version?.files?.tender?.storagePath;
  if (!path) return toast("The tender file of this version is not available.", true);
  return openStorageFile(path, `#page=${page}`);
}

// ---- user corrections ------------------------------------------------------------------------

function editPosition(lvId) {
  const p = view.results.position_results.find((x) => x.lv_id === lvId);
  if (!p) return;
  const o = overrides()[lvId] || {};
  const catalog = view.results.catalog || [];
  const productValue = o.product_id !== undefined ? o.product_id : "__keep";
  const groups = {};
  for (const c of catalog) (groups[c.category] ??= []).push(c);
  const alternatives = String(p.alternatives || "").split(/[,;|]/).map((x) => x.trim()).filter(Boolean)
    .map((id) => catalog.find((c) => c.product_id === id) || { product_id: id, description: "not in this catalogue" });
  const optionHtml = (c) => `<option value="${esc(c.product_id)}">${esc(c.product_id)} – ${esc(c.description)}${c.net_cost_chf != null ? ` (${chf(c.net_cost_chf)} / ${esc(c.unit)})` : ""}${c.source_type === "supplier_package" ? " · supplier package" : ""}</option>`;
  const e = p.estimate;
  const d = BASIS[p.price_basis] || BASIS.none;
  // "Automatic" keeps the engine's classification; a status saved by an earlier edit is pointed out
  const engineLabel = CATEGORY[categorize(p.original ? { ...p, ...p.original } : p)].label;
  const savedStatus = o.status ? (STATUSES.find(([k]) => k === userStatus(o.status))?.[1] || o.status) : null;

  openDialog(`Edit ${lvId}${p.row_id ? ` · ${p.row_id}` : ""}`, `
    <div class="src-box">
      ${p.description ? `<div><b>Description</b> ${esc(p.description)}${p.subcategory ? ` <small>(${esc(p.subcategory)})</small>` : ""}</div>` : ""}
      ${p.description_de ? `<div><b>Tender text</b> ${esc(p.description_de)}</div>` : ""}
      <div><b>System</b> ${esc(p.system || "–")}${p.chapter ? ` · ${esc(p.chapter)}` : ""} · page <a href="#" id="dlgPage">${p.source_page}</a></div>
      ${p.manufacturer_hint || p.model_hint ? `<div><b>Hints</b> ${esc([p.manufacturer_hint, p.model_hint].filter(Boolean).join(" · "))}</div>` : ""}
      <div><b>Result</b> ${esc(p.matched_product_id || "no product")} · ${esc(CATEGORY[categorize(p)].label)} · <span class="badge ${d.cls}">${d.label}</span>${p.price_flag ? ` · ${esc(flagLabel(p.price_flag))}` : ""}</div>
      ${reasonOf(p) ? `<div><b>Reason</b> ${esc(reasonOf(p))}</div>` : ""}
      ${e ? `<div><b>Estimate</b> ${esc([e.method, e.basis].filter(Boolean).join(": "))}${p.price_range_chf ? ` · range ${rangeText(p.price_range_chf)} CHF` : ""}</div>` : ""}
    </div>
    <div class="form-grid">
      <label for="ovProduct">Product</label>
      <select id="ovProduct">
        <option value="__keep">Keep result (${esc(p.matched_product_id || "none")})</option>
        <option value="">No product (manual pricing)</option>
        ${alternatives.length ? `<optgroup label="Suggested alternatives">${alternatives.map(optionHtml).join("")}</optgroup>` : ""}
        ${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(optionHtml).join("")}</optgroup>`).join("")}
      </select>
      <label for="ovQty">Quantity (${esc(p.unit || "")})</label>
      <input id="ovQty" type="number" step="any" placeholder="${p.tender_quantity ?? p.quantity ?? "not in tender"}" value="${o.quantity ?? ""}">
      <label for="ovPrice">Unit price CHF</label>
      <input id="ovPrice" type="number" step="any" placeholder="${p.net_unit_cost_chf ?? "e.g. from a supplier quote"}" value="${o.unit_price_chf ?? ""}">
      <label for="ovStatus">Status</label>
      <div><select id="ovStatus"><option value="">Automatic (keep: ${esc(engineLabel)})</option>${STATUSES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
        ${savedStatus ? `<small style="display:block;color:var(--danger);margin-top:4px">"${esc(savedStatus)}" was set in an earlier edit. Choose Automatic to go back to the computed status.</small>` : ""}</div>
      <label for="ovNote">Note</label>
      <input id="ovNote" type="text" placeholder="Why the change (optional)" value="${esc(o.note || "")}">
    </div>
    <p style="color:var(--muted);font-size:13px;margin:14px 0 0"><b>Save</b> applies the change right away: this position is re-priced and the totals and bids are updated (saved as an "edited in the app" version). A later Re-compute recalculates everything from the files.</p>`, [
    { label: "Remove edit", cls: "ghost", onClick: () => saveEdit(lvId, null) },
    { label: "Cancel", cls: "ghost", onClick: closeDialog },
    { label: "Save", cls: "navy", onClick: () => {
      const product = $("ovProduct").value;
      const edit = {};
      if (product !== "__keep") edit.product_id = product;
      if ($("ovQty").value !== "") edit.quantity = Number($("ovQty").value);
      if ($("ovPrice").value !== "") edit.unit_price_chf = Number($("ovPrice").value);
      if ($("ovStatus").value) edit.status = $("ovStatus").value;
      if ($("ovNote").value.trim()) edit.note = $("ovNote").value.trim();
      saveEdit(lvId, Object.keys(edit).length ? edit : null);
    } },
  ]);
  $("ovProduct").value = productValue;
  $("ovStatus").value = userStatus(o.status) || "";
  $("dlgPage").onclick = (ev) => { ev.preventDefault(); openSourcePage(p.source_page); };
}

function saveEdit(lvId, edit) {
  closeDialog();
  busy(async () => {
    const r = await ctx.saveEdits({ positions: { [lvId]: edit } }, edit ? `Edited ${lvId}` : `Removed the edit of ${lvId}`);
    toast(r.savedOnly
      ? `${lvId} saved. It is applied at the next ${ctx.state.project.currentVersion ? "Re-compute" : "Compute"} (${r.reason}).`
      : `${edit ? `${lvId} updated` : `Edit of ${lvId} removed`}: prices and totals recalculated, ${r.created ? `saved as version ${r.version}` : `version ${r.version} updated`}.`);
  });
}

// ---- export ------------------------------------------------------------------------------------

function exportCsv() {
  // Semicolon + decimal comma so Excel (German/Swiss settings) opens it correctly.
  const cell = (v) => {
    if (typeof v === "number") return String(v).replace(".", ",");
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = [
    ["LV pos.", (p) => p.lv_id], ["Row id", (p) => p.row_id], ["Page", (p) => p.source_page], ["System", (p) => p.system],
    ["Chapter", (p) => p.chapter], ["Description", (p) => p.description], ["Tender text", (p) => p.description_de],
    ["Product", (p) => p.matched_product_id], ["Install code", (p) => p.install_code], ["Qty", (p) => p.quantity], ["Unit", (p) => p.unit],
    ["Unit cost CHF", (p) => p.net_unit_cost_chf], ["Material CHF", (p) => p.material_cost_chf], ["Hours", (p) => p.adjusted_install_hours],
    ["Labour CHF", (p) => p.labour_cost_chf], ["Direct CHF", (p) => p.direct_position_cost_chf],
    ["Price basis", (p) => (BASIS[p.price_basis] || BASIS.none).label], ["In firm total", (p) => (p.included_in_total ? "yes" : "no")],
    ["Range low CHF", (p) => p.price_range_chf?.low], ["Range high CHF", (p) => p.price_range_chf?.high],
    ["Confidence", (p) => p.match_confidence], ["Status", (p) => CATEGORY[p._category].label],
    ["Price flag", (p) => (p.price_flag ? flagLabel(p.price_flag) : "")], ["Reason", (p) => p._reason], ["Alternatives", (p) => p.alternatives],
  ];
  const lines = [cols.map(([l]) => cell(l)).join(";")].concat(filtered().map((p) => cols.map(([, f]) => cell(f(p))).join(";")));
  const name = `${ctx.state.project.name.replace(/[^\w-]+/g, "_")}_v${view.version.version}_summary.csv`;
  downloadText(name, lines.join("\r\n"));
}
