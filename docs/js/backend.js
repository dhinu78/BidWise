// Connection to the tender pricer (tender-pricer-9) through the local bridge (pricer-bridge/bridge.py):
//
//   python pricer-bridge/bridge.py            (from the BidWise folder; keep the window open)
//
// On Compute / Re-compute the app sends the version's files to the bridge, which runs the pricer's
// command line inside tender-pricer-9
//
//   python src/build_positions.py <tender.pdf> --catalog <catalog.csv> --productivity <productivity.csv>
//                                 --params <project_parameters.json> --out out
//
// and answers with the files the script wrote to out/ (priced_output.json, lv_positions.csv).
// Leave BACKEND_URL empty to use the built-in browser engine (js/compute.js) instead.
//
//   GET  {BACKEND_URL}/health    -> {"status": "ok", "ready": true, "busy": false, ...}
//   POST {BACKEND_URL}/compute   multipart/form-data: tender, catalog, productivity, parameters, [llm]
//   -> 200 {"priced_output": {...}, "lv_positions_csv": "...", "out_dir", "command", "seconds", "log"}
//   -> 400 / 409 / 500 {"detail": "..."}
//
// priced_output.json is shown as it is (dashboard, detailed summary). The pricer does not know about
// the user's position edits (parameters.position_overrides); the app applies them on top of its
// output after every run. Neither the pricer nor the bridge knows anything about Firebase.
export const BACKEND_URL = "http://localhost:8765";

// true: --llm (the pricer's LLM reads the page images), false: --no-llm (rules only),
// null: neither flag, so the pricer's own default (BIDWISE_LLM in its .env) applies.
export const BACKEND_LLM = null;

const TIMEOUT_MS = 31 * 60 * 1000;                  // the bridge stops the script after 30 minutes

export const backendEnabled = () => !!BACKEND_URL;
const base = () => BACKEND_URL.replace(/\/+$/, "");
export const backendHost = () => (BACKEND_URL ? new URL(BACKEND_URL).host : "");

/** True when the bridge answers /health within a few seconds. */
export async function backendReachable(ms = 4000) {
  if (!BACKEND_URL) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base()}/health`, { signal: ctl.signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The file name the pricer accepts for each input (it checks the extension). */
function fileName(kind, name) {
  const ext = kind === "tender" ? ".pdf" : ".csv";
  return String(name || "").toLowerCase().endsWith(ext) ? name : `${kind}${ext}`;
}

/**
 * Run the pricer on the version's files.
 * @param {{files:{tender:Blob,catalog:Blob,productivity:Blob},
 *          names:{tender:string,catalog:string,productivity:string},
 *          parameters:object, onProgress?:(text:string)=>void}} job
 * @returns {Promise<{parameters:null, output:object, files:object, run:object}>}
 */
export async function runBackend({ files, names, parameters, onProgress }) {
  const form = new FormData();
  for (const k of ["tender", "catalog", "productivity"]) form.append(k, files[k], fileName(k, names[k]));
  form.append("parameters", new Blob([JSON.stringify(parameters, null, 2)], { type: "application/json" }), "project_parameters.json");
  if (BACKEND_LLM !== null) form.append("llm", String(!!BACKEND_LLM));

  // the script runs within the request; show the elapsed time meanwhile
  const started = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    onProgress?.(`Running build_positions.py (tender pricer)… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
      + (s > 20 ? "\nThe first run of a tender takes longest; repeats are faster." : ""));
  };
  tick();
  const timer = setInterval(tick, 1000);
  const ctl = new AbortController();
  const stop = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  let res, body = null;
  try {
    res = await fetch(`${base()}/compute`, { method: "POST", body: form, signal: ctl.signal });
    try { body = await res.json(); } catch {}
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "The pricer did not finish within 30 minutes."
      : `The pricer bridge stopped answering (${backendHost()}). Is its window still open?`);
  } finally {
    clearInterval(timer);
    clearTimeout(stop);
  }
  if (!res.ok) {
    const msg = body?.detail ?? body?.error ?? res.statusText;
    throw new Error(`Pricer error ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  const output = body?.priced_output;
  if (!output || !Array.isArray(output.position_results)) throw new Error("out/priced_output.json has no position_results.");
  return {
    parameters: null, output,
    files: body.lv_positions_csv ? { "lv_positions.csv": body.lv_positions_csv } : {},
    run: { out_dir: body.out_dir, command: body.command, seconds: body.seconds },
  };
}
