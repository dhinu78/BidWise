// How tender positions are grouped on the dashboard donut and in the detailed summary.
//
// Set `status` on each item of results.position_results (see compute.js) to one of the keys below.
// "calculated" positions are split automatically: match_confidence >= 0.9 -> perfectly_matched,
// otherwise -> assumption_applied.

export const CATEGORIES = [
  { key: "perfectly_matched",        label: "Perfectly Matched",        color: "#4f9e6b", group: "calculated" },
  { key: "supplier_quote_required",  label: "Supplier Quote Required",  color: "#a9d8b6", group: "calculated" },
  { key: "assumption_applied",       label: "Assumption applied",       color: "#022338", group: "calculated" },
  { key: "review_required",          label: "Review Required",          color: "#e0b040", group: "manual" },
  { key: "insufficient_information", label: "Insufficient Information", color: "#c95c4a", group: "manual" },
  { key: "non_priceable",            label: "Non-priceable",            color: "#b9c2cc", group: "manual" },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

export function categorize(p) {
  const s = String(p.status || "").toLowerCase();
  if (CATEGORY[s] && s !== "perfectly_matched") return s;
  if (s === "calculated" || s === "perfectly_matched") {
    return (p.match_confidence ?? 1) >= 0.9 ? "perfectly_matched" : "assumption_applied";
  }
  if (p.review_required) return "review_required";
  return "insufficient_information";
}

/**
 * Numbers for the dashboard. Values in results.kpis (if present) win over the derived ones:
 *   kpis.position_breakdown_pct = {perfectly_matched: 48.9, ...}
 *   kpis.calculated_pct, kpis.manual_review_pct, kpis.priceable_positions, kpis.materials_found
 */
export function breakdown(results) {
  const pos = results?.position_results || [];
  const k = results?.kpis || {};
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  for (const p of pos) counts[categorize(p)]++;
  const total = pos.length;

  const share = k.position_breakdown_pct
    || (total ? Object.fromEntries(CATEGORIES.map((c) => [c.key, (100 * counts[c.key]) / total])) : null);
  const groupSum = (g) => (share ? CATEGORIES.filter((c) => c.group === g).reduce((s, c) => s + (share[c.key] || 0), 0) : null);

  return {
    total,
    counts,
    share,                                                   // null when there are no results
    calculated: k.calculated_pct ?? groupSum("calculated"),
    manual: k.manual_review_pct ?? groupSum("manual"),
    priceable: k.priceable_positions ?? (total ? total - counts.non_priceable : null),
    materials: k.materials_found ?? (total ? pos.filter((p) => p.matched_product_id).length : null),
  };
}
