// >>> PUT YOUR CALCULATION HERE (optional) <<<
//
// Called on every Re-compute, after the version folder has been saved.
// `inputs` = {
//   version,          // number, e.g. 3
//   parameters,       // project_parameters.json as an object
//   catalog,          // catalog.csv rows: [{column: "text", ...}, ...]
//   productivity,     // productivity.csv rows
//   tenderPdf,        // the tender PDF as a Blob
// }
//
// Return an object shaped like sample_data/expected_output_example.json
// (position_results, example_subset_summary, recommended_bid_range).
// It is saved as results.json in the version folder and shown on the dashboard.
// Return null to only save the inputs (the dashboard then shows "–").
//
// Tip (checked against the example output): for a position,
//   adjusted_install_hours = quantity * base_hours_per_unit
//                            * product(factors in factor_keys except site_efficiency) / site_efficiency
//   material_cost_chf      = net_unit_cost_chf * quantity * (1 + material_waste_pct/100)

export async function computeEstimation(inputs) {
  return null;
}
