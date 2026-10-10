// Page 3: Detailed summary of one version's results.
import { $, esc, chf, num, pct, busy, toast, downloadText, openDialog, closeDialog } from "./ui.js";
import { CATEGORIES, CATEGORY, STATUSES, SCOPES, categorize, breakdown, viewOf } from "./categories.js";

const COLUMNS = [
  { key: "lv_id", label: "LV pos." },
  { key: "source_page", label: "Page", num: true },
  { key: "system", label: "System" },
  { key: "description", label: "Tender text", cls: "desc" },
  { key: "matched_product_id", label: "Product" },
  { key: "install_code", label: "Install code" },
  { key: "quantity", label: "Qty", num: true, fmt: (v) => num(v) },
  { key: "unit", label: "Unit" },
  { key: "net_unit_cost_chf", label: "Unit cost CHF", num: true, fmt: chf },
  { key: "material_cost_chf", label: "Material CHF", num: true, fmt: chf, total: true },
  { key: "adjusted_install_hours", label: "Hours", num: true, fmt: (v) => num(v), total: true },
  { key: "labour_cost_chf", label: "Labour CHF", num: true, fmt: chf, total: true },
  { key: "direct_position_cost_chf", label: "Direct CHF", num: true, fmt: chf, total: true },
  { key: "price_source", label: "Price source" },
  { key: "match_confidence", label: "Confidence", num: true, fmt: (v) => (v == null ? "–" : pct(v * 100, 0)) },
  { key: "_category", label: "Status" },
  { key: "match_note", label: "Match / assumption", cls: "note" },
  { key: "_edit", label: "" },
];

let ctx;
const view = { version: null, results: null, scope: "full", filter: "all", q: "", sort: { key: "lv_id", dir: 1 } };

export function initSummaryPage(context) {
  ctx = context;
  $("summaryVersion").onchange = (e) => busy(() => loadVersion(+e.target.value));
  const body = $("summaryBody");
  body.addEventListener("input", (e) => { if (e.target.id === "sumSearch") { view.q = e.target.value; renderTable(); } });
  body.addEventListener("click", (e) => {
    const scope = e.target.closest("[data-sumscope]");
    if (scope) { view.scope = scope.dataset.sumscope; view.filter = "all"; return renderBody(); }
    const chip = e.target.closest("[data-filter]");
    if (chip) { view.filter = chip.dataset.filter; renderChips(); renderTable(); }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : 1 };
      renderTable();
    }
    const page = e.target.closest("[data-page]");
    if (page) { e.preventDefault(); openSourcePage(+page.dataset.page); }
    const edit = e.target.closest("[data-edit]");
    if (edit) editPosition(edit.dataset.edit);
    if (e.target.closest("#sumExport")) exportCsv();
  });
}

export async function showSummaryPage() {
  const versions = await ctx.store.listVersions(ctx.state.user.uid, ctx.state.project.id);
  const ok = versions.filter((v) => v.files);
  $("summaryVersion").innerHTML = ok.length
    ? ok.map((v) => `<option value="${v.version}">v${v.version} · ${new Date(v.createdAt).toLocaleDateString()}${v.results ? "" : " (no results)"}</option>`).join("")
    : `<option value="">no versions yet</option>`;
  const current = ok.find((v) => v.version === ctx.state.project.currentVersion) || ok[0];
  view.filter = "all"; view.q = ""; view.scope = ctx.state.scope || "full";
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

function costTable(s, scope) {
  if (scope === "verified") {
    return `<table class="mini"><tbody>
      <tr><td>Material (incl. waste)</td><td class="num">${chf(s.material_cost_chf)}</td></tr>
      <tr><td>Installation labour</td><td class="num">${chf(s.labour_cost_chf)}</td></tr>
      <tr class="total"><td>Direct cost</td><td class="num">${chf(s.direct_cost_chf)}</td></tr>
      <tr><td>Transport &amp; equipment</td><td class="num">${chf(s.transport_equipment_chf)}</td></tr>
      <tr><td>Overhead</td><td class="num">${chf(s.overhead_chf)}</td></tr>
      <tr class="total"><td>Cost baseline</td><td class="num">${chf(s.cost_baseline_chf)}</td></tr>
    </tbody></table>`;
  }
  const label = (k) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return `<table class="mini"><tbody>
    <tr><td>Catalogue material (incl. waste)</td><td class="num">${chf(s.catalog_material_chf)}</td></tr>
    <tr><td>Supplier packages</td><td class="num">${chf(s.supplier_packages_chf)}</td></tr>
    <tr><td>Small material</td><td class="num">${chf(s.small_material_chf)}</td></tr>
    <tr><td>Supplier package contingency</td><td class="num">${chf(s.supplier_contingency_chf)}</td></tr>
    <tr><td>Installation labour</td><td class="num">${chf(s.labour_cost_chf)}</td></tr>
    ${s.custom_allowances_chf ? `<tr><td>Custom allowances</td><td class="num">${chf(s.custom_allowances_chf)}</td></tr>` : ""}
    ${(s.project_costs || []).map((l) => `<tr><td>${esc(label(l.label))}${l.hours != null ? ` <small>(${num(l.hours)} h × ${chf(l.rate)})</small>` : ""}</td><td class="num">${chf(l.chf)}</td></tr>`).join("")}
    <tr><td>Transport &amp; equipment</td><td class="num">${chf(s.transport_equipment_chf)}</td></tr>
    <tr class="total"><td>Project direct cost</td><td class="num">${chf(s.direct_cost_chf)}</td></tr>
    <tr><td>Overhead</td><td class="num">${chf(s.overhead_chf)}</td></tr>
    <tr class="total"><td>Cost baseline</td><td class="num">${chf(s.cost_baseline_chf)}</td></tr>
  </tbody></table>`;
}

function bidTable(range) {
  if (!range) return "";
  return `<table class="mini"><thead><tr><th>Scenario</th><th class="num">Bid CHF</th><th class="num">Margin</th><th class="num">Win prob.</th><th class="num">Exp. contribution</th></tr></thead><tbody>
    ${range.scenarios.map((s) => `<tr${s.scenario === range.best_expected_contribution ? ' style="font-weight:700"' : ""}>
      <td>${esc(s.scenario)}</td><td class="num">${chf(s.bid_price_chf)}</td><td class="num">${pct(s.margin_pct, 1)}</td>
      <td class="num">${pct(s.estimated_win_probability * 100, 0)}</td><td class="num">${chf(s.expected_contribution_chf)}</td></tr>`).join("")}
    <tr class="sub"><td colspan="5">Reference price at target margin: ${chf(range.reference_price_chf)} CHF</td></tr>
  </tbody></table>`;
}

function systemsTable(r) {
  const systems = r.systems || [];
  if (!systems.length) return "";
  return `<table class="mini"><thead><tr><th>System</th><th class="num">Pages</th><th class="num">Positions</th><th class="num">Priced</th><th class="num">Direct CHF</th></tr></thead><tbody>
    ${systems.map((s) => `<tr><td>${esc(s.name)}${s.airflow_m3h ? ` <small>· ${num(s.airflow_m3h, 0)} m³/h</small>` : ""}</td>
      <td class="num">${s.first_page}–${s.last_page}</td><td class="num">${s.positions}</td><td class="num">${s.priced}</td><td class="num">${chf(s.direct_cost_chf)}</td></tr>`).join("")}
    <tr class="total"><td>Total positions</td><td></td><td class="num">${systems.reduce((a, s) => a + s.positions, 0)}</td>
      <td class="num">${systems.reduce((a, s) => a + s.priced, 0)}</td><td class="num">${chf(systems.reduce((a, s) => a + s.direct_cost_chf, 0))}</td></tr>
  </tbody></table>`;
}

function renderBody() {
  const body = $("summaryBody");
  const r = view.results;
  if (!r) {
    body.innerHTML = `<div class="empty-state card">
      <h3>${view.version ? `Version ${view.version.version} has no calculated results` : "No versions yet"}</h3>
      <p>${view.version
        ? (view.version.computeError ? `The calculation failed: ${esc(view.version.computeError)}` : "Click Re-compute on the dashboard to calculate it.")
        : "Upload the tender, catalog and productivity files on the dashboard, then click Re-compute."}</p></div>`;
    return;
  }
  const v = viewOf(r, view.scope);
  const b = breakdown(v);
  const s = v.summary;
  const range = v.bids;
  const pendingOverrides = Object.keys(overrides()).filter((id) => !r.position_results.find((p) => p.lv_id === id)?.overridden).length;
  const warnings = [...(r.warnings || [])];
  if (pendingOverrides) warnings.push(`${pendingOverrides} position edit(s) are saved but not in this version yet – click Re-compute on the dashboard.`);

  body.innerHTML = `
    ${warnings.length ? `<div class="warn-box">${warnings.map(esc).join("<br>")}</div>` : ""}
    <div class="toolbar">
      ${r.views ? `<div class="scope" style="min-width:280px">${Object.entries(SCOPES).map(([k, l]) =>
        `<button data-sumscope="${k}" class="${view.scope === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
      <span style="color:var(--muted);font-size:13px">${esc(r.source_tender_file || "")} · ${num(r.tender?.pages, 0)} pages · computed ${new Date(r.generated_at || view.version.createdAt).toLocaleString()}</span>
    </div>
    <div class="tiles">
      <div class="tile"><small>Positions</small><b>${num(b.total, 0)}</b></div>
      <div class="tile"><small>Priceable positions</small><b>${num(b.priceable, 0)}</b></div>
      <div class="tile"><small>Materials found</small><b>${num(b.materials, 0)}</b></div>
      <div class="tile"><small>Calculated</small><b>${pct(b.calculated, 0)}</b></div>
      <div class="tile"><small>Manual review</small><b>${pct(b.manual, 0)}</b></div>
      <div class="tile"><small>Supplier quotes needed</small><b>${num(b.counts.supplier_quote_required, 0)}</b></div>
    </div>
    <div class="cost-strip">
      <div class="tile"><small>Material CHF</small><b>${chf(s.material_cost_chf)}</b></div>
      <div class="tile"><small>Labour CHF</small><b>${chf(s.labour_cost_chf)}</b></div>
      <div class="tile"><small>Direct CHF</small><b>${chf(s.direct_cost_chf)}</b></div>
      <div class="tile"><small>Baseline CHF</small><b>${chf(s.cost_baseline_chf)}</b></div>
      <div class="tile"><small>${esc(range?.name || "Recommended bid range")} CHF</small><b>${range ? `${chf(range.low_chf)} – ${chf(range.high_chf)}` : "–"}</b></div>
    </div>
    <div class="split">
      <div class="card"><h3>Cost build-up</h3>${costTable(s, view.scope)}</div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div class="card"><h3>${esc(range?.name || "Recommended Bid Range")}</h3>${bidTable(range)}</div>
        ${view.scope === "full" ? `<div class="card"><h3>Systems in the tender</h3>${systemsTable(r)}</div>` : ""}
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="sumSearch" placeholder="Search position, text, product, code…" value="${esc(view.q)}">
      <div class="chips" id="sumChips"></div>
      <span class="spacer"></span>
      <button class="btn ghost small" id="sumExport">Export CSV</button>
    </div>
    <div class="table-wrap"><table id="sumTable"></table></div>`;
  renderChips();
  renderTable();
}

function rows() {
  return viewOf(view.results, view.scope).positions.map((p) => ({ ...p, _category: categorize(p) }));
}

function renderChips() {
  const all = rows();
  const count = (k) => all.filter((p) => p._category === k).length;
  $("sumChips").innerHTML = [`<button class="chip ${view.filter === "all" ? "on" : ""}" data-filter="all">All ${all.length}</button>`]
    .concat(CATEGORIES.filter((c) => count(c.key)).map((c) =>
      `<button class="chip ${view.filter === c.key ? "on" : ""}" data-filter="${c.key}"><i style="background:${c.color}"></i>${c.label} ${count(c.key)}</button>`))
    .join("");
}

function filtered() {
  const q = view.q.trim().toLowerCase();
  const { key, dir } = view.sort;
  return rows()
    .filter((p) => view.filter === "all" || p._category === view.filter)
    .filter((p) => !q || [p.lv_id, p.verified_ref, p.matched_product_id, p.install_code, p.price_source, p.description, p.system, p.match_note]
      .some((v) => String(v ?? "").toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? ""), "de", { numeric: true }) * dir;
    });
}

function cellHtml(p, c, ov) {
  switch (c.key) {
    case "_category": {
      const cat = CATEGORY[p._category];
      const label = p.status === "out_of_scope" ? "Out of scope" : cat.label;
      return `<td><span class="status"><i style="background:${cat.color}"></i>${label}</span>${p.included_in_total ? "" : ' <small title="Not included in the totals">·excl.</small>'}</td>`;
    }
    case "lv_id":
      return `<td>${esc(p.lv_id)}${p.verified_ref ? ` <small title="Verified example ${esc(p.verified_ref)}">✓${esc(p.verified_ref)}</small>` : ""}${ov && !p.overridden ? '<span class="pending" title="Edited – Re-compute to apply">edited</span>' : ""}</td>`;
    case "source_page":
      return `<td class="num"><a href="#" data-page="${p.source_page}" title="Open the tender PDF at page ${p.source_page}">${p.source_page}</a></td>`;
    case "system":
      return `<td>${esc((p.system || "").replace(/^244\.\d\d\s*/, ""))}</td>`;
    case "_edit":
      return `<td><button class="edit" data-edit="${esc(p.lv_id)}">Edit</button></td>`;
    default: {
      const v = p[c.key];
      const text = c.fmt ? c.fmt(v) : esc(v ?? "–");
      return `<td class="${c.num ? "num" : ""} ${c.cls || ""}"${c.cls ? ` title="${esc(v ?? "")}"` : ""}>${text}</td>`;
    }
  }
}

function renderTable() {
  const list = filtered();
  const ov = overrides();
  const arrow = (k) => (view.sort.key === k ? (view.sort.dir > 0 ? " ▲" : " ▼") : "");
  const head = `<thead><tr>${COLUMNS.map((c) => `<th ${c.key === "_edit" ? "" : `data-sort="${c.key}"`} class="${c.num ? "num" : ""}">${c.label}${arrow(c.key)}</th>`).join("")}</tr></thead>`;
  const body = list.map((p) => `<tr class="${p.overridden || ov[p.lv_id] ? "overridden" : ""}">${COLUMNS.map((c) => cellHtml(p, c, ov[p.lv_id])).join("")}</tr>`).join("");
  const included = list.filter((p) => p.included_in_total);
  const foot = `<tfoot><tr>${COLUMNS.map((c, i) => {
    if (i === 0) return `<td colspan="2">Total priced (${included.length} / ${list.length})</td>`;
    if (i === 1) return "";
    if (!c.total) return "<td></td>";
    return `<td class="num">${c.fmt(included.reduce((s, p) => s + (Number(p[c.key]) || 0), 0))}</td>`;
  }).join("")}</tr></tfoot>`;
  $("sumTable").innerHTML = head + `<tbody>${body || `<tr><td colspan="${COLUMNS.length}" class="empty-state">No positions match.</td></tr>`}</tbody>` + foot;
}

// ---- source traceability -------------------------------------------------------------------

async function openSourcePage(page) {
  const path = view.version?.files?.tender?.storagePath;
  if (!path) return toast("The tender file of this version is not available.", true);
  const win = window.open("", "_blank");
  try {
    const url = await ctx.store.fileUrl(path);
    if (win) win.location.href = `${url}#page=${page}`;
    else window.open(`${url}#page=${page}`, "_blank", "noopener");
  } catch (e) {
    win?.close();
    toast(e.message || String(e), true);
  }
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

  openDialog(`Edit ${lvId}`, `
    <div class="src-box">
      <div><b>Tender text</b> ${esc(p.description)}</div>
      <div><b>System</b> ${esc(p.system)} · page <a href="#" id="dlgPage">${p.source_page}</a></div>
      ${p.manufacturer_hint || p.model_hint ? `<div><b>Hints</b> ${esc([p.manufacturer_hint, p.model_hint].filter(Boolean).join(" · "))}</div>` : ""}
      <div><b>Proposed</b> ${esc(p.matched_product_id || "no product")} · ${esc(CATEGORY[categorize(p)].label)} · ${esc(p.match_note)}</div>
    </div>
    <div class="form-grid">
      <label for="ovProduct">Product</label>
      <select id="ovProduct">
        <option value="__keep">Keep proposal (${esc(p.matched_product_id || "none")})</option>
        <option value="">No product (manual pricing)</option>
        ${Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((c) =>
          `<option value="${esc(c.product_id)}">${esc(c.product_id)} – ${esc(c.description)} (${chf(c.net_cost_chf)} / ${esc(c.unit)})${c.source_type === "supplier_package" ? " · supplier package" : ""}</option>`).join("")}</optgroup>`).join("")}
      </select>
      <label for="ovQty">Quantity (${esc(p.unit || "")})</label>
      <input id="ovQty" type="number" step="any" placeholder="${p.tender_quantity ?? "not in tender"}" value="${o.quantity ?? ""}">
      <label for="ovStatus">Status</label>
      <select id="ovStatus"><option value="">Automatic</option>${STATUSES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <label for="ovNote">Note</label>
      <input id="ovNote" type="text" placeholder="Why the change (optional)" value="${esc(o.note || "")}">
    </div>
    <p style="color:var(--muted);font-size:13px;margin:14px 0 0">Saved edits are applied on the next <b>Re-compute</b> and stored with that version.</p>`, [
    { label: "Remove edit", cls: "ghost", onClick: () => saveEdit(lvId, null) },
    { label: "Cancel", cls: "ghost", onClick: closeDialog },
    { label: "Save", cls: "navy", onClick: () => {
      const product = $("ovProduct").value;
      const edit = {};
      if (product !== "__keep") edit.product_id = product;
      if ($("ovQty").value !== "") edit.quantity = Number($("ovQty").value);
      if ($("ovStatus").value) edit.status = $("ovStatus").value;
      if ($("ovNote").value.trim()) edit.note = $("ovNote").value.trim();
      saveEdit(lvId, Object.keys(edit).length ? edit : null);
    } },
  ]);
  $("ovProduct").value = productValue;
  $("ovStatus").value = o.status || "";
  $("dlgPage").onclick = (e) => { e.preventDefault(); openSourcePage(p.source_page); };
}

function saveEdit(lvId, edit) {
  closeDialog();
  busy(async () => {
    await ctx.store.saveOverride(ctx.state.user, ctx.state.project.id, lvId, edit);
    await ctx.reload();
    renderBody();
    toast(edit ? `${lvId} saved. Click Re-compute on the dashboard to apply it.` : `Edit of ${lvId} removed. Re-compute to apply.`);
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
  const cols = COLUMNS.filter((c) => c.key !== "_edit");
  const extra = ["verified_ref", "included_in_total"];
  const lines = [cols.map((c) => cell(c.label)).concat(extra).join(";")]
    .concat(filtered().map((p) => cols.map((c) => cell(c.key === "_category" ? CATEGORY[p._category].label : p[c.key]))
      .concat(extra.map((k) => cell(p[k]))).join(";")));
  const name = `${ctx.state.project.name.replace(/[^\w-]+/g, "_")}_v${view.version.version}_${view.scope}_summary.csv`;
  downloadText(name, lines.join("\r\n"));
}
