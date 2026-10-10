// Small DOM helpers shared by all pages.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const de = (min, max) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: min, maximumFractionDigits: max });
export const chf = (v) => (v == null || Number.isNaN(+v) ? "–" : de(2, 2).format(+v));
export const num = (v, d = 2) => (v == null || Number.isNaN(+v) ? "–" : de(0, d).format(+v));
export const pct = (v, d = 1) => (v == null || Number.isNaN(+v) ? "–" : `${de(0, d).format(+v)}%`);

let toastTimer;
export function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isError ? "error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 4000);
}

export async function busy(fn, quietErrors = []) {
  $("busy").hidden = false;
  try { return await fn(); }
  catch (e) {
    if (!quietErrors.some((C) => e instanceof C)) console.error(e);
    toast(e.message || String(e), true);
  } finally { $("busy").hidden = true; }
}

export function openDialog(title, bodyHtml, buttons = []) {
  const dlg = $("dlg");
  $("dlgTitle").textContent = title;
  $("dlgBody").innerHTML = bodyHtml;
  $("dlgBody").onclick = null;
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
export const closeDialog = () => $("dlg").open && $("dlg").close();
$("dlg").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDialog(); });

/** Text prompt. Resolves to the text ("" allowed) or null when cancelled. */
export function ask(title, value = "") {
  return new Promise((resolve) => {
    openDialog(title, `<div class="ask"><input id="askInput" value="${esc(value)}"></div>`, [
      { label: "Cancel", cls: "ghost", onClick: () => { resolve(null); closeDialog(); } },
      { label: "OK", cls: "navy", onClick: () => { resolve($("askInput").value.trim()); closeDialog(); } },
    ]);
    $("dlg").addEventListener("close", () => resolve(null), { once: true });
    const input = $("askInput");
    input.focus(); input.select();
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("dlgFoot").lastChild.click(); } };
  });
}

/** Choice dialog. Resolves to the chosen value, or null when closed. */
export function choose(title, text, options) {
  return new Promise((resolve) => {
    openDialog(title, `<p>${esc(text)}</p>`, options.map((o) => ({
      label: o.label, cls: o.cls, onClick: () => { resolve(o.value); closeDialog(); },
    })));
    $("dlg").addEventListener("close", () => resolve(null), { once: true });
  });
}

export function downloadText(filename, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: `${type};charset=utf-8` }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
