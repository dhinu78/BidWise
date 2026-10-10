// Page 2: Edit parameters (full page, with "+" to add your own parameters).
import { $, esc, toast, busy, choose } from "./ui.js";
import { validateParameters } from "./validate.js";

// Unit choices for new parameters -> suffix added to the stored key.
const UNIT_SUFFIX = { "%": "_pct", "CHF": "_chf", "h": "_hours", "CHF/h": "_chf_per_h", "×": "" };

const SECTIONS = [
  { id: "productivity_factors", title: "Productivity factors",
    sub: "Multipliers on installation hours (1.10 = 10 % more time). Used through the factor_keys column of productivity.csv.",
    unitOf: () => "×", units: ["×"], step: 0.01 },
  { id: "allowances", title: "Allowances",
    sub: "Surcharges in percent.", unitOf: () => "%", units: ["%"], step: 0.1 },
  { id: "project_costs", title: "Project costs",
    sub: "Fixed project-level hours, rates and lump sums.", unitOf: unitFromKey, units: ["CHF", "h", "CHF/h"], step: 1 },
  { id: "commercial", title: "Commercial",
    sub: "Overhead, margin and rounding.", unitOf: unitFromKey, units: ["%", "CHF"], step: 0.1 },
];

function unitFromKey(key) {
  if (key.endsWith("_pct")) return "%";
  if (key.endsWith("_chf_per_h")) return "CHF/h";
  if (key.endsWith("_hours")) return "h";
  if (key.endsWith("_chf")) return "CHF";
  return "";
}
const humanize = (key) => {
  const s = key.replace(/_(pct|chf_per_h|chf|hours)$/, "").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const slug = (label) => label.trim().toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const round = (v) => Math.round(v * 1e8) / 1e8;

let ctx;          // {state, store, reload, go}
let draft = null; // working copy of project.parameters
let dirty = false;

export const isDirty = () => dirty;

export function initParamsPage(context) {
  ctx = context;
  $("paramsSaveBtn").onclick = save;
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  const grid = $("paramGrid");
  grid.addEventListener("input", onInput);
  grid.addEventListener("change", onInput);
  grid.addEventListener("click", onClick);
  grid.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.closest(".add-row")) { e.preventDefault(); e.target.closest(".add-row").querySelector("button").click(); }
  });
}

export function showParamsPage() {
  draft = structuredClone(ctx.state.project.parameters);
  draft.custom_parameters ??= [];
  dirty = false;
  $("paramErrors").hidden = true;
  render();
}

/** Ask before leaving with unsaved changes. Resolves true if it's OK to leave. */
export async function confirmLeave() {
  if (!dirty) return true;
  const answer = await choose("Unsaved changes", "You changed parameters that are not saved yet.", [
    { label: "Discard", value: "discard", cls: "ghost" },
    { label: "Keep editing", value: "stay", cls: "ghost" },
    { label: "Save", value: "save", cls: "navy" },
  ]);
  if (answer === "discard") { dirty = false; return true; }
  if (answer === "save") return await save();
  return false;
}

// ---- rendering --------------------------------------------------------------------

function row({ path, label, value, unit, step = "any", custom = false, removable = custom, scale = 1, type = "number" }) {
  const v = type === "number" ? round(value * scale) : value;
  const input = type === "checkbox"
    ? `<input type="checkbox" data-path="${path}" data-type="checkbox" ${value ? "checked" : ""}>`
    : type === "text"
      ? `<input type="text" class="left" data-path="${path}" data-type="text" value="${esc(value ?? "")}">`
      : `<input type="number" step="${step}" data-path="${path}" data-type="number" data-scale="${scale}" value="${Number.isFinite(v) ? v : ""}">`;
  return `<div class="prow">
    <label>${esc(label)}${custom ? '<span class="custom-tag">custom</span>' : ""}</label>
    ${input}${type === "text" ? "" : `<span class="unit">${esc(unit || "")}</span>`}
    <button class="del" data-del="${path}" title="Remove" ${removable ? "" : "disabled"}>×</button>
  </div>`;
}

function addRow(sectionId, units, placeholder = "New parameter name") {
  return `<div class="add-row" data-add="${sectionId}">
    <input type="text" placeholder="${placeholder}" data-new="name">
    <input type="number" step="any" placeholder="Value" data-new="value">
    ${units.length > 1
      ? `<select data-new="unit">${units.map((u) => `<option>${u}</option>`).join("")}</select>`
      : `<span class="unit" style="align-self:center">${units[0]}</span>`}
    <button title="Add">+</button>
  </div>`;
}

function render() {
  const p = draft;
  const custom = new Set(p.custom_parameters);
  const cards = [];

  cards.push(`<section class="pcard"><h3>Project</h3><p class="sub">Basic information.</p>
    ${row({ path: "project.name", label: "Project name", value: p.project.name, type: "text" })}
    ${row({ path: "project.id", label: "Project ID", value: p.project.id, type: "text" })}
    ${row({ path: "project.currency", label: "Currency", value: p.project.currency, type: "text" })}
    <div class="prow"><label>Tender file</label><span class="readonly" title="${esc(p.project.source_tender_file || "")}">${esc(p.project.source_tender_file || "not uploaded")}</span><span></span><span></span></div>
  </section>`);

  for (const s of SECTIONS) {
    const obj = p[s.id] || {};
    cards.push(`<section class="pcard"><h3>${s.title}</h3><p class="sub">${s.sub}</p>
      ${Object.entries(obj).map(([k, v]) => row({
        path: `${s.id}.${k}`, label: humanize(k), value: v, unit: s.unitOf(k), step: s.step, custom: custom.has(`${s.id}.${k}`),
      })).join("")}
      ${addRow(s.id, s.units)}
    </section>`);
  }

  const sb = p.stretch_bid_optimization;
  if (sb) {
    cards.push(`<section class="pcard"><h3>Bid scenarios</h3><p class="sub">Margin per scenario. Each scenario becomes one bid card on the dashboard.</p>
      ${sb.scenario_names.map((name) => row({
        path: `stretch_bid_optimization.scenario_margins_pct.${name}`, label: name,
        value: sb.scenario_margins_pct[name], unit: "%", step: 0.1,
        custom: custom.has(`scenario.${name}`), removable: sb.scenario_names.length > 1,
      })).join("")}
      ${addRow("scenarios", ["%"], "New scenario name")}
    </section>`);

    cards.push(`<section class="pcard"><h3>Win probability model</h3><p class="sub">Probabilities are shown in percent.</p>
      ${row({ path: "stretch_bid_optimization.enabled", label: "Bid range optimisation enabled", value: sb.enabled, type: "checkbox" })}
      ${row({ path: "stretch_bid_optimization.reference_win_probability", label: "Reference win probability", value: sb.reference_win_probability, unit: "%", scale: 100 })}
      ${row({ path: "stretch_bid_optimization.price_sensitivity_probability_points_per_1pct_price", label: "Price sensitivity per 1 % price", value: sb.price_sensitivity_probability_points_per_1pct_price, unit: "pts", scale: 100 })}
      ${row({ path: "stretch_bid_optimization.strategic_appetite_adjustment", label: "Strategic appetite adjustment", value: sb.strategic_appetite_adjustment, unit: "pts", scale: 100 })}
      ${row({ path: "stretch_bid_optimization.competition_adjustment", label: "Competition adjustment", value: sb.competition_adjustment, unit: "pts", scale: 100 })}
      ${row({ path: "stretch_bid_optimization.minimum_probability", label: "Minimum probability", value: sb.minimum_probability, unit: "%", scale: 100 })}
      ${row({ path: "stretch_bid_optimization.maximum_probability", label: "Maximum probability", value: sb.maximum_probability, unit: "%", scale: 100 })}
    </section>`);
  }

  $("paramGrid").innerHTML = cards.join("");
}

// ---- editing ----------------------------------------------------------------------

function setPath(obj, path, value) {
  const keys = path.split(".");
  let t = obj;
  keys.slice(0, -1).forEach((k) => (t = t[k]));
  t[keys.at(-1)] = value;
}

function onInput(e) {
  const el = e.target;
  if (!el.dataset.path) return;
  let value;
  if (el.dataset.type === "checkbox") value = el.checked;
  else if (el.dataset.type === "text") value = el.value;
  else {
    value = el.value === "" ? NaN : round(Number(el.value) / Number(el.dataset.scale || 1));
    el.classList.toggle("invalid", Number.isNaN(value));
  }
  setPath(draft, el.dataset.path, value);
  dirty = true;
  if (el.dataset.path === "project.name") $("projectName").textContent = value;
}

function onClick(e) {
  const del = e.target.closest("[data-del]");
  if (del && !del.disabled) return removeParam(del.dataset.del);
  const add = e.target.closest(".add-row button");
  if (add) return addParam(add.closest(".add-row"));
}

function addParam(rowEl) {
  const section = rowEl.dataset.add;
  const name = rowEl.querySelector('[data-new="name"]').value.trim();
  const value = Number(rowEl.querySelector('[data-new="value"]').value);
  const unit = rowEl.querySelector('[data-new="unit"]')?.value
    ?? rowEl.querySelector(".unit")?.textContent.trim();
  if (!name) return toast("Enter a name for the new parameter.", true);
  if (rowEl.querySelector('[data-new="value"]').value === "" || Number.isNaN(value)) return toast("Enter a number as value.", true);

  if (section === "scenarios") {
    const sb = draft.stretch_bid_optimization;
    if (sb.scenario_names.includes(name)) return toast(`Scenario "${name}" already exists.`, true);
    sb.scenario_names.push(name);
    sb.scenario_margins_pct[name] = value;
    draft.custom_parameters.push(`scenario.${name}`);
  } else {
    const key = slug(name) + (UNIT_SUFFIX[unit] ?? "");
    if (!slug(name)) return toast("Use letters or numbers in the name.", true);
    draft[section] ??= {};
    if (key in draft[section]) return toast(`"${humanize(key)}" already exists in this section.`, true);
    draft[section][key] = value;
    draft.custom_parameters.push(`${section}.${key}`);
  }
  dirty = true;
  render();
  toast(`Added "${name}". Click Save to keep it.`);
}

function removeParam(path) {
  const [section, ...rest] = path.split(".");
  if (section === "stretch_bid_optimization") {
    const name = rest.at(-1);
    const sb = draft.stretch_bid_optimization;
    if (sb.scenario_names.length <= 1) return;
    sb.scenario_names = sb.scenario_names.filter((n) => n !== name);
    delete sb.scenario_margins_pct[name];
    draft.custom_parameters = draft.custom_parameters.filter((p) => p !== `scenario.${name}`);
  } else {
    delete draft[section][rest.join(".")];
    draft.custom_parameters = draft.custom_parameters.filter((p) => p !== path);
  }
  dirty = true;
  render();
}

async function save() {
  const errors = validateParameters(draft);
  if (errors.length) {
    $("paramErrors").textContent = "Please fix:\n" + errors.join("\n");
    $("paramErrors").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    return false;
  }
  $("paramErrors").hidden = true;
  let ok = false;
  await busy(async () => {
    await ctx.store.saveParameters(ctx.state.user, ctx.state.project.id, draft);
    dirty = false;
    await ctx.reload();
    draft = structuredClone(ctx.state.project.parameters);
    draft.custom_parameters ??= [];
    render();
    toast("Parameters saved. Click Re-compute on the dashboard to store them as a new version.");
    ok = true;
  });
  return ok;
}
