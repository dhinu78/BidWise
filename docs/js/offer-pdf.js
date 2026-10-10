// Priced tender: the original tender PDF with the prices filled in, plus one page of offer notes,
// all in the tender's own language (German, French, Italian or English, detected from its text).
// The results may describe positions in English (translated by the backend's LLM); they are put
// back by page + line coordinates (bbox), never by their translated text:
//   - position lines: unit price + amount in the price columns
//       located by the result's source_page + bbox; without a bbox, the tender is read again and
//       the position is matched on its page by its original-language text, then by quantity,
//       then by order on the page. lv_ids are not used: the backend numbers positions its own way.
//   - chapter total lines  Total … "F"                      -> chapter sum of that system
//   - per-system cost summary pages  A … / Total            -> chapter sums / system total
//   - cost matrix (header A B C D E F Total, rows 244.1 …)    -> sums per system and chapter,
//     lot blocks, "Eingabesumme Los n … CHF" and "Total Eingabesumme brutto CHF"
//   - conditions: gross, discount %, subtotal 1, early-payment discount %, subtotal 2, general
//     deductions % (as printed), subtotal 3, VAT % (as printed), net, and the gross/net columns
//   - "Eingabesumme Netto Fr. … inkl. MWST"
// The contractor block (name, address, date, signature) is left as it is.
// Selling prices: cost × (bid price of the chosen scenario ÷ firm direct cost), rounded to 5 Rappen.
import { readPdfLines, parseTender } from "./tender-parser.js";

// ---- tender language ------------------------------------------------------------------------------
// Form labels are recognised in every language (a form only contains its own); everything written
// into the PDF uses the detected language.

const STOPWORDS = {
  de: /\b(der|die|das|und|mit|für|inkl|gemäss|sowie)\b/gi,
  fr: /\b(les|des|et|pour|avec|du|selon|compris)\b/gi,
  it: /\b(il|della|delle|per|con|degli|secondo|compreso)\b/gi,
  en: /\b(the|and|with|for|of|including|according)\b/gi,
};

export function detectLanguage(pages) {
  const text = pages.slice(0, 40).map((pg) => pg.lines.map((l) => l.text).join(" ")).join(" ");
  const score = Object.fromEntries(Object.entries(STOPWORDS).map(([k, re]) => [k, (text.match(re) || []).length]));
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : "de";
}

const WORDS = {
  de: { locale: "de-CH", validity: (n, d) => `Gültigkeit des Angebots: ${n} Tage (bis ${d}).`, open: "Preis folgt", included: "inbegriffen", notOffered: "nicht offeriert",
    title: "Bemerkungen zum Angebot", project: "Projekt", basis: (v, s, b, d) => `Grundlage: BIDWISE Version ${v}, Preisszenario "${s}" (Angebotssumme vor Konditionen CHF ${b}). Datum: ${d}.`,
    summary: "Zusammenfassung", gross: "Brutto", discount: "Rabatt", early: "Skonto", deductions: "allg. Bauabzüge", subtotal: "Zwischentotal", vat: "MWST", net: "Netto inkl. MWST",
    reservations: "Vorbehalte", priced: (n) => `${n} Positionen sind bepreist.`,
    estimates: (n) => ` ${n} davon (mit * markiert) sind Richtpreise: Sie beruhen auf Schätzungen und werden nach Eingang der Lieferantenofferten bestätigt.`,
    openList: (n) => `Für ${n} Positionen folgt der Preis (fehlende Angaben oder Lieferantenofferte ausstehend):`,
    page: "Seite", more: (n) => `… und ${n} weitere.`,
    markers: `Mit "inbegriffen" bezeichnete Positionen sind in anderen Positionen oder in den Projektkosten enthalten; "nicht offeriert" bezeichnet Leistungen ausserhalb unseres Angebots.`,
    missing: (n, ids) => `Hinweis: ${n} bepreiste Positionen konnten im Formular nicht verortet werden (${ids}); sie sind in den Summen enthalten.`,
    docTitle: "Angebot" },
  fr: { locale: "fr-CH", validity: (n, d) => `Validité de l'offre : ${n} jours (jusqu'au ${d}).`, open: "prix à suivre", included: "compris", notOffered: "non offert",
    title: "Remarques sur l'offre", project: "Projet", basis: (v, s, b, d) => `Base : BIDWISE version ${v}, scénario de prix "${s}" (montant de l'offre avant conditions CHF ${b}). Date : ${d}.`,
    summary: "Récapitulation", gross: "Brut", discount: "Rabais", early: "Escompte", deductions: "Déductions générales", subtotal: "Sous-total", vat: "TVA", net: "Net TVA incluse",
    reservations: "Réserves", priced: (n) => `${n} positions sont chiffrées.`,
    estimates: (n) => ` Dont ${n} (marquées *) sont des prix indicatifs : ils reposent sur des estimations et seront confirmés à réception des offres des fournisseurs.`,
    openList: (n) => `Pour ${n} positions, le prix suivra (indications manquantes ou offre fournisseur en attente) :`,
    page: "page", more: (n) => `… et ${n} autres.`,
    markers: `Les positions marquées "compris" sont incluses dans d'autres positions ou dans les frais du projet ; "non offert" désigne des prestations hors de notre offre.`,
    missing: (n, ids) => `Remarque : ${n} positions chiffrées n'ont pas pu être situées dans le formulaire (${ids}) ; elles sont comprises dans les totaux.`,
    docTitle: "Offre" },
  it: { locale: "it-CH", validity: (n, d) => `Validità dell'offerta: ${n} giorni (fino al ${d}).`, open: "prezzo segue", included: "compreso", notOffered: "non offerto",
    title: "Osservazioni sull'offerta", project: "Progetto", basis: (v, s, b, d) => `Base: BIDWISE versione ${v}, scenario di prezzo "${s}" (importo dell'offerta prima delle condizioni CHF ${b}). Data: ${d}.`,
    summary: "Riepilogo", gross: "Lordo", discount: "Ribasso", early: "Sconto", deductions: "Deduzioni generali", subtotal: "Subtotale", vat: "IVA", net: "Netto IVA inclusa",
    reservations: "Riserve", priced: (n) => `${n} posizioni sono quotate.`,
    estimates: (n) => ` Di queste, ${n} (contrassegnate con *) sono prezzi indicativi: si basano su stime e saranno confermati alla ricezione delle offerte dei fornitori.`,
    openList: (n) => `Per ${n} posizioni il prezzo seguirà (dati mancanti o offerta del fornitore in attesa):`,
    page: "pagina", more: (n) => `… e altre ${n}.`,
    markers: `Le posizioni indicate con "compreso" sono incluse in altre posizioni o nei costi di progetto; "non offerto" indica prestazioni al di fuori della nostra offerta.`,
    missing: (n, ids) => `Nota: ${n} posizioni quotate non sono state localizzate nel modulo (${ids}); sono comprese nei totali.`,
    docTitle: "Offerta" },
  en: { locale: "en-GB", validity: (n, d) => `Offer valid for ${n} days (until ${d}).`, open: "price to follow", included: "included", notOffered: "not offered",
    title: "Notes on the offer", project: "Project", basis: (v, s, b, d) => `Basis: BIDWISE version ${v}, price scenario "${s}" (offer sum before conditions CHF ${b}). Date: ${d}.`,
    summary: "Summary", gross: "Gross", discount: "Discount", early: "Early-payment discount", deductions: "General deductions", subtotal: "Subtotal", vat: "VAT", net: "Net incl. VAT",
    reservations: "Reservations", priced: (n) => `${n} positions are priced.`,
    estimates: (n) => ` ${n} of them (marked *) are indicative prices: they are based on estimates and will be confirmed once the supplier quotes are in.`,
    openList: (n) => `For ${n} positions the price will follow (missing information or supplier quote pending):`,
    page: "page", more: (n) => `… and ${n} more.`,
    markers: `Positions marked "included" are covered by other positions or the project costs; "not offered" means work outside our offer.`,
    missing: (n, ids) => `Note: ${n} priced positions could not be located in the form (${ids}); they are included in the totals.`,
    docTitle: "Offer" },
};

// form labels, all languages
const L = {
  unitHead: /^(Einheits|Prix|Prezzo|Unit)/i, unitHeadAlt: /^(Preis|price)$/i, amountHead: /^(Betrag|Montant|Importo|Amount)$/i,
  total: /^(Total|Totale)\b/i,
  costPage: /KOSTENZUSAMMENSTELLUNG|R[ÉE]CAPITULATION|RIEPILOGO|COST SUMMARY/i,
  lot: /^(LOS|LOT|LOTTO)\s+(\d+)/i,
  lotSum: /^(Eingabesumme|Montant de l'offre|Importo dell'offerta|Offer sum)\s+(Los|lot|lotto)\s+(\d+)/i,
  totalSum: /^(Total|Totale)\s+(Eingabesumme|du montant de l'offre|montant de l'offre|importo dell'offerta|offer sum)/i,
  netSum: /^(Eingabesumme\s+Netto|Montant de l'offre\s+net|Importo dell'offerta\s+netto|Net offer sum)/i,
  gross: /^(Brutto|Brut|Lordo|Gross)\b/i,
  discount: /^(Rabatt|Rabais|Ribasso|Discount)\b/i,
  early: /^(Skonto|Escompte|Sconto|Early[- ]payment)\b/i,
  sub: (n) => new RegExp(`^(Zwischentotal|Sous-total|Subtotale|Subtotal)\\s*${n}\\b`, "i"),
  deductions: /^(allg\.?\s*Bauabz\S*|D[ée]ductions? g[ée]n[ée]rales?|Deduzion[ei] general[ei]|General deductions?)/i,
  vat: /^(MWST|MwSt|TVA|IVA|VAT)\b/i,
  net: /^(Netto|Net)\b/i,
  pct: (word) => new RegExp(`^${word.source.slice(1)}\\s+(\\d+[.,]?\\d*)\\s*%`, "i"),
  noNpk: /ohne NPK|sans CAN|senza CPN/i,
};

const PDFLIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
const INK = [0.04, 0.16, 0.36];                     // dark blue, like a filled-in form

const round05 = (v) => Math.round(v * 20) / 20;
const chfText = (v) => {
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return `${v < 0 ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, "'")}.${d}`;
};
const pctText = (v) => (Math.round(v * 100) / 100).toFixed(2);
const isDots = (t) => /^[.…_]{3,}$/.test(t);
const norm = (s) => String(s || "").replace(/[“”„"]/g, '"').normalize("NFC");
const codeOf = (s) => (/\b(\d{3})\.(\d{1,2})\b/.exec(String(s || "")) || []).slice(1);
const sysKey = (s) => { const [a, b] = codeOf(s); return a ? `${a}.${String(+b).padStart(2, "0")}` : null; };
const chapterOf = (p) => (/^\s*([A-H])\b/.exec(p.chapter || p.section || "") || [])[1] || null;

/** Selling prices and markers per position (marker = "open" | "included" | "notOffered"). */
export function priceLines(results, { scenario, includeEstimates = true } = {}) {
  const pos = results.position_results || [];
  const firmDirect = pos.filter((p) => p.included_in_total).reduce((s, p) => s + (+p.direct_position_cost_chf || 0), 0);
  const sc = (results.recommended_bid_range?.scenarios || []).find((s) => s.scenario === scenario)
    || results.recommended_bid_range?.scenarios?.[0];
  const k = sc && firmDirect > 0 ? sc.bid_price_chf / firmDirect : 1;
  return {
    factor: k, scenario: sc,
    lines: pos.map((p) => {
      const est = p.price_basis === "estimate";
      const priced = (p.included_in_total || (includeEstimates && est)) && +p.quantity > 0 && p.direct_position_cost_chf != null;
      if (priced) {
        const unit = round05((p.direct_position_cost_chf * k) / p.quantity);
        return { p, unit, amount: round05(unit * p.quantity), estimate: est && !p.included_in_total };
      }
      const marker = p.status === "out_of_scope" ? "notOffered"
        : ["part_of_package", "covered_by_project_costs"].includes(p.price_flag) || p.status === "non_priceable" ? "included"
        : "open";
      return { p, marker };
    }),
  };
}

/** Totals per system / chapter and the conditions chain. */
function totals(lines, settings, pages) {
  const bySys = {}, byChap = {};
  let brutto = 0;
  for (const l of lines) {
    if (l.amount == null) continue;
    const sys = sysKey(l.p.system_code || l.p.system), ch = chapterOf(l.p);
    brutto += l.amount;
    if (sys) bySys[sys] = (bySys[sys] || 0) + l.amount;
    if (sys && ch) byChap[`${sys}|${ch}`] = (byChap[`${sys}|${ch}`] || 0) + l.amount;
  }
  // percentages printed in the tender win over defaults (e.g. "allg. Bauabzüge 1.30 %", "MWST 8.10 %")
  const printed = (re) => {
    for (const pg of pages) for (const ln of pg.lines) {
      const m = re.exec(norm(ln.text));
      if (m) return +m.at(-1).replace(",", ".");
    }
    return null;
  };
  const bau = printed(L.pct(L.deductions)) ?? 0;
  const mwst = printed(L.pct(L.vat)) ?? 8.1;
  const c = { brutto: round05(brutto), rabattPct: +settings.rabatt_pct || 0, skontoPct: +settings.skonto_pct || 0, bauPct: bau, mwstPct: mwst };
  c.rabatt = round05(c.brutto * c.rabattPct / 100); c.zt1 = round05(c.brutto - c.rabatt);
  c.skonto = round05(c.zt1 * c.skontoPct / 100); c.zt2 = round05(c.zt1 - c.skonto);
  c.bau = round05(c.zt2 * c.bauPct / 100); c.zt3 = round05(c.zt2 - c.bau);
  c.mwst = round05(c.zt3 * c.mwstPct / 100); c.netto = round05(c.zt3 + c.mwst);
  return { bySys, byChap, c };
}

// ---- where each position is in the tender ----------------------------------------------------------

/** The position's text in the tender's own language, if the results carry it. */
const originalText = (p) => p.description_original || p.original_description || p.source_text || p.description_de || "";
const tokens = (s) => new Set(norm(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}
const sameQty = (a, b) => a != null && b != null && Math.abs(+a - +b) < 1e-6;

/**
 * Positions without a bbox, matched to the positions read from the tender, page by page, with an
 * order-preserving alignment (both lists are in reading order): a pair whose quantities differ
 * can't match; equal quantities and similar original-language text make a pair stronger.
 * Text alone is never enough (a page often repeats near-identical items), and translated text
 * is not used. Returns Map(result position -> {bbox, text}).
 */
export function locatePositions(results, parsed) {
  const out = new Map();
  const byPage = (list) => list.reduce((m, p) => ((m[p.source_page] ??= []).push(p), m), {});
  const want = byPage(results.filter((p) => !p.bbox && p.source_page));
  const have = byPage(parsed);
  for (const [page, rs] of Object.entries(want)) {
    const cs = [...(have[page] || [])].sort((a, b) => a.bbox[1] - b.bbox[1]);
    const n = rs.length, m = cs.length;
    if (!m) continue;
    const pair = (r, c) => {
      const qr = r.quantity, qc = c.quantity;
      if (qr != null && qc != null && !sameQty(qr, qc)) return -1;
      const t = originalText(r);
      // without the original text, order alone is only trusted when the page counts agree
      if (!t && !sameQty(qr, qc) && n !== m) return -1;
      return 0.2 + (sameQty(qr, qc) ? 1 : 0) + (t ? overlap(t, c.description_de) : 0);
    };
    // best[i][j]: best total for rs[0..i) and cs[0..j)
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const s = pair(rs[i - 1], cs[j - 1]);
      best[i][j] = Math.max(best[i - 1][j], best[i][j - 1], s > 0 ? best[i - 1][j - 1] + s : -Infinity);
    }
    for (let i = n, j = m; i > 0 && j > 0;) {
      const s = pair(rs[i - 1], cs[j - 1]);
      if (s > 0 && Math.abs(best[i][j] - (best[i - 1][j - 1] + s)) < 1e-9) {
        out.set(rs[i - 1], { bbox: cs[j - 1].bbox, text: cs[j - 1].description_de });
        i--; j--;
      } else if (best[i][j] === best[i - 1][j]) i--;
      else j--;
    }
  }
  return out;
}

/**
 * @param {{tenderBytes:ArrayBuffer, results:object, settings:object, project:object, version:number,
 *          onProgress?:(t:string)=>void}} args
 * @returns {Promise<{bytes:Uint8Array, summary:object}>}
 */
export async function buildOfferPdf({ tenderBytes, results, settings, project, version, onProgress }) {
  const { PDFDocument, StandardFonts, rgb } = await import(PDFLIB);
  const src = new Uint8Array(tenderBytes);              // one copy per reader (pdf.js may take over its input)
  onProgress?.("Reading the tender layout…");
  const pages = await readPdfLines(src.slice(), (i, n) => onProgress?.(`Reading the tender layout… page ${i} / ${n}`));
  const lang = detectLanguage(pages), W = WORDS[lang];

  const { lines, factor, scenario } = priceLines(results, settings);
  const { bySys, byChap, c } = totals(lines, settings, pages);

  // positions without line coordinates: read the tender again and match them on their page
  let located = new Map();
  if (lines.some((l) => !l.p.bbox)) {
    onProgress?.("Locating the positions…");
    try { located = locatePositions(results.position_results || [], (await parseTender(src.slice())).positions); }
    catch (e) { console.warn("Positions could not be located in the tender", e); }
  }

  onProgress?.("Writing the prices…");
  const doc = await PDFDocument.load(src.slice(), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const pdfPages = doc.getPages();
  const color = rgb(...INK);
  const safe = (s) => String(s ?? "").replace(/[^\x20-\x7E -ÿ'’–]/g, "").replace(/[’]/g, "'").replace(/–/g, "-");

  // draw helpers (coordinates from the top-left, like the text reader)
  const H = (i) => pdfPages[i].getHeight();
  const blank = (i, x0, x1, base, size) => pdfPages[i].drawRectangle({ x: x0, y: H(i) - base - 2.5, width: x1 - x0, height: size + 3.5, color: rgb(1, 1, 1) });
  const right = (i, text, xr, base, { size = 8.5, f = font, clear = null } = {}) => {
    const t = safe(text), w = f.widthOfTextAtSize(t, size);
    if (clear) blank(i, Math.min(clear[0], xr - w - 1), clear[1], base, size);
    pdfPages[i].drawText(t, { x: xr - w, y: H(i) - base, size, font: f, color });
  };
  const center = (i, text, xc, base, size = 7.5) => {
    const t = safe(text), w = font.widthOfTextAtSize(t, size);
    pdfPages[i].drawText(t, { x: xc - w / 2, y: H(i) - base, size, font, color });
  };

  // columns per page (unit price and amount), carried over to pages without a header
  let cols = { unitRight: 488, amountRight: 562 };
  const pageCols = pages.map((pg) => {
    const head = pg.lines.slice(0, 8).flatMap((l) => l.words);
    const unit = head.find((w) => L.unitHead.test(w.text)) || head.find((w) => L.unitHeadAlt.test(w.text));
    const amount = head.find((w) => L.amountHead.test(w.text));
    if (unit && amount) cols = { unitRight: Math.max(unit.x1 + 8, amount.x0 - 30), amountRight: Math.min(pg.width - 30, amount.x1 + 25) };
    return { ...cols };
  });
  // system of a page: the footer file name ("…\244.05 LA05 Turnhalle.docx") wins over the header
  const pageSys = pages.map((pg) => {
    const foot = /(\d{3}\.\d{1,2})[^\\]*\.docx/.exec(pg.lines.at(-1)?.text || "");
    return sysKey(foot ? foot[1] : pg.lines[0]?.text);
  });

  // 1. positions
  let filled = 0;
  const missing = [];
  for (const l of lines) {
    const i = (l.p.source_page || 0) - 1;
    const bbox = l.p.bbox || located.get(l.p)?.bbox;
    if (i < 0 || i >= pdfPages.length || !bbox) { if (l.amount != null) missing.push(l); continue; }
    const near = pages[i].lines.reduce((best, ln) => (Math.abs(ln.top - bbox[1]) < Math.abs((best?.top ?? 1e9) - bbox[1]) ? ln : best), null);
    const base = near && Math.abs(near.top - bbox[1]) < 6 ? near.base : bbox[3] - 1.5;
    const pc = pageCols[i];
    if (l.amount != null) {
      right(i, `${chfText(l.unit)}${l.estimate ? "*" : ""}`, pc.unitRight, base, { clear: [pc.unitRight - 46, pc.unitRight + 2] });
      right(i, chfText(l.amount), pc.amountRight, base, { clear: [pc.amountRight - 70, pc.amountRight + 3] });
      filled++;
    } else {
      right(i, W[l.marker], pc.amountRight, base, { size: 7.5, f: italic, clear: [pc.amountRight - 70, pc.amountRight + 3] });
    }
  }

  // 2. form lines found by their labels
  let lot = null;
  const lotSystems = {};
  let matrix = null;
  pages.forEach((pg, i) => {
    const pc = pageCols[i];
    const isCostPage = pg.lines.some((l) => L.costPage.test(l.text));
    for (const ln of pg.lines) {
      const t = norm(ln.text), w = ln.words;
      const dots = w.filter((x) => isDots(x.text));
      const lastDots = dots.at(-1);

      // chapter total inside the bill:  Total Dämmungen "F"
      const ch = /^(?:Total|Totale)\b.*"([A-H])"\s*$/i.exec(t);
      if (ch && pageSys[i] && !/\b(Stk|m2|m|h|pce|pz)\b/.test(t)) {
        right(i, chfText(round05(byChap[`${pageSys[i]}|${ch[1]}`] || 0)), pc.amountRight, ln.base, { f: bold, clear: [pc.amountRight - 70, pc.amountRight + 3] });
        continue;
      }
      // matrix header: A B C D E F … Total
      const letters = w.filter((x) => /^[A-H]$/.test(x.text) && x.x0 > 150);
      if (letters.length >= 4) {
        matrix = { cols: Object.fromEntries(letters.map((x) => [x.text, (x.x0 + x.x1) / 2])), total: null };
        continue;
      }
      if (matrix && !matrix.total) {
        const tw = w.find((x) => /^(Total|Totale)$/i.test(x.text) && x.x0 > 400);
        if (tw) matrix.total = (tw.x0 + tw.x1) / 2;
      }
      const lotM = L.lot.exec(t);
      if (lotM) { lot = lotM[2]; lotSystems[lot] ??= []; continue; }
      // matrix rows: 244.1 LA01 …
      if (matrix && /^\d{3}\.\d{1,2}$/.test(w[0]?.text || "") && w[0].x0 < 150) {
        const sys = sysKey(w[0].text);
        if (lot) lotSystems[lot].push(sys);
        for (const [X, x] of Object.entries(matrix.cols)) {
          const v = byChap[`${sys}|${X}`];
          if (v) center(i, chfText(round05(v)), x, ln.base);
        }
        if (matrix.total && bySys[sys]) center(i, chfText(round05(bySys[sys])), matrix.total, ln.base);
        continue;
      }
      if (matrix && /^(Total|Totale)$/i.test(t) && lot) {
        const syss = lotSystems[lot] || [];
        for (const [X, x] of Object.entries(matrix.cols)) {
          const v = syss.reduce((s, sy) => s + (byChap[`${sy}|${X}`] || 0), 0);
          if (v) center(i, chfText(round05(v)), x, ln.base);
        }
        const tot = syss.reduce((s, sy) => s + (bySys[sy] || 0), 0);
        if (matrix.total && tot) center(i, chfText(round05(tot)), matrix.total, ln.base);
        continue;
      }
      // Eingabesumme Los n … brutto CHF ……  /  Total Eingabesumme brutto CHF ……
      const los = L.lotSum.exec(t);
      if (los && lastDots) {
        const tot = (lotSystems[los[3]] || []).reduce((s, sy) => s + (bySys[sy] || 0), 0);
        right(i, chfText(round05(tot)), lastDots.x1, ln.base, { clear: [lastDots.x0, lastDots.x1 + 2] });
        continue;
      }
      if (L.totalSum.test(t) && lastDots) {
        right(i, chfText(c.brutto), lastDots.x1, ln.base, { f: bold, clear: [lastDots.x0, lastDots.x1 + 2] });
        continue;
      }
      // per-system cost summary page: "A Apparate ……" and "Total 244.01 …"
      if (isCostPage && pageSys[i] && lastDots && /^[A-H]$/.test(w[0]?.text || "")) {
        pc.summaryRight = lastDots.x1;                 // the system total goes under these amounts
        right(i, chfText(round05(byChap[`${pageSys[i]}|${w[0].text}`] || 0)), lastDots.x1, ln.base, { clear: [lastDots.x0, lastDots.x1 + 2] });
        continue;
      }
      if (isCostPage && pageSys[i] && L.total.test(t) && sysKey(t) === pageSys[i]) {
        const xr = pc.summaryRight || pc.amountRight;
        right(i, chfText(round05(bySys[pageSys[i]] || 0)), xr, ln.base, { f: bold, clear: [xr - 70, xr + 1] });
        continue;
      }
      // conditions sheet
      if (dots.length) {
        const amountField = dots.find((x) => x.x1 - x.x0 > 60) || lastDots;   // the wide amount field
        const pctField = dots.find((x) => x.x1 - x.x0 <= 45);
        const put = (v, f = font) => right(i, chfText(v), amountField.x1, ln.base, { f, clear: [amountField.x0, amountField.x1 + 2] });
        const putPct = (v) => { if (pctField) right(i, pctText(v), pctField.x1, ln.base, { clear: [pctField.x0, pctField.x1 + 2] }); };
        if (L.netSum.test(t)) { put(c.netto, bold); continue; }
        if (L.gross.test(t)) { put(c.brutto); continue; }
        if (L.discount.test(t)) { putPct(c.rabattPct); put(c.rabatt); continue; }
        if (L.sub(1).test(t)) { put(c.zt1); continue; }
        if (L.early.test(t)) { putPct(c.skontoPct); put(c.skonto); continue; }
        if (L.sub(2).test(t)) { put(c.zt2); continue; }
        if (L.deductions.test(t)) { put(c.bau); continue; }
        if (L.sub(3).test(t)) { put(c.zt3); continue; }
        if (L.vat.test(t)) { put(c.mwst); continue; }
        if (L.net.test(t)) { put(c.netto, bold); continue; }
        // BKP summary with gross / net columns: "244 Lufttechnische Anlagen …… ……" and "Total …… ……"
        if (dots.length >= 2 && (/^\d{3}\s+\D/.test(t) || /^(Total|Totale)\s*[.…]/i.test(t)) && !L.noNpk.test(t)) {
          const [b, n] = dots.slice(-2);
          right(i, chfText(c.brutto), b.x1, ln.base, { clear: [b.x0, b.x1 + 2] });
          right(i, chfText(c.zt3), n.x1, ln.base, { clear: [n.x0, n.x1 + 2] });
          continue;
        }
      }
    }
  });

  // 3. offer notes (appended page), in the tender's language
  const [w0, h0] = [pdfPages[0].getWidth(), pdfPages[0].getHeight()];
  let page = doc.addPage([w0, h0]);
  let y = 70;
  const say = (text, { size = 9.5, f = font, gap = 4, indent = 0 } = {}) => {
    const maxW = w0 - 110 - indent;
    const words = safe(text).split(" ");
    let line = "";
    const flush = () => {
      if (y > h0 - 60) { page = doc.addPage([w0, h0]); y = 60; }
      page.drawText(line, { x: 56 + indent, y: h0 - y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
      y += size + gap; line = "";
    };
    for (const word of words) {
      if (f.widthOfTextAtSize(line ? `${line} ${word}` : word, size) > maxW) flush();
      line = line ? `${line} ${word}` : word;
    }
    if (line) flush();
  };
  // a position is named by its own text in the tender, never by a translation
  const nameOf = (p) => located.get(p)?.text || originalText(p) || `${W.page} ${p.source_page ?? "–"}`;
  const date = new Date().toLocaleDateString(W.locale);
  const priced = lines.filter((l) => l.amount != null), est = lines.filter((l) => l.estimate), open = lines.filter((l) => l.marker === "open");
  say(W.title, { size: 14, f: bold, gap: 10 });
  say(`${W.project}: ${project.name}`);
  say(W.basis(version, scenario?.scenario || "–", chfText(c.brutto), date));
  if (+settings.validity_days > 0) say(W.validity(+settings.validity_days, new Date(Date.now() + settings.validity_days * 864e5).toLocaleDateString(W.locale)));
  y += 6;
  say(W.summary, { size: 11, f: bold, gap: 6 });
  for (const [label, v, strong] of [[W.gross, c.brutto], [`${W.discount} ${pctText(c.rabattPct)} %`, -c.rabatt], [`${W.early} ${pctText(c.skontoPct)} %`, -c.skonto],
    [`${W.deductions} ${pctText(c.bauPct)} %`, -c.bau], [W.subtotal, c.zt3], [`${W.vat} ${pctText(c.mwstPct)} %`, c.mwst], [W.net, c.netto, true]]) {
    if (y > h0 - 60) { page = doc.addPage([w0, h0]); y = 60; }
    page.drawText(safe(label), { x: 70, y: h0 - y, size: 9.5, font: strong ? bold : font });
    const t = chfText(v), tw = font.widthOfTextAtSize(t, 9.5);
    page.drawText(t, { x: 330 - tw, y: h0 - y, size: 9.5, font: strong ? bold : font });
    y += 14;
  }
  y += 6;
  say(W.reservations, { size: 11, f: bold, gap: 6 });
  say(`${W.priced(priced.length)}${est.length ? W.estimates(est.length) : ""}`);
  if (open.length) {
    say(W.openList(open.length));
    for (const l of open.slice(0, 80)) say(`- ${W.page} ${l.p.source_page ?? "–"}: ${nameOf(l.p)}`, { size: 8.5, gap: 2.5, indent: 10 });
    if (open.length > 80) say(W.more(open.length - 80), { size: 8.5 });
  }
  say(W.markers);
  if (missing.length) {
    const ids = missing.slice(0, 12).map((l) => `${W.page} ${l.p.source_page ?? "–"}`).join(", ") + (missing.length > 12 ? " …" : "");
    say(W.missing(missing.length, ids), { size: 8.5 });
  }

  doc.setTitle(`${W.docTitle} – ${project.name}`);
  doc.setProducer("BIDWISE Estimation Tool");
  const bytes = await doc.save();
  return { bytes, summary: { ...c, filled, priced: priced.length, estimates: est.length, open: open.length, missing: missing.length, factor, scenario: scenario?.scenario, language: lang } };
}
