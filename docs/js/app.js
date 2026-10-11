import * as store from "./store.js";
import { KINDS, inspectFile, sha256, validateParameters, crossCheck, decodeText, parseCSV, ValidationError } from "./validate.js";
import { computeEstimation, buildContext, normalizeBackendOutput, applyEditsToResults, repriceResults, rulesList } from "./compute.js";
import { BACKEND_URL, runBackend, backendReachable, backendHost } from "./backend.js";
import { $, esc, chf, pct, num, toast, busy, progress, shortName, openDialog, closeDialog, ask, choose, computeLabel, stableJson, paramsKey } from "./ui.js";
import { CATEGORIES, breakdown, viewOf, recommendedScenario } from "./categories.js";
import { DEFAULT_PARAMETERS } from "./defaults.js";
import { initParamsPage, showParamsPage, confirmLeave, isDirty } from "./params-page.js";
import { initSummaryPage, showSummaryPage } from "./summary-page.js";
import { initAssistant, assistantProjectChanged } from "./ai.js";
import { getFile, putFile } from "./local-files.js";

const LAST_PROJECT_KEY = "bidwise.lastProject";

const state = {
  user: null,
  defaults: DEFAULT_PARAMETERS,
  project: null,
  latest: null,     // latest version document
  localBlobs: {},   // files picked in this browser session: {kind: {sha256, blob}}
};

const ctx = {
  state, store, reload: () => reload(), go: (p) => go(p),
  recompute: () => $("recomputeBtn").click(),   // same flow as the button (asks for a note)
  refresh: () => showPage(),                    // re-render the current page after outside changes
  saveEdits: (changes, note) => saveEdits(changes, note),
};
initParamsPage(ctx);
initSummaryPage(ctx);
initAssistant(ctx);

// ---- pages (#/ , #/parameters ; #/summary = the summary section of the dashboard) ---------

const PAGES = { "": "dashboard", parameters: "params", summary: "dashboard" };
let currentPage = null, currentProjectId = null;
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

const ALL_PAGES = ["start", "dashboard", "params"];

function showPage() {
  if (!state.user) return;
  const route = location.hash.replace(/^#\/?/, "");
  const page = state.project ? PAGES[route] || "dashboard" : "start";
  // a re-render of the same page (after an edit, a save, …) keeps the scroll position and filters
  const same = page === currentPage && state.project?.id === currentProjectId;
  currentPage = page;
  currentProjectId = state.project?.id ?? null;
  document.body.dataset.page = page;
  for (const p of ALL_PAGES) $(`page-${p}`).hidden = p !== page;
  if (page === "start") return renderStart();
  if (!same) window.scrollTo(0, 0);
  if (page === "params") showParamsPage();
  if (page === "dashboard") refreshSummary(same, route === "summary");
}

/** The detailed summary below the dashboard: shown once there are results, loaded in the background. */
async function refreshSummary(keepView, scroll) {
  const has = !!state.latest?.results;
  $("summarySection").hidden = !has;
  if (!has) return;
  try { await showSummaryPage({ keepView }); }
  catch (e) { console.warn("The detailed summary could not be loaded", e); }
  if (scroll) $("summarySection").scrollIntoView({ behavior: "smooth", block: "start" });
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
  document.body.classList.toggle("signed-in", !!user);
  if (!user) {
    state.project = null;
    for (const p of ALL_PAGES) $(`page-${p}`).hidden = true;
    return;
  }
  const name = user.displayName || user.email || "?";
  $("userName").textContent = name.split(" ")[0];
  $("avatar").innerHTML = user.photoURL
    ? `<img src="${esc(user.photoURL)}" alt="" referrerpolicy="no-referrer">`
    : esc(name[0].toUpperCase());

  await store.saveProfile(user);

  // Re-open the last project used in this browser; otherwise show the start page.
  // Projects are only created when the user clicks "New".
  const projects = await store.listProjects(user.uid);
  let pid = null;
  try { pid = localStorage.getItem(LAST_PROJECT_KEY); } catch {}
  state.projects = projects;
  if (pid && projects.some((p) => p.id === pid)) await openProject(pid);
  else { state.project = null; state.latest = null; showPage(); }
}));

// ---- start page (no project open) ------------------------------------------------------------

function projectRows(projects) {
  return projects.map((p) => `
    <div class="list-row" data-pid="${esc(p.id)}">
      <div><b>${esc(p.name)}</b>${p.parameters?.project?.client ? ` <small>· ${esc(p.parameters.project.client)}</small>` : ""}
        <br><small>${p.workingFiles?.tender ? esc(p.workingFiles.tender.filename) + " · " : ""}updated ${new Date(p.updatedAt).toLocaleString()}</small></div>
      <span>${p.id === state.project?.id ? '<span class="tag ok">open</span> ' : ""}<span class="tag">${p.currentVersion ? `Version ${p.currentVersion}` : "no version yet"}</span> <span class="tag bid-${esc(p.bid?.status || "in_progress")}">${esc(bidLabel(p.bid?.status))}</span>
        <button class="row-del" data-del="${esc(p.id)}" title="Delete this project" aria-label="Delete project ${esc(p.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></span>
    </div>`).join("");
}

function renderStart() {
  const projects = state.projects || [];
  $("projectName").textContent = "";
  $("startTitle").textContent = `Welcome${state.user?.displayName ? ", " + state.user.displayName.split(" ")[0] : ""}`;
  $("startList").innerHTML = projects.length
    ? `<h3>Your projects</h3>${projectRows(projects)}`
    : `<p class="start-empty">You have no projects yet. Create one for each tender you want to price.</p>`;
}
$("startList").onclick = (e) => {
  const del = e.target.closest("[data-del]");
  if (del) return confirmDeleteProject(del.dataset.del);
  const row = e.target.closest("[data-pid]");
  if (row) busy(() => openProject(row.dataset.pid));
};

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
  assistantProjectChanged();
  // the detailed summary below the dashboard follows the new results too (first Compute shows it)
  if (currentPage === "dashboard" && state.project) refreshSummary(true);
}

async function newProject() {
  const name = await ask("New project name (e.g. the tender or building)");
  if (!name) return;
  busy(async () => {
    const project = await store.createProject(state.user, name, state.defaults);
    state.projects = [project, ...(state.projects || [])];
    go("");
    await openProject(project.id);
    toast("Project created. Upload the tender PDF, catalog and productivity files, then click Compute.");
  });
}
$("newBtn").onclick = newProject;
$("startNewBtn").onclick = newProject;

$("renameBtn").onclick = async () => {
  const name = await ask("Rename project", state.project.name);
  if (name) busy(async () => { await store.renameProject(state.user, state.project.id, name); await reload(); });
};

$("projectsBtn").onclick = () => busy(async () => {
  const projects = await store.listProjects(state.user.uid);
  state.projects = projects;
  openDialog("Projects", projectRows(projects) || "<p>No projects yet. Click <b>New</b> to create one.</p>");
  $("dlgBody").onclick = (e) => {
    const del = e.target.closest("[data-del]");
    if (del) return confirmDeleteProject(del.dataset.del, () => $("projectsBtn").click());
    const row = e.target.closest("[data-pid]");
    if (row) { closeDialog(); busy(() => openProject(row.dataset.pid)); }
  };
});

/**
 * Delete a project from Firebase for good (files, versions, results, chats, quotes), after the user
 * types its name. `then` runs afterwards (e.g. reopen the Projects list).
 */
function confirmDeleteProject(pid, then) {
  const p = (state.projects || []).find((x) => x.id === pid) || (state.project?.id === pid ? state.project : null);
  if (!p) return;
  openDialog("Delete project", `
    <p style="margin-top:0">This permanently deletes <b>${esc(p.name)}</b> from Firebase: all ${p.currentVersion ? `${p.currentVersion} version(s), ` : ""}uploaded files,
      results, edits, bid status, assistant chats, supplier quotes and generated PDFs. <b>This cannot be undone.</b></p>
    <div class="form-grid">
      <label for="delName">Type the project name</label>
      <input id="delName" type="text" autocomplete="off" placeholder="${esc(p.name)}">
    </div>
    <p id="delErr" style="color:var(--danger);margin:10px 0 0" hidden>The name does not match.</p>`, [
    { label: "Cancel", cls: "ghost", onClick: () => { closeDialog(); then?.(); } },
    { label: "Delete permanently", cls: "danger", onClick: () => {
      if ($("delName").value.trim() !== p.name.trim()) { $("delErr").hidden = false; return; }
      closeDialog();
      busy(async () => {
        const res = await store.deleteProject(state.user, pid, progress);
        try {
          localStorage.removeItem(`bidwise.offer.${pid}`);
          if (localStorage.getItem(LAST_PROJECT_KEY) === pid) localStorage.removeItem(LAST_PROJECT_KEY);
        } catch {}
        state.projects = (state.projects || []).filter((x) => x.id !== pid);
        if (state.project?.id === pid) {
          state.project = null; state.latest = null; state.localBlobs = {};
          assistantProjectChanged();
        }
        showPage();
        toast(`Project "${p.name}" deleted (${res.files} file(s) removed).`);
        then?.();
      });
    } },
  ]);
  setTimeout(() => $("delName")?.focus(), 50);
}

$("saveBtn").onclick = () => busy(async () => {
  await store.saveParameters(state.user, state.project.id, state.project.parameters);
  toast("Project saved. (Uploads and parameter changes are also saved automatically.)");
});

// ---- priced tender PDF (js/offer-pdf.js) ---------------------------------------------------------

// Only what the tender does not say itself; company details, dates etc. are left to the tender form.
const OFFER_DEFAULTS = { scenario: "", includeEstimates: true, rabatt_pct: 0, skonto_pct: 0, validity_days: 30 };

/**
 * A file of a version: picked in this session, or read back from Storage once and then kept for
 * the session (state.localBlobs, matched by sha256).
 */
async function versionFile(version, kind, ms, message) {
  const rec = version.files?.[kind];
  const local = state.localBlobs[kind];
  if (local && local.sha256 === rec?.sha256) return local.blob;
  const blob = await Promise.race([store.readFile(rec.storagePath),
    new Promise((_, no) => setTimeout(() => no(new Error(message)), ms))]);
  if (rec?.sha256) state.localBlobs[kind] = { sha256: rec.sha256, blob };
  return blob;
}

/**
 * The tender PDF of a version: picked in this session or kept in this browser (js/local-files.js).
 * Null if it is in neither; it is then downloaded (downloadTender).
 */
async function localTender(version) {
  const sha = version.files?.tender?.sha256;
  const local = state.localBlobs.tender;
  if (local && local.sha256 === sha) return local.blob;
  const kept = sha ? await getFile(sha) : null;
  if (kept) state.localBlobs.tender = { sha256: sha, blob: kept };
  return kept;
}

/** Download the saved tender once (plain download link, no SDK time limit) and keep it in this browser. */
let tenderDownloadFailed = false;
async function downloadTender(version) {
  const rec = version.files?.tender;
  progress("Downloading the tender PDF…");
  try {
    const blob = await store.downloadFile(rec.storagePath, 180_000);
    const hash = await sha256(await blob.arrayBuffer());
    if (rec.sha256 && hash !== rec.sha256) throw new Error("the downloaded file is not the saved tender");
    state.localBlobs.tender = { sha256: hash, blob };
    putFile(hash, blob, rec.filename);
    return blob;
  } catch (e) {
    tenderDownloadFailed = true;                       // next time the dialog offers to pick the file
    throw new Error(`The tender PDF could not be downloaded (${e.message || e}). Click PDF again and pick the tender file instead.`);
  }
}

/** A tender PDF the user picks in the PDF dialog; must be the one the version was computed from. */
async function pickedTender(file, version) {
  const sha = version.files?.tender?.sha256;
  const hash = await sha256(await file.arrayBuffer());
  if (sha && hash !== sha) throw new Error(`"${file.name}" is not the tender of version ${version.version} (${version.files.tender.filename}). Please pick that file.`);
  state.localBlobs.tender = { sha256: hash, blob: file };
  putFile(hash, file, file.name);
  tenderDownloadFailed = false;
  return file;
}

// offer settings stay in this browser (per project); older projects may still carry them in Firestore
const offerKey = () => `bidwise.offer.${state.project.id}`;
function offerSettings() {
  try { const s = JSON.parse(localStorage.getItem(offerKey())); if (s) return s; } catch {}
  return state.project.offer || {};
}
function keepOfferSettings(s) {
  try { localStorage.setItem(offerKey(), JSON.stringify(s)); } catch {}
}

$("pdfBtn").onclick = async () => {
  const results = state.latest?.results;
  if (!results) return toast(`${computeLabel(state.project)} the project first; the PDF is made from the computed prices.`, true);
  const latest = state.latest;
  const tender = await localTender(latest);
  const { scenario: s0, includeEstimates, rabatt_pct, skonto_pct, validity_days } = { ...OFFER_DEFAULTS, ...offerSettings() };
  const o = { scenario: s0, includeEstimates, rabatt_pct, skonto_pct, validity_days };
  const scenarios = results.recommended_bid_range?.scenarios || [];
  const chosen = o.scenario && scenarios.some((s) => s.scenario === o.scenario) ? o.scenario
    : recommendedScenario(results.recommended_bid_range) || scenarios[0]?.scenario || "";
  const field = (id, label, value, type = "text", extra = "") =>
    `<label for="of_${id}">${label}</label><input id="of_${id}" type="${type}" value="${esc(value ?? "")}" ${extra}>`;
  openDialog("Priced tender (PDF)", `
    <p style="margin:0 0 14px;color:var(--muted);font-size:14px">The original tender with the prices filled in: unit price and amount per position, chapter and system totals, the cost summary and the conditions. The PDF stays in the tender's own language; company details, date and signature are left for you to complete. Version ${state.project.currentVersion}${results.edited_in_app ? " (with edits made in the app)" : ""}.</p>
    <div class="form-grid">
      <label for="of_scenario">Price scenario</label>
      <select id="of_scenario">${scenarios.map((s) => `<option value="${esc(s.scenario)}" ${s.scenario === chosen ? "selected" : ""}>${esc(s.scenario)}: CHF ${chf(s.bid_price_chf)} (margin ${num(s.margin_pct, 1)} %)</option>`).join("")}</select>
      <label for="of_est">Estimated prices</label>
      <select id="of_est"><option value="1" ${o.includeEstimates ? "selected" : ""}>Include as indicative prices (marked *)</option><option value="0" ${o.includeEstimates ? "" : "selected"}>Leave open (marked "price to follow")</option></select>
      ${field("rabatt", "Discount %", o.rabatt_pct, "number", 'step="0.1" min="0" max="100"')}
      ${field("skonto", "Early-payment discount %", o.skonto_pct, "number", 'step="0.1" min="0" max="100"')}
      ${field("validity", "Offer valid for (days)", o.validity_days, "number", 'step="1" min="0"')}
      ${tender || !tenderDownloadFailed ? "" : `<label for="of_tender">Tender PDF</label><div><input id="of_tender" type="file" accept=".pdf,application/pdf">
        <small style="display:block;color:var(--muted)">The download did not work. Pick ${esc(latest.files?.tender?.filename || "the tender PDF")} once; this browser keeps it for later PDFs.</small></div>`}
    </div>`, [
    { label: "Cancel", cls: "ghost", onClick: closeDialog },
    { label: "Create PDF", cls: "navy", onClick: () => {
      const settings = {
        scenario: $("of_scenario").value, includeEstimates: $("of_est").value === "1",
        rabatt_pct: +$("of_rabatt").value || 0, skonto_pct: +$("of_skonto").value || 0,
        validity_days: Math.max(0, Math.round(+$("of_validity").value || 0)),
      };
      const file = $("of_tender")?.files[0] || null;
      if (!tender && tenderDownloadFailed && !file) return toast("Please pick the tender PDF first.", true);
      closeDialog();
      busy(async () => {
        progress("Preparing the priced tender…");
        keepOfferSettings(settings);
        const src = tender || (file ? await pickedTender(file, latest) : await downloadTender(latest));
        const { buildOfferPdf } = await import("./offer-pdf.js");
        const { bytes, summary } = await buildOfferPdf({
          tenderBytes: await src.arrayBuffer(), results: latest.results, settings,
          project: state.project, version: latest.version, onProgress: progress,
        });
        const name = `${state.project.name.replace(/[^\w-]+/g, "_")}_offer_v${latest.version}_${settings.scenario || "offer"}.pdf`;
        const blob = new Blob([bytes], { type: "application/pdf" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        // a copy goes to Firebase after the download, in the background; the download never waits for it
        if (latest.folder) store.saveVersionFile(`${latest.folder}/offer/${name}`, blob, "application/pdf")
          .catch((e) => { console.warn("PDF not stored", e); toast(`The PDF was downloaded, but its copy could not be saved online (${e.code || e.message}).`, true); });
        toast(`PDF created: ${summary.priced} positions priced${summary.estimates ? ` (${summary.estimates} indicative *)` : ""}${summary.open ? `, ${summary.open} marked "price to follow"` : ""}${summary.missing ? `, ${summary.missing} not found in the form (listed on the last page)` : ""}. Net incl. VAT CHF ${chf(summary.netto)}.`);
      });
    } },
  ]);
};

$("paramsBtn").onclick = () => go("parameters");
$("summaryBtn").onclick = () => $("summarySection").scrollIntoView({ behavior: "smooth", block: "start" });

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
    putFile(hash, file, file.name);                           // kept in this browser for Compute and the PDF
    await reload();
    let extra = "";
    if (kind === "productivity") {
      // every factor key used by the file becomes an editable project factor (1.0 = no effect)
      const params = structuredClone(state.project.parameters);
      params.productivity_factors ??= {};
      const added = [...new Set(checked.csv.rows.flatMap((r) => String(r.factor_keys || "").split("|").map((k) => k.trim())))]
        .filter((k) => k && !(k in params.productivity_factors));
      if (added.length) {
        for (const k of added) params.productivity_factors[k] = 1.0;
        await store.saveParameters(state.user, state.project.id, params);
        await reload();
        extra = `\nAdded productivity factors (1.0, adjust under Edit parameters): ${added.join(", ")}`;
      }
    }
    toast(`Uploaded ${rec.filename}${rec.rows ? ` (${rec.rows} rows)` : ""}${extra}`);
  }, [ValidationError]);
};

// ---- re-compute & version history ------------------------------------------------------------

/**
 * The pricer does not read parameters.position_overrides: apply the user's edits (prices, quantities,
 * products, statuses) to its output, exactly as an edit in the app would.
 */
function withUserEdits(results, params) {
  const n = Object.keys(params.position_overrides || {}).length;
  if (!n) return results;
  const r = applyEditsToResults(results, params, params);
  delete r.edited_in_app;                                        // a computed version, not an in-app edit
  r.warnings = [...(r.warnings || []).filter((w) => !w.startsWith("Edited in the app")),
    `${n} position edit(s) made in the app were applied on top of the pricer's output.`];
  return r;
}

/**
 * The project's working files in this browser before a Compute: picked in this session, kept in
 * this browser (local-files.js), or downloaded from the cloud once. A file that can't be loaded
 * (e.g. Storage downloads blocked) is asked for once; it must be the same file (same SHA-256).
 * Returns false when the user cancels.
 */
async function ensureWorkingFiles() {
  const files = state.project.workingFiles || {};
  const need = [];
  for (const kind of KINDS) {
    const rec = files[kind];
    if (state.localBlobs[kind]?.sha256 === rec.sha256) continue;
    const kept = await getFile(rec.sha256);
    if (kept) state.localBlobs[kind] = { sha256: rec.sha256, blob: kept };
    else need.push(kind);
  }
  if (!need.length) return true;

  const failed = [], reasons = {};
  await busy(async () => {
    for (const kind of need) {
      const rec = files[kind];
      progress(`Loading the saved ${kind} file (${rec.filename})…`);
      try {
        const blob = await store.readFile(rec.storagePath);
        if (await sha256(await blob.arrayBuffer()) !== rec.sha256) throw new Error("different content");
        state.localBlobs[kind] = { sha256: rec.sha256, blob };
        putFile(rec.sha256, blob, rec.filename);
      } catch (e) {
        console.warn(`The saved ${kind} file could not be loaded`, e);
        failed.push(kind);
        reasons[kind] = e.message || String(e);
      }
    }
  });
  if (!failed.length) return true;

  return new Promise((resolve) => {
    const rows = failed.map((k) => `<label for="pick_${k}">${esc(k[0].toUpperCase() + k.slice(1))}</label>
      <div><input id="pick_${k}" type="file" accept="${k === "tender" ? ".pdf,application/pdf" : ".csv,text/csv"}">
        <small style="display:block;color:var(--muted)">${esc(files[k].filename)} · not loaded: ${esc(reasons[k])}</small></div>`).join("");
    openDialog("Pick the project files once", `
      <p style="margin:0 0 12px;color:var(--muted);font-size:14px">The saved file${failed.length > 1 ? "s" : ""} could not be loaded from the cloud in this browser.
        Pick the same file${failed.length > 1 ? "s" : ""} from your PC; this browser keeps ${failed.length > 1 ? "them" : "it"} for later Computes.</p>
      <div class="form-grid">${rows}</div>
      <p class="ai-change-err" id="pickErr" style="color:var(--danger);margin:10px 0 0" hidden></p>`, [
      { label: "Cancel", cls: "ghost", onClick: () => { resolve(false); closeDialog(); } },
      { label: "Continue", cls: "navy", onClick: async () => {
        const wrong = [];
        for (const k of failed) {
          const f = $(`pick_${k}`).files[0];
          if (!f) { wrong.push(`${k}: no file picked`); continue; }
          const hash = await sha256(await f.arrayBuffer());
          if (hash !== files[k].sha256) { wrong.push(`${k}: "${f.name}" is not the saved ${files[k].filename} (to use a new file, upload it on the dashboard)`); continue; }
          state.localBlobs[k] = { sha256: hash, blob: f };
          putFile(hash, f, f.name);
        }
        if (wrong.length) { $("pickErr").textContent = wrong.join(" · "); $("pickErr").hidden = false; return; }
        resolve(true);
        closeDialog();
      } },
    ]);
    $("dlg").addEventListener("close", () => resolve(false), { once: true });
  });
}

$("recomputeBtn").onclick = async (ev) => {
  const errors = validateParameters(state.project.parameters);
  if (errors.length) return toast(`Fix the parameters first:\n${errors.join("\n")}`, true);
  const missing = KINDS.filter((k) => !state.project.workingFiles?.[k]);
  if (missing.length) return toast(`Upload these files first: ${missing.join(", ")}`, true);
  const changes = changesSinceLatest();
  if (changes && !changes.length && state.latest?.status === "computed") {
    const again = await choose("Nothing has changed",
      `The files and parameters are the same as in version ${state.latest.version}. Compute a new, identical version anyway?`,
      [{ label: "Cancel", value: false, cls: "ghost" }, { label: "Compute again", value: true, cls: "navy" }]);
    if (!again) return;
  }

  // After the first Compute, Re-compute starts from the detailed summary (the positions with the user's
  // edits) instead of reading the tender PDF again, as long as the tender file is unchanged.
  // Shift + click reads the tender again anyway.
  const latestRes = state.latest?.results;
  const fromSummary = !!latestRes && !ev?.shiftKey
    && state.project.workingFiles?.tender?.sha256 === state.latest?.files?.tender?.sha256;

  // the pricer runs on this PC: make sure it is up before a version is reserved
  let useBackend = !!BACKEND_URL && !fromSummary;
  if (useBackend && !(await backendReachable())) {
    const how = await new Promise((resolve) => {
      openDialog("The pricer is not running", `
        <p style="margin-top:0">BIDWISE could not reach the pricer bridge at <b>${esc(backendHost())}</b>.
          Start it in a terminal in the BidWise folder and keep the window open, then click ${esc(computeLabel(state.project))} again:</p>
        <pre style="background:#f4f6f7;padding:8px 10px;border-radius:6px;white-space:pre-wrap">python pricer-bridge/bridge.py</pre>
        <p>It runs <code>python src/build_positions.py … --out out</code> in tender-pricer-9 for every Compute.</p>
        <p style="margin-bottom:0">Or compute this version with the simpler built-in engine instead.</p>`, [
        { label: "Cancel", cls: "ghost", onClick: () => { resolve(null); closeDialog(); } },
        { label: "Use built-in engine", cls: "grey", onClick: () => { resolve("builtin"); closeDialog(); } },
      ]);
      $("dlg").addEventListener("close", () => resolve(null), { once: true });
    });
    if (how !== "builtin") return;
    useBackend = false;
  }

  const note = await ask(`Note for version ${(state.project.currentVersion || 0) + 1} (optional)`, "");
  if (note === null) return;
  if (!(await ensureWorkingFiles())) return;
  busy(async () => {
    progress("Saving version…");
    const parsed = {};
    const prepare = async (blobs, parameters) => {
      for (const kind of ["catalog", "productivity"]) {
        parsed[kind] = parseCSV(decodeText(await blobs[kind].arrayBuffer()).text).rows;
      }
      return crossCheck(parameters, parsed.productivity);
    };
    const afterSave = async (blobs, version, manifest) => {
      const tenderName = manifest.files.tender.filename;
      if (fromSummary) {
        progress("Re-pricing the positions from the detailed summary…");
        const ctx = buildContext(manifest.parameters, parsed.catalog, parsed.productivity);
        const results = repriceResults(latestRes, manifest.parameters, state.latest.parameters || {}, ctx);
        results.version = version;
        return { results };
      }
      if (!useBackend) {
        return computeEstimation({
          version, parameters: manifest.parameters, catalog: parsed.catalog,
          productivity: parsed.productivity, tenderPdf: blobs.tender, tenderName, onProgress: progress,
        });
      }
      const answer = await runBackend({
        files: blobs,
        names: Object.fromEntries(KINDS.map((k) => [k, manifest.files[k].filename])),
        parameters: manifest.parameters,
        onProgress: progress,
      });
      progress("Saving results…");
      // the pricer's output is shown as it is; the user's position edits are applied on top of it
      let results = normalizeBackendOutput(answer.output,
        buildContext(answer.parameters || manifest.parameters, parsed.catalog, parsed.productivity), { version, tenderName });
      results.backend = { url: BACKEND_URL, ...answer.run };
      results = withUserEdits(results, answer.parameters || manifest.parameters);
      let parameters = null;
      if (answer.parameters) {
        parameters = { ...answer.parameters };
        // keep the user's position edits and custom-parameter list when the backend leaves them out
        for (const k of ["position_overrides", "custom_parameters"]) {
          if (!(k in parameters) && k in manifest.parameters) parameters[k] = manifest.parameters[k];
        }
        const problems = validateParameters(parameters);
        if (problems.length) results.warnings.push(`The parameters returned by the backend have problems: ${problems.join("; ")}`);
        results.parameter_changes = paramChanges(manifest.parameters, parameters);
      }
      return { results, parameters, output: answer.output, files: answer.files };
    };
    const manifest = await store.recompute(state.user, state.project.id, note, state.localBlobs, prepare, afterSave);
    await reload();
    const changed = manifest.results?.parameter_changes || [];
    const extra = [...(manifest.warnings || []), ...(manifest.results?.warnings || []),
      changed.length ? `Parameters updated by the backend: ${changed.slice(0, 6).map((c) => `${c.path} ${c.from ?? "–"} → ${c.to ?? "–"}`).join(", ")}${changed.length > 6 ? ` (+${changed.length - 6} more)` : ""}` : "",
      manifest.computeError ? `Calculation failed: ${manifest.computeError}` : ""].filter(Boolean);
    toast(`Saved version ${manifest.version}.${extra.length ? "\n" + extra.join("\n") : ""}`, !!manifest.computeError);
  });
};

// ---- edits saved right away (no re-compute) -------------------------------------------------------

function setPath(o, path, v) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((x, k) => (x[k] ??= {}), o)[last] = v;
}

/** Productivity rules of a version, for results computed before the rules were stored with them. */
async function rulesOf(version) {
  const blob = await versionFile(version, "productivity", 30_000, "timeout");
  return rulesList(buildContext({}, [], parseCSV(decodeText(await blob.arrayBuffer()).text).rows));
}

/**
 * Save position edits and parameter changes and apply them right away, like a normal edit:
 * edited positions are re-priced and the totals / bids updated in the app, stored as an
 * "edited in the app" version (no engine run). A later Re-compute recalculates everything.
 *   changes.positions = {lv_id: override | null}   (null removes the edit)
 *   changes.params    = [{path, value}]
 * Returns {version, created} or {savedOnly: true, reason} when there are no results to update.
 */
async function saveEdits({ positions = {}, params = [] } = {}, note = "") {
  const user = state.user;
  const project = await store.getProject(user.uid, state.project.id);
  const next = structuredClone(project.parameters);
  next.position_overrides ??= {};
  for (const [id, o] of Object.entries(positions)) {
    if (o) next.position_overrides[id] = { ...o, updatedAt: new Date().toISOString(), updatedBy: user.email || user.uid };
    else delete next.position_overrides[id];
  }
  for (const c of params) setPath(next, c.path, c.value);
  const problems = validateParameters(next);
  if (problems.length) throw new Error(`Not saved: ${problems.join("; ")}`);

  const latest = state.latest;
  const fileChanges = latest?.files ? KINDS.filter((k) => project.workingFiles?.[k]?.sha256 !== latest.files[k]?.sha256) : [];
  if (!latest?.results || fileChanges.length) {
    await store.saveParameters(user, project.id, next);
    await reload();
    showPage();
    return { savedOnly: true, reason: !latest?.results ? "not computed yet" : `new ${fileChanges.join(", ")} file uploaded` };
  }
  let base = latest.results;
  if (!base.productivity?.length) {
    try { base = { ...base, productivity: await rulesOf(latest) }; }
    catch (e) { console.warn("Productivity rules not available; labour of changed products stays 0", e); }
  }
  const results = applyEditsToResults(base, next, latest.parameters || {});
  const saved = await store.saveEditedVersion(user, project.id, latest, next, results, note);
  await reload();
  showPage();
  return saved;
}

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
      <td><span class="tag ${status}">${esc(v.edited_in_app ? "edited in app" : v.status)}</span>${v.edited_in_app
        ? `<br><small>${(v.edit_log || []).length} edit(s) on version ${esc(v.based_on_version ?? "–")}</small>` : ""}</td>
      <td>${v.files ? `<button class="btn ghost small" data-restore="${v.version}">Restore</button>` : ""}</td>
    </tr>`;
  }).join("");
  openDialog("Version history", versions.length
    ? `<table><thead><tr><th>#</th><th>Created</th><th>Files</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : "<p>No versions yet. Upload the three files and click Compute.</p>");

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

/** Leaf values that differ between two parameter objects (position edits are left out). */
function paramChanges(before, after, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (!prefix && (k === "position_overrides" || k === "custom_parameters")) continue;
    const a = before?.[k], b = after?.[k], path = prefix + k;
    const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (isObj(a) || isObj(b)) out.push(...paramChanges(isObj(a) ? a : {}, isObj(b) ? b : {}, path + "."));
    else if (stableJson(a) !== stableJson(b)) out.push({ path, from: a, to: b });
  }
  return out;
}

/**
 * What differs between the working state and the latest version: ["tender", "parameters", …],
 * [] when nothing changed, null when there is no version to compare with.
 */
function changesSinceLatest() {
  const p = state.project, v = state.latest;
  if (!p || !v?.files) return null;
  const changed = KINDS.filter((k) => p.workingFiles?.[k]?.sha256 !== v.files[k]?.sha256);
  if (paramsKey(p.parameters) !== paramsKey(v.parameters)) changed.push(
    Object.keys(p.parameters.position_overrides || {}).length !== Object.keys(v.parameters.position_overrides || {}).length
      || paramsKey({ position_overrides: p.parameters.position_overrides }) !== paramsKey({ position_overrides: v.parameters.position_overrides })
      ? "parameters / position edits" : "parameters");
  return changed;
}

// ---- bid status (in process / awaiting response / won / lost) ---------------------------------
// Kept on the project with a history entry per change; each entry records the version and its bid
// figures, so finished bids become history for later ones. Picking a status only opens its dialog:
// nothing changes until Save, and Save writes to Firestore first (on top of the latest stored
// status, re-read at that moment) and only then updates the screen.

const BID_STATUSES = [
  ["in_progress", "In process", "#2f6fb2"], ["awaiting_response", "Awaiting response", "#d99a00"],
  ["won", "Won", "#2e9d5b"], ["lost", "Lost", "#c9442f"],
];
const bidLabel = (k) => BID_STATUSES.find(([s]) => s === k)?.[1] || "In process";
const bidOf = (p) => ({ status: "in_progress", history: [], ...(p?.bid || {}) });

function renderBidStatus() {
  const bid = bidOf(state.project);
  $("bidStatus").innerHTML = BID_STATUSES.map(([k, l]) => `<option value="${k}" ${k === bid.status ? "selected" : ""}>${l}</option>`).join("");
  $("bidStatus").value = bid.status;
  $("bidStatusBox").className = `bid-status s-${bid.status}`;
  const last = bid.history.at(-1);
  $("bidStatusBox").title = `Bid status${last ? ` · since ${new Date(last.at).toLocaleDateString()}` : ""}${bid.submitted?.price_chf != null
    ? ` · submitted CHF ${chf(bid.submitted.price_chf)}` : ""}${bid.outcome?.winning_price_chf != null ? ` · ${bid.outcome.result === "won" ? "contract" : "winning"} price CHF ${chf(bid.outcome.winning_price_chf)}` : ""}`;
}

/** What the shown version said at the time of a status change (for later comparison). */
function bidSnapshot() {
  const r = state.latest?.results, s = viewOf(r)?.summary || {};
  return {
    version: state.project.currentVersion || null,
    direct_cost_chf: s.direct_cost_chf ?? null, cost_baseline_chf: s.cost_baseline_chf ?? null,
    scenarios: (r?.recommended_bid_range?.scenarios || []).map((x) => ({
      scenario: x.scenario, bid_price_chf: x.bid_price_chf ?? null, margin_pct: x.margin_pct ?? null,
      win_probability: x.estimated_win_probability ?? null })),
    recommended: recommendedScenario(r?.recommended_bid_range),
  };
}

/** Save a status change: Firestore first, then the screen. `extra` = details from the dialog. */
function saveBidStatus(status, extra, snap) {
  return busy(async () => {
    progress("Saving the bid status…");
    const fresh = await store.getProject(state.user.uid, state.project.id);      // latest stored status
    const bid = bidOf(fresh);
    const at = new Date().toISOString();
    const next = { ...bid, ...extra, status, updatedAt: at,
      history: [...bid.history, { status, at, by: state.user.email || state.user.uid, ...snap }] };
    await store.saveBid(state.user, state.project.id, next);
    state.project.bid = next;
    renderBidStatus();
    toast(`Bid status saved: ${bidLabel(status)}.`);
  }).then(renderBidStatus);                       // on an error busy() shows it; the saved status stays
}

$("bidStatus").onchange = () => {
  const status = $("bidStatus").value;
  renderBidStatus();                               // the control keeps the saved status until Save
  const bid = bidOf(state.project);
  if (status === bid.status) return;
  const snap = bidSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  const dialog = (title, intro, fields, collect) => openDialog(title, `
      <p style="margin:0 0 12px;color:var(--muted);font-size:14px">${intro}</p>
      <div class="form-grid">
        <label>Status</label><div style="padding-top:7px"><b>${esc(bidLabel(bid.status))}</b> → <b style="color:${BID_STATUSES.find(([k]) => k === status)[2]}">${esc(bidLabel(status))}</b></div>
        ${fields}
      </div>`, [
    { label: "Cancel", cls: "ghost", onClick: closeDialog },
    { label: "Save", cls: "navy", onClick: () => { const extra = collect(); closeDialog(); saveBidStatus(status, extra, snap); } },
  ]);

  if (status === "awaiting_response") {
    const sc = snap.scenarios;
    const pick = bid.submitted?.scenario || snap.recommended || sc[0]?.scenario || "";
    return dialog("Bid submitted", "Which price went to the client. It is kept with the project, so won and lost bids can guide later ones.", `
        <label for="bsScenario">Submitted price</label>
        <select id="bsScenario">${sc.map((x) => `<option value="${esc(x.scenario)}" ${x.scenario === pick ? "selected" : ""}>${esc(x.scenario)}: CHF ${chf(x.bid_price_chf)}${x.margin_pct != null ? ` (margin ${num(x.margin_pct, 1)} %)` : ""}</option>`).join("")}
          <option value="" ${sc.length ? "" : "selected"}>Other amount</option></select>
        <label for="bsPrice">Amount CHF</label>
        <input id="bsPrice" type="number" step="any" min="0" placeholder="only for another amount">
        <label for="bsDate">Submitted on</label>
        <input id="bsDate" type="date" value="${today}">`, () => {
      const name = $("bsScenario").value, chosen = sc.find((x) => x.scenario === name);
      return { submitted: { scenario: chosen ? name : "", price_chf: chosen ? chosen.bid_price_chf : +$("bsPrice").value || null,
        margin_pct: chosen?.margin_pct ?? null, date: $("bsDate").value || today, version: snap.version, cost_baseline_chf: snap.cost_baseline_chf } };
    });
  }
  if (status === "won" || status === "lost") {
    return dialog(status === "won" ? "Bid won" : "Bid lost", "The details are optional; they make the history more useful for later bids.", `
        ${bid.submitted?.price_chf != null ? `<label>Our submitted price</label><div style="padding-top:7px">CHF ${chf(bid.submitted.price_chf)}${bid.submitted.scenario ? ` (${esc(bid.submitted.scenario)})` : ""}</div>` : ""}
        <label for="boPrice">${status === "won" ? "Contract price CHF" : "Winning price CHF"}</label>
        <input id="boPrice" type="number" step="any" min="0" placeholder="${status === "won" ? "if different from our offer" : "if known"}">
        <label for="boDate">Decision date</label>
        <input id="boDate" type="date" value="${today}">
        <label for="boNote">Note</label>
        <input id="boNote" type="text" placeholder="${status === "won" ? "e.g. negotiated 2 % discount" : "e.g. price, delivery time, relationship"}">`, () => ({
      outcome: { result: status, winning_price_chf: +$("boPrice").value || null, date: $("boDate").value || today, note: $("boNote").value.trim() || null },
    }));
  }
  return dialog("Bid in process", "Back to working on this bid; the earlier steps stay in its history.", `
        <label for="bpNote">Note</label>
        <input id="bpNote" type="text" placeholder="optional, e.g. revised offer requested">`, () => ({
    outcome: null, ...($("bpNote").value.trim() ? { note: $("bpNote").value.trim() } : {}),
  }));
};

/** Installation hours of the positions counted in the totals. */
const installHours = (positions = []) => positions.filter((p) => p.included_in_total)
  .reduce((s, p) => s + (+p.adjusted_install_hours || 0), 0);

const winColor = (p) => (p >= 0.66 ? "var(--win-1)" : p >= 0.55 ? "var(--win-2)" : "var(--win-3)");

function renderDashboard() {
  const p = state.project;
  $("projectName").textContent = p.name;
  $("projectName").title = p.name;
  $("versionNo").textContent = p.currentVersion || "–";
  renderBidStatus();
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
  const view = viewOf(results);
  const changes = changesSinceLatest();
  const missing = KINDS.filter((k) => !p.workingFiles?.[k]);
  const label = computeLabel(p);
  const info = $("runInfo");
  info.classList.toggle("stale", !!changes?.length);
  info.textContent = changes?.length
    ? `Changed since version ${p.currentVersion}: ${changes.join(", ")}. ${label} to update the results.`
    : !results ? ""
    : [`${num(view.positions.length, 0)} positions`,
      results.tender?.lv_pages ? `${num(results.tender.lv_pages, 0)} LV pages` : "",
      results.systems?.length ? `${num(results.systems.length, 0)} system${results.systems.length === 1 ? "" : "s"}` : "",
      results.engine === "backend" ? "backend engine" : "",
      results.edited_in_app ? "edited in the app" : ""].filter(Boolean).join(" · ");
  $("recomputeBtn").textContent = label;
  $("recomputeBtn").classList.toggle("attention", !!changes?.length);
  $("recomputeBtn").title = missing.length ? `Upload first: ${missing.join(", ")}` : "";
  $("historyBtn").disabled = !p.currentVersion;
  $("historyBtn").title = p.currentVersion ? "" : "No versions yet";
  $("summaryBtn").disabled = !results;
  $("summaryBtn").title = results ? "" : `${label} first to see the detailed summary`;

  const b = breakdown(view);
  $("chart").innerHTML = donutSvg(b);
  $("priceable").textContent = b.priceable == null ? "–" : num(b.priceable, 0);
  $("materials").textContent = b.materials == null ? "–" : num(b.materials, 0);

  const s = view?.summary || {};
  $("costs").innerHTML = [
    ["Material", s.material_cost_chf], ["Labor", s.labour_cost_chf],
    ["Direct", s.direct_cost_chf], ["Baseline", s.cost_baseline_chf],
  ].map(([l, v]) => `<dt>${l}: CHF</dt><dd>${chf(v)}</dd>`).join("")
    + (view ? `<dt>Hours:</dt><dd title="Installation hours of the positions counted in the totals">${num(installHours(view.positions), 0)} h</dd>` : "");

  const sb = p.parameters.stretch_bid_optimization || {};
  const range = view?.bids;
  const scenarios = range?.scenarios
    || (sb.scenario_names || ["Aggressive", "Target", "Conservative"]).map((n) => ({ scenario: n }));
  $("bids").style.setProperty("--bid-cols", Math.min(scenarios.length, 4));
  $("bids").innerHTML = scenarios.map((sc) => {
    const prob = sc.estimated_win_probability;
    const margin = sc.margin_pct ?? sb.scenario_margins_pct?.[sc.scenario];
    const best = range && recommendedScenario(range) === sc.scenario && scenarios.length > 1;
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
    : missing.length ? `Upload the ${missing.join(", ")} file${missing.length > 1 ? "s" : ""}, then click Compute.`
    : "All files are uploaded. Check Edit parameters, then click Compute."}</p>`);
}
