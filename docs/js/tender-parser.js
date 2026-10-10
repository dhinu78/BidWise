// Tender PDF -> LV positions, in the browser (pdf.js).
//
// Rule-based reader for Swiss bills of quantities (Leistungsverzeichnis, NPK/BKP layout), based
// on lv_extractor.py: a page is an LV page when its column headings name a unit column
// ("Mass-Gattg." / "Einheit") and a quantity column ("Massbetrag" / "Menge"). On it, every line
// with a unit in the unit column is a quantity position; the item heading, section, system
// (BKP code from the page header or footer), Fabrikat/Typ hints and source page are attached.
// When a backend is configured (js/backend.js) the backend reads the PDF instead.
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

export const UNITS = {
  "Stk": "pc", "Stk.": "pc", "St": "pc", "St.": "pc", "Stück": "pc", "m": "m", "lfm": "m", "m1": "m",
  "m2": "m2", "m²": "m2", "m3": "m3", "m³": "m3", "Tage": "day", "Std": "h", "Std.": "h", "h": "h",
  "psch": "LS", "psch.": "LS", "Pauschal": "LS", "LS": "LS", "gl": "LS", "Gl": "LS", "kg": "kg", "t": "t",
};
const UNIT_HEADERS = ["Gattg.", "Mass-Gattg.", "Einheit", "ME"];
const QTY_HEADERS = ["betrag", "Massbetrag", "Menge"];
const PAGE_NO_RE = /\s*(Seite|Page)\s+\d+\s*(\/|von)\s*\d+.*$/i;
const BKP_RE = /\b(\d{3}\.\d{1,2})\b/;
const SECTION_RE = /^([A-H])\s+([A-ZÄÖÜ][A-ZÄÖÜ /\-]{3,})$/;
const ATTR_RE = /\b(Fabrikat|Typ|Offerte|Material|Luftmenge)\b\s*(.*)$/;
const AIRFLOW_RE = /(?:Luftmenge|Luftvolumenstrom)\s*:?\s*([\d'’`]+)\s*m[3³]\/h/;
const SKIP = ["Pos.", "Gattg.", "H:\\Projekt", "Gegenstand"];

let pdfjsPromise;
async function loadPdfjs() {
  pdfjsPromise ??= import(PDFJS).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return lib;
  });
  return pdfjsPromise;
}

const title = (s) => s.toLowerCase().replace(/(^|[\s/\-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

function toNum(s) {
  const t = String(s).replace(/['’`]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** pdf.js text items -> words {text, x0, x1, top} (like pdfplumber.extract_words). */
function pageWords(items, viewport) {
  const words = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const h = Math.hypot(c, d) || it.height || 10;
    const [vx, vy] = viewport.convertToViewportPoint(e, f);
    const top = vy - h;
    const cw = it.width / Math.max(it.str.length, 1);
    for (const m of it.str.matchAll(/\S+/g)) {
      const x0 = vx + m.index * cw;
      const x1 = x0 + m[0].length * cw;
      // glue onto the previous word when the glyphs touch (pdf.js splits runs at font changes)
      const prev = words.at(-1);
      if (prev && Math.abs(prev.top - top) < 1.5 && x0 - prev.x1 < 0.6 && x0 >= prev.x0) {
        prev.text += m[0]; prev.x1 = x1; prev.base = Math.max(prev.base, vy);
      } else words.push({ text: m[0], x0, x1, top, base: vy });
    }
  }
  return words;
}

/** Group words into visual lines (4 pt tolerance), each sorted left to right. */
function pageLines(words) {
  const lines = [];
  for (const w of [...words].sort((p, q) => p.top - q.top)) {
    const last = lines.at(-1);
    if (last && w.top - last[0].top <= 4) last.push(w);
    else lines.push([w]);
  }
  return lines.map((ws) => ws.sort((p, q) => p.x0 - q.x0));
}

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * All text lines of a PDF with word positions (points from the top-left), for filling in forms.
 * @returns {Promise<{width:number,height:number,lines:{text:string,top:number,base:number,words:object[]}[]}[]>}
 */
export async function readPdfLines(pdfData, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = typeof pdfData?.arrayBuffer === "function" ? await pdfData.arrayBuffer() : pdfData;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const pages = [];
  for (let pno = 1; pno <= pdf.numPages; pno++) {
    const page = await pdf.getPage(pno);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = pageLines(pageWords(content.items, viewport)).map((ws) => ({
      text: ws.map((w) => w.text).join(" ").trim(), top: ws[0].top, base: Math.max(...ws.map((w) => w.base)), words: ws,
    }));
    pages.push({ width: viewport.width, height: viewport.height, lines });
    page.cleanup();
    onProgress?.(pno, pdf.numPages);
  }
  await pdf.destroy();
  return pages;
}

/**
 * Extract all quantity positions from the tender PDF.
 * @param {Blob|ArrayBuffer} pdfData
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{pageCount:number, lvPages:number, systems:object[], positions:object[]}>}
 */
export async function parseTender(pdfData, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = typeof pdfData?.arrayBuffer === "function" ? await pdfData.arrayBuffer() : pdfData;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;

  const rows = [];
  const names = {};
  const systems = {};
  let system = null, section = null, itemTitle = null, attrs = {}, titleOpen = true;
  let systemAirflow = null, lvPages = 0;

  for (let pno = 1; pno <= pdf.numPages; pno++) {
    const page = await pdf.getPage(pno);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = pageLines(pageWords(content.items, viewport));
    page.cleanup();
    onProgress?.(pno, pdf.numPages);
    if (!lines.length) continue;

    // LV page = column headings for unit and quantity within the first lines
    const hdr = {};
    for (const ws of lines.slice(0, 6)) for (const w of ws) hdr[w.text] ??= w;
    const unitHead = UNIT_HEADERS.map((k) => hdr[k]).find(Boolean);
    const qtyHead = QTY_HEADERS.map((k) => hdr[k]).find(Boolean);
    if (!unitHead || !qtyHead) continue;               // cover, conditions, descriptions
    lvPages++;

    // system: BKP code + name from the running header ("… 244.01 LA01 Nebenräume Seite 3 / 22");
    // a "…¤.05 LA05 Turnhalle.docx" footer wins when header and footer disagree
    const head = lines[0].map((w) => w.text).join(" ").replace(PAGE_NO_RE, "").trim();
    const hm = BKP_RE.exec(head);
    const hdrCode = hm ? hm[1] : "";
    const hdrSys = hm ? head.slice(hm.index).trim() : "";
    if (hdrCode) names[hdrCode] ??= hdrSys;
    const foot = lines.at(-1).map((w) => w.text).join(" ");
    const fm = /(\d{3}\.\d{1,2})[^\\]*\.docx/.exec(foot);
    const code = fm ? fm[1] : hdrCode || system?.split(" ")[0] || "000";
    const newSys = names[code] ?? (hdrSys || system || "General");
    const warn = hdrCode && code !== hdrCode ? `page header says '${hdrSys}', footer says ${code}` : "";
    if (newSys !== system) {
      system = newSys; section = null; itemTitle = null; attrs = {}; systemAirflow = null;
    }
    const sys = (systems[code] ??= { code, name: newSys, first_page: pno, last_page: pno, airflow_m3h: null });
    sys.last_page = pno;

    // locate the unit ("Mass-Gattg.") and quantity ("Massbetrag") columns on this page
    const ux = unitHead.x0, qx = qtyHead.x0;
    const unitRng = [ux - 15, ux + 25], qtyRng = [qx - 15, qx + 40];

    let lastTop = null;
    for (const ws of lines.slice(1)) {
      const text = ws.map((w) => w.text).join(" ").trim();
      if (!text || SKIP.some((s) => text.startsWith(s))) continue;
      const gap = lastTop != null ? ws[0].top - lastTop : 99;
      lastTop = ws[0].top;

      const af = AIRFLOW_RE.exec(text);
      if (af) {
        const v = toNum(af[1]);
        if (v) { attrs.airflow ??= v; systemAirflow ??= v; sys.airflow_m3h ??= v; }
      }

      const unitW = ws.find((w) => w.x0 >= unitRng[0] && w.x0 <= unitRng[1] && w.text in UNITS);
      const qtyW = ws.find((w) => w.x0 >= qtyRng[0] && w.x0 <= qtyRng[1]);
      const left = ws.filter((w) => w.x0 < unitRng[0]).map((w) => w.text).join(" ").trim();

      if (unitW) {                                       // ---- a priceable quantity line
        const qty = qtyW ? toNum(qtyW.text) : null;
        const label = left && left !== itemTitle ? left : "";
        titleOpen = true;
        rows.push({
          lv_id: `LV${String(rows.length + 1).padStart(4, "0")}`,
          system_code: code,
          system,
          section,
          item: itemTitle,
          detail: label,
          description_de: [itemTitle, label].filter(Boolean).join(" – "),
          quantity: qty,
          unit_raw: unitW.text,
          unit: UNITS[unitW.text],
          manufacturer_hint: attrs.Fabrikat || "",
          model_hint: attrs.Typ || "",
          offer_ref: attrs.Offerte || "",
          airflow_hint_m3h: attrs.airflow ?? systemAirflow ?? null,
          source_page: pno,
          // where the quantity line is: [x0, top, x1, baseline] in points from the top-left
          bbox: [r1(ws[0].x0), r1(ws[0].top), r1(ws.at(-1).x1), r1(Math.max(...ws.map((w) => w.base)))],
          extraction_status: qty != null ? "extracted" : "insufficient_information",
          warning: warn,
        });
        continue;
      }

      const sm = SECTION_RE.exec(text);
      if (sm) {
        section = `${sm[1]} ${title(sm[2])}`; itemTitle = null; attrs = {}; titleOpen = true;
        continue;
      }
      const am = ATTR_RE.exec(text);
      if (am && am.index === 0) {
        let val = am[2].replace(/^z\.\s?B\.?\s*/, "").replace(/^[\s.]+|[\s.]+$/g, "");
        val = val.replace(/\s+(Fabrikat|Typ)\b.*/, "");
        if (val && !(am[1] in attrs)) attrs[am[1]] = val;
        continue;
      }
      // new item heading: short line after a visible gap, left-aligned
      if (titleOpen && gap > 18 && text.length < 70 && ws[0].x0 < 90
          && /^\p{Lu}/u.test(text) && !/[-,:]$/.test(text)) {
        itemTitle = text; attrs = {}; titleOpen = false;
      }
    }
  }
  await pdf.destroy();
  return { pageCount: pdf.numPages, lvPages, systems: Object.values(systems), positions: rows };
}
