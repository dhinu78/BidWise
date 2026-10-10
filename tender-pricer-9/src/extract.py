"""Layout driven LV extractor. Works on any tender whose positions have a unit
column (Stk / m / m2 / ...) next to a quantity column, which is the standard
Swiss/German LV form. Column positions are learned by layout.py, not hardcoded.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from layout import LayoutProfile, Span, page_spans, unit_key, NUM, learn_layout
from vocab import UNIT_MAP

POS_NO = re.compile(r"^\d{1,4}(?:\.\d{1,4}){1,3}$")   # NPK style 111.101 if a tender has them


def to_num(s: str) -> float:
    return float(s.replace("'", "").replace("’", "").replace(",", "."))


@dataclass
class Line:
    page: int
    y: float
    spans: list[Span]

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.spans)


@dataclass
class QtyRow:
    page: int
    y: float
    line_idx: int
    variant: str
    unit_raw: str
    unit: str
    quantity: float | None
    bbox: list[float]


@dataclass
class Block:
    block_id: str
    system: str | None
    chapter: str
    title: str
    position_no: str | None
    pages: list[int]
    text_lines: list[str] = field(default_factory=list)
    qty_rows: list[QtyRow] = field(default_factory=list)


def group_lines(spans: list[Span], page: int, tol: float = 3.0) -> list[Line]:
    spans = sorted(spans, key=lambda s: (s.y1, s.x0))
    raw: list[Line] = []
    for s in spans:
        if raw and abs(s.y1 - max(x.y1 for x in raw[-1].spans)) <= tol:
            raw[-1].spans.append(s)
        else:
            raw.append(Line(page, s.y0, [s]))
    for l in raw:
        l.spans.sort(key=lambda s: s.x0)
    # fold superscript-only lines ("2" of m², "3" of m³) into the next line
    out, skip = [], False
    for k, l in enumerate(raw):
        if skip:
            skip = False
            continue
        nxt = raw[k + 1] if k + 1 < len(raw) else None
        if nxt and all(s.text in ("2", "3") for s in l.spans) and 0 < nxt.y - l.y <= 5 \
                and all(s.size < max(x.size for x in nxt.spans) for s in l.spans):
            nxt.spans = sorted(nxt.spans + l.spans, key=lambda s: s.x0)
            out.append(nxt); skip = True
        else:
            out.append(l)
    return out


def parse_qty_row(line: Line, lp: LayoutProfile) -> QtyRow | None:
    units = [s for s in line.spans if lp.unit_band[0] <= s.x0 < lp.unit_band[1] and unit_key(s.text)]
    if not units:
        return None
    u = units[0]
    raw = u.text
    for s in line.spans:   # superscript right after the unit
        if s is not u and u.x1 - 1 <= s.x0 <= u.x1 + 6 and s.text in ("2", "3") and s.size < u.size:
            raw += s.text
    key = unit_key(raw) or unit_key(u.text)
    qs = [s for s in line.spans if lp.qty_band[0] <= s.x0 < lp.qty_band[1] and NUM.match(s.text)]
    qty = to_num(qs[0].text) if qs else None
    left = [s.text for s in line.spans if s.x0 < min(lp.unit_band[0], lp.qty_band[0])]
    bbox = [min(s.x0 for s in line.spans), min(s.y0 for s in line.spans),
            max(s.x1 for s in line.spans), max(s.y1 for s in line.spans)]
    return QtyRow(line.page, line.y, -1, " ".join(left), raw, UNIT_MAP[key], qty, bbox)


def is_title(line: Line, lp: LayoutProfile) -> bool:
    f = line.spans[0]
    if not lp.uses_bold_titles:
        return False
    return (abs(f.x0 - lp.text_x) < 6 and f.bold and f.size >= lp.title_min_size
            and not f.text.endswith(":") and not f.text.startswith("-"))


def is_chapter(line: Line, lp: LayoutProfile) -> bool:
    """Chapter heading = bold short label (A, B, 1., II) followed by an ALL CAPS title,
    e.g. 'C  ARMATUREN UND INSTRUMENTE'. Recognised by its look, not by its x position,
    because some sections indent it differently (LA03 has it at x=85 instead of x=64)."""
    f = line.spans[0]
    if not (f.bold and len(f.text) <= 3 and not NUM.match(f.text)):
        return False
    rest = " ".join(s.text for s in line.spans[1:] if s.x0 < lp.unit_band[0])
    caps_title = len(rest) >= 4 and rest.upper() == rest and any(c.isalpha() for c in rest)
    return caps_title or f.x0 < lp.text_x - 10


def extract(pdf_path: Path, lp: LayoutProfile | None = None):
    doc = pymupdf.open(pdf_path)
    lp = lp or learn_layout(doc)
    blocks: list[Block] = []
    chapter, cur, last_sys = "", None, None
    last_title_y, last_title_page = -99.0, -1

    def close():
        nonlocal cur
        if cur:
            blocks.append(cur)
        cur = None

    for i, page in enumerate(doc):
        pno = i + 1
        if lp.page_kind.get(pno) != "lv":
            continue
        system = lp.page_system.get(pno)
        if system != last_sys:
            close(); chapter = ""; last_sys = system
        body = [s for s in page_spans(page) if lp.body_top <= s.y0 < lp.body_bottom]
        for line in group_lines(body, pno):
            if is_chapter(line, lp):
                close()
                chapter = line.text
                continue
            pos_no = None
            if line.spans[0].x0 < lp.text_x - 10 and POS_NO.match(line.spans[0].text):
                pos_no = line.spans[0].text
            q = parse_qty_row(line, lp)
            if is_title(line, lp) or pos_no:
                text = " ".join(s.text for s in line.spans
                                if s.x0 >= lp.text_x - 6 and s.x0 < lp.unit_band[0])
                if (cur and not cur.qty_rows and not pos_no and pno == last_title_page
                        and line.y - last_title_y <= 14):
                    cur.title += " " + text          # wrapped heading
                else:
                    close()
                    cur = Block(f"B{len(blocks)+1:04d}", system, chapter, text, pos_no, [pno])
                last_title_y, last_title_page = line.y, pno
                if q:
                    q.line_idx = len(cur.text_lines)
                    cur.qty_rows.append(q)
                    cur.text_lines.append(line.text)
                continue
            if cur is None:
                cur = Block(f"B{len(blocks)+1:04d}", system, chapter, "(untitled)", None, [pno])
            if pno not in cur.pages:
                cur.pages.append(pno)
            if q:
                q.line_idx = len(cur.text_lines)
                cur.qty_rows.append(q)
            cur.text_lines.append(line.text)
    close()
    return lp, blocks
