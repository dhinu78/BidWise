import * as store from "./store.js";
import { KINDS, inspectFile, sha256, validateParameters, crossCheck, decodeText, parseCSV, ValidationError } from "./validate.js";
import { computeEstimation } from "./compute.js";
import { $, esc, chf, pct, num, toast, busy, progress, shortName, openDialog, closeDialog, ask } from "./ui.js";
import { CATEGORIES, SCOPES, breakdown, viewOf } from "./categories.js";
import { DEFAULT_PARAMETERS } from "./defaults.js";
import { initParamsPage, showParamsPage, confirmLeave, isDirty } from "./params-page.js";
import { initSummaryPage, showSummaryPage } from "./summary-page.js";

const LAST_PROJECT_KEY = "bidwise.lastProject";
const SCOPE_KEY = "bidwise.scope";

const state = {
  user: null,
  defaults: DEFAULT_PARAMETERS,
  scope: (() => { try { return SCOPES[localStorage.getItem(SCOPE_KEY)] ? localStorage.getItem(SCOPE_KEY) : "full"; } catch { return "full"; } })(),
  project: null,
  latest: null,     // latest version document
  localBlobs: {},   // files picked in this browser session: {kind: {sha256, blob}}
};

const ctx = { state, store, reload: () => reload(), go: (p) => go(p) };
initParamsPage(ctx);
initSummaryPage(ctx);

// ---- pages (#/ , #/parameters , #/summary) -----------------------------------------

const PAGES = { "": "dashboard", parameters: "params", summary: "summary" };
let currentPage = "dashboard";
let ignoreHash = false;

const go = (name) => { location.hash = name ? `#/${name}` : "#/"; };

window.addEventListener("hashchange", async () => {
  if (ignoreHash) { ignoreHash = false; return; }
  if (currentPage === "params" && isDirty() && !(await confirmLeave())) {
    ignoreHash = true;
    location.hash = "#/parameters";
    return;
  }
  showPage();
});

function showPage() {
  const page = PAGES[location.hash.replace(/^#\/?/, "")] || "dashboard";
  if (!state.project) return;
  currentPage = page;
  document.body.dataset.page = page;
  for (const p of ["dashboard", "params", "summary"]) $(`page-${p}`).hidden = p !== page;
  window.scrollTo(0, 0);
  if (page === "params") showParamsPage();
  if (page === "summary") busy(showSummaryPage);
}

$("backBtn").onclick = () => go("");

// ---- auth ------------------------------------------------------------------------------

$("loginBtn").onclick = () => busy(store.signIn);
$("logoutBtn").onclick = async () => {
  if (currentPage === "params" && !(await confirmLeave())) return;
  busy(store.logOut);
};

store.onUser((user) => busy(async () => {
  state.user = user;
  $("loginView").hidden = !!user;
  $("signedInHeader").hidden = !user;
  if (!user) {
    state.project = null;
    for (const p of ["dashboard", "params", "summary"]) $(`page-${p}`).hidden = true;
    return;
  }
  const name = user.displayName || user.email || "?";
  $("userName").textContent = name.split(" ")[0];
  $("avatar").innerHTML = user.photoURL
    ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
    : esc(name[0].toUpperCase());

  await store.saveProfile(user);

  const projects = await store.listProjects(user.uid);
  let pid = null;
  try { pid = localStorage.getItem(LAST_PROJECT_KEY); } catch {}
  if (!projects.some((p) => p.id === pid)) pid = projects[0]?.id;
  if (!pid) pid = (await store.createProject(user, "New project", state.defaults)).id;
  await openProject(pid);
}));

// ---- projects ----------------------------------------------------------------------------

async function openProject(pid) {
  state.localBlobs = {};
  try { localStorage.setItem(LAST_PROJECT_KEY, pid); } catch {}
  await reload(pid);
  showPage();
}

async function reload(pid = state.project?.id) {
  state.project = await store.getProject(state.user.uid, pid);
  state.latest = state.project.currentVersion
    ? await store.getVersion(state.user.uid, pid, state.project.currentVersion)
    : null;
  renderDashboard();
}

$("newBtn").onclick = async () => {
  const name = await ask("New project name");
  if (name) busy(async () => { go(""); await openProject((await store.createProject(state.user, name, state.defaults)).id); });
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

document.querySelectorAll("[data-scope]").forEach((btn) => {
  btn.onclick = () => {
    state.scope = btn.dataset.scope;
    try { localStorage.setItem(SCOPE_KEY, state.scope); } catch {}
    renderDashboard();
  };
});
$("paramsBtn").onclick = () => go("parameters");
$("summaryBtn").onclick = () => go("summary");

// ---- uploads ------------------------------------------------------------------------------

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
    const checked = await inspectFile(kind, file);
    const hash = await sha256(checked.buffer);
    const rec = await store.uploadWorkingFile(state.user, state.project.id, kind, file, checked, hash);
    state.localBlobs[kind] = { sha256: hash, blob: file };
    await reload();
    toast(`Uploaded ${rec.filename}${rec.rows ? ` (${rec.rows} rows)` : ""}`);
  }, [ValidationError]);
};

// ---- re-compute & version history ------------------------------------------------------------

$("recomputeBtn").onclick = async () => {
  const errors = validateParameters(state.project.parameters);
  if (errors.length) return toast(`Fix the parameters first:\n${errors.join("\n")}`, true);
  const missing = KINDS.filter((k) => !state.project.workingFiles?.[k]);
  if (missing.length) return toast(`Upload these files first: ${missing.join(", ")}`, true);

  const note = await ask("Note for this version (optional)", "");
  if (note === null) return;
  busy(async () => {
    progress("Saving version…");
    const parsed = {};
    const prepare = async (blobs, parameters) => {
      for (const kind of ["catalog", "productivity"]) {
        parsed[kind] = parseCSV(decodeText(await blobs[kind].arrayBuffer()).text).rows;
      }
      return crossCheck(parameters, parsed.productivity);
    };
    const afterSave = (blobs, version, manifest) => computeEstimation({
      version, parameters: manifest.parameters, catalog: parsed.catalog,
      productivity: parsed.productivity, tenderPdf: blobs.tender,
      tenderName: manifest.files.tender.filename, onProgress: progress,
    });
    const manifest = await store.recompute(state.user, state.project.id, note, state.localBlobs, prepare, afterSave);
    await reload();
    const extra = [...(manifest.warnings || []), ...(manifest.results?.warnings || []),
      manifest.computeError ? `Calculation failed: ${manifest.computeError}` : ""].filter(Boolean);
    toast(`Saved version ${manifest.version}.${extra.length ? "\n" + extra.join("\n") : ""}`, !!manifest.computeError);
  });
};

$("historyBtn").onclick = () => busy(async () => {
  const versions = await store.listVersions(state.user.uid, state.project.id);
  const rows = versions.map((v) => {
    const files = v.files
      ? KINDS.map((k) => `<a href="#" data-path="${esc(v.files[k].storagePath)}">${esc(v.files[k].filename)}</a>${v.changedSincePrevious?.[k] ? ' <span class="tag">changed</span>' : ""}`).join("<br>")
        + `<br><a href="#" data-path="${esc(v.parametersPath)}">project_parameters.json</a>${v.changedSincePrevious?.parameters ? ' <span class="tag">changed</span>' : ""}`
      : `<span style="color:var(--danger)">${esc(v.error || "")}</span>`;
    const status = { saved: "ok", computed: "ok", failed: "bad", compute_failed: "bad" }[v.status] || "";
    return `<tr>
      <td><b>${v.version}</b></td>
      <td>${new Date(v.createdAt).toLocaleString()}<br><small>${esc(v.createdBy?.name || v.createdBy?.email || "")}</small></td>
      <td>${files}</td>
      <td>${esc(v.note || "")}</td>
      <td><span class="tag ${status}">${esc(v.status)}</span></td>
      <td>${v.files ? `<button class="btn ghost small" data-restore="${v.version}">Restore</button>` : ""}</td>
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
});

// ---- dashboard rendering ----------------------------------------------------------------------

function donutSvg(b) {
  const W = 660, H = 430, cx = W / 2, cy = H / 2, r = 145, sw = 38, LH = 15;
  const C = 2 * Math.PI * r;
  let parts = "", start = 0;
  const labels = [];
  if (b.share) {
    const total = CATEGORIES.reduce((s, c) => s + (b.share[c.key] || 0), 0) || 1;
    for (const c of CATEGORIES) {
      const v = (b.share[c.key] || 0) / total;
      if (v <= 0) continue;
      parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color}" stroke-width="${sw}"
        stroke-dasharray="${v * C} ${C}" transform="rotate(${-90 + start * 360} ${cx} ${cy})"><title>${c.label}: ${pct(b.share[c.key])}</title></circle>`;
      const mid = (start + v / 2) * 2 * Math.PI - Math.PI / 2;
      const words = c.label.split(" ");
      const lines = (c.label.length > 14 && words.length > 1
        ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")]
        : [c.label]).concat(pct(b.share[c.key]));
      const rr = r + sw / 2 + 16;
      const x = cx + Math.cos(mid) * rr;
      const h = lines.length * LH;
      // block centred on the ray; above/below the ring it hangs away from it
      let y = cy + Math.sin(mid) * rr - h / 2 + Math.sin(mid) * h / 2;
      labels.push({ x, y, h, lines, side: Math.cos(mid) > 0.25 ? 1 : Math.cos(mid) < -0.25 ? -1 : 0 });
      start += v;
    }
    // push overlapping labels on the same side apart
    for (const side of [1, -1, 0]) {
      const list = labels.filter((l) => l.side === side).sort((a, b2) => a.y - b2.y);
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1];
        if (list[i].y < prev.y + prev.h + 3) list[i].y = prev.y + prev.h + 3;
      }
    }
  } else {
    parts = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e0e0e0" stroke-width="${sw}"/>`;
  }
  const text = labels.map((l) => `<text class="seg-label" text-anchor="${l.side > 0 ? "start" : l.side < 0 ? "end" : "middle"}">${
    l.lines.map((t, i) => `<tspan x="${l.x.toFixed(1)}" y="${(l.y + LH * (i + 0.8)).toFixed(1)}">${esc(t)}</tspan>`).join("")}</text>`).join("");
  const center = `
    <g transform="translate(${cx - 17} ${cy - 98})" fill="none" stroke="#4f9e6b" stroke-width="3" stroke-linecap="round">
      <circle cx="17" cy="17" r="15.5"/><path d="M9 17.5l5.5 5.5 11.5-13"/></g>
    <text class="center-title" x="${cx}" y="${cy - 36}" text-anchor="middle">Calculated:</text>
    <text class="center-val" x="${cx}" y="${cy - 8}" text-anchor="middle">${pct(b.calculated, 0)}</text>
    <g transform="translate(${cx - 18} ${cy + 6})" fill="none" stroke="#c95c4a" stroke-width="2.8" stroke-linejoin="round">
      <path d="M18 2L35 32H1z"/><path d="M18 12v10M18 27v.5" stroke-linecap="round"/></g>
    <text class="center-title" x="${cx}" y="${cy + 66}" text-anchor="middle">Manual review:</text>
    <text class="center-val" x="${cx}" y="${cy + 94}" text-anchor="middle">${pct(b.manual, 0)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Position status breakdown">${parts}${text}${center}</svg>`;
}

const winColor = (p) => (p >= 0.66 ? "var(--win-1)" : p >= 0.55 ? "var(--win-2)" : "var(--win-3)");

function renderDashboard() {
  const p = state.project;
  $("projectName").textContent = p.name;
  $("projectName").title = p.name;
  $("versionNo").textContent = p.currentVersion || "–";
  for (const kind of KINDS) {
    const rec = p.workingFiles?.[kind];
    const el = $(`f-${kind}`);
    el.textContent = rec ? shortName(rec.filename, 22) : "upload a file";
    el.classList.toggle("empty", !rec);
    el.title = rec ? `${rec.filename}
Uploaded ${new Date(rec.uploadedAt).toLocaleString()}${rec.rows ? `
${rec.rows} rows` : ""}` : "";
  }

  const results = state.latest?.results;
  const view = viewOf(results, state.scope);
  document.querySelectorAll("[data-scope]").forEach((b) => b.classList.toggle("on", b.dataset.scope === state.scope));
  $("scopeNote").textContent = !results ? ""
    : state.scope === "verified"
      ? `${num(view.positions.length, 0)} verified example positions (golden output)`
      : `${num(view.positions.length, 0)} positions from ${num(results.tender?.lv_pages, 0)} LV pages · ${num(results.systems?.length, 0)} systems`;

  const b = breakdown(view);
  $("chart").innerHTML = donutSvg(b);
  $("priceable").textContent = b.priceable == null ? "–" : num(b.priceable, 0);
  $("materials").textContent = b.materials == null ? "–" : num(b.materials, 0);

  const s = view?.summary || {};
  $("costs").innerHTML = [
    ["Material", s.material_cost_chf], ["Labor", s.labour_cost_chf],
    ["Direct", s.direct_cost_chf], ["Baseline", s.cost_baseline_chf],
  ].map(([l, v]) => `<dt>${l}: CHF</dt><dd>${chf(v)}</dd>`).join("");

  const sb = p.parameters.stretch_bid_optimization || {};
  const range = view?.bids;
  const scenarios = range?.scenarios
    || (sb.scenario_names || ["Aggressive", "Target", "Conservative"]).map((n) => ({ scenario: n }));
  $("bids").style.setProperty("--bid-cols", Math.min(scenarios.length, 4));
  $("bids").innerHTML = scenarios.map((sc) => {
    const prob = sc.estimated_win_probability;
    const margin = sc.margin_pct ?? sb.scenario_margins_pct?.[sc.scenario];
    const best = range?.best_expected_contribution === sc.scenario && scenarios.length > 1;
    return `<div class="bid${best ? " best" : ""}"><h3>${esc(sc.scenario)} Bid</h3><dl>
      <dt>Bid Price</dt><dd>${sc.bid_price_chf != null ? chf(sc.bid_price_chf) + " CHF" : "–"}</dd>
      <dt>Margin</dt><dd>${margin != null ? margin.toLocaleString("de-DE", { minimumFractionDigits: 1 }) + " %" : "–"}</dd>
      <dt>Win Probability</dt><dd>${prob != null
        ? `<span class="bar" title="${pct(prob * 100, 1)}"><i style="width:${prob * 100}%;background:${winColor(prob)}"></i></span>${Math.round(prob * 100)}%`
        : "–"}</dd>
      <dt>Contribution</dt><dd>${sc.expected_contribution_chf != null ? chf(sc.expected_contribution_chf) + " CHF" : "–"}</dd>
    </dl></div>`;
  }).join("") + (results ? "" : `<p class="hint">${
    state.latest?.status === "compute_failed" ? `Version ${p.currentVersion} could not be calculated: ${esc(state.latest.computeError)}`
    : p.currentVersion ? `Version ${p.currentVersion} is saved without results. Click Re-compute to calculate it.`
    : "Upload the tender, catalog and productivity files, then click Re-compute."}</p>`);
}
