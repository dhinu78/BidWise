// Default project_parameters for new projects. Tender-neutral: factors are 1.0 (no effect),
// project hours and lump sums are 0 and filled in per tender on the Edit parameters page.
// Percentages and rates are company-wide starting values. Existing projects keep their own copy.
//
// Productivity factors: every factor key used in productivity.csv (factor_keys column) is added
// here automatically with 1.0 when that file is uploaded, so it can be tuned per project.
export const DEFAULT_PARAMETERS = {
  schema_version: "3.0",
  project: {
    name: "",
    id: "",
    client: "",
    currency: "CHF",
    source_tender_file: null,
  },
  productivity_factors: {
    site_efficiency: 1.0,
  },
  allowances: {
    material_waste_pct: 3.0,
    small_material_pct: 3.0,
    transport_equipment_pct: 2.0,
    supplier_package_contingency_pct: 3.0,
  },
  project_costs: {
    engineering_hours: 0,
    engineering_rate_chf_per_h: 145,
    commissioning_hours: 0,
    commissioning_rate_chf_per_h: 155,
    documentation_chf: 0,
  },
  commercial: {
    overhead_pct: 8.5,
    target_margin_pct: 5.0,
    round_to_chf: 1000,
  },
  stretch_bid_optimization: {
    enabled: true,
    output_name: "Recommended Bid Range",
    scenario_names: ["Aggressive", "Target", "Conservative"],
    reference_win_probability: 0.5,
    price_sensitivity_probability_points_per_1pct_price: 0.05,
    strategic_appetite_adjustment: 0,
    competition_adjustment: 0,
    minimum_probability: 0.05,
    maximum_probability: 0.95,
    scenario_margins_pct: { Aggressive: 2.5, Target: 4.0, Conservative: 6.5 },
  },
  custom_parameters: [],
  position_overrides: {},
};
