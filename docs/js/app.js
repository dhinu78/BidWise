import * as store from "./store.js";
import { KINDS, inspectFile, sha256, validateParameters, crossCheck, decodeText, parseCSV, ValidationError } from "./validate.js";
import { computeEstimation } from "./compute.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const chf = (v) => (v == null || Number.isNaN(+v) ? "–" : (+v).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const LAST_PROJECT_KEY = "tender.lastProject";

const state = {
  user: null,
  defaults: null,
  project: null,
  latest: null,          // latest version document
  localBlobs: {},        // files picked in this browser session: {kind: {sha256, blob}}
};

// ---- small UI helpers -------------------------------------------------------------

let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 4000);
}

async function busy(fn) {
  $("busy").hidden = false;
  try { return await fn(); }
  catch (e) { if (!(e instanceof ValidationError)) console.error(e); toast(e.message || String(e), true); }
  finally { $("busy").hidden = true; }
}

function openDialog(title, bodyHtml, buttons = []) {
  const dlg = $("dlg");
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = bodyHtml;
  const foot = $("dlgFoot");
  foot.innerHTML = "";
  foot.hidden = !buttons.length;
  for (const b of buttons) {
    const el = document.createElement("button");
    el.className = `btn ${b.cls || "grey"}`;
    el.textContent = b.label;
    el.onclick = b.onClick;
    foot.appendChild(el);
  }
  if (!dlg.open) dlg.showModal();
  return dlg;
}
const closeDialog = () => $("dlg").close();
$("dlg").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDialog(); });

function ask(title, value = "") {
  return new Promise((resolve) => {
    openDialog(title, `<div class="ask"><input id="askInput" value="${esc(value)}"></div>`, [
      { label: "Cancel", cls: "ghost", onClick: () => { closeDialog(); resolve(null); } },
      { label: "OK", cls: "navy", onClick: () => { const v = $("askInput").value.trim(); closeDialog(); resolve(v); } },
    ]);
    $("dlg").addEventListener("close", () => resolve(null), { once: true });   // closed with × or Esc
    const input = $("askInput");
    input.focus(); input.select();
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("dlgFoot").lastChild.click(); } };
  });
}

// ---- auth ---------------------------------------------------------------------------

$("loginBtn").onclick = () => busy(store.signIn);
$("logoutBtn").onclick = () => busy(store.logOut);

store.onUser((user) => busy(async () => {
  state.user = user;
  $("loginView").hidden = !!user;
  $("mainView").hidden = !user;
  $("signedInHeader").hidden = !user;
  if (!user) { state.project = null; return; }

  const name = user.displayName || user.email;
  $("userName").textContent = (name || "").split(" ")[0];
  $("avatar").innerHTML = user.photoURL
    ? `<img class="avatar" src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
    : esc((name || "?")[0].toUpperCase());

  await store.saveProfile(user);
  state.defaults ??= await (await fetch("defaults/project_parameters.json")).json();

  const projects = await store.listProjects(user.uid);
  let pid = null;
  try { pid = localStorage.getItem(LAST_PROJECT_KEY); } catch {}
  if (!projects.some((p) => p.id === pid)) pid = projects[0]?.id;
  if (!pid) pid = (await store.createProject(user, "New project", state.defaults)).id;
  await openProject(pid);
}));

// ---- projects -----------------------------------------------------------------------

async function openProject(pid) {
  state.localBlobs = {};
  try { localStorage.setItem(LAST_PROJECT_KEY, pid); } catch {}
  await reload(pid);
}

async function reload(pid = state.project?.id) {
  state.project = await store.getProject(state.user.uid, pid);
  state.latest = state.project.currentVersion
    ? await store.getVersion(state.user.uid, pid, state.project.currentVersion)
    : null;
  render();
}

$("newBtn").onclick = async () => {
  const name = await ask("New project name");
  if (name) busy(async () => openProject((await store.createProject(state.user, name, state.defaults)).id));
};

$("renameBtn").onclick = async () => {
  const name = await ask("Rename project", state.project.name);
  if (name) busy(async () => { await store.renameProject(state.user, state.project.id, name); await reload(); });
};

$("projectsBtn").onclick = () => busy(async () => {
  const projects = await store.listProjects(state.user.uid);
  openDialog("Projects", projects.map((p) => `
    <div class="list-row" data-pid="${esc(p.id)}">
      <div><b>${esc(p.name)}</b><br><small>Updated ${new Date(p.updatedAt).toLocaleString()}</small></div>
      <span class="tag">Version ${p.currentVersion || "–"}</span>
    </div>`).join("") || "<p>No projects yet.</p>");
  $("dlgBody").onclick = (e) => {
    const row = e.target.closest("[data-pid]");
    if (row) { closeDialog(); busy(() => openProject(row.dataset.pid)); }
  };
});

$("saveBtn").onclick = () => busy(async () => {
  await store.saveParameters(state.user, state.project.id, state.project.parameters);
  toast("Project saved. (Uploads and parameter changes are also saved automatically.)");
});

$("pdfBtn").onclick = () => window.print();

// ---- uploads ------------------------------------------------------------------------

let pendingKind = null;
document.querySelectorAll("[data-upload]").forEach((btn) => {
  btn.onclick = () => {
    pendingKind = btn.dataset.upload;
    const picker = $("filePicker");
    picker.accept = pendingKind === "tender" ? ".pdf,application/pdf" : ".csv,text/csv";
    picker.value = "";
    picker.click();
  };
});

$("filePicker").onchange = (e) => {
  const file = e.target.files[0];
  const kind = pendingKind;
  if (!file || !kind) return;
  busy(async () => {
    const checked = await inspectFile(kind, file);   // throws ValidationError with a clear message
    const hash = await sha256(checked.buffer);
    const rec = await store.uploadWorkingFile(state.user, state.project.id, kind, file, checked, hash);
    state.localBlobs[kind] = { sha256: hash, blob: file };
    await reload();
    toast(`Uploaded ${rec.filename}${rec.rows ? ` (${rec.rows} rows)` : ""}`);
  });
};

// ---- parameters editor --------------------------------------------------------------

function fieldsHtml(obj, path = []) {
  return Object.entries(obj).map(([key, val]) => {
    const p = [...path, key].join(".");
    const label = esc(key.replace(/_/g, " "));
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return `<fieldset><legend>${label}</legend>${fieldsHtml(val, [...path, key])}</fieldset>`;
    }
    if (typeof val === "boolean") {
      return `<div class="field"><label>${label}</label><input type="checkbox" data-path="${p}" data-type="boolean" ${val ? "checked" : ""}></div>`;
    }
    if (typeof val === "number") {
      return `<div class="field"><label>${label}</label><input type="number" step="any" data-path="${p}" data-type="number" value="${val}"></div>`;
    }
    if (Array.isArray(val)) {
      return `<div class="field"><label>${label} <small>(comma separated)</small></label><input type="text" data-path="${p}" data-type="array" value="${esc(val.join(", "))}"></div>`;
    }
    return `<div class="field"><label>${label}</label><input type="text" data-path="${p}" data-type="${val === null ? "nullable" : "string"}" value="${esc(val ?? "")}"></div>`;
  }).join("");
}

function readFields(container, original) {
  const out = structuredClone(original);
  container.querySelectorAll("[data-path]").forEach((el) => {
    const keys = el.dataset.path.split(".");
    let target = out;
    keys.slice(0, -1).forEach((k) => (target = target[k]));
    const last = keys.at(-1);
    switch (el.dataset.type) {
      case "boolean": target[last] = el.checked; break;
      case "number": target[last] = el.value === "" ? NaN : Number(el.value); break;
      case "array": target[last] = el.value.split(",").map((s) => s.trim()).filter(Boolean); break;
      case "nullable": target[last] = el.value.trim() || null; break;
      default: target[last] = el.value;
    }
  });
  return out;
}

$("paramsBtn").onclick = () => {
  const params = state.project.parameters;
  openDialog("Edit parameters", `<div id="paramErrors" class="errors"></div><div id="paramForm">${fieldsHtml(params)}</div>`, [
    { label: "Reset to defaults", cls: "ghost", onClick: () => {
        const d = structuredClone(state.defaults);
        d.project = { ...d.project, name: params.project.name, source_tender_file: params.project.source_tender_file };
        $("paramForm").innerHTML = fieldsHtml(d);
      } },
    { label: "Cancel", cls: "ghost", onClick: closeDialog },
    { label: "Save parameters", cls: "navy", onClick: () => {
        const updated = readFields($("paramForm"), params);
        const errors = validateParameters(updated);
        if (errors.length) { $("paramErrors").textContent = errors.join("\n"); $("dlgBody").scrollTop = 0; return; }
        busy(async () => {
          await store.saveParameters(state.user, state.project.id, updated);
          closeDialog();
          await reload();
          toast("Parameters saved. Click Re-compute to store them as a new version.");
        });
      } },
  ]);
};

// ---- re-compute & versions ----------------------------------------------------------

$("recomputeBtn").onclick = async () => {
  const errors = validateParameters(state.project.parameters);
  if (errors.length) return toast(`Fix the parameters first:\n${errors.join("\n")}`, true);
  const missing = KINDS.filter((k) => !state.project.workingFiles?.[k]);
  if (missing.length) return toast(`Upload these files first: ${missing.join(", ")}`, true);

  const note = await ask("Note for this version (optional)", "");
  if (note === null) return;   // cancelled
  busy(async () => {
    let parsed = {};
    const prepare = async (blobs, parameters) => {
      for (const kind of ["catalog", "productivity"]) {
        parsed[kind] = parseCSV(decodeText(await blobs[kind].arrayBuffer()).text).rows;
      }
      return crossCheck(parameters, parsed.productivity);
    };
    const afterSave = (blobs, version, manifest) => computeEstimation({
      version, parameters: manifest.parameters, catalog: parsed.catalog,
      productivity: parsed.productivity, tenderPdf: blobs.tender,
    });
    const manifest = await store.recompute(state.user, state.project.id, note, state.localBlobs, prepare, afterSave);
    await reload();
    const extra = [...(manifest.warnings || []), manifest.computeError ? `Calculation failed: ${manifest.computeError}` : ""].filter(Boolean);
    toast(`Saved version ${manifest.version}.${extra.length ? "\n" + extra.join("\n") : ""}`, !!manifest.computeError);
  });
};

$("historyBtn").onclick = () => busy(showHistory);

async function showHistory() {
  const versions = await store.listVersions(state.user.uid, state.project.id);
  const rows = versions.map((v) => {
    const files = v.files
      ? KINDS.map((k) => `<a href="#" data-path="${esc(v.files[k].storagePath)}">${esc(v.files[k].filename)}</a>${v.changedSincePrevious?.[k] ? ' <span class="tag">changed</span>' : ""}`).join("<br>")
      : `<span class="errors">${esc(v.error || "")}</span>`;
    const status = { saved: "ok", computed: "ok", failed: "bad", compute_failed: "bad" }[v.status] || "";
    return `<tr>
      <td><b>${v.version}</b></td>
      <td>${new Date(v.createdAt).toLocaleString()}<br><small>${esc(v.createdBy?.name || v.createdBy?.email || "")}</small></td>
      <td>${files}${v.files ? `<br><a href="#" data-path="${esc(v.parametersPath)}">project_parameters.json</a>${v.changedSincePrevious?.parameters ? ' <span class="tag">changed</span>' : ""}` : ""}</td>
      <td>${esc(v.note || "")}</td>
      <td><span class="tag ${status}">${esc(v.status)}</span></td>
      <td>${v.files ? `<button class="btn ghost" data-restore="${v.version}" style="font-size:13px">Restore</button>` : ""}</td>
    </tr>`;
  }).join("");
  openDialog("Version history", versions.length
    ? `<table><thead><tr><th>#</th><th>Created</th><th>Files</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No versions yet. Upload the three files and click Re-compute.</p>");

  $("dlgBody").onclick = (e) => {
    const link = e.target.closest("[data-path]");
    if (link) {
      e.preventDefault();
      busy(async () => window.open(await store.fileUrl(link.dataset.path), "_blank", "noopener"));
    }
    const restore = e.target.closest("[data-restore]");
    if (restore) {
      const n = +restore.dataset.restore;
      busy(async () => {
        await store.restoreVersion(state.user, state.project.id, n);
        state.localBlobs = {};
        await reload();
        closeDialog();
        toast(`Version ${n} loaded. Its files and parameters are now the current working state.`);
      });
    }
  };
}

$("summaryBtn").onclick = () => {
  const r = state.latest?.results;
  if (!r?.position_results?.length) return toast("No calculated results yet for this version.");
  const rows = r.position_results.map((p) => `<tr><td>${esc(p.lv_id)}</td><td>${esc(p.matched_product_id)}</td>
    <td>${p.quantity} ${esc(p.unit)}</td><td>${chf(p.material_cost_chf)}</td><td>${chf(p.labour_cost_chf)}</td>
    <td>${chf(p.direct_position_cost_chf)}</td><td>${esc(p.status)}</td></tr>`).join("");
  openDialog(`Detailed summary – version ${state.latest.version}`,
    `<table><thead><tr><th>LV</th><th>Product</th><th>Qty</th><th>Material</th><th>Labour</th><th>Direct</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`);
};

// ---- dashboard rendering --------------------------------------------------------------

function donut(pct, label) {
  const r = 50, c = 2 * Math.PI * r;
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return `<div class="donut">
    <svg viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#e0e0e0" stroke-width="12"/>
      ${v > 0 ? `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--green)" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(v / 100) * c} ${c}" transform="rotate(-90 60 60)"/>` : ""}
      <text x="60" y="68" text-anchor="middle" class="val">${pct == null ? "–" : Math.round(pct) + "%"}</text>
    </svg><p>${label}</p></div>`;
}

function kpis(results) {
  const k = results?.kpis || {};
  const pos = results?.position_results || [];
  const share = (fn) => (pos.length ? (100 * pos.filter(fn).length) / pos.length : null);
  return {
    found: k.recommendations_found_pct ?? share((p) => !!p.matched_product_id),
    supplier: k.supplier_quote_needed_pct ?? share((p) => p.status === "supplier_quote_required"),
    manual: k.manual_review_required_pct ?? share((p) => !!p.review_required),
    variable: k.variable_costs_estimated_pct ?? null,
  };
}

function render() {
  const p = state.project;
  $("projectName").textContent = p.name;
  $("projectName").title = p.name;
  $("versionNo").textContent = p.currentVersion || "–";
  for (const kind of KINDS) {
    const rec = p.workingFiles?.[kind];
    const el = $(`f-${kind}`);
    el.textContent = rec ? rec.filename : "upload a file";
    el.classList.toggle("empty", !rec);
    el.title = rec ? `${rec.filename}\nUploaded ${new Date(rec.uploadedAt).toLocaleString()}${rec.rows ? `\n${rec.rows} rows` : ""}` : "";
  }

  const results = state.latest?.results;
  const k = kpis(results);
  $("donuts").innerHTML = donut(k.found, "Recommendations found") + donut(k.supplier, "Supplier quote needed")
    + donut(k.manual, "Manual review required") + donut(k.variable, "Variable costs estimated");

  const s = results?.example_subset_summary || results?.summary || {};
  $("costs").innerHTML = [
    ["Material", s.material_cost_chf], ["Labor", s.labour_cost_chf],
    ["Direct", s.direct_cost_chf], ["Baseline", s.cost_baseline_chf],
  ].map(([l, v]) => `<dt>${l}: CHF</dt><dd>${chf(v)}</dd>`).join("");

  const scenarios = results?.recommended_bid_range?.scenarios
    || (p.parameters.stretch_bid_optimization?.scenario_names || ["Aggressive", "Target", "Conservative"]).map((n) => ({ scenario: n }));
  const colors = ["var(--green-strong)", "var(--green-light)", "var(--amber)"];
  $("bids").innerHTML = scenarios.map((sc, i) => {
    const prob = sc.estimated_win_probability;
    const margin = sc.margin_pct ?? p.parameters.stretch_bid_optimization?.scenario_margins_pct?.[sc.scenario];
    return `<div class="bid"><h3>${esc(sc.scenario)} Bid</h3><dl>
      <dt>Bid Price</dt><dd>${sc.bid_price_chf != null ? chf(sc.bid_price_chf) + " CHF" : "–"}</dd>
      <dt>Margin</dt><dd>${margin != null ? margin.toLocaleString("de-DE", { minimumFractionDigits: 1 }) + " %" : "–"}</dd>
      <dt>Win Probability</dt><dd>${prob != null
        ? `<span class="bar"><i style="width:${prob * 100}%;background:${colors[i % 3]}"></i></span>${Math.round(prob * 100)}%`
        : "–"}</dd>
      <dt>Contribution</dt><dd>${sc.expected_contribution_chf != null ? chf(sc.expected_contribution_chf) + " CHF" : "–"}</dd>
    </dl></div>`;
  }).join("") + (results ? "" : `<p class="no-results">${p.currentVersion
    ? `Version ${p.currentVersion} is saved. Results appear here once a calculation is added in js/compute.js.`
    : "Upload the tender, catalog and productivity files, then click Re-compute."}</p>`);
}
