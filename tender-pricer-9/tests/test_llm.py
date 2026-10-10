"""Vision LLM step with a fake client (no network): page images, labels, quantity check, fallback, cache,
and vocab.py learning from the LLM."""
import json, sys
from pathlib import Path
from types import SimpleNamespace
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
import pandas as pd
import pytest

import vocab
import llm_understand
from llm_understand import Understander, render_page
from build_positions import build, attach_golden

D = ROOT / "data"
PDF = D / "BKP_244_LV_Lueftung_260804.pdf"


@pytest.fixture(autouse=True)
def own_learned_vocab(tmp_path):
    """every test learns into its own empty file"""
    before = vocab.LEARNED_PATH
    vocab.load_learned(tmp_path / "learned.json")
    yield
    vocab.load_learned(before)


@pytest.fixture(scope="module")
def rules():
    vocab.load_learned(Path(vocab.LEARNED_PATH).parent / "none.json")
    df, _ = build(PDF)
    return df


class FakeVision:
    """Answers like the real SDKs (strict JSON schema). Reads the labels it was given and answers per label.
    answer(page, text_de, nth) -> dict of overrides or None"""

    def __init__(self, rules_df, override=None, fail=False):
        self.fail, self.override = fail, override or (lambda page, text, base: base)
        self.calls = []
        self.rows = {}
        for r in rules_df.sort_values(["source_page"]).itertuples():
            self.rows.setdefault((r.source_page, r.description_de), []).append(r)
        self.messages = SimpleNamespace(create=lambda **kw: self._create("anthropic", **kw))
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: self._create("openai", **kw)))

    def _create(self, style, **kw):
        self.calls.append((style, kw))
        if self.fail:
            raise ConnectionError("network down")
        content = kw["messages"][-1]["content"]
        text = next(c["text"] for c in content if c["type"] == "text")
        page = int(text.split("Tender page ", 1)[1].split(".", 1)[0])
        items = json.loads(text.split("\n", 1)[1])["items"]
        used, out = {}, []
        for it in items:
            k = (page, it["text_de"])
            n = used.get(k, 0); used[k] = n + 1
            r = self.rows[k][min(n, len(self.rows[k]) - 1)]
            base = {"label": it["label"], "category": r.category, "subcategory": r.subcategory,
                    "description_en": r.description, "material": None, "features": [], "dn_mm": None,
                    "width_mm": None, "height_mm": None, "length_mm": None, "fire_class": None,
                    "quantity_seen": None if pd.isna(r.quantity) else float(r.quantity),
                    "unit_seen": None if pd.isna(r.quantity) else r.unit,
                    "evidence": str(r.title_de).split()[:3], "confidence": 0.9}
            out.append(self.override(page, it["text_de"], base))
        body = json.dumps({"items": out})
        if style == "openai":
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=body, refusal=None),
                                                            finish_reason="stop")],
                                   usage=SimpleNamespace(prompt_tokens=1500, completion_tokens=400))
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=body)], stop_reason="end_turn",
                               usage=SimpleNamespace(input_tokens=1500, output_tokens=400))


def und(tmp_path, client, provider="openai"):
    return Understander(client=client, cache_path=tmp_path / "cache.json", provider=provider)


def test_page_image_is_rendered_with_labels():
    png = render_page(PDF, 78, [("R1", [85.1, 685.7, 435.2, 696.8])])
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 50_000


def test_openai_gets_one_page_image_per_call_and_no_prices(rules, tmp_path, monkeypatch):
    monkeypatch.delenv("BIDWISE_MODEL", raising=False)
    fake = FakeVision(rules)
    df, rep = build(PDF, llm=und(tmp_path, fake, "openai"))
    style, kw = fake.calls[0]
    assert style == "openai" and kw["model"] == "gpt-5-mini"
    content = kw["messages"][1]["content"]
    img = next(c for c in content if c["type"] == "image_url")["image_url"]
    assert img["url"].startswith("data:image/png;base64,") and img["detail"] == "high"
    text = next(c["text"] for c in content if c["type"] == "text")
    items = json.loads(text.split("\n", 1)[1])["items"]
    assert all(set(it) == {"label", "text_de"} for it in items)              # no quantity given away
    sch = kw["response_format"]["json_schema"]
    item = sch["schema"]["properties"]["items"]["items"]
    assert sch["strict"] is True and item["properties"]["label"]["enum"] == [it["label"] for it in items]
    assert {"quantity_seen", "unit_seen"} <= set(item["required"])
    system = kw["messages"][0]["content"]
    assert "74.8" not in system and "net_cost" not in system
    assert rep["understanding"]["pages_sent"] == df.source_page.nunique() == len(fake.calls)


def test_anthropic_gets_image_blocks(rules, tmp_path, monkeypatch):
    monkeypatch.delenv("BIDWISE_MODEL", raising=False)
    fake = FakeVision(rules)
    build(PDF, llm=und(tmp_path, fake, "anthropic"))
    style, kw = fake.calls[0]
    assert style == "anthropic" and kw["model"] == "claude-haiku-5-5"
    block = kw["messages"][0]["content"][0]
    assert block["type"] == "image" and block["source"]["media_type"] == "image/png"
    assert kw["output_config"]["format"]["type"] == "json_schema"


def test_every_row_answered_nothing_lost(rules, tmp_path):
    df, rep = build(PDF, llm=und(tmp_path, FakeVision(rules)))
    u = rep["understanding"]
    assert u["mode"] == "llm_vision" and u["ok"] == len(df) == len(rules) and u["fallback"] == 0
    assert (df.description_source == "llm_vision").all()
    assert list(df.quantity.fillna(-1)) == list(rules.quantity.fillna(-1))      # quantities untouched
    assert list(df.source_page) == list(rules.source_page) and list(df.unit) == list(rules.unit)
    assert list(df.status) == list(rules.status)
    assert attach_golden(df, D / "example_lv_positions.csv").reference_lv_id.notna().sum() == 22


def test_quantity_misread_goes_to_review(rules, tmp_path):
    def override(page, text, base):
        if page == 78 and text == "Zuluft - Tellerventil | Grösse Ø 10 cm":
            return {**base, "quantity_seen": 6.0}
        return base
    df, rep = build(PDF, llm=und(tmp_path, FakeVision(rules, override)))
    r = df[(df.source_page == 78) & (df.description_de == "Zuluft - Tellerventil | Grösse Ø 10 cm")].iloc[0]
    assert r.quantity == 5 and r.llm_check == "quantity_mismatch"
    assert (r.status, r.price_flag) == ("review_required", "quantity_check")
    assert "PDF text reads 5 pc" in r.status_reason and "page image reads 6.0" in r.status_reason
    assert rep["understanding"]["quantity_mismatch"] == 1


def test_quantity_the_text_extraction_missed_goes_to_review(rules, tmp_path):
    first_missing = rules[rules.quantity.isna()].iloc[0]
    def override(page, text, base):
        if page == first_missing.source_page and text == first_missing.description_de:
            return {**base, "quantity_seen": 1.0, "unit_seen": "Stk"}
        return base
    df, _ = build(PDF, llm=und(tmp_path, FakeVision(rules, override)))
    r = df[(df.source_page == first_missing.source_page) & (df.description_de == first_missing.description_de)].iloc[0]
    assert (r.status, r.price_flag) == ("review_required", "quantity_check")
    assert "PDF text reads no quantity" in r.status_reason


def test_api_failure_falls_back_to_vocab(rules, tmp_path):
    df, rep = build(PDF, llm=und(tmp_path, FakeVision(rules, fail=True)))
    assert (df.llm_check == "fallback").all() and (df.description_source == "rules").all()
    assert list(df.status) == list(rules.status) and list(df.description) == list(rules.description)
    assert "network down" in rep["understanding"]["errors"][0]


def test_missing_key_falls_back(rules, tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(llm_understand, "load_env", lambda *a, **k: None)
    df, rep = build(PDF, llm=und(tmp_path, None))
    assert (df.llm_check == "fallback").all()
    assert any("OPENAI_API_KEY" in e for e in rep["understanding"]["errors"])


def test_cache_makes_the_second_run_free(rules, tmp_path):
    build(PDF, llm=und(tmp_path, FakeVision(rules)))
    second = FakeVision(rules)
    df, rep = build(PDF, llm=und(tmp_path, second))
    assert second.calls == [] and rep["understanding"]["api_calls"] == 0
    assert rep["understanding"]["cache_hits"] == len(df)


def test_vocab_learns_from_the_llm_and_works_offline(rules, tmp_path):
    flex = ("Ductwork", "Flexible connector", "Flexible duct connector, galvanized, DN100")
    def override(page, text, base):
        if text.startswith("Einseitig Dehnungsmanschette"):
            return {**base, "category": flex[0], "subcategory": flex[1], "description_en": flex[2],
                    "evidence": ["Dehnungsmanschette", "Potentialausgleich"], "confidence": 0.95}
        return base
    df, rep = build(PDF, llm=und(tmp_path, FakeVision(rules, override)))
    assert rep["understanding"]["learned"] > 0
    saved = json.loads(Path(vocab.LEARNED_PATH).read_text(encoding="utf-8"))
    entry = next(e for e in saved if "dehnungsmanschette" in e["phrase"])
    assert (entry["category"], entry["subcategory"], entry["english"]) == ("Ductwork", "Flexible connector",
                                                                          "Flexible duct connector")
    offline, _ = build(PDF)                                     # no LLM: vocab.py now knows it
    rows = offline[offline.description_de.str.startswith("Einseitig Dehnungsmanschette")]
    assert len(rows) and (rows.category == "Ductwork").all() and (rows.subcategory == "Flexible connector").all()
    assert rows.description.str.startswith("Flexible duct connector").all()
    assert (rules.loc[rows.index, "category"] == "Controls").all()           # before learning it was wrong


def test_unknown_provider_falls_back(rules, monkeypatch):
    monkeypatch.setenv("BIDWISE_PROVIDER", "gemini")
    df, rep = build(PDF, llm=True)
    assert (df.llm_check == "fallback").all() and "unknown BIDWISE_PROVIDER" in rep["understanding"]["errors"][0]


def test_api_returns_vision_fields(rules, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import api
    fake = FakeVision(rules)

    class FakeUnderstander(Understander):
        def __init__(self, *a, **k):
            super().__init__(client=fake, cache_path=tmp_path / "c.json", provider="openai")
    monkeypatch.setattr(llm_understand, "Understander", FakeUnderstander)
    monkeypatch.setattr(api, "JOBS", tmp_path / "jobs")
    files = {"tender": ("t.pdf", PDF.read_bytes()), "catalog": ("catalog.csv", (D / "catalog.csv").read_bytes()),
             "productivity": ("p.csv", (D / "productivity.csv").read_bytes())}
    r = TestClient(api.app).post("/price", files=files, data={"llm": "true"})
    assert r.status_code == 200, r.text
    po = r.json()["priced_output"]
    assert po["understanding"]["mode"] == "llm_vision" and po["understanding"]["ok"] == 251
    u = po["position_results"][9]["understanding"]
    assert u["source"] == "llm_vision" and u["llm_check"] == "ok" and u["quantity_seen_in_image"] == 5.0


def test_llm_is_the_default_and_rules_only_on_request(tmp_path, monkeypatch):
    from pipeline import run
    monkeypatch.delenv("BIDWISE_LLM", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setattr(llm_understand, "load_env", lambda *a, **k: None)
    on = run(PDF, D / "catalog.csv", out_dir=tmp_path / "a")["priced_output"]
    assert on["understanding"]["mode"] == "llm_vision"                      # tried the LLM (no key -> fallback)
    off = run(PDF, D / "catalog.csv", out_dir=tmp_path / "b", llm=False)["priced_output"]
    assert off["understanding"]["mode"] == "rules"
    assert {p["description_source"] for p in off["position_results"]} == {"rules"}


def test_csv_says_who_wrote_each_description(rules, tmp_path):
    from pipeline import run
    fake = FakeVision(rules)
    res = run(PDF, D / "catalog.csv", out_dir=tmp_path, llm=und(tmp_path, fake))
    csv = pd.read_csv(res["lv_positions_csv"])
    assert list(csv.columns[15:17]) == ["description_source", "llm_check"]
    assert (csv.description_source == "llm_vision").all()
    p = res["priced_output"]["position_results"][9]
    assert p["description_source"] == "llm_vision"
