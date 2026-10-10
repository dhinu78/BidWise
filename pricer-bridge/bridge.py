"""BIDWISE pricer bridge: lets the browser app run the tender pricer's command line on this PC.

    python pricer-bridge/bridge.py                 (from the BidWise folder; keep the window open)

When Compute / Re-compute is clicked, the app sends the project's files here. The bridge saves them
in a new folder under %TEMP%/bidwise-bridge, runs, inside tender-pricer-9,

    python src/build_positions.py <tender.pdf> --catalog <catalog.csv> --productivity <productivity.csv>
                                  --params <project_parameters.json> --out out

and answers with what the script wrote to tender-pricer-9/out/ (priced_output.json, lv_positions.csv).
The pricer's code is never changed; only its out/ folder is written, by the script itself.

    GET  /health    {"status": "ok", "pricer": "...", "python": "..."}
    GET  /fetch?url=<Firebase Storage download URL>   the file, for browsers where the Storage bucket
                    blocks direct downloads (CORS); only firebasestorage.googleapis.com URLs
    POST /compute   multipart/form-data: tender (.pdf), catalog (.csv), productivity (.csv),
                    parameters (.json), optional llm = "true" | "false"
      -> 200 {"priced_output": {...}, "lv_positions_csv": "...", "out_dir": "...", "command": [...],
              "seconds": 12.3, "log": "last lines of the script's output"}
      -> 400 {"detail": "..."} bad upload · 409 another run is busy · 500 the script failed

Settings (environment variables, all optional):
    BIDWISE_PRICER_DIR     the pricer folder           default: ../tender-pricer-9 next to this folder
    BIDWISE_PRICER_PYTHON  python with the pricer's packages (pymupdf, pandas, ...)  default: this python
    BIDWISE_BRIDGE_PORT    default 8765
    BIDWISE_ALLOWED_ORIGINS  default "http://localhost:5500,https://dhinu78.github.io"
Only standard-library Python; it runs the pricer with BIDWISE_PRICER_PYTHON.
"""
from __future__ import annotations

import email.parser
import email.policy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
PRICER = Path(os.environ.get("BIDWISE_PRICER_DIR", HERE.parent / "tender-pricer-9")).resolve()
PYTHON = os.environ.get("BIDWISE_PRICER_PYTHON", sys.executable)
PORT = int(os.environ.get("BIDWISE_BRIDGE_PORT", "8765"))
ORIGINS = [o.strip() for o in os.environ.get(
    "BIDWISE_ALLOWED_ORIGINS", "http://localhost:5500,https://dhinu78.github.io").split(",") if o.strip()]
INPUTS = Path(tempfile.gettempdir()) / "bidwise-bridge"     # the files of each run (not in OneDrive)
OUT = "out"                                   # --out out, relative to the pricer folder
TIMEOUT_S = 30 * 60
MAX_UPLOAD = 200 * 1024 * 1024
FIELDS = {"tender": ".pdf", "catalog": ".csv", "productivity": ".csv", "parameters": ".json"}

busy = threading.Lock()                       # one run at a time: they share out/


def safe_name(name: str, ext: str, fallback: str) -> str:
    base = Path(name or "").name
    keep = "".join(c if c.isalnum() or c in "._- " else "_" for c in base).strip()
    return keep if keep.lower().endswith(ext) else fallback + ext


def parse_multipart(content_type: str, body: bytes) -> dict:
    msg = email.parser.BytesParser(policy=email.policy.default).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if not msg.is_multipart():
        raise ValueError("expected multipart/form-data")
    parts = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            parts[name] = (part.get_filename(), part.get_payload(decode=True) or b"")
    return parts


def run_pricer(parts: dict) -> dict:
    missing = [k for k in FIELDS if k not in parts or not parts[k][1]]
    if missing:
        raise ValueError(f"missing file(s): {', '.join(missing)}")
    if not (PRICER / "src" / "build_positions.py").exists():
        raise RuntimeError(f"tender pricer not found in {PRICER}")

    # the inputs of this run: a new folder each time, outside OneDrive (a synced folder can't always be
    # deleted and recreated right away); earlier runs' folders are removed when possible
    for old in INPUTS.glob("run-*"):
        shutil.rmtree(old, ignore_errors=True)
    run_dir = INPUTS / f"run-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}-{threading.get_ident() % 10000}"
    run_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for kind, ext in FIELDS.items():
        filename, data = parts[kind]
        p = run_dir / safe_name(filename, ext, kind if kind != "parameters" else "project_parameters")
        p.write_bytes(data)
        paths[kind] = str(p)

    cmd = [PYTHON, "src/build_positions.py", paths["tender"], "--catalog", paths["catalog"],
           "--productivity", paths["productivity"], "--params", paths["parameters"], "--out", OUT]
    llm = (parts.get("llm", (None, b""))[1] or b"").decode().strip().lower()
    if llm in ("true", "1", "on"):
        cmd.append("--llm")
    elif llm in ("false", "0", "off"):
        cmd.append("--no-llm")

    out_dir = PRICER / OUT
    started = time.time()
    print(f"[bridge] {time.strftime('%H:%M:%S')} running: {' '.join(cmd)}  (in {PRICER})", flush=True)
    proc = subprocess.run(cmd, cwd=PRICER, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=TIMEOUT_S, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    seconds = round(time.time() - started, 1)
    log = (proc.stdout + ("\n" + proc.stderr if proc.stderr else "")).strip()
    print(f"[bridge] finished in {seconds} s with exit code {proc.returncode}", flush=True)
    if proc.returncode != 0:
        raise RuntimeError(f"build_positions.py failed (exit code {proc.returncode}):\n" + "\n".join(log.splitlines()[-15:]))

    json_path, csv_path = out_dir / "priced_output.json", out_dir / "lv_positions.csv"
    if not json_path.exists() or json_path.stat().st_mtime < started - 1:
        raise RuntimeError(f"the script did not write a new {json_path}")
    return {
        "priced_output": json.loads(json_path.read_text(encoding="utf-8")),
        "lv_positions_csv": csv_path.read_text(encoding="utf-8") if csv_path.exists() else None,
        "out_dir": str(out_dir), "command": cmd[1:], "seconds": seconds,
        "log": "\n".join(log.splitlines()[-20:]),
    }


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")   # https page -> localhost

    def reply(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/fetch":
            return self.fetch_storage_file()
        if route != "/health":
            return self.reply(404, {"detail": "not found"})
        self.reply(200, {"status": "ok", "pricer": str(PRICER), "python": PYTHON,
                         "ready": (PRICER / "src" / "build_positions.py").exists(), "busy": busy.locked(), "fetch": True})

    def fetch_storage_file(self):
        """GET /fetch?url=<Firebase Storage download URL>: the file's bytes. For browsers whose
        Storage bucket does not allow direct downloads (CORS); only Firebase Storage URLs."""
        origin = self.headers.get("Origin")
        if origin and origin not in ORIGINS:
            return self.reply(403, {"detail": f"origin {origin} is not allowed"})
        url = parse_qs(urlparse(self.path).query).get("url", [""])[0]
        u = urlparse(url)
        if u.scheme != "https" or u.hostname != "firebasestorage.googleapis.com":
            return self.reply(400, {"detail": "only Firebase Storage download URLs can be fetched"})
        try:
            with urlopen(Request(url, headers={"User-Agent": "bidwise-bridge"}), timeout=120) as res:
                data = res.read(MAX_UPLOAD + 1)
                ctype = res.headers.get("Content-Type", "application/octet-stream")
        except HTTPError as e:
            return self.reply(e.code, {"detail": f"Firebase Storage answered {e.code}"})
        except Exception as e:
            return self.reply(502, {"detail": f"could not download the file: {e}"})
        if len(data) > MAX_UPLOAD:
            return self.reply(413, {"detail": "file too large"})
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.split("?")[0] != "/compute":
            return self.reply(404, {"detail": "not found"})
        origin = self.headers.get("Origin")
        if origin and origin not in ORIGINS:
            return self.reply(403, {"detail": f"origin {origin} is not allowed"})
        length = int(self.headers.get("Content-Length") or 0)
        if not length or length > MAX_UPLOAD:
            return self.reply(400, {"detail": "empty or too large upload"})
        try:
            parts = parse_multipart(self.headers.get("Content-Type", ""), self.rfile.read(length))
        except Exception as e:
            return self.reply(400, {"detail": f"could not read the upload: {e}"})
        if not busy.acquire(blocking=False):
            return self.reply(409, {"detail": "the pricer is already running for another Compute; try again when it has finished"})
        try:
            self.reply(200, run_pricer(parts))
        except ValueError as e:
            self.reply(400, {"detail": str(e)})
        except subprocess.TimeoutExpired:
            self.reply(500, {"detail": f"build_positions.py did not finish within {TIMEOUT_S // 60} minutes"})
        except Exception as e:
            self.reply(500, {"detail": str(e)})
        finally:
            busy.release()

    def log_message(self, fmt, *args):                       # quieter console: one line per request
        print(f"[bridge] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"BIDWISE pricer bridge on http://localhost:{PORT}\n  pricer: {PRICER}\n  python: {PYTHON}\n"
          f"  output: {PRICER / OUT}\n  allowed pages: {', '.join(ORIGINS)}\nKeep this window open while using BIDWISE.", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
