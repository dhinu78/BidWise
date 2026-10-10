// File and parameter checks. Pure functions, no Firebase.

export const KINDS = ["tender", "catalog", "productivity"];
export const ALLOWED_EXT = { tender: [".pdf"], catalog: [".csv"], productivity: [".csv"] };

// Columns that must exist. Add the catalog columns once its format is fixed.
export const REQUIRED_COLUMNS = {
  catalog: [],
  productivity: ["install_code", "unit", "base_hours_per_unit", "default_hourly_rate_chf", "factor_keys"],
};
const NUMERIC_COLUMNS = {
  catalog: [],
  productivity: ["base_hours_per_unit", "default_hourly_rate_chf"],
};

export function toNumber(v) {
  let s = String(v ?? "").trim().replace(/['\s]/g, "");
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", "."); // decimal comma
  if (s === "") return NaN;
  return Number(s);
}

export function decodeText(buffer) {
  // Excel exports in Switzerland/Germany are often Windows-1252 instead of UTF-8.
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buffer), encoding: "windows-1252" };
  }
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const count = (ch) => firstLine.split(ch).length - 1;
  return [";", "\t", ","].sort((a, b) => count(b) - count(a))[0];
}

export function parseCSV(text, delimiter = detectDelimiter(text)) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  const header = (nonEmpty.shift() || []).map((h) => h.trim());
  const records = nonEmpty.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { delimiter, columns: header, rows: records };
}

export class ValidationError extends Error {}

export async function inspectFile(kind, file) {
  const ext = (file.name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  if (!ALLOWED_EXT[kind].includes(ext)) {
    throw new ValidationError(`${kind} must be a ${ALLOWED_EXT[kind].join("/")} file (got "${ext || "no extension"}")`);
  }
  if (file.size === 0) throw new ValidationError("The file is empty");
  const buffer = await file.arrayBuffer();

  if (kind === "tender") {
    const magic = new TextDecoder("ascii").decode(buffer.slice(0, 5));
    if (magic !== "%PDF-") throw new ValidationError("The tender file is not a valid PDF");
    return { info: {}, buffer };
  }

  const { text, encoding } = decodeText(buffer);
  const csv = parseCSV(text);
  if (!csv.columns.length) throw new ValidationError(`${kind} CSV has no header row`);
  const missing = REQUIRED_COLUMNS[kind].filter((c) => !csv.columns.includes(c));
  if (missing.length) throw new ValidationError(`${kind} CSV is missing columns: ${missing.join(", ")}`);
  if (!csv.rows.length) throw new ValidationError(`${kind} CSV has a header but no data rows`);
  const errors = [];
  csv.rows.forEach((r, i) => {
    for (const col of NUMERIC_COLUMNS[kind]) {
      if (Number.isNaN(toNumber(r[col]))) errors.push(`line ${i + 2}: "${col}" is not a number (${r[col]})`);
    }
  });
  if (errors.length) throw new ValidationError(errors.slice(0, 8).join("\n") + (errors.length > 8 ? "\n…" : ""));
  return {
    info: { encoding, delimiter: csv.delimiter, columns: csv.columns, rows: csv.rows.length },
    buffer,
    csv,
  };
}

export async function sha256(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- project_parameters.json ---------------------------------------------------

export function validateParameters(p) {
  const errs = [];
  const num = (path, v, { min = -Infinity, max = Infinity, gt } = {}) => {
    if (typeof v !== "number" || Number.isNaN(v)) return errs.push(`${path} must be a number`);
    if (v < min || v > max) errs.push(`${path} must be between ${min} and ${max}`);
    if (gt !== undefined && !(v > gt)) errs.push(`${path} must be greater than ${gt}`);
  };
  const pct = (path, v) => num(path, v, { min: 0, max: 100 });
  const prob = (path, v) => num(path, v, { min: 0, max: 1 });

  if (!p?.project?.name) errs.push("project.name is required");
  if (!/^[A-Z]{3}$/.test(p?.project?.currency || "")) errs.push("project.currency must be a 3-letter code like CHF");

  for (const [k, v] of Object.entries(p.productivity_factors || {})) num(`productivity_factors.${k}`, v, { gt: 0 });
  for (const [k, v] of Object.entries(p.allowances || {})) pct(`allowances.${k}`, v);
  for (const [k, v] of Object.entries(p.project_costs || {})) num(`project_costs.${k}`, v, { min: 0 });

  const c = p.commercial || {};
  pct("commercial.overhead_pct", c.overhead_pct);
  pct("commercial.target_margin_pct", c.target_margin_pct);
  num("commercial.round_to_chf", c.round_to_chf, { gt: 0 });

  const s = p.stretch_bid_optimization;
  if (s) {
    prob("stretch_bid_optimization.reference_win_probability", s.reference_win_probability);
    prob("stretch_bid_optimization.minimum_probability", s.minimum_probability);
    prob("stretch_bid_optimization.maximum_probability", s.maximum_probability);
    num("stretch_bid_optimization.price_sensitivity_probability_points_per_1pct_price",
      s.price_sensitivity_probability_points_per_1pct_price);
    num("stretch_bid_optimization.strategic_appetite_adjustment", s.strategic_appetite_adjustment, { min: -1, max: 1 });
    num("stretch_bid_optimization.competition_adjustment", s.competition_adjustment, { min: -1, max: 1 });
    if (s.minimum_probability > s.maximum_probability) errs.push("minimum_probability must be ≤ maximum_probability");
    const names = [...(s.scenario_names || [])].sort().join("|");
    const margins = Object.keys(s.scenario_margins_pct || {}).sort().join("|");
    if (names !== margins) errs.push("scenario_margins_pct needs exactly one entry per scenario name");
    for (const [k, v] of Object.entries(s.scenario_margins_pct || {})) pct(`scenario_margins_pct.${k}`, v);
  }
  return errs;
}

// Warnings shown on Re-compute (they don't block saving).
export function crossCheck(params, productivityRows) {
  const warnings = [];
  const factors = new Set(Object.keys(params.productivity_factors || {}));
  const unknown = new Set();
  for (const r of productivityRows) {
    for (const k of (r.factor_keys || "").split("|").filter(Boolean)) if (!factors.has(k)) unknown.add(k);
  }
  if (unknown.size) warnings.push(`productivity.csv uses factor keys missing from productivity_factors: ${[...unknown].join(", ")}`);
  const seen = new Set(), dup = new Set();
  for (const r of productivityRows) (seen.has(r.install_code) ? dup : seen).add(r.install_code);
  if (dup.size) warnings.push(`Duplicate install_code in productivity.csv: ${[...dup].join(", ")}`);
  return warnings;
}

export function safeFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop();
  const clean = base.replace(/[^A-Za-z0-9._()\- ]+/g, "_").replace(/^[ .]+|[ .]+$/g, "");
  return clean || "file";
}
