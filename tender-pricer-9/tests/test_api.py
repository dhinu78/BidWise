"""The frontend's path: upload tender + catalogue + productivity (+ parameters) -> JSON + downloads."""
import json, shutil, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import pytest
from fastapi.testclient import TestClient

import api

D = ROOT / "data"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "JOBS", tmp_path / "jobs")
    return TestClient(api.app)


def files(**override):
    f = {"tender": ("tender.pdf", (D / "BKP_244_LV_Lueftung_260804.pdf").read_bytes(), "application/pdf"),
         "catalog": ("catalog.csv", (D / "catalog.csv").read_bytes(), "text/csv"),
         "productivity": ("productivity.csv", (D / "productivity.csv").read_bytes(), "text/csv"),
         "parameters": ("project_parameters.json", (D / "project_parameters.json").read_bytes(), "application/json")}
    f.update(override)
    return {k: v for k, v in f.items() if v is not None}


def test_upload_price_and_download(client):
    r = client.post("/price", files=files())
    assert r.status_code == 200, r.text
    body = r.json()
    po = body["priced_output"]
    assert len(po["position_results"]) == 251
    assert po["inputs"] == {"tender": "tender.pdf", "catalog": "catalog.csv", "productivity": "productivity.csv",
                            "project_parameters": "project_parameters.json"}
    csv = client.get(body["downloads"]["lv_positions_csv"])
    js = client.get(body["downloads"]["priced_output_json"])
    assert csv.status_code == js.status_code == 200
    assert csv.text.splitlines()[0].startswith("lv_id,system,source_page")
    assert json.loads(js.content) == po


def test_parameters_are_optional(client):
    r = client.post("/price", files=files(parameters=None))
    assert r.status_code == 200 and r.json()["priced_output"]["inputs"]["project_parameters"] == "data/ default"


def test_bad_uploads_get_a_clear_400(client):
    assert client.post("/price", files=files(tender=("t.txt", b"x", "text/plain"))).status_code == 400
    r = client.post("/price", files=files(catalog=("catalog.csv", b"a,b\n1,2\n", "text/csv")))
    assert r.status_code == 400 and "catalog: missing columns" in r.json()["detail"]
    r = client.post("/price", files=files(productivity=("p.csv", b"install_code\nX\n", "text/csv")))
    assert r.status_code == 400 and "productivity: missing columns" in r.json()["detail"]
    r = client.post("/price", files=files(tender=("t.pdf", b"not a pdf", "application/pdf")))
    assert r.status_code == 400
    assert client.post("/price", files=files(), data={"trade": "electrical"}).status_code == 400


def test_downloads_are_locked_to_the_two_outputs(client):
    assert client.get("/jobs/abc/secret.txt").status_code == 404
    assert client.get("/jobs/nojob/lv_positions.csv").status_code == 404
