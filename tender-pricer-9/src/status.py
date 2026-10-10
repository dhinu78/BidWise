"""The six outcomes of slide 11: every LV row gets exactly one.

    calculated                 catalogue product, firm price
    supplier_quote_required    supplier package, or the product type is not in the catalogue
    assumption_applied         price derived with a stated assumption (size scaling, hourly rate)
    review_required            the tool cannot decide (several products fit, unclassified, service w/o rule)
    insufficient_information   the tender does not give what is needed (no quantity, no size)
    out_of_scope               not priced as a position (part of a package, or carried at project level)

Rules are checked top to bottom, first hit wins. `decide(row)` works with or without the side
estimate columns, so it can run after matching and again after estimating.
"""
from __future__ import annotations
import pandas as pd

STATUSES = ["calculated", "supplier_quote_required", "assumption_applied",
            "review_required", "insufficient_information", "out_of_scope"]
STATUS_LABELS = {"calculated": "Calculated", "supplier_quote_required": "Supplier quote required",
                 "assumption_applied": "Assumption applied", "review_required": "Review required",
                 "insufficient_information": "Insufficient information",
                 "out_of_scope": "Out of scope / non-priceable"}

# Service rows whose cost project_parameters.json already carries once for the whole project.
# (section, key) must exist in the parameters, otherwise the row falls through to review_required.
PROJECT_COST_BUCKETS = {
    "Transport":     ("allowances", "transport_equipment_pct"),
    "Commissioning": ("project_costs", "commissioning_hours"),
    "Testing":       ("project_costs", "commissioning_hours"),
    "Pressure test": ("project_costs", "commissioning_hours"),
    "Flushing":      ("project_costs", "commissioning_hours"),
    "Documentation": ("project_costs", "documentation_chf"),
    "Hygiene":       ("project_costs", "hygiene_inspection_chf"),
    "Engineering":   ("project_costs", "engineering_hours"),
    "Labelling":     ("allowances", "small_material_pct"),
}
SIZE_METHODS = ("catalogue price curve", "scaled by size difference")
FIRM_CONFIDENCE = {"catalogue": 0.92, "supplier_package": 0.72}   # organisers' constants


def _missing(v) -> bool:
    return v is None or (isinstance(v, float) and pd.isna(v)) or v == ""


def _bucket(row: dict, params: dict | None):
    b = PROJECT_COST_BUCKETS.get(row.get("subcategory"))
    if b and row.get("category") in ("Service", "Other") and (params is None or b[1] in params.get(b[0], {})):
        return b
    return None


def decide(row: dict, params: dict | None = None) -> tuple[str, str, float | None, str]:
    """-> (status, price_flag, match_confidence, status_reason)"""
    kind = row.get("match_type")
    pid = row.get("suggested_product_id")
    method = row.get("est_method")
    cat = row.get("category")

    # 0 the LLM read a different quantity / unit on the page image, or one the text extraction missed
    if row.get("llm_check") == "quantity_mismatch":
        q, u = row.get("quantity"), row.get("unit")
        pdf_q = "no quantity" if _missing(q) else f"{q:g} {u}"
        return ("review_required", "quantity_check", None,
                f"PDF text reads {pdf_q}, the page image reads {row.get('llm_quantity_seen')} "
                f"{row.get('llm_unit_seen') or ''}; please check page {row.get('source_page')}".replace("  ", " "))
    # 1 no quantity printed
    if _missing(row.get("quantity")):
        return ("insufficient_information", "no_quantity", None,
                "No quantity printed in the tender")
    # 2 component of a unit that is priced as one package (AHU sections)
    if kind == "part_of_package":
        return ("out_of_scope", "part_of_package", None,
                "Component of a unit priced as one supplier package; not priced separately")
    # 3/4 firm catalogue match
    if not _missing(pid):
        if row.get("price_source") == "supplier_package":
            return ("supplier_quote_required", "supplier_package", FIRM_CONFIDENCE["supplier_package"],
                    f"Supplier package {pid}: catalogue budget price, confirm with supplier quote")
        return ("calculated", "catalogue", FIRM_CONFIDENCE["catalogue"],
                f"Catalogue product {pid} ({kind} match)")
    # 5 cost already carried once at project level
    b = _bucket(row, params)
    if b:
        return ("out_of_scope", "covered_by_project_costs", None,
                f"Carried at project level ({b[0]}.{b[1]}); not priced per position to avoid double counting")
    # 6 several products fit equally
    if kind == "ambiguous":
        return ("review_required", "ambiguous_match", None,
                f"Several catalogue products fit equally ({row.get('alternatives')}); estimator must pick")
    # 7 not classified
    if _missing(cat) or cat == "Unclassified":
        return ("review_required", "unclassified", None, "Position could not be classified")
    # 8 product type known, but the tender gives no size to pick a variant
    if kind == "size_unknown":
        return ("insufficient_information", "no_size", None,
                f"Tender gives no size; closest type {row.get('estimate_product_id')} shown as estimate")
    # 9 size not in catalogue, price scaled from the same product type
    if kind == "size_not_in_catalogue" and method in SIZE_METHODS:
        ref = f"{row.get('estimate_product_id')} ({row.get('est_reference_size')})"
        if row.get("est_size_diff_pct") == 0:          # same size, other variant (e.g. 45 deg vs 90 deg bend)
            ang = row.get("angle_deg")
            what = f"{ang:g} deg variant" if not _missing(ang) else "this variant"
            return ("assumption_applied", "size_scaled", None,
                    f"Same size but {what} not in catalogue; priced from the same product type: "
                    f"{str(row.get('est_basis', '')).split(' + labour')[0]}")
        return ("assumption_applied", "size_scaled", None,
                f"Size {row.get('est_requested_size')} not in catalogue; {method} from {ref}, "
                f"size difference {row.get('est_size_diff_pct'):+g} %")
    # 10 hours priced at the productivity hourly rate
    if row.get("unit") == "h" and method == "labour only":
        return ("assumption_applied", "labour_rate", None,
                f"Hours priced at the productivity hourly rate ({row.get('est_basis')})")
    # 11 services / other without a project bucket or rule
    if cat in ("Service", "Other"):
        return ("review_required", "needs_review", None,
                f"{row.get('subcategory') or cat}: no catalogue product or project cost item")
    # 12 product type not in the catalogue (or size could not be scaled)
    if kind == "size_not_in_catalogue":
        why = "size not in catalogue and could not be scaled"
    elif str(row.get("match_reason", "")).startswith("no product with this category and unit"):
        why = f"no {cat} product sold per {row.get('unit')} in catalogue"
    else:
        why = "product type not in catalogue"
    return ("supplier_quote_required", "not_in_catalogue", None,
            f"{row.get('subcategory') or cat}: {why}; request supplier quote")


def apply(df: pd.DataFrame, params: dict | None = None) -> pd.DataFrame:
    df = df.copy()
    out = [decide(r, params) for r in df.to_dict("records")]
    df["status"] = [o[0] for o in out]
    df["price_flag"] = [o[1] for o in out]
    df["match_confidence"] = [o[2] for o in out]
    df["status_reason"] = [o[3] for o in out]
    return df
