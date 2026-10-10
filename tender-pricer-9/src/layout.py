"""Learn the layout of an unknown tender PDF.

Nothing here is specific to the Oberglatt tender. Every number is measured from
the document itself, so a tender with other column positions, fonts or page
order still works. The result is a LayoutProfile that extract.py consumes.
"""
from __future__ import annotations
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from statistics import median

import pymupdf

from vocab import UNIT_MAP, TAKEOFF_KEYWORDS

NUM = re.compile(r"^\d{1,3}(?:['’]\d{3})+(?:[.,]\d+)?$|^\d+(?:[.,]\d+)?$")
PAGE_COUNTER = re.compile(r"(?:Seite|Page|Pag\.?)?\s*:?\s*(\d+)\s*/\s*(\d+)", re.I)


@dataclass
class Span:
    x0: float; y0: float; x1: float; y1: float
    text: str; size: float; bold: bool


def page_spans(page) -> list[Span]:
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                t = s["text"].strip()
                if t:
                    out.append(Span(*s["bbox"], t, round(s["size"], 1),
                                    bool(s["flags"] & 16) or "bold" in s["font"].lower()))
    return out


def unit_key(text: str) -> str | None:
    k = text.lower().rstrip(".").replace("²", "2").replace("³", "3")
    return k if k in UNIT_MAP else None


@dataclass
class LayoutProfile:
    unit_band: tuple[float, float]
    qty_band: tuple[float, float]
    qty_side: str                      # "right" or "left" of the unit cell
    text_x: float                      # left edge of the description column
    title_min_size: float              # bold spans at text_x with size >= this open a block
    uses_bold_titles: bool
    body_top: float                    # y below running header + column header
    body_bottom: float                 # y above running footer
    page_kind: dict[int, str] = field(default_factory=dict)   # lv / takeoff / prose / rate_sheet
    page_system: dict[int, str | None] = field(default_factory=dict)
    header_text: dict[int, str] = field(default_factory=dict)
    confidence: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_dict(self):
        return asdict(self)


def _cluster(values: list[float], width: float = 6.0) -> tuple[float, float, int]:
    """Densest 1D cluster: returns (lo, hi, count)."""
    if not values:
        return (0, 0, 0)
    vals = sorted(values)
    best = (vals[0], vals[0], 0)
    j = 0
    for i, v in enumerate(vals):
        while vals[j] < v - width * 3:
            j += 1
        cnt = i - j + 1
        if cnt > best[2]:
            best = (vals[j], v, cnt)
    return best


def _lines(spans: list[Span], tol: float = 3.0) -> list[list[Span]]:
    spans = sorted(spans, key=lambda s: (s.y1, s.x0))
    out: list[list[Span]] = []
    for s in spans:
        if out and abs(s.y1 - max(x.y1 for x in out[-1])) <= tol:
            out[-1].append(s)
        else:
            out.append([s])
    return [sorted(l, key=lambda s: s.x0) for l in out]


def learn_layout(doc: pymupdf.Document) -> LayoutProfile:
    pages = [page_spans(p) for p in doc]
    heights = [p.rect.height for p in doc]

    # 1. unit column: where do unit words sit that have a number right next to them?
    unit_x, right_q, left_q = [], [], []
    for spans in pages:
        for line in _lines(spans):
            for k, s in enumerate(line):
                if not unit_key(s.text):
                    continue
                nxt = line[k + 1] if k + 1 < len(line) else None
                prv = line[k - 1] if k > 0 else None
                if nxt and NUM.match(nxt.text) and 0 <= nxt.x0 - s.x1 <= 90:
                    unit_x.append(s.x0); right_q.append(nxt.x0)
                elif prv and NUM.match(prv.text) and 0 <= s.x0 - prv.x1 <= 60:
                    unit_x.append(s.x0); left_q.append(prv.x0)
    lo, hi, n = _cluster(unit_x)
    notes = [f"unit tokens with adjacent number: {len(unit_x)}, in densest column: {n}"]
    unit_band = (lo - 8, hi + 12)
    qty_side = "right" if len(right_q) >= len(left_q) else "left"
    qs = [q for q in (right_q if qty_side == "right" else left_q)]
    qlo, qhi, _ = _cluster(qs, width=10)
    qty_band = (qlo - 8, qhi + 25) if qty_side == "right" else (qlo - 25, qhi + 8)

    # 2. which pages carry quantity rows in that column?
    kind, rows_per_page = {}, {}
    for pno, spans in enumerate(pages, 1):
        rows = 0
        for line in _lines(spans):
            us = [s for s in line if unit_band[0] <= s.x0 < unit_band[1] and unit_key(s.text)]
            if us:
                rows += 1
        rows_per_page[pno] = rows
        head = " ".join(s.text for s in spans if s.y0 < 120)
        if any(k.lower() in head.lower() for k in TAKEOFF_KEYWORDS):
            kind[pno] = "takeoff"
        elif rows >= 1:
            kind[pno] = "lv"
        else:
            kind[pno] = "prose"
    lv_pages = [p for p, k in kind.items() if k == "lv"]

    # pages with only description text still belong to the LV if they carry the
    # same running header line as the pages that have quantity rows
    def top_lines_of(p):
        h = heights[p - 1]
        return {re.sub(r"\d", "#", " ".join(s.text for s in l))
                for l in _lines([s for s in pages[p - 1] if s.y0 < h * 0.06])}
    marker_count = Counter(t for p in lv_pages for t in top_lines_of(p))
    markers = {t for t, c in marker_count.items() if c >= 0.5 * len(lv_pages)}
    words = Counter(w for t in markers for w in t.split() if len(w) > 3 and "#" not in w)
    marker_words = {w for w, _ in words.most_common(3)}
    if marker_words:
        notes.append(f"LV running header words: {sorted(marker_words)}")
        for p in kind:
            if kind[p] == "prose":
                top = " ".join(top_lines_of(p))
                if all(w in top for w in marker_words):
                    kind[p] = "lv"
    # a section cover page ("Seite 1 / 4") right before an LV page is part of the LV
    for p in sorted(kind, reverse=True):
        if kind[p] == "prose" and kind.get(p + 1) == "lv":
            top = " ".join(s.text for s in pages[p - 1] if s.y0 < heights[p - 1] * 0.06)
            if PAGE_COUNTER.search(top):
                kind[p] = "lv"
    lv_pages = [p for p, k in kind.items() if k == "lv"]

    # lone lv pages surrounded by prose are noise (a stray "m" in a condition text)
    for p in list(lv_pages):
        if rows_per_page[p] == 1 and kind.get(p - 1) != "lv" and kind.get(p + 1) != "lv":
            kind[p] = "prose"
    lv_pages = [p for p, k in kind.items() if k == "lv"]

    # 3. running header/footer = text that repeats on many LV pages near top/bottom
    top_lines, bot_lines = Counter(), Counter()
    for p in lv_pages:
        h = heights[p - 1]
        for line in _lines(pages[p - 1]):
            y = line[0].y0
            key = re.sub(r"\d", "#", " ".join(s.text for s in line))[:12]   # stable prefix, e.g. "H:\Projekt\#"
            if y < h * 0.15:
                top_lines[(key, round(y))] += 1
            elif y > h * 0.88:
                bot_lines[(key, round(y))] += 1
    min_rep = max(2, int(0.3 * len(lv_pages)))
    rep_top = [y for (k, y), c in top_lines.items() if c >= min_rep]
    rep_bot = [y for (k, y), c in bot_lines.items() if c >= min_rep]
    body_top = (max(rep_top) + 12) if rep_top else 0
    body_bottom = (min(rep_bot) - 2) if rep_bot else max(heights)

    # 4. description column + title style
    xs, sizes = [], []
    for p in lv_pages:
        for s in pages[p - 1]:
            if body_top <= s.y0 < body_bottom and s.x0 < unit_band[0] - 20:
                xs.append(round(s.x0))
                sizes.append(s.size)
    text_x = Counter(xs).most_common(1)[0][0] if xs else 0
    body_size = median(sizes) if sizes else 10
    bold_at_text = sum(1 for p in lv_pages for s in pages[p - 1]
                       if s.bold and abs(s.x0 - text_x) < 6 and body_top <= s.y0 < body_bottom)
    uses_bold = bold_at_text >= max(3, len(lv_pages) // 2)

    # 5. systems: header text that is NOT identical on most pages = section name
    header_spans = {}
    for p in lv_pages:
        hs = [s for s in pages[p - 1] if s.y0 < body_top - 12 and s.y0 < heights[p - 1] * 0.12]
        header_spans[p] = hs
    freq = Counter(s.text for hs in header_spans.values() for s in hs)
    const = {t for t, c in freq.items() if c >= 0.8 * len(lv_pages)}
    page_system, header_text = {}, {}
    current = None
    for p in sorted(kind):
        if kind[p] not in ("lv", "takeoff"):
            page_system[p] = None
            continue
        if kind[p] == "lv":
            hs = header_spans.get(p, [])
            full = " ".join(s.text for s in sorted(hs, key=lambda s: s.x0))
            header_text[p] = full
            m = PAGE_COUNTER.search(full)
            name = " ".join(s.text for s in sorted(hs, key=lambda s: s.x0)
                            if s.text not in const and not PAGE_COUNTER.fullmatch(s.text)
                            and not re.fullmatch(r"(Seite|Page)\s*:?", s.text, re.I))
            name = PAGE_COUNTER.sub("", name).strip()
            restart = bool(m and m.group(1) == "1")
            if current is None or restart or (not m and name and name != current):
                # with page counters, only a counter reset starts a new section;
                # this protects against copy-paste errors in running headers
                current = name or f"Section {len(set(page_system.values()))}"
        page_system[p] = current

    conf = min(1.0, n / max(1, len(unit_x))) if unit_x else 0.0
    if not lv_pages:
        notes.append("no quantity column found: use the LLM page fallback")
    return LayoutProfile(unit_band, qty_band, qty_side, float(text_x),
                         round(body_size - 0.5, 1) if uses_bold else 0.0, uses_bold,
                         body_top, body_bottom, kind, page_system, header_text,
                         round(conf, 2), notes)
