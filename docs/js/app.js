import * as store from "./store.js";
import { KINDS, inspectFile, sha256, validateParameters, crossCheck, decodeText, parseCSV, ValidationError } from "./validate.js";
import { computeEstimation } from "./compute.js";
import { $, esc, chf, pct, num, toast, busy, openDialog, closeDialog, ask } from "./ui.js";
import { CATEGORIES, breakdown } from "./categories.js";
import { initParamsPage, showParamsPage, confirmLeave, isDirty } from "./params-page.js";
import { initSummaryPage, showSummaryPage } from "./summary-page.js";

const LAST_PROJECT_KEY = "bidwise.lastProject";

const state = {
  user: null,
  defaults: null,
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
  state.defaults ??= await (await fetch("defaults/project_parameters.json")).json();

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
    });
    const manifest = await store.recompute(state.user, state.project.id, note, state.localBlobs, prepare, afterSave);
    await reload();
    const extra = [...(manifest.warnings || []), manifest.computeError ? `Calculation failed: ${manifest.computeError}` : ""].filter(Boolean);
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
  const W = 420, H = 380, cx = W / 2, cy = H / 2, r = 112, sw = 40;
  const C = 2 * Math.PI * r;
  let parts = "", labels = "", start = 0;
  if (b.share) {
    const total = CATEGORIES.reduce((s, c) => s + (b.share[c.key] || 0), 0) || 1;
    for (const c of CATEGORIES) {
      const v = (b.share[c.key] || 0) / total;
      if (v <= 0) continue;
      parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color}" stroke-width="${sw}"
        stroke-dasharray="${v * C} ${C}" transform="rotate(${-90 + start * 360} ${cx} ${cy})"><title>${c.label}: ${pct(b.share[c.key])}</title></circle>`;
      const mid = (start + v / 2) * 2 * Math.PI - Math.PI / 2;
      const lx = cx + Math.cos(mid) * (r + sw / 2 + 14), ly = cy + Math.sin(mid) * (r + sw / 2 + 14);
      const anchor = Math.cos(mid) > 0.25 ? "start" : Math.cos(mid) < -0.25 ? "end" : "middle";
      const words = c.label.split(" ");
      const lines = c.label.length > 14 && words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [c.label];
      const y0 = ly - ((lines.length) * 11) / 2 + (Math.sin(mid) > 0.3 ? 8 : Math.sin(mid) < -0.3 ? -4 : 2);
      labels += `<text class="seg-label" text-anchor="${anchor}">${lines.concat(pct(b.share[c.key])).map((t, i) =>
        `<tspan x="${lx}" y="${y0 + i * 11}">${esc(t)}</tspan>`).join("")}</text>`;
      start += v;
    }
  } else {
    parts = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e0e0e0" stroke-width="${sw}"/>`;
  }
  const center = `
    <g transform="translate(${cx - 13} ${cy - 76})" fill="none" stroke="#4f9e6b" stroke-width="2.6" stroke-linecap="round">
      <circle cx="13" cy="13" r="12"/><path d="M7 13.5l4 4 9-10"/></g>
    <text class="center-title" x="${cx}" y="${cy - 28}" text-anchor="middle">Calculated:</text>
    <text class="center-val" x="${cx}" y="${cy - 7}" text-anchor="middle">${pct(b.calculated, 0)}</text>
    <g transform="translate(${cx - 14} ${cy + 5})" fill="none" stroke="#c95c4a" stroke-width="2.4" stroke-linejoin="round">
      <path d="M14 2L27 25H1z"/><path d="M14 10v7M14 21v.5" stroke-linecap="round"/></g>
    <text class="center-title" x="${cx}" y="${cy + 52}" text-anchor="middle">Manual review:</text>
    <text class="center-val" x="${cx}" y="${cy + 73}" text-anchor="middle">${pct(b.manual, 0)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Position status breakdown">${parts}${labels}${center}</svg>`;
}

function renderDashboard() {
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
  const b = breakdown(results);
  $("chart").innerHTML = donutSvg(b);
  $("priceable").textContent = b.priceable == null ? "–" : num(b.priceable, 0);
  $("materials").textContent = b.materials == null ? "–" : num(b.materials, 0);

  const s = results?.example_subset_summary || results?.summary || {};
  $("costs").innerHTML = [
    ["Material", s.material_cost_chf], ["Labor", s.labour_cost_chf],
    ["Direct", s.direct_cost_chf], ["Baseline", s.cost_baseline_chf],
  ].map(([l, v]) => `<dt>${l}: CHF</dt><dd>${chf(v)}</dd>`).join("");

  const sb = p.parameters.stretch_bid_optimization || {};
  const scenarios = results?.recommended_bid_range?.scenarios
    || (sb.scenario_names || ["Aggressive", "Target", "Conservative"]).map((n) => ({ scenario: n }));
  const colors = ["var(--win-1)", "var(--win-2)", "var(--win-3)"];
  $("bids").style.setProperty("--bid-cols", Math.min(scenarios.length, 4));
  $("bids").innerHTML = scenarios.map((sc, i) => {
    const prob = sc.estimated_win_probability;
    const margin = sc.margin_pct ?? sb.scenario_margins_pct?.[sc.scenario];
    return `<div class="bid"><h3>${esc(sc.scenario)} Bid</h3><dl>
      <dt>Bid Price</dt><dd>${sc.bid_price_chf != null ? chf(sc.bid_price_chf) + " CHF" : "–"}</dd>
      <dt>Margin</dt><dd>${margin != null ? margin.toLocaleString("de-DE", { minimumFractionDigits: 1 }) + " %" : "–"}</dd>
      <dt>Win Probability</dt><dd>${prob != null
        ? `<span class="bar"><i style="width:${prob * 100}%;background:${colors[i % 3]}"></i></span>${Math.round(prob * 100)}%`
        : "–"}</dd>
      <dt>Contribution</dt><dd>${sc.expected_contribution_chf != null ? chf(sc.expected_contribution_chf) + " CHF" : "–"}</dd>
    </dl></div>`;
  }).join("") + (results ? "" : `<p class="hint">${p.currentVersion
    ? `Version ${p.currentVersion} is saved. Results appear here once a calculation is added in js/compute.js.`
    : "Upload the tender, catalog and productivity files, then click Re-compute."}</p>`);
}
