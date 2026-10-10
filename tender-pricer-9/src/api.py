"""HTTP API for the frontend: upload the tender files, get the priced result.

    uvicorn api:app --app-dir src --reload --port 8000        (then open http://localhost:8000/docs)

POST /price   multipart/form-data
    tender         file  (required)  tender PDF
    catalog        file  (required)  catalog.csv
    productivity   file  (required)  productivity.csv
    parameters     file  (optional)  project_parameters.json, default: data/project_parameters.json
    trade          text  (optional)  ventilation | heating | sanitary, default: detected
    llm            bool  (optional)  default true: the LLM reads the page images (OPENAI_API_KEY on the server);
                                     false: vocab.py rules only
  -> 200 {"job_id", "downloads": {"lv_positions_csv", "priced_output_json"}, "priced_output": {...}}
  -> 400 {"detail": "..."} when a file is missing, of the wrong type, or lacks columns

GET /jobs/{job_id}/lv_positions.csv       download
GET /jobs/{job_id}/priced_output.json     download
GET /health                               {"status": "ok"}
"""
from __future__ import annotations
import shutil, sys, uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline import run, InputError

ROOT = Path(__file__).resolve().parent.parent
JOBS = ROOT / "jobs"
OUTPUTS = {"lv_positions.csv": "text/csv", "priced_output.json": "application/json"}

app = FastAPI(title="Bidwise", description="Tender PDF -> priced LV positions", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _save(upload: UploadFile, folder: Path, name: str, suffixes: tuple[str, ...]) -> Path:
    if not upload.filename or not upload.filename.lower().endswith(suffixes):
        raise HTTPException(400, f"{name}: expected a {' or '.join(suffixes)} file, got '{upload.filename}'")
    path = folder / Path(upload.filename).name                  # keep the user's file name, no directories
    with open(path, "wb") as f:
        shutil.copyfileobj(upload.file, f)
    return path


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/price")
def price(tender: UploadFile = File(...), catalog: UploadFile = File(...),
          productivity: UploadFile = File(...), parameters: UploadFile | None = File(None),
          trade: str | None = Form(None), llm: bool | None = Form(None)):
    if trade is not None and trade not in ("ventilation", "heating", "sanitary"):
        raise HTTPException(400, "trade must be ventilation, heating or sanitary")
    job_id = uuid.uuid4().hex[:12]
    inputs = JOBS / job_id / "inputs"
    inputs.mkdir(parents=True)
    pdf = _save(tender, inputs, "tender", (".pdf",))
    cat = _save(catalog, inputs, "catalog", (".csv",))
    prod = _save(productivity, inputs, "productivity", (".csv",))
    par = _save(parameters, inputs, "parameters", (".json",)) if parameters and parameters.filename else None
    try:
        res = run(pdf, cat, prod, par, JOBS / job_id, trade or None, llm=llm)
    except InputError as e:
        raise HTTPException(400, str(e))
    except Exception as e:                                          # unreadable PDF, broken CSV ...
        raise HTTPException(400, f"could not process the files: {type(e).__name__}: {e}")
    return {
        "job_id": job_id,
        "downloads": {"lv_positions_csv": f"/jobs/{job_id}/lv_positions.csv",
                      "priced_output_json": f"/jobs/{job_id}/priced_output.json"},
        "priced_output": res["priced_output"],
    }


@app.get("/jobs/{job_id}/{filename}")
def download(job_id: str, filename: str):
    if filename not in OUTPUTS or not job_id.isalnum():
        raise HTTPException(404, "not found")
    path = JOBS / job_id / filename
    if not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type=OUTPUTS[filename], filename=filename)
