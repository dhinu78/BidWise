// Rule-based matching of extracted (German) LV positions to catalogue items / supplier packages.
//
// Each position gets:
//   category, install_code, matched_product_id (or null), status, match_confidence, match_note
// Status meanings (README): calculated | supplier_quote_required | assumption_applied |
//   review_required | insufficient_information | out_of_scope | non_priceable
// Confidence: 0.92 exact catalogue match, 0.72 exact supplier package, lower = assumption.
import { VERIFIED_POSITIONS } from "./reference.js";

const CONF = { exact: 0.92, package: 0.72, near: 0.65, weak: 0.5 };

// ---- size parsing ------------------------------------------------------------------------

const n = (s) => Number(String(s).replace(",", "."));
/** Round size in mm: "Ø 12.5 cm", "Grösse 16 Ø cm", "Ø 250 mm". Values without unit: <= 63 -> cm. */
export function diameterMm(text) {
  const m = /[øØ]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)?/.exec(text)
    || /(\d+(?:[.,]\d+)?)\s*[øØ]\s*(mm|cm)?/.exec(text);
  if (!m) return null;
  return toMm(n(m[1]), m[2]);
}
const toMm = (v, unit) => (unit === "mm" ? v : unit === "cm" ? v * 10 : v <= 63 ? v * 10 : v);

/** Rectangular size [w, h, (l)] in mm: "40 x 20 cm", "300 x 200", "MS-F/300x400x1250", "50x30". */
export function rectMm(text) {
  const m = /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)(?:\s*x\s*(\d+(?:[.,]\d+)?))?\s*(mm|cm)?/i.exec(text);
  if (!m) return null;
  const dims = [m[1], m[2], m[3]].filter(Boolean).map(n);
  const unit = m[4] || (Math.max(dims[0], dims[1]) < 100 ? "cm" : "mm");
  return dims.map((v) => (unit === "cm" ? v * 10 : v));
}
/** First number after a token, e.g. DN after "TVR-D" or "VFC". */
function numberAfter(text, token) {
  const m = new RegExp(`${token}[\\s.]*?(\\d+(?:[.,]\\d+)?)`, "i").exec(text);
  return m ? n(m[1]) : null;
}

// catalogue sizes
const productDn = (p) => Number((/DN(\d+)/.exec(p.description) || [])[1]) || null;
const productRect = (p) => {
  const m = /(\d+)x(\d+)(?:x(\d+))?/.exec(p.description + " " + p.model);
  return m ? [m[1], m[2], m[3]].filter(Boolean).map(Number) : null;
};
const productAirflow = (p) => Number((/(\d+)\s*m3\/h/.exec(p.description) || [])[1]) || null;
const productAngle = (p) => Number((/(\d+)°/.exec(p.description) || [])[1]) || null;

// ---- catalogue lookups ---------------------------------------------------------------------

let CAT = [];
const bySub = (sub) => CAT.filter((p) => p.subcategory === sub);

/** Pick the closest product by a numeric distance. Returns {product, exact}. */
function nearest(products, dist) {
  let best = null, bestD = Infinity;
  for (const p of products) {
    const d = dist(p);
    if (d != null && d < bestD) { best = p; bestD = d; }
  }
  return best ? { product: best, exact: bestD < 1e-6 } : null;
}
const byDn = (products, dn) => (dn ? nearest(products, (p) => (productDn(p) ? Math.abs(productDn(p) - dn) : null)) : null);
const byRect = (products, dims) => {
  if (!dims) return null;
  const [a, b] = [Math.max(dims[0], dims[1]), Math.min(dims[0], dims[1])];
  return nearest(products, (p) => {
    const r = productRect(p);
    if (!r) return null;
    const [x, y] = [Math.max(r[0], r[1]), Math.min(r[0], r[1])];
    const len = dims[2] && r[2] ? Math.abs(dims[2] - r[2]) / 10 : 0;
    return Math.abs(a - x) + Math.abs(b - y) + len;
  });
};
const byAirflow = (products, q) => (q ? nearest(products, (p) => Math.abs(productAirflow(p) - q) / q) : null);

// ---- result builders -----------------------------------------------------------------------

function fromProduct(category, hit, what, extra = {}) {
  if (!hit) return { category, status: "review_required", match_confidence: CONF.weak, match_note: `No catalogue size for ${what}`, ...extra };
  const p = hit.product;
  const pkg = p.source_type === "supplier_package" || String(p.supplier_quote_required).toLowerCase() === "true";
  return {
    category,
    matched_product_id: p.product_id,
    install_code: p.install_code,
    status: pkg ? "supplier_quote_required" : hit.exact ? "calculated" : "assumption_applied",
    match_confidence: hit.exact ? (pkg ? CONF.package : CONF.exact) : (pkg ? 0.6 : CONF.near),
    match_note: hit.exact ? `${what} → ${p.description}` : `Nearest catalogue size: ${p.description} for ${what}`,
    ...extra,
  };
}
const fixed = (category, productId, conf, note, extra = {}) => {
  const p = CAT.find((x) => x.product_id === productId);
  return p ? fromProduct(category, { product: p, exact: conf >= 0.9 }, note, extra) : review(category, note);
};
const review = (category, note, extra = {}) => ({ category, status: "review_required", match_confidence: 0, match_note: note, ...extra });
const nonPriceable = (category, note) => ({ category, status: "non_priceable", match_confidence: 1, match_note: note });
const labourOnly = (category, role, note) => ({ category, status: "assumption_applied", labour_only_role: role, match_confidence: 0.8, match_note: note });

// ---- rules (first match wins) ----------------------------------------------------------------

const RULES = [
  // air-handling units, sized by the airflow stated in the system ("Luftmenge 6200 m3/h")
  [/^zuluftger(ä|a)t/, (t, p) => {
    if (/fortluft/.test(t)) return review("Equipment", "Exhaust section of the AHU – check whether it is included in the AHU package");
    const hit = byAirflow(bySub("Air-handling unit"), p.airflow_hint_m3h);
    return hit ? fromProduct("Equipment", { ...hit, exact: true }, `AHU ${p.airflow_hint_m3h} m³/h`)
      : review("Equipment", "AHU without stated airflow");
  }, "item"],
  // AHU sub-components and pure specification lines
  [/leerteil|qualitätsstufe|taschenfilter|druckverluste|tropfenabscheider|daten und zubehör|^motor/, () =>
    nonPriceable("Equipment", "AHU component – included in the AHU supplier package")],
  [/farbbeschichtung|bezeichnungsschild|total regulierung|nachweis dem bericht|statische berechnung|versandkosten/, () =>
    nonPriceable("Other", "Specification / documentation item – covered by project costs")],
  [/^ventilator/, (t, p) => {
    const hit = byAirflow(bySub("Fan"), p.airflow_hint_m3h);
    return hit ? fromProduct("Equipment", { ...hit, exact: true }, `Fan ${p.airflow_hint_m3h} m³/h`) : review("Equipment", "Fan without stated airflow");
  }, "item"],

  // air terminals
  [/tellerventil/, (t) => {
    const sub = /abluft/.test(t) ? "Exhaust valve" : "Supply valve";
    const dn = diameterMm(t);
    return fromProduct("Air terminal", byDn(bySub(sub), dn), `${sub} DN${dn}`);
  }],
  [/gitter|überström|wirbelstrahl|düsenrohr|regenhut|lamellenhut|sockelrohr|frontplatte|dekorlochblech|einbausatz/, () =>
    review("Air terminal", "No catalogue item – request a supplier price", { install_code: "DIFFUSER" })],

  // fire protection
  [/brandschutzklappe/, (t) => {
    const dn = diameterMm(t);
    return fromProduct("Fire protection", byDn(bySub("Fire damper"), dn), `Fire damper DN${dn}`);
  }],
  [/durchdringung/, (t) => {
    const dn = diameterMm(t);
    if (dn) return fromProduct("Fire protection", byDn(bySub("Circular seal"), dn), `Fire seal DN${dn}`);
    const r = rectMm(t);
    return fromProduct("Fire protection", byRect(bySub("Rectangular seal"), r), `Fire seal ${r?.slice(0, 2).join("x")} mm`);
  }],
  [/revisi\w*deckel/, (t) => {
    const r = rectMm(t);
    return fromProduct("Fire protection", byRect(bySub("Inspection cover"), r), `Inspection cover ${r?.slice(0, 2).join("x")} mm`);
  }],
  [/kontroll- und putzdeckel/, (t) => {
    const r = rectMm(t) || (diameterMm(t) ? [diameterMm(t), diameterMm(t)] : null);
    const hit = byRect(bySub("Inspection cover"), r);
    return fromProduct("Ductwork", hit && { ...hit, exact: false }, `Duct access door ${r?.slice(0, 2).join("x")} mm`);
  }],
  [/brandschutzdämmung|aussendämmung ei\d+/, () =>
    review("Fire protection", "Fire-rated insulation – no catalogue item, request a supplier price", { install_code: "INSULATION_60" })],

  // dampers
  [/drosselklappe/, (t) => {
    const dn = diameterMm(t);
    return fromProduct("Damper", byDn(bySub("Manual damper"), dn), `Balancing damper DN${dn}`);
  }],

  // silencers
  [/kompaktschalldämpfer|rohrschalldämpfer/, (t, p) => {
    const dn = /\/\s*\d+/.test(p.model_hint) ? numberAfter(p.model_hint, "KOSD") : null;
    const fromDetail = /^\s*\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)/.exec(p.detail || "");
    const size = dn || (fromDetail ? toMm(n(fromDetail[1])) : null);
    return fromProduct("Silencer", byDn(bySub("Compact"), size), `Compact silencer DN${size}`);
  }],
  [/schalldämpfer/, (t, p) => {
    const r = rectMm(p.model_hint || "") || rectMm(t);
    return fromProduct("Silencer", byRect(bySub("Rectangular"), r), `Rectangular silencer ${r?.join("x")} mm`);
  }],

  // flow controllers
  [/vfc|konstant/, (t) => {
    const v = numberAfter(t, "vfc") ?? numberAfter(t, "\\.{3,}");
    const dn = v ? toMm(v) : null;
    return fromProduct("Flow controller", byDn(bySub("CAV circular"), dn), `Constant volume controller DN${dn}`);
  }],
  [/tvr-d/, (t) => {
    const v = numberAfter(t, "tvr-d");
    const dn = v ? toMm(v) : null;
    return fromProduct("Flow controller", byDn(bySub("VAV circular"), dn), `VAV controller DN${dn}`);
  }],
  [/volumenstromregler|tvj-d/, (t) => {
    const r = rectMm(t);
    if (r) return fromProduct("Flow controller", byRect(bySub("VAV rectangular"), r), `VAV controller ${r.slice(0, 2).join("x")} mm`);
    const dn = diameterMm(t);
    return fromProduct("Flow controller", byDn(bySub("VAV circular"), dn), `VAV controller DN${dn}`);
  }],

  // insulation
  [/doppelwandige blechkanäle|wetterfeste ummantelung/, () =>
    fixed("Insulation", "P-INS-003", CONF.package, "Weatherproof insulation with stainless cladding")],
  [/thermische aussendämmung\s*(\d+)/, (t) => {
    const mm = Number(/thermische aussendämmung\s*(\d+)/.exec(t)[1]);
    if (mm === 30) return fixed("Insulation", "P-INS-001", CONF.exact, "30 mm mineral wool insulation");
    if (mm === 60) return fixed("Insulation", "P-INS-002", CONF.exact, "60 mm mineral wool insulation");
    return fixed("Insulation", "P-INS-002", CONF.weak, `${mm} mm insulation – priced as the thickest catalogue item (60 mm)`);
  }],
  [/kanal-aussendämmung/, () => fixed("Insulation", "P-INS-001", CONF.near, "Insulation at wall/ceiling penetrations – priced as 30 mm")],

  // supports
  [/anschlusswinkel|anschlusswinkle/, () => fixed("Support", "P-SUP-001", CONF.exact, "Connection-angle set")],
  [/montagefüsse/, () => fixed("Support", "P-SUP-001", CONF.weak, "Roof mounting feet – priced as support set")],

  // controls / field devices
  [/drehantrieb/, () => fixed("Controls", "P-CTL-003", CONF.exact, "Actuator")],
  [/kanaltemperaturfühler|kanaltemperatur- und feuchte/, (t) =>
    fixed("Controls", "P-CTL-002", /feuchte/.test(t) ? CONF.near : CONF.exact, /feuchte/.test(t) ? "Temperature/humidity sensor – priced as temperature sensor" : "Temperature sensor")],
  [/druckdifferenzfühler/, () => fixed("Controls", "P-CTL-001", CONF.exact, "Differential pressure transmitter")],
  [/druckwächter/, () => fixed("Controls", "P-CTL-001", CONF.near, "Pressure switch – priced as differential pressure transmitter")],
  [/frostschutzwächter/, () => fixed("Controls", "P-CTL-002", CONF.near, "Frost protection thermostat – priced as temperature sensor")],
  [/zeigerthermometer/, (t) => /montagerahmen/.test(t)
    ? nonPriceable("Controls", "Mounting frame – accessory of the thermometer")
    : fixed("Controls", "P-CTL-002", CONF.weak, "Dial thermometer – priced as temperature sensor")],
  [/kanalrauchmelder/, () => review("Controls", "Duct smoke detector – no catalogue item", { install_code: "CONTROL_POINT" })],

  // ductwork
  [/rohr,?\s*länge\s*(\d+(?:\.\d+)?)\s*m/, (t, p) => {
    const len = n(/länge\s*(\d+(?:\.\d+)?)\s*m/.exec(t)[1]);
    const dn = diameterMm(t);
    const res = fromProduct("Ductwork", byDn(bySub("Circular duct"), dn), `Circular duct DN${dn}`);
    if (!res.matched_product_id) return res;
    return {
      ...res, status: res.status === "calculated" ? "assumption_applied" : res.status, match_confidence: CONF.near,
      quantity_factor: len, unit_override: "m",
      match_note: `${res.match_note}; ${p.quantity ?? "?"} pc × ${len} m converted to metres`,
    };
  }],
  [/bogen\s*(\d+)°/, (t) => {
    const angle = Number(/bogen\s*(\d+)°/.exec(t)[1]);
    const dn = diameterMm(t);
    const bends = bySub("Circular bend");
    const hit = dn ? nearest(bends, (p) => Math.abs(productDn(p) - dn) * 10 + Math.abs(productAngle(p) - angle) / 15) : null;
    return fromProduct("Ductwork", hit, `Bend ${angle}° DN${dn}`);
  }],
  [/verbindungsmanschette|ringraumdichtung|mauerkragen|dehnungsmanschette|montageschiene/, () =>
    review("Ductwork", "Duct accessory – no catalogue item", { install_code: "DUCT_FITTING" })],
  [/kanaldichtheitsprüfung/, () => review("Service", "Duct leakage test – include in commissioning or price as service")],

  // labour-only positions stated in hours
  [/ausführungszeichnung/, (t, p) => p.unit === "h"
    ? labourOnly("Service", "project_engineer", "Engineering hours stated in the tender × engineering rate")
    : review("Service", "Drawing work")],
  [/montage/, (t, p) => p.unit === "h"
    ? labourOnly("Service", "installer", "Installation hours stated in the tender × installer rate")
    : review("Service", "Installation item without catalogue price")],

  // kitchen ceiling (supplier system)
  [/kassette|l-profil|deckenunterkonstruktion|küche|abwäscherei/, () =>
    review("Kitchen ceiling", "Kitchen ventilation ceiling – supplier system, request a quote")],
];

/** Match one extracted position. `catalog` = catalog.csv rows. */
export function matchPosition(pos, catalog) {
  CAT = catalog;
  const item = (pos.item || pos.detail || "").normalize("NFC").toLowerCase();
  const text = [pos.item, pos.detail, pos.model_hint].filter(Boolean).join(" ").normalize("NFC").toLowerCase();
  let res = null;
  for (const [re, fn, on] of RULES) {
    if (re.test(on === "item" ? item : text)) { res = fn(text, pos); break; }
  }
  res ??= review("Other", "No matching rule – manual pricing needed");
  res.matched_product_id ??= null;
  res.install_code ??= null;
  if (pos.quantity == null && res.status !== "non_priceable") {
    res = { ...res, status: "insufficient_information", match_note: `No quantity in the tender. ${res.match_note || ""}`.trim() };
  }
  return res;
}

/**
 * Link extracted positions to the verified examples (example_lv_positions.csv): same page and
 * quantity, and the same proposed product (first pass) or install code (second pass).
 * Returns Map(extracted lv_id -> verified row).
 */
export function linkVerified(items) {
  const links = new Map(), used = new Set();
  const pass = (same) => {
    for (const v of VERIFIED_POSITIONS) {
      if (used.has(v.lv_id)) continue;
      const it = items.find(({ pos, match }) => !links.has(pos.lv_id)
        && pos.source_page === v.source_page && pos.quantity === v.quantity && same(v, match));
      if (it) { links.set(it.pos.lv_id, v); used.add(v.lv_id); }
    }
  };
  pass((v, m) => m.matched_product_id === v.suggested_product_id);
  pass((v, m) => m.install_code === v.expected_install_code);
  return links;
}
