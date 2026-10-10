// How tender positions are grouped on the dashboard donut and in the detailed summary.
//
// `status` on each item of results.position_results (see compute.js) is one of the README
// statuses. "calculated" positions are split by match_confidence: >= 0.9 -> Perfectly Matched,
// otherwise -> Assumption applied. "out_of_scope" is shown together with Non-priceable.

export const CATEGORIES = [
  { key: "perfectly_matched",        label: "Perfectly Matched",        color: "#4f9e6b", group: "calculated" },
  { key: "supplier_quote_required",  label: "Supplier Quote Required",  color: "#a9d8b6", group: "calculated" },
  { key: "assumption_applied",       label: "Assumption applied",       color: "#13324a", group: "calculated" },
  { key: "review_required",          label: "Review Required",          color: "#e0b040", group: "manual" },
  { key: "insufficient_information", label: "Insufficient Information", color: "#c95c4a", group: "manual" },
  { key: "non_priceable",            label: "Non-priceable",            color: "#b9c2cc", group: "manual" },
];
export const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));

// Statuses a user can set on a position (detailed summary -> Edit).
export const STATUSES = [
  ["calculated", "Calculated"], ["assumption_applied", "Assumption applied"],
  ["supplier_quote_required", "Supplier quote required"], ["review_required", "Review required"],
  ["insufficient_information", "Insufficient information"], ["out_of_scope", "Out of scope"],
  ["non_priceable", "Non-priceable"],
];

export function categorize(p) {
  const s = String(p.status || "").toLowerCase();
  if (s === "out_of_scope") return "non_priceable";
  if (s === "calculated" || s === "perfectly_matched") {
    return (p.match_confidence ?? 1) >= 0.9 ? "perfectly_matched" : "assumption_applied";
  }
  if (CATEGORY[s]) return s;
  if (p.review_required) return "review_required";
  return "insufficient_information";
}

export const SCOPES = { full: "Full tender", verified: "Verified subset" };

/** The positions, cost summary and bid range for one scope ("full" | "verified"). */
export function viewOf(results, scope = "full") {
  if (!results) return null;
  const all = results.position_results || [];
  const v = results.views?.[scope] || results.views?.full;
  const positions = scope === "verified" && results.views ? all.filter((p) => p.verified_ref) : all;
  return {
    scope,
    positions,
    summary: v?.summary || results.example_subset_summary || results.summary || {},
    bids: v?.recommended_bid_range || results.recommended_bid_range || null,
    kpis: v?.kpis || results.kpis || {},
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
    priceable: k.priceable_positions ?? (total ? total - counts.non_priceable : null),
    materials: k.materials_found ?? (total ? pos.filter((p) => p.matched_product_id).length : null),
  };
}
