// Page 3: Detailed summary of one version's results.
import { $, esc, chf, num, pct, busy, downloadText } from "./ui.js";
import { CATEGORIES, CATEGORY, categorize, breakdown } from "./categories.js";

const COLUMNS = [
  { key: "lv_id", label: "LV pos." },
  { key: "source_page", label: "Page", num: true, fmt: (v) => num(v, 0) },
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
];

let ctx;
const view = { version: null, results: null, filter: "all", q: "", sort: { key: "lv_id", dir: 1 } };

export function initSummaryPage(context) {
  ctx = context;
  $("summaryVersion").onchange = (e) => busy(() => loadVersion(+e.target.value));
  const body = $("summaryBody");
  body.addEventListener("input", (e) => { if (e.target.id === "sumSearch") { view.q = e.target.value; renderTable(); } });
  body.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (chip) { view.filter = chip.dataset.filter; renderChips(); renderTable(); }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      view.sort = { key: k, dir: view.sort.key === k ? -view.sort.dir : 1 };
      renderTable();
    }
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
  view.filter = "all"; view.q = "";
  if (current) { $("summaryVersion").value = current.version; await loadVersion(current.version, current); }
  else { view.version = null; view.results = null; renderBody(); }
}

async function loadVersion(n, doc) {
  const v = doc || await ctx.store.getVersion(ctx.state.user.uid, ctx.state.project.id, n);
  view.version = v;
  view.results = v?.results || null;
  renderBody();
}

function renderBody() {
  const body = $("summaryBody");
  const r = view.results;
  if (!r) {
    body.innerHTML = `<div class="empty-state card">
      <h3>${view.version ? `Version ${view.version.version} has no calculated results yet` : "No versions yet"}</h3>
      <p>${view.version
        ? "The files and parameters of this version are saved. Results appear here once your calculation (js/compute.js) returns them."
        : "Upload the tender, catalog and productivity files on the dashboard, then click Re-compute."}</p></div>`;
    return;
  }
  const b = breakdown(r);
  const s = r.example_subset_summary || r.summary || {};
  const sc = r.recommended_bid_range?.scenarios || [];
  const prices = sc.map((x) => x.bid_price_chf).filter((x) => x != null);

  body.innerHTML = `
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
      <div class="tile"><small>Recommended bid range CHF</small><b>${prices.length ? `${chf(Math.min(...prices))} – ${chf(Math.max(...prices))}` : "–"}</b></div>
    </div>
    <div class="toolbar">
      <input type="search" id="sumSearch" placeholder="Search position, product, code…" value="${esc(view.q)}">
      <div class="chips" id="sumChips"></div>
      <span class="spacer"></span>
      <button class="btn ghost small" id="sumExport">Export CSV</button>
    </div>
    <div class="table-wrap"><table id="sumTable"></table></div>`;
  renderChips();
  renderTable();
}

function rows() {
  return (view.results?.position_results || []).map((p) => ({ ...p, _category: categorize(p) }));
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
    .filter((p) => !q || [p.lv_id, p.matched_product_id, p.install_code, p.price_source, p.description]
      .some((v) => String(v ?? "").toLowerCase().includes(q)))
    .sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? ""), "de", { numeric: true }) * dir;
    });
}

function renderTable() {
  const list = filtered();
  const arrow = (k) => (view.sort.key === k ? (view.sort.dir > 0 ? " ▲" : " ▼") : "");
  const head = `<thead><tr>${COLUMNS.map((c) => `<th data-sort="${c.key}" class="${c.num ? "num" : ""}">${c.label}${arrow(c.key)}</th>`).join("")}</tr></thead>`;
  const body = list.map((p) => `<tr>${COLUMNS.map((c) => {
    if (c.key === "_category") {
      const cat = CATEGORY[p._category];
      return `<td><span class="status"><i style="background:${cat.color}"></i>${cat.label}</span></td>`;
    }
    return `<td class="${c.num ? "num" : ""}">${c.fmt ? c.fmt(p[c.key]) : esc(p[c.key] ?? "–")}</td>`;
  }).join("")}</tr>`).join("");
  const foot = `<tfoot><tr>${COLUMNS.map((c, i) => {
    if (i === 0) return `<td>Total (${list.length})</td>`;
    if (!c.total) return "<td></td>";
    return `<td class="num">${c.fmt(list.reduce((s, p) => s + (Number(p[c.key]) || 0), 0))}</td>`;
  }).join("")}</tr></tfoot>`;
  $("sumTable").innerHTML = head + `<tbody>${body || `<tr><td colspan="${COLUMNS.length}" class="empty-state">No positions match.</td></tr>`}</tbody>` + foot;
}

function exportCsv() {
  // Semicolon + decimal comma so Excel (German/Swiss settings) opens it correctly.
  const cell = (v) => {
    if (typeof v === "number") return String(v).replace(".", ",");
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = COLUMNS.map((c) => c.key);
  const lines = [COLUMNS.map((c) => cell(c.label)).join(";")]
    .concat(filtered().map((p) => cols.map((k) => cell(k === "_category" ? CATEGORY[p._category].label : p[k])).join(";")));
  const name = `${ctx.state.project.name.replace(/[^\w-]+/g, "_")}_v${view.version.version}_summary.csv`;
  downloadText(name, lines.join("\r\n"));
}
