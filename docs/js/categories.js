// How tender positions are grouped on the dashboard donut and in the detailed summary.
//
// `status` on each item of results.position_results (see compute.js) is one of the README
// statuses. "calculated" positions are split by match_confidence: >= 0.9 -> Perfectly Matched,
// otherwise (or without a confidence, e.g. no product matched) -> Assumption applied. "out_of_scope" is shown as Non-priceable.

export const CATEGORIES = [
  { key: "perfectly_matched",        label: "Perfectly Matched",        color: "#4f9e6b", group: "calculated" },
  { key: "supplier_quote_required",  label: "Supplier Quote Required",  color: "#a9d8b6", group: "calculated" },
  { key: "assumption_applied",       label: "Assumption applied",       color: "#13324a", group: "calculated" },
  { key: "review_required",          label: "Review Required",          color: "#e0b040", group: "manual" },
  { key: "insufficient_information", label: "Insufficient Information", color: "#c95c4a", group: "manual" },
  { key: "non_priceable",            label: "Non-priceable",                         color: "#b9c2cc", group: "manual" },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

// Statuses a user can set on a position (detailed summary -> Edit).
export const STATUSES = [
  ["calculated", "Calculated"], ["assumption_applied", "Assumption applied"],
  ["supplier_quote_required", "Supplier quote required"], ["review_required", "Review required"],
  ["insufficient_information", "Insufficient information"], ["non_priceable", "Non-priceable"],
];

/** A status saved by older edits ("out_of_scope") is the same choice as Non-priceable now. */
export const userStatus = (s) => (s === "out_of_scope" ? "non_priceable" : s);

// Recommended bid scenario. Current rule, until there is more bid history: the highest win
// probability (ties: the higher expected contribution). Used by the dashboard, the detailed
// summary, the PDF dialog's default and the assistant.
export const RECOMMENDATION_RULE = "highest win probability";
export function recommendedScenario(range) {
  const all = range?.scenarios || [];
  const withP = all.filter((s) => Number.isFinite(s.estimated_win_probability));
  if (!withP.length) return range?.best_expected_contribution || all[0]?.scenario || null;
  return withP.reduce((a, b) => (b.estimated_win_probability > a.estimated_win_probability
    || (b.estimated_win_probability === a.estimated_win_probability
      && (b.expected_contribution_chf ?? -Infinity) > (a.expected_contribution_chf ?? -Infinity)) ? b : a)).scenario;
}

export function categorize(p) {
  const s = String(p.status || "").toLowerCase();
  if (s === "out_of_scope") return "non_priceable";
  if (s === "calculated" || s === "perfectly_matched") {
    return (p.match_confidence ?? 0) >= 0.9 ? "perfectly_matched" : "assumption_applied";
  }
  if (CATEGORY[s]) return s;
  if (p.review_required) return "review_required";
  return "insufficient_information";
}

/** Positions, cost summary, bid range and KPIs of one results object. */
export function viewOf(results) {
  if (!results) return null;
  return {
    positions: results.position_results || [],
    summary: results.summary || results.project_summary || {},
    bids: results.recommended_bid_range || null,
    kpis: results.kpis || {},
  };
}

/** Numbers for the donut and the count tiles. */
export function breakdown(view) {
  const pos = view?.positions || [];
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  for (const p of pos) counts[categorize(p)]++;
  const total = pos.length;
  const share = total ? Object.fromEntries(CATEGORIES.map((c) => [c.key, (100 * counts[c.key]) / total])) : null;
  const groupSum = (g) => (share ? CATEGORIES.filter((c) => c.group === g).reduce((s, c) => s + share[c.key], 0) : null);
  const k = view?.kpis || {};
  return {
    total,
    counts,
    share,                                                   // null when there are no results
    calculated: groupSum("calculated"),
    manual: groupSum("manual"),
    // every position of the bill (each has its own outcome, non-priceable ones included); not the
    // stored kpis.priceable_positions, which older versions counted without the non-priceable ones
    priceable: total || null,
    materials: k.materials_found ?? (total ? pos.filter((p) => p.matched_product_id).length : null),
  };
}
