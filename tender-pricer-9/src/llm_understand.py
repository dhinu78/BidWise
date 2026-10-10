"""Step 3 with an LLM that LOOKS at the tender pages (vision): classify and translate every LV row.

How one page is processed
    1. PyMuPDF has already extracted the page's rows exactly (text, quantity, unit, position on the page).
    2. The page is rendered as an image; every row gets a red box and a label R1, R2 ... at its exact position.
    3. One LLM call per page: image + the list of labels. For every label the LLM returns category,
       subcategory, English description, material, features, sizes, fire class, evidence, and the
       quantity + unit it READS FROM THE IMAGE.
    4. Answers are mapped back by label. Nothing is created or removed: the rows are PyMuPDF's.

No loss of data
    * quantities, units, pages and positions always come from PyMuPDF, never from the LLM
    * the LLM's own quantity reading is a check: different number or unit -> review_required
      ("quantity_check"); a quantity in the image that the text extraction missed -> review_required
    * labels are an enum in the JSON schema: the LLM cannot invent rows
    * a row without a usable answer (API down, no key, missing label) falls back to vocab.py
    * sizes from the regex parser win; the LLM only fills a size the parser missed (noted in parse_notes)
    * only page images and labels are sent: never prices, costs or margins

vocab.py learns
    Every confident reading (confidence >= 0.8, quantity check passed) is written to vocab_learned.json.
    vocab.classify() checks it first, so the offline fallback knows everything the LLM has read before.

Repeatable and cheap
    Answers are cached per row (cache/llm_cache.json). Re-runs and live demos make no API calls.

Configuration (environment variables or .env in the project root)
    BIDWISE_PROVIDER     openai (default) | anthropic
    OPENAI_API_KEY / ANTHROPIC_API_KEY
    BIDWISE_MODEL        default gpt-5-mini (openai) / claude-haiku-5-5 (anthropic); must accept images
    BIDWISE_REASONING    optional (OpenAI gpt-5 models): minimal | low | medium | high
    BIDWISE_DPI          page image resolution, default 130
"""
from __future__ import annotations
import base64, hashlib, json, os, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import pymupdf

import vocab
from vocab import CATEGORIES, RULES, UNIT_MAP

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = {"openai": "gpt-5-mini", "anthropic": "claude-haiku-5-5"}
KEY_VAR = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
CACHE = ROOT / "cache" / "llm_cache.json"
WORKERS = 4
LEARN_MIN_CONFIDENCE = 0.8
CHECKS = ("ok", "quantity_mismatch", "fallback")


class LLMError(RuntimeError):
    pass


def load_env(path: Path = ROOT / ".env") -> None:
    """Read KEY=VALUE lines from .env (if present) without overriding real environment variables."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ------------------------------------------------------------------ prompt + schema
SYSTEM = """You read page images of Swiss German building-services tenders (Leistungsverzeichnis, LV) for {trade}.
Some lines on the page are marked with a red box and a red label (R1, R2, ...). Each boxed line is one
priced position row. For EVERY label, read the boxed line together with everything above it that belongs
to the same position (bold title, description lines, table headers, Fabrikat / Typ) and answer:

- category: exactly one value from the allowed list. "Other" only if nothing fits.
- subcategory: reuse a name from the subcategory list when one fits, otherwise a short English noun.
  Services: Transport, Commissioning, Testing, Documentation, Labour, Pressure test, Flushing, Hygiene.
  Parts of an air-handling unit (filter, fan, heat-exchanger section ...): "AHU section".
  Options of a product (paint coating, colour surcharge, surface treatment): subcategory "Option",
  category of the product they belong to.
- description_en: "<product name>, <material>, <features>, <size>" in the naming style of the catalogue below,
  product name first, e.g. "Rectangular silencer, galvanized, 400x300x1250 mm". Write the description
  yourself from what you read on the page; do not copy the extracted hint text.
  Diameters as DN<mm> (Ø 10 cm = DN100), rectangles as <W>x<H> mm or <W>x<H>x<L> mm.
- dn_mm, width_mm, height_mm, length_mm: only sizes printed for this row, converted to mm; else null.
- material, features, fire_class (EI30, EI90-S ...): only what is printed; else null / [].
- quantity_seen, unit_seen: the quantity and unit printed in the boxed line's quantity columns, exactly
  as printed (e.g. 5 and "Stk"); null if the boxed line shows none.
- evidence: the German words you relied on, copied from the page.
- confidence: 0 to 1.
Answer once for every label. Never answer for unlabelled lines. Never output prices.

Allowed categories: {categories}

Subcategories by category:
{subcats}

Catalogue product names (naming style only, do not pick products):
{catalog}"""

NULLABLE_INT = {"type": ["integer", "null"]}
NULLABLE_NUM = {"type": ["number", "null"]}
NULLABLE_STR = {"type": ["string", "null"]}
FIELDS = ["label", "category", "subcategory", "description_en", "material", "features", "dn_mm", "width_mm",
          "height_mm", "length_mm", "fire_class", "quantity_seen", "unit_seen", "evidence", "confidence"]


def schema(categories: list[str], labels: list[str]) -> dict:
    item = {
        "type": "object",
        "properties": {
            "label": {"type": "string", "enum": labels},
            "category": {"type": "string", "enum": categories},
            "subcategory": {"type": "string"},
            "description_en": {"type": "string"},
            "material": NULLABLE_STR,
            "features": {"type": "array", "items": {"type": "string"}},
            "dn_mm": NULLABLE_INT, "width_mm": NULLABLE_INT, "height_mm": NULLABLE_INT, "length_mm": NULLABLE_INT,
            "fire_class": NULLABLE_STR,
            "quantity_seen": NULLABLE_NUM,
            "unit_seen": NULLABLE_STR,
            "evidence": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
        },
        "required": FIELDS,
        "additionalProperties": False,
    }
    return {"type": "object", "properties": {"items": {"type": "array", "items": item}},
            "required": ["items"], "additionalProperties": False}


def vocabulary(catalog: pd.DataFrame, trade: str) -> tuple[list[str], dict[str, list[str]], str]:
    """Allowed categories / subcategories from the uploaded catalogue + vocab.py; catalogue names (no prices)."""
    cats = list(dict.fromkeys(list(catalog.category.dropna().unique()) + CATEGORIES.get(trade, []) + ["Other"]))
    subs: dict[str, list[str]] = {c: [] for c in cats}
    for c, s in zip(catalog.category, catalog.subcategory):
        if c in subs and s not in subs[c]:
            subs[c].append(s)
    for r in RULES:
        if trade in r.trades and r.category in subs and r.subcategory not in subs[r.category]:
            subs[r.category].append(r.subcategory)
    names = "\n".join(f"- {c} / {s}: {d}" for c, s, d in
                      catalog[["category", "subcategory", "description"]].itertuples(index=False))
    return cats, subs, names


# ------------------------------------------------------------------ page images
def render_page(pdf_path, page_no: int, boxes: list[tuple[str, list]], dpi: int = 130) -> bytes:
    """PNG of one page with a red box + label around every row to classify. The PDF file is not changed."""
    doc = pymupdf.open(pdf_path)
    try:
        page = doc[page_no - 1]
        for label, bb in boxes:
            x0, y0, x1, y1 = bb
            page.draw_rect(pymupdf.Rect(x0 - 2, y0 - 1.5, x1 + 2, y1 + 1.5), color=(1, 0, 0), width=0.9)
            page.insert_text((max(4.0, x0 - 60), y1 - 1), label, fontsize=9, color=(1, 0, 0))
        return page.get_pixmap(dpi=dpi).tobytes("png")
    finally:
        doc.close()


# ------------------------------------------------------------------ client
class Understander:
    """Ask the LLM about pages, with a cache. `client` may be the real SDK client or a fake one in tests:
    OpenAI style (.chat.completions.create) or Anthropic style (.messages.create)."""

    def __init__(self, model: str | None = None, client=None, cache_path: Path | None = CACHE,
                 workers: int = WORKERS, provider: str | None = None, dpi: int | None = None):
        load_env()
        self.provider = (provider or os.environ.get("BIDWISE_PROVIDER", "openai")).lower()
        if self.provider not in DEFAULT_MODEL:
            raise LLMError(f"unknown BIDWISE_PROVIDER '{self.provider}' (use openai or anthropic)")
        self.model = model or os.environ.get("BIDWISE_MODEL") or DEFAULT_MODEL[self.provider]
        self.reasoning = os.environ.get("BIDWISE_REASONING") or None
        self.dpi = int(dpi or os.environ.get("BIDWISE_DPI") or 130)
        self.client = client
        self.cache_path = cache_path
        self.workers = workers
        self.cache = {}
        if cache_path and Path(cache_path).exists():
            self.cache = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        self.lock = threading.Lock()
        self.stats = {"api_calls": 0, "pages_sent": 0, "cache_hits": 0, "input_tokens": 0, "output_tokens": 0,
                      "errors": []}

    def _client(self):
        if self.client is None:
            var = KEY_VAR[self.provider]
            if not os.environ.get(var):
                raise LLMError(f"{var} is not set")
            if self.provider == "openai":
                import openai
                self.client = openai.OpenAI(max_retries=3, timeout=180)
            else:
                import anthropic
                self.client = anthropic.Anthropic(max_retries=3, timeout=180)
        return self.client

    def key(self, trade: str, page: int, bbox, text: str) -> str:
        bb = ",".join(f"{v:.0f}" for v in bbox)
        prompt = hashlib.sha1(SYSTEM.encode("utf-8")).hexdigest()[:8]     # new prompt -> fresh answers
        return hashlib.sha1(f"vision|{prompt}|{self.model}|{trade}|{page}|{bb}|{text}".encode("utf-8")).hexdigest()[:16]

    def _count(self, inp, out) -> None:
        with self.lock:
            self.stats["api_calls"] += 1
            self.stats["input_tokens"] += int(inp or 0)
            self.stats["output_tokens"] += int(out or 0)

    def _call(self, png: bytes, items: list[dict], page: int, system: str, fmt: dict) -> tuple[str, bool]:
        """-> (JSON text, cut_off)"""
        b64 = base64.b64encode(png).decode("ascii")
        user = (f"Tender page {page}. Classify these boxed rows (the extracted text is a hint to locate them; "
                f"read the image for the full context):\n{json.dumps({'items': items}, ensure_ascii=False)}")
        if self.provider == "openai":
            extra = {"reasoning_effort": self.reasoning} if self.reasoning else {}
            resp = self._client().chat.completions.create(
                model=self.model, max_completion_tokens=16000,
                messages=[{"role": "system", "content": system},
                          {"role": "user", "content": [
                              {"type": "text", "text": user},
                              {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}",
                                                                  "detail": "high"}}]}],
                response_format={"type": "json_schema",
                                 "json_schema": {"name": "lv_page", "strict": True, "schema": fmt}},
                **extra)
            u = getattr(resp, "usage", None)
            self._count(getattr(u, "prompt_tokens", 0), getattr(u, "completion_tokens", 0))
            choice = resp.choices[0]
            if getattr(choice.message, "refusal", None):
                raise LLMError(f"model refused: {choice.message.refusal}")
            return choice.message.content or "", choice.finish_reason == "length"
        resp = self._client().messages.create(
            model=self.model, max_tokens=8000, system=system,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": user}]}],
            output_config={"format": {"type": "json_schema", "schema": fmt}})
        u = getattr(resp, "usage", None)
        self._count(getattr(u, "input_tokens", 0), getattr(u, "output_tokens", 0))
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "")
        return text, getattr(resp, "stop_reason", None) == "max_tokens"

    def _ask(self, png, items, page, system, cats) -> dict[str, dict]:
        fmt = schema(cats, [it["label"] for it in items])
        text, cut = self._call(png, items, page, system, fmt)
        if cut and len(items) > 1:                       # answer cut off: ask for the labels in two halves
            h = len(items) // 2
            return {**self._ask(png, items[:h], page, system, cats), **self._ask(png, items[h:], page, system, cats)}
        return {a["label"]: a for a in json.loads(text)["items"]}

    def understand(self, rows: list[dict], trade: str, catalog: pd.DataFrame, pdf_path) -> dict[str, dict]:
        """rows: [{"key", "page", "bbox", "text_de"}] -> {key: answer}. Raises LLMError without a client."""
        cats, subs, names = vocabulary(catalog, trade)
        system = SYSTEM.format(trade=trade, categories=", ".join(cats), catalog=names,
                               subcats="\n".join(f"- {c}: {', '.join(s)}" for c, s in subs.items() if s))
        pages: dict[int, list[dict]] = {}
        for r in rows:
            pages.setdefault(r["page"], []).append(r)
        todo = {}
        for p, rs in pages.items():
            if all(r["key"] in self.cache for r in rs):
                self.stats["cache_hits"] += len(rs)
            else:
                todo[p] = sorted(rs, key=lambda r: r["bbox"][1])
        if todo:
            self._client()                                   # fail early and clearly without a key
            images = {p: render_page(pdf_path, p, [(f"R{i}", r["bbox"]) for i, r in enumerate(rs, 1)], self.dpi)
                      for p, rs in todo.items()}             # rendered up front: PyMuPDF is not thread safe

            def run(p):
                rs = todo[p]
                items = [{"label": f"R{i}", "text_de": r["text_de"]} for i, r in enumerate(rs, 1)]
                try:
                    got = self._ask(images[p], items, p, system, cats)
                except Exception as e:                       # one failed page -> its rows fall back
                    with self.lock:
                        self.stats["errors"].append(f"page {p}: {type(e).__name__}: {e}"[:300])
                    return
                with self.lock:
                    self.stats["pages_sent"] += 1
                    for i, r in enumerate(rs, 1):
                        if f"R{i}" in got:
                            self.cache[r["key"]] = got[f"R{i}"]
            with ThreadPoolExecutor(self.workers) as ex:
                list(ex.map(run, sorted(todo)))
            self.save()
        return {r["key"]: self.cache[r["key"]] for r in rows if r["key"] in self.cache}

    def save(self) -> None:
        if self.cache_path:
            Path(self.cache_path).parent.mkdir(parents=True, exist_ok=True)
            Path(self.cache_path).write_text(json.dumps(self.cache, ensure_ascii=False, indent=1), encoding="utf-8")


# ------------------------------------------------------------------ apply to the extracted rows
RULE_CODE = {(r.category, r.subcategory): r.install_code for r in RULES}


def _norm_cat(value: str, cats: list[str]) -> str | None:
    return {c.lower(): c for c in cats}.get(str(value).strip().lower())


def _unit(u) -> str | None:
    if u is None:
        return None
    k = str(u).strip().lower().rstrip(".").replace("²", "2").replace("³", "3")
    return UNIT_MAP.get(k, k)


def _bbox(b):
    return eval(b) if isinstance(b, str) else list(b)


def _learn_entry(r, a, trade, code) -> dict | None:
    phrase = vocab.norm_de(r.title_de if isinstance(r.get("title_de"), str) else "")
    kws = [w for w in (vocab.norm_de(" ".join(a.get("evidence") or [])).split()) if len(w) >= 6][:3]
    if len(kws) == 1 and len(kws[0]) < 10:               # one short word is too generic to learn
        kws = []
    if len(phrase) < 5 and not kws:
        return None
    english = str(a["description_en"]).split(",")[0].strip()
    return {"trade": trade, "phrase": phrase if len(phrase) >= 5 else "", "keywords": kws,
            "category": r.category, "subcategory": r.subcategory, "english": english,
            "install_code": code, "example_de": r.description_de}


def apply_llm(df: pd.DataFrame, catalog: pd.DataFrame, trade: str, pdf_path,
              und: Understander | None = None, learn: bool = True) -> tuple[pd.DataFrame, dict]:
    """Replace category / subcategory / description with the LLM's reading of the page image.
    The rows, quantities, units and pages stay exactly as extracted."""
    from normalize import install_code as refine_code
    df = df.copy()
    df["rules_category"], df["rules_subcategory"], df["rules_description"] = df.category, df.subcategory, df.description
    for c in ("description_source", "llm_check", "llm_confidence", "llm_evidence", "llm_quantity_seen",
              "llm_unit_seen"):
        df[c] = None
    report = {"mode": "llm_vision", "provider": None, "model": None, "rows": len(df), **{c: 0 for c in CHECKS},
              "pages_sent": 0, "api_calls": 0, "cache_hits": 0, "input_tokens": 0, "output_tokens": 0,
              "learned": 0, "errors": []}
    try:
        und = und or Understander()
    except LLMError as e:
        df["description_source"], df["llm_check"] = "rules", "fallback"
        report["errors"].append(str(e)); report["fallback"] = len(df)
        return df, report
    report["provider"], report["model"] = und.provider, und.model
    cats, _, _ = vocabulary(catalog, trade)
    rows = [{"key": und.key(trade, int(r.source_page), _bbox(r.bbox), r.description_de or ""),
             "page": int(r.source_page), "bbox": _bbox(r.bbox), "text_de": r.description_de or ""}
            for r in df.itertuples()]
    try:
        answers = und.understand(rows, trade, catalog, pdf_path)
    except LLMError as e:
        answers = {}
        report["errors"].append(str(e))

    learned = []
    for (i, r), q in zip(df.iterrows(), rows):
        a = answers.get(q["key"])
        cat = _norm_cat(a["category"], cats) if a else None
        if not a or not cat or not str(a.get("description_en", "")).strip():
            df.loc[i, ["description_source", "llm_check"]] = ["rules", "fallback"]
            continue
        sub = str(a.get("subcategory") or "").strip() or r.subcategory
        df.loc[i, ["category", "subcategory", "description"]] = [cat, sub, a["description_en"].strip()]
        df.loc[i, ["description_source", "llm_confidence"]] = ["llm_vision", a.get("confidence")]
        df.at[i, "llm_evidence"] = ", ".join(a.get("evidence") or [])
        df.loc[i, ["llm_quantity_seen", "llm_unit_seen"]] = [a.get("quantity_seen"), a.get("unit_seen")]

        # quantity check: the image reading must agree with the extracted number and unit
        qs, us = a.get("quantity_seen"), _unit(a.get("unit_seen"))
        qty_missing = pd.isna(r.quantity)
        mismatch = (qty_missing and qs is not None) or \
                   (not qty_missing and qs is not None and abs(float(qs) - float(r.quantity)) > 1e-6) or \
                   (us is not None and not qty_missing and us != r.unit)
        df.loc[i, "llm_check"] = "quantity_mismatch" if mismatch else "ok"

        # install code hint for the LLM's category (the matched product's own code still wins later)
        if (cat, sub) != (r.category, r.subcategory):
            size = {"shape": "round", "dn_mm": r.dn_mm} if pd.notna(r.dn_mm) else \
                   ({"shape": "rect"} if pd.notna(r.width_mm) else None)
            hit = vocab.learned_lookup(r.title_de or "", trade) if isinstance(r.get("title_de"), str) else None
            code = RULE_CODE.get((cat, sub)) or (hit[3] if hit and hit[0] == cat else "UNKNOWN")
            df.loc[i, "expected_install_code"] = refine_code(code, cat, size, r.description_de or "")
        # size: the regex parser wins; the LLM only fills a size the parser missed
        if pd.isna(r.dn_mm) and pd.isna(r.width_mm):
            if a.get("dn_mm"):
                df.loc[i, ["dn_mm", "shape"]] = [float(a["dn_mm"]), "round"]
            elif a.get("width_mm") and a.get("height_mm"):
                df.loc[i, ["width_mm", "height_mm", "shape"]] = [float(a["width_mm"]), float(a["height_mm"]), "rect"]
                if a.get("length_mm"):
                    df.loc[i, "length_mm"] = float(a["length_mm"])
            if a.get("dn_mm") or a.get("width_mm"):
                df.loc[i, "parse_notes"] = "; ".join(x for x in (r.parse_notes, "size from LLM")
                                                     if isinstance(x, str) and x)
        if pd.isna(r.fire_class) and a.get("fire_class"):
            df.loc[i, "fire_class"] = a["fire_class"]
        if learn and not mismatch and float(a.get("confidence") or 0) >= LEARN_MIN_CONFIDENCE:
            e = _learn_entry(df.loc[i], a, trade, df.loc[i, "expected_install_code"])
            if e:
                learned.append(e)

    if learned:
        report["learned"] = vocab.learn(learned)
    for c in CHECKS:
        report[c] = int((df.llm_check == c).sum())
    report.update(api_calls=und.stats["api_calls"], pages_sent=und.stats["pages_sent"],
                  cache_hits=und.stats["cache_hits"], input_tokens=und.stats["input_tokens"],
                  output_tokens=und.stats["output_tokens"], errors=report["errors"] + und.stats["errors"])
    return df, report
