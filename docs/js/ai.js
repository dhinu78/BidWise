// BIDBOT, the BIDWISE AI assistant: a chat panel that explains the current estimate in plain language, drafts
// supplier quote requests, reads uploaded supplier quotes (PDF text extracted in the browser,
// file stored with the project) and compares them, and proposes changes (position quantity / product / unit price / status,
// project parameters). Proposed changes are shown as a card and only applied when the user clicks
// "Apply"; they are then saved right away like a normal edit (re-priced in the app, see app.js
// saveEdits), no Re-compute needed. It only handles questions about the tender (scope
// rules enforced by the relay). Conversations are saved per project in Firestore
// (users/{uid}/projects/{pid}/chats) and can be reopened under "History".
//
// The browser never holds an AI key. Requests go to the BIDWISE AI relay (ai-relay/worker.js, a
// Cloudflare Worker) with the user's Firebase sign-in token; the relay adds the Gemini key.
// Leave AI_RELAY_URL empty to hide the assistant.
//
// Gemini gets a short instruction plus "tools" it can call to look at the estimate (overview,
// position search, single position, catalogue), to show an email draft and to propose changes.
import { $, esc, chf, stableJson, paramsKey } from "./ui.js";
import { KINDS, validateParameters } from "./validate.js";
import { readPdfLines } from "./tender-parser.js";
import { recommendedScenario, RECOMMENDATION_RULE, CATEGORY, categorize, breakdown, viewOf, userStatus } from "./categories.js";

export const AI_RELAY_URL = "https://bidwise-ai.kunaalkk1.workers.dev";

const MAX_TOOL_ROUNDS = 6;
const MAX_REQUEST_CHARS = 300_000;       // the relay accepts up to 400 kB
const QUICK = [
  "What should I do next?",
  "Explain the estimated positions",
  "Draft supplier quote requests",
  "What are the biggest risks in this bid?",
  "Compare the supplier quotes",
];

let ctx;
const chat = { projectId: null, id: null, title: "", createdAt: null, messages: [], contents: [], busy: false };

// ---- data the tools read -----------------------------------------------------------------------

const results = () => ctx.state.latest?.results || null;
const num0 = (v) => (v === null || v === "" || v === undefined || !Number.isFinite(+v) ? undefined : +v);
const getPath = (o, path) => String(path || "").split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((x, k) => (x[k] ??= {}), o)[last] = v;
}
const STATUS_WORDS = {
  calculated: "perfectly matched", perfectly_matched: "perfectly matched", assumption_applied: "priced with an assumption",
  supplier_quote_required: "needs a supplier price", review_required: "needs a manual check",
  insufficient_information: "information missing in the tender",
  // one category in the app: "out_of_scope" (pricer) and "non_priceable" are both Non-priceable
  out_of_scope: "non-priceable", non_priceable: "non-priceable",
};
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));
const r2 = (v) => (Number.isFinite(+v) && v !== null ? Math.round(+v * 100) / 100 : v);

function compact(p) {
  return clean({
    lv_id: p.lv_id, page: p.source_page, system: p.system, chapter: p.chapter,
    description: p.description, tender_text: p.description_de,
    quantity: p.quantity, unit: p.unit, product: p.matched_product_id, install_code: p.install_code,
    unit_cost_chf: r2(p.net_unit_cost_chf), direct_chf: r2(p.direct_position_cost_chf),
    price_basis: p.price_basis, range_chf: p.price_range_chf, status: p.status, price_flag: p.price_flag,
    reason: p.status_reason || p.match_note, alternatives: p.alternatives,
    manufacturer_hint: p.manufacturer_hint, model_hint: p.model_hint,
  });
}

function countBy(list, f) {
  const out = {};
  for (const p of list) { const k = f(p) ?? "none"; out[k] = (out[k] || 0) + 1; }
  return out;
}

const TOOLS = {
  get_overview: {
    description: "Overview of the current estimate: totals (firm, estimated, indicative), bid scenarios, positions per category (as on the dashboard) / price flag / price basis, the number of priceable positions, systems, warnings, main parameters and the largest estimated positions. Call this first.",
    parameters: { type: "object", properties: {} },
    run() {
      const r = results();
      const p = ctx.state.project;
      if (!r) return { computed: false, note: "No computed version yet. The user must upload the files and click Compute." };
      const pos = r.position_results || [];
      const flags = {};
      for (const x of pos) {
        if (!x.price_flag) continue;
        const f = (flags[x.price_flag] ??= { positions: 0, direct_chf: 0 });
        f.positions++; f.direct_chf = r2(f.direct_chf + (+x.direct_position_cost_chf || 0));
      }
      const est = pos.filter((x) => x.price_basis === "estimate")
        .sort((a, b) => (b.direct_position_cost_chf || 0) - (a.direct_position_cost_chf || 0)).slice(0, 12).map(compact);
      return clean({
        project: p.name, client: p.parameters?.project?.client, tender_file: r.source_tender_file,
        version: p.currentVersion, engine: r.engine,
        bid_status: p.bid?.status || "in_progress", bid_submitted: p.bid?.submitted, bid_outcome: p.bid?.outcome,
        installation_hours_firm: r2((r.position_results || []).filter((x) => x.included_in_total).reduce((a, x) => a + (+x.adjusted_install_hours || 0), 0)), tender: r.tender && clean({ ...r.tender, systems: undefined }),
        positions: pos.length,
        // the app's categories, exactly as on the dashboard (out of scope counts as Non-priceable)
        priceable_positions: breakdown(viewOf(r)).priceable,
        by_category: countBy(pos, (x) => CATEGORY[categorize(x)].label),
        by_price_basis: countBy(pos, (x) => x.price_basis),
        by_price_flag: flags,
        firm_summary: r.summary,
        estimated: r.estimated, indicative_total: r.indicative_total, cost_note: r.cost_note,
        bid_range: r.recommended_bid_range && clean({
          basis: r.recommended_bid_range.basis,
          recommended: recommendedScenario(r.recommended_bid_range), recommendation_rule: RECOMMENDATION_RULE,
          scenarios: r.recommended_bid_range.scenarios,
        }),
        systems: (r.systems || []).map((s) => clean({ name: s.name, positions: s.positions, firm: s.priced, estimated: s.estimated,
          firm_chf: s.direct_cost_chf, estimated_chf: s.estimated_cost_chf })),
        warnings: r.warnings,
        parameters: clean({ commercial: p.parameters?.commercial, allowances: p.parameters?.allowances,
          productivity_factors: p.parameters?.productivity_factors }),
        user_edits_saved: Object.keys(p.parameters?.position_overrides || {}).length,
        largest_estimated_positions: est,
      });
    },
  },
  find_positions: {
    description: "Search tender positions. All filters are optional and combined. Returns compact rows.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "calculated | assumption_applied | supplier_quote_required | review_required | insufficient_information | non_priceable (includes out of scope)" },
        price_flag: { type: "string", description: "e.g. catalogue, supplier_package, size_scaled, not_in_catalogue, ambiguous_match, covered_by_project_costs, part_of_package, no_size, no_quantity, labour_rate" },
        price_basis: { type: "string", description: "firm | estimate | none" },
        system: { type: "string", description: "part of the system name, e.g. 244.03 or Turnhalle" },
        text: { type: "string", description: "words to find in description, tender text, product, reason or hints" },
        min_direct_chf: { type: "number" },
        sort: { type: "string", description: "direct_desc (default) or page" },
        limit: { type: "integer", description: "max rows, default 25, at most 60" },
      },
    },
    run(a = {}) {
      const r = results();
      if (!r) return { computed: false };
      const q = String(a.text || "").toLowerCase();
      let list = (r.position_results || []).filter((p) =>
        (!a.status || userStatus(p.status) === userStatus(a.status))
        && (!a.price_flag || p.price_flag === a.price_flag)
        && (!a.price_basis || p.price_basis === a.price_basis)
        && (!a.system || String(p.system || "").toLowerCase().includes(String(a.system).toLowerCase()))
        && (!a.min_direct_chf || (p.direct_position_cost_chf || 0) >= a.min_direct_chf)
        && (!q || [p.description, p.description_de, p.matched_product_id, p.status_reason, p.match_note, p.manufacturer_hint, p.model_hint, p.subcategory]
          .some((v) => String(v || "").toLowerCase().includes(q))));
      list = a.sort === "page"
        ? list.sort((x, y) => (x.source_page || 0) - (y.source_page || 0))
        : list.sort((x, y) => (y.direct_position_cost_chf || 0) - (x.direct_position_cost_chf || 0));
      const limit = Math.min(Math.max(+a.limit || 25, 1), 60);
      return { total_matches: list.length, returned: Math.min(limit, list.length), positions: list.slice(0, limit).map(compact) };
    },
  },
  get_position: {
    description: "All details of one position by its lv_id (e.g. LV0013), including the estimate method.",
    parameters: { type: "object", properties: { lv_id: { type: "string" } }, required: ["lv_id"] },
    run({ lv_id } = {}) {
      const p = (results()?.position_results || []).find((x) => x.lv_id === lv_id);
      if (!p) return { found: false };
      const { bbox, ...rest } = p;
      return clean({ ...rest, user_edit: ctx.state.project.parameters?.position_overrides?.[lv_id] });
    },
  },
  list_catalog: {
    description: "Products in the uploaded catalogue (id, description, unit, net price CHF, catalogue item or supplier package).",
    parameters: { type: "object", properties: { category: { type: "string", description: "optional, e.g. Silencer" } } },
    run({ category } = {}) {
      const list = (results()?.catalog || []).filter((c) => !category || String(c.category || "").toLowerCase().includes(category.toLowerCase()));
      return { products: list.map((c) => clean({ id: c.product_id, category: c.category, description: c.description, unit: c.unit,
        net_chf: c.net_cost_chf, type: c.source_type })) };
    },
  },
  propose_changes: {
    description: "Propose changes the user asked for. They are shown as a card with an Apply button; nothing changes until the user clicks Apply. Apply saves them right away: the positions are re-priced and the totals and bids updated (no Re-compute needed). Position changes: quantity, unit price (CHF, e.g. from a supplier quote), product (catalogue id, \"\" = no product), status, note. Parameter changes: an existing numeric parameter by its path, e.g. commercial.overhead_pct or stretch_bid_optimization.scenario_margins_pct.Target (probabilities are 0..1, percentages are numbers like 8.5).",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "one plain sentence: what changes and why" },
        position_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lv_id: { type: "string" },
              quantity: { type: "number" },
              unit_price_chf: { type: "number" },
              product_id: { type: "string", description: "catalogue id of a different product; leave out to keep the current one" },
              remove_product: { type: "boolean", description: "true only if the user explicitly asks to remove the product from the position" },
              status: { type: "string", description: "only if the user explicitly asks to change the status: calculated (= Perfectly Matched, the user confirms the match) | assumption_applied | supplier_quote_required | review_required | insufficient_information | non_priceable" },
              price_source: { type: "string", description: "where a unit price comes from, e.g. Quote Trox 12.10.2026" },
              note: { type: "string" },
            },
            required: ["lv_id"],
          },
        },
        parameter_changes: {
          type: "array",
          items: { type: "object", properties: { path: { type: "string" }, value: { type: "number" } }, required: ["path", "value"] },
        },
      },
      required: ["summary"],
    },
    run(a = {}) {
      const r = results();
      const p = ctx.state.project;
      const pos = r?.position_results || [];
      const catalog = r?.catalog || [];
      const changes = [], problems = [];
      for (const c of a.position_changes || []) {
        const row = pos.find((x) => x.lv_id === c.lv_id);
        if (!row) { problems.push(`${c.lv_id}: no such position`); continue; }
        const edit = {};
        const isNum = (v) => v !== null && v !== "" && v !== undefined && Number.isFinite(+v);
        // only real changes: values equal to the current ones (filled in by the model) are dropped
        if (isNum(c.quantity) && +c.quantity !== row.quantity) edit.quantity = +c.quantity;
        if (isNum(c.unit_price_chf) && +c.unit_price_chf !== row.net_unit_cost_chf) edit.unit_price_chf = +c.unit_price_chf;
        if (c.remove_product === true) {
          if (row.matched_product_id) edit.product_id = "";
        } else if (typeof c.product_id === "string" && c.product_id && c.product_id !== row.matched_product_id) {
          if (!catalog.some((x) => x.product_id === c.product_id)) problems.push(`${c.lv_id}: product ${c.product_id} is not in the catalogue`);
          else edit.product_id = c.product_id;
        }
        if (c.status === "out_of_scope") c.status = "non_priceable";            // merged into one option
        if (c.status === "perfectly_matched") c.status = "calculated";          // the same confirmed status
        // compare with what the position shows, not its raw status: "calculated" without a confirmed
        // match still shows as Assumption applied, so asking for Perfectly Matched must go through
        const pricedNow = row.status === "calculated" && (row.match_confidence ?? 0) >= 0.9;
        if (c.status && (c.status !== row.status || (c.status === "calculated" && !pricedNow))) {
          if (STATUS_WORDS[c.status]) edit.status = c.status;
          else problems.push(`${c.lv_id}: unknown status ${c.status}`);
        }
        // a price the user confirms through BIDBOT (new or the current one) settles the position: it becomes
        // Perfectly Matched (confirmed match, firm price in the totals), unless another status was asked for
        if (isNum(c.unit_price_chf) && !edit.status && !c.status && !pricedNow) edit.status = "calculated";
        if (c.price_source && "unit_price_chf" in edit) edit.price_source = String(c.price_source).slice(0, 120);
        if (c.note) edit.note = String(c.note).slice(0, 300);
        if (!Object.keys(edit).length) { problems.push(`${c.lv_id}: nothing to change`); continue; }
        changes.push({
          type: "position", lv_id: row.lv_id, page: row.source_page,
          label: row.description || row.description_de || row.lv_id,
          before: clean({ quantity: row.quantity, unit: row.unit, unit_price_chf: row.net_unit_cost_chf, product_id: row.matched_product_id, status: row.status, match_confidence: row.match_confidence }),
          edit,
        });
      }
      for (const c of a.parameter_changes || []) {
        const cur = getPath(p.parameters, c.path);
        if (typeof cur !== "number") { problems.push(`${c.path}: not an existing numeric parameter`); continue; }
        if (!Number.isFinite(+c.value)) { problems.push(`${c.path}: value is not a number`); continue; }
        if (+c.value === cur) continue;
        changes.push({ type: "parameter", path: c.path, before: cur, after: +c.value });
      }
      if (!changes.length) return { shown: false, problems: problems.length ? problems : ["no changes"] };
      addChangeCard({ summary: String(a.summary || ""), changes });
      return clean({ shown: true, problems,
        note: "Shown to the user with an Apply button. Nothing changes until they click it; then prices and totals update right away." });
    },
  },
  save_quote_details: {
    description: "Save what a supplier quote offers, after the user uploaded it: supplier, dates, conditions and each offered item with its net unit price and the tender positions (lv_id) it covers. Shows the user a summary card.",
    parameters: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        supplier: { type: "string" },
        quote_number: { type: "string" },
        quote_date: { type: "string", description: "YYYY-MM-DD if known" },
        valid_until: { type: "string", description: "YYYY-MM-DD if known" },
        delivery_time: { type: "string" },
        conditions: { type: "string", description: "discounts, payment terms, exclusions, in one or two sentences" },
        total_net_chf: { type: "number" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string" },
              unit_price_chf: { type: "number", description: "net price per unit after discounts, excl. VAT" },
              total_chf: { type: "number" },
              lv_ids: { type: "array", items: { type: "string" }, description: "tender positions this item prices" },
            },
            required: ["description"],
          },
        },
      },
      required: ["quote_id", "supplier", "items"],
    },
    async run(a = {}) {
      const pos = results()?.position_results || [];
      const known = new Set(pos.map((p) => p.lv_id));
      const unknown = [];
      const items = (a.items || []).slice(0, 200).map((it) => {
        const lv = (it.lv_ids || []).filter((id) => { if (known.has(id)) return true; unknown.push(id); return false; });
        return clean({ description: String(it.description || "").slice(0, 300), quantity: num0(it.quantity), unit: it.unit,
          unit_price_chf: num0(it.unit_price_chf), total_chf: num0(it.total_chf), lv_ids: lv });
      });
      const details = clean({ supplier: a.supplier, quote_number: a.quote_number, quote_date: a.quote_date, valid_until: a.valid_until,
        delivery_time: a.delivery_time, conditions: a.conditions, total_net_chf: num0(a.total_net_chf), items });
      const q = await ctx.store.getQuote(ctx.state.user.uid, chat.projectId, a.quote_id).catch(() => null);
      if (!q) return { saved: false, error: "unknown quote_id" };
      await ctx.store.updateQuote(ctx.state.user.uid, chat.projectId, a.quote_id, { details });
      addQuoteCard({ quote_id: a.quote_id, filename: q.filename, storagePath: q.storagePath, ...details });
      return clean({ saved: true, items: items.length, matched_positions: [...new Set(items.flatMap((i) => i.lv_ids || []))],
        unknown_lv_ids: unknown.length ? [...new Set(unknown)] : undefined });
    },
  },
  list_quotes: {
    description: "Supplier quotes uploaded for this project: supplier, date, validity, number of items, total and which positions they price.",
    parameters: { type: "object", properties: {} },
    async run() {
      const list = await ctx.store.listQuotes(ctx.state.user.uid, chat.projectId);
      return { quotes: list.map((q) => clean({ quote_id: q.id, file: q.filename, uploaded: q.uploadedAt?.slice(0, 10),
        supplier: q.details?.supplier, quote_date: q.details?.quote_date, valid_until: q.details?.valid_until,
        delivery_time: q.details?.delivery_time, total_net_chf: q.details?.total_net_chf, items: q.details?.items?.length,
        positions: [...new Set((q.details?.items || []).flatMap((i) => i.lv_ids || []))], read: !!q.details })) };
    },
  },
  get_quote: {
    description: "One uploaded quote: its saved details (items, prices, conditions) and, if not read yet, its text.",
    parameters: { type: "object", properties: { quote_id: { type: "string" } }, required: ["quote_id"] },
    async run({ quote_id } = {}) {
      const q = await ctx.store.getQuote(ctx.state.user.uid, chat.projectId, quote_id);
      if (!q) return { found: false };
      return clean({ quote_id: q.id, file: q.filename, details: q.details, text: q.details ? undefined : q.text?.slice(0, 30_000) });
    },
  },
  show_email_draft: {
    description: "Show an email draft to the user as a card with Copy and Open-in-email buttons. Use one call per supplier. The app never sends emails itself.",
    parameters: {
      type: "object",
      properties: {
        supplier: { type: "string", description: "supplier or product group, e.g. Trox Hesco (silencers)" },
        to: { type: "string", description: "email address if the user gave one, else empty" },
        subject: { type: "string" },
        body: { type: "string", description: "plain text email body" },
        lv_ids: { type: "array", items: { type: "string" } },
      },
      required: ["supplier", "subject", "body"],
    },
    run(a = {}) {
      addEmailCard(a);
      return { shown: true };
    },
  },
};

function systemText() {
  const p = ctx.state.project;
  const changed = changesSinceLatest();
  return `Your name is BIDBOT, the assistant in BIDWISE. You help the estimator prepare the bid for this tender (ventilation / HVAC, Swiss bill of quantities) in the BIDWISE app.
Project: "${p?.name || "–"}". ${p?.currentVersion ? `Results shown: version ${p.currentVersion}${ctx.state.latest?.results?.edited_in_app ? " (includes edits made in the app)" : ""}.` : "Not computed yet."}${changed?.length ? ` Saved changes not yet included in the results: ${changed.join(", ")} (they need a Re-compute).` : ""} Today: ${new Date().toISOString().slice(0, 10)}.

Write for a busy person who is not a data expert:
- Start with one plain sentence that answers the question. Then at most 5 short points, most money first. Keep the whole answer under about 150 words unless the user asks for detail.
- Use everyday words. Never show internal codes or field names (no "supplier_quote_required", "price_basis", "lv_id", "insufficient_information"). Say instead: "needs a supplier price", "estimated price", "quantity missing in the tender", "priced from the catalogue".
- Avoid abbreviations or explain them once: say "price request" (not RFQ), "ventilation unit" (not AHU), "air-flow controller" (not VAV/CAV).
- Name a position by what it is, then the reference in brackets, e.g. "the large ventilation unit for the classrooms (position LV0149, page 147)".
- Round money: "about CHF 198'000"; give exact figures only when asked.
- Use simple markdown: **bold** for the key word of a point, numbered steps for actions. No tables, no horizontal lines, no headings.
- End with one short question offering the obvious next step (e.g. "Shall I write the price request to Trox?").

How to work:
- Use the tools to read the estimate; call get_overview first. Never invent numbers, positions or products.
- Position counts: use the app's categories from get_overview (by_category, priceable_positions). Priceable positions = every position of the bill (priceable_positions), the non-priceable ones included; "Non-priceable" is one category that includes everything out of scope, never count out of scope separately.
- Bid scenarios: recommend the one with the highest win probability (the app's current rule until there is more bid history; get_overview gives it as bid_range.recommended). Mention its margin and expected contribution as information, not as the reason.
- Firm prices (catalogue / supplier package) make the totals and the bids; estimated prices are side estimates with a range; some positions are not priced.
- If the user asks to change something (a quantity, a price from a supplier quote, a product, a status, a parameter such as overhead or margin), call propose_changes. Look the positions up first. Only change what the user asked for: send only the fields being changed (leave every other field out; never send product_id to keep a product, use remove_product only if the user asks to remove it); do not add a status change unless the user explicitly asks to change a position's status (classifying positions is the job of Compute). When the user confirms a price (a new one, e.g. from a supplier quote, or the current one), send unit_price_chf: the app then marks that position as Perfectly Matched by itself, so no status is needed. Then tell the user in one sentence to check the card and click "Apply"; prices and totals then update right away. Never claim a change is done before the user applied it.
- Uploaded supplier quotes: when the user uploads one, read its text, call save_quote_details once with every offered item (net unit price after discounts, excl. VAT) linked to the tender positions it prices (look positions up with find_positions; only link when the item clearly matches size and type). Then say in plain words what the quote covers, what it costs compared with our current price for those positions, and anything to watch (validity, delivery time, exclusions). Then offer to use the prices and, if the user agrees or asked for it, call propose_changes with unit_price_chf and price_source "Quote <supplier> <date>".
- Comparing quotes: use list_quotes and get_quote; compare per position on net unit price, whether everything required is included, delivery time, validity and conditions; recommend one in a sentence and say why.
- Supplier price requests: group the positions per supplier, then call show_email_draft once per supplier. Write the email in German (Swiss style: "ss" instead of "ß", "Freundliche Grüsse"), formal and short, listing each position with tender page, description, size/type, quantity and unit, asking for net prices, delivery time and offer validity, and mentioning the project name. Use placeholders like [Name] for unknown contact details.`;
}

/** What changed since the shown version: ["tender", "parameters", …]; null if never computed. */
function changesSinceLatest() {
  const p = ctx.state.project, v = ctx.state.latest;
  if (!p || !v?.files) return null;
  const out = KINDS.filter((k) => p.workingFiles?.[k]?.sha256 !== v.files[k]?.sha256);
  if (paramsKey(p.parameters) !== paramsKey(v.parameters)) out.push("parameters / position edits");
  return out;
}

// ---- Gemini over the relay -------------------------------------------------------------------

class QuotaError extends Error {
  constructor(retryAt) { super("quota_exhausted"); this.retryAt = retryAt ? new Date(retryAt) : null; }
}

async function callRelay(contents, { noTools = false } = {}) {
  const body = {
    systemInstruction: { parts: [{ text: systemText() }] },
    contents,
    tools: [{ functionDeclarations: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters })) }],
    generationConfig: { temperature: 0.4 },
  };
  if (noTools) body.toolConfig = { functionCallingConfig: { mode: "NONE" } };     // text answer only
  const token = await ctx.store.idToken();
  let res;
  try {
    res = await fetch(`${AI_RELAY_URL.replace(/\/+$/, "")}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The AI service is not reachable right now. Please try again in a moment.");
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 429 || data?.error === "quota_exhausted") throw new QuotaError(data?.retry_at);
  if (res.status === 401) throw new Error("Your sign-in has expired. Please sign out and in again.");
  if (!res.ok) throw new Error(`The AI service returned an error${data?.message ? `: ${data.message}` : ` (${res.status})`}.`);
  return data;
}

/** Drop the oldest turns while the conversation is too large, keeping it starting with a user text. */
function trim(contents) {
  while (JSON.stringify(contents).length > MAX_REQUEST_CHARS && contents.length > 2) {
    contents.shift();
    while (contents.length && !(contents[0].role === "user" && contents[0].parts?.some((p) => p.text))) contents.shift();
  }
}

const quotaText = (at) => {
  const ok = at && !isNaN(at) && at > Date.now();
  const when = !ok ? "later" : at - Date.now() < 3 * 60_000 ? "in a minute or two"
    : `after ${at.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}${at.toDateString() !== new Date().toDateString() ? ` on ${at.toLocaleDateString("de-CH")}` : ""}`;
  return `**BIDWISE is a prototype** and BIDBOT runs on a free plan. The free AI credits are used up for the time being, so I can't answer right now. Please try again ${when}. Everything else in BIDWISE keeps working as usual.`;
};

async function ask(text, { display = null, attachment = null } = {}) {
  if (chat.busy || !text.trim()) return;
  if (!AI_RELAY_URL) return addMessage("assistant", "BIDBOT is not connected yet (AI_RELAY_URL in js/ai.js).", "notice");
  showLog();
  chat.busy = true;
  setBusy(true);
  addMessage("user", display || text, "", attachment ? { attachment } : null);
  const question = { role: "user", parts: [{ text }] };
  chat.contents.push(question);
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      trim(chat.contents);
      let data = await callRelay(chat.contents), cand = data?.candidates?.[0];
      // Gemini sometimes produces a broken tool call (long input, nested arguments). Try again, telling
      // it so; if that fails too, ask once more without tools, so there is at least a plain answer.
      for (let retry = 1; retry <= 2 && !cand?.content?.parts?.length && !data?.promptFeedback?.blockReason
        && /MALFORMED_FUNCTION_CALL|^$/.test(cand?.finishReason || ""); retry++) {
        setThinking(["retrying"]);
        const last = chat.contents.at(-1);
        const nudge = { text: retry === 1
          ? "(Your last tool call was not valid JSON. Call the tool again with simple, valid arguments: plain numbers, short strings.)"
          : "(Answer in plain text now, without calling any tools.)" };
        const turn = { ...last, parts: [...last.parts, nudge] };
        data = await callRelay([...chat.contents.slice(0, -1), turn], { noTools: retry === 2 });
        cand = data?.candidates?.[0];
      }
      if (!cand?.content?.parts?.length) {
        const why = data?.promptFeedback?.blockReason || cand?.finishReason || "no answer";
        throw new Error(why === "MALFORMED_FUNCTION_CALL"
          ? "The AI could not process this request right now. Please try again, or ask in a shorter way."
          : `The AI returned no answer (${why}). Please rephrase the question.`);
      }
      chat.contents.push({ role: "model", parts: cand.content.parts });
      const calls = cand.content.parts.filter((p) => p.functionCall);
      const said = cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      if (said) addMessage("assistant", said);
      if (!calls.length) break;
      if (round === MAX_TOOL_ROUNDS) { addMessage("assistant", "I stopped after several look-ups. Please ask a more specific question.", "notice"); break; }
      setThinking(calls.map((c) => c.functionCall.name));
      const responses = await Promise.all(calls.map(async ({ functionCall: { name, args } }) => {
        let response;
        try { response = TOOLS[name] ? await TOOLS[name].run(args || {}) : { error: `unknown tool ${name}` }; }
        catch (e) { response = { error: String(e.message || e) }; }
        const s = JSON.stringify(response);
        if (s.length > 40_000) response = { truncated: true, data: s.slice(0, 40_000) };
        return { functionResponse: { name, response } };
      }));
      chat.contents.push({ role: "user", parts: responses });
    }
  } catch (e) {
    const i = chat.contents.indexOf(question);   // forget the unanswered question and its look-ups
    if (i >= 0) chat.contents.length = i;
    if (e instanceof QuotaError) addMessage("assistant", quotaText(e.retryAt), "quota");
    else addMessage("assistant", e.message || String(e), "error");
  } finally {
    chat.busy = false;
    setBusy(false);
    setThinking(null);
    persist();
  }
}

// ---- conversation history (Firestore: users/{uid}/projects/{pid}/chats) ----------------------

const MAX_SAVED_MESSAGES = 300;
const SKIP_IN_CONTEXT = new Set(["intro", "notice", "error", "quota"]);
const newId = () => (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 16);

function freshChat() {
  Object.assign(chat, { id: newId(), title: "", createdAt: null, messages: [], contents: [] });
}

/** Save the current conversation (after every answer). Errors only go to the console. */
async function persist() {
  if (!chat.messages.some((m) => m.role === "user") || !ctx.state.user || !chat.projectId) return;
  let messages = chat.messages.slice(-MAX_SAVED_MESSAGES);
  while (JSON.stringify(messages).length > 800_000 && messages.length > 2) messages = messages.slice(2);
  chat.title ||= chat.messages.find((m) => m.role === "user").text.slice(0, 80);
  chat.createdAt ||= new Date().toISOString();
  try {
    await ctx.store.saveChat(ctx.state.user, chat.projectId, { id: chat.id, title: chat.title, createdAt: chat.createdAt,
      version: ctx.state.project?.currentVersion || 0, messages });
  } catch (e) { console.warn("Could not save the conversation", e); }
}

/** Rebuild the model's context from saved messages (texts and email drafts; look-ups are redone when needed). */
function contentsFrom(messages) {
  const turns = [];
  for (const m of messages) {
    if (SKIP_IN_CONTEXT.has(m.kind)) continue;
    const role = m.role === "user" ? "user" : "model";
    const text = m.attachment
      ? `[I uploaded the supplier quote "${m.attachment.name}" (quote_id ${m.attachment.quote_id}); use get_quote to read it.]`
      : m.kind === "quote"
        ? `[Quote details saved: ${m.quote.supplier || "supplier"}, ${(m.quote.items || []).length} items, quote_id ${m.quote.quote_id}]`
        : m.kind === "email"
      ? `[Email draft shown to the user, ${m.email.supplier}] Subject: ${m.email.subject}\n${String(m.email.body || "").slice(0, 3000)}`
      : m.kind === "changes"
        ? `[Proposed changes, ${m.state || "pending"}] ${m.summary || ""} ${JSON.stringify(m.changes.map((c) => (c.type === "parameter" ? { path: c.path, value: c.after } : { lv_id: c.lv_id, ...c.edit })))}`
        : m.text;
    const last = turns.at(-1);
    if (last?.role === role) last.parts[0].text += `\n\n${text}`;
    else turns.push({ role, parts: [{ text }] });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  while (turns.length && turns.at(-1).role === "user") turns.pop();   // unanswered question
  return turns;
}

async function openChat(id) {
  const saved = await ctx.store.getChat(ctx.state.user.uid, chat.projectId, id).catch(() => null);
  if (!saved) return renderHistory("This conversation could not be loaded.");
  Object.assign(chat, { id: saved.id, title: saved.title, createdAt: saved.createdAt, messages: saved.messages || [] });
  chat.contents = contentsFrom(chat.messages);
  $("aiLog").innerHTML = "";
  for (const m of chat.messages) render(m);
  render({ role: "assistant", kind: "intro", text: `Earlier conversation from ${new Date(saved.updatedAt || saved.createdAt).toLocaleString()}. You can continue it.` });
  showLog();
}

async function renderHistory(note = "") {
  const box = $("aiHistory");
  box.innerHTML = `<p class="ai-hist-note">Loading…</p>`;
  showHistory();
  let list = [];
  try { list = await ctx.store.listChats(ctx.state.user.uid, chat.projectId); }
  catch (e) { note = "The conversation history could not be loaded."; }
  box.innerHTML = `
    <div class="ai-hist-top"><b>Conversations in this project</b><button class="btn navy small" data-new>+ New conversation</button></div>
    ${note ? `<p class="ai-hist-note">${esc(note)}</p>` : ""}
    ${list.length ? list.map((c) => `<div class="ai-hist-item${c.id === chat.id ? " on" : ""}" data-open="${esc(c.id)}">
        <div><b>${esc(c.title || "Conversation")}</b><small>${new Date(c.updatedAt || c.createdAt).toLocaleString()}${c.version ? ` · version ${c.version}` : ""} · ${c.count} messages${c.id === chat.id ? " · open" : ""}</small></div>
        <button title="Delete this conversation" data-del="${esc(c.id)}">🗑</button>
      </div>`).join("") : `<p class="ai-hist-note">No saved conversations yet. They are saved automatically after each answer.</p>`}`;
}

function showHistory() { $("aiLog").hidden = true; $("aiHistory").hidden = false; $("aiHist").classList.add("on"); }
function showLog() { $("aiLog").hidden = false; $("aiHistory").hidden = true; $("aiHist").classList.remove("on"); }

// ---- panel -----------------------------------------------------------------------------------

/** Minimal, safe markdown: escape first, then bold/italic/code; numbered steps keep counting and
 *  any bullets under a step stay inside that step; headings become bold lines; rules are dropped. */
function md(text) {
  const lines = esc(text).split(/\r?\n/);
  let html = "", list = null, sub = false, steps = 0;
  const closeSub = () => { if (sub) { html += "</ul>"; sub = false; } };
  const closeItem = () => { if (list === "ol") { closeSub(); html += "</li>"; } };
  const close = () => {
    if (list === "ol") { closeItem(); html += "</ol>"; }
    else if (list === "ul") html += "</ul>";
    list = null;
  };
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1<i>$2</i>").replace(/`([^`]+)`/g, "<code>$1</code>");
  for (const line of lines) {
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue;                       // --- rules
    const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const b = /^\s*[-*•]\s+(.*)$/.exec(line);
    const h = /^\s*#{1,4}\s+(.*)$/.exec(line);
    if (n) {
      if (list === "ol") closeItem();
      else {
        // a "1." after text that followed earlier steps continues the count (models often restart at 1)
        const start = +n[1] === 1 && steps ? steps + 1 : +n[1];
        close(); html += start > 1 ? `<ol start="${start}">` : "<ol>"; list = "ol";
        steps = start - 1;
      }
      steps++;
      html += `<li>${inline(n[2])}`;
    } else if (b && list === "ol") {                                      // detail under a step
      if (!sub) { html += "<ul>"; sub = true; }
      html += `<li>${inline(b[1])}</li>`;
    } else if (b) {
      if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(b[1])}</li>`;
    } else if (!line.trim()) {
      if (list === "ul") close();                                        // blank line ends a bullet list
    } else if (list === "ol" && /^\s{2,}/.test(line)) {
      html += `<br>${inline(line.trim())}`;                               // continuation of a step
    } else {
      close();
      html += h ? `<p class="ai-h">${inline(h[1])}</p>` : `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html;
}

/** Show one message (text bubble or email card). */
function render(m) {
  const el = document.createElement("div");
  if (m.kind === "email") {
    const { supplier = "", to = "", subject = "", body = "", lv_ids = [] } = m.email || {};
    const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    el.className = "ai-mail";
    el.innerHTML = `<div class="ai-mail-head"><b>✉ ${esc(supplier)}</b>${lv_ids.length ? `<small>${esc(lv_ids.join(", "))}</small>` : ""}</div>
      <div class="ai-mail-sub"><span>Subject:</span> ${esc(subject)}</div>
      <pre>${esc(body)}</pre>
      <div class="ai-mail-actions">
        <button class="btn ghost small" data-copy>Copy</button>
        <a class="btn navy small" href="${esc(mailto)}" ${mailto.length > 1900 ? 'title="Long email: if it opens truncated, use Copy"' : ""}>Open in email</a>
      </div>`;
    el.querySelector("[data-copy]").onclick = async (e) => {
      try { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); e.target.textContent = "Copied"; }
      catch { e.target.textContent = "Copy failed"; }
      setTimeout(() => (e.target.textContent = "Copy"), 1500);
    };
  } else if (m.kind === "quote") {
    renderQuoteCard(el, m.quote);
  } else if (m.kind === "changes") {
    renderChangeCard(el, m);
  } else {
    el.className = `ai-msg ${m.role} ${m.kind || ""}`;
    el.innerHTML = m.role === "user"
      ? `${m.attachment ? `<span class="ai-file">📄 ${esc(m.attachment.name)}</span>` : ""}<p>${esc(m.text)}</p>` : md(m.text);
  }
  $("aiLog").appendChild(el);
  $("aiLog").scrollTop = $("aiLog").scrollHeight;
}

function addMessage(role, text, kind = "", extra = null) {
  const m = { role, text, ...(kind ? { kind } : {}), ...(extra || {}), at: new Date().toISOString() };
  if (kind !== "intro") chat.messages.push(m);
  render(m);
}

function addEmailCard(email) {
  const m = { role: "assistant", kind: "email", email: { supplier: email.supplier || "", to: email.to || "", subject: email.subject || "",
    body: email.body || "", lv_ids: Array.isArray(email.lv_ids) ? email.lv_ids : [] }, at: new Date().toISOString() };
  chat.messages.push(m);
  render(m);
}

// ---- supplier quotes -----------------------------------------------------------------------------

function renderQuoteCard(el, q) {
  el.className = "ai-quote";
  const items = q.items || [];
  el.innerHTML = `<div class="ai-change-head"><b>📄 ${esc(q.supplier || q.filename || "Quote")}</b>
      <small>${[q.quote_date && `dated ${esc(q.quote_date)}`, q.valid_until && `valid until ${esc(q.valid_until)}`].filter(Boolean).join(" · ")}</small></div>
    ${q.delivery_time || q.conditions ? `<p>${esc([q.delivery_time && `Delivery: ${q.delivery_time}`, q.conditions].filter(Boolean).join(" · "))}</p>` : ""}
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th>Positions</th></tr></thead><tbody>
      ${items.slice(0, 40).map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${i.quantity ?? "–"} ${esc(i.unit || "")}</td>
        <td class="num">${i.unit_price_chf != null ? chf(i.unit_price_chf) : "–"}</td><td>${esc((i.lv_ids || []).join(", ") || "–")}</td></tr>`).join("")}
    </tbody></table>
    ${items.length > 40 ? `<p><small>+ ${items.length - 40} more items</small></p>` : ""}
    <div class="ai-change-actions">${q.total_net_chf != null ? `<span>Total net CHF ${chf(q.total_net_chf)}</span>` : "<span></span>"}
      ${q.storagePath ? `<button class="btn ghost small" data-open>Open PDF</button>` : ""}</div>`;
  el.querySelector("[data-open]")?.addEventListener("click", async () => {
    const win = window.open("", "_blank");
    try { const url = await ctx.store.fileUrl(q.storagePath); if (win) win.location.href = url; else window.open(url, "_blank", "noopener"); }
    catch (e) { win?.close(); addMessage("assistant", `The quote could not be opened: ${e.message || e}`, "error"); }
  });
}

function addQuoteCard(q) {
  const m = { role: "assistant", kind: "quote", quote: q, at: new Date().toISOString() };
  chat.messages.push(m);
  render(m);
}

/**
 * Supplier quote PDF: 📎 reads the file and shows it as a chip above the message box; nothing is
 * sent yet. Send uploads it with the project and sends it together with the typed message (or a
 * default question when the box is empty).
 */
let pendingQuote = null;            // {file, text, pages}

async function attachQuote(file) {
  if (!file || chat.busy) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return addMessage("assistant", "Please upload the quote as a PDF file.", "error");
  if (file.size > 25 * 1024 * 1024) return addMessage("assistant", "That file is larger than 25 MB. Please upload a smaller PDF.", "error");
  if (!ctx.state.project) return;
  setBusy(true);
  setThinking(["reading_quote"]);
  try {
    const pages = await readPdfLines(await file.arrayBuffer());
    const text = pages.map((pg, i) => `--- page ${i + 1} ---\n${pg.lines.map((l) => l.text).join("\n")}`).join("\n");
    if (text.replace(/--- page \d+ ---|\s/g, "").length < 80) {
      return addMessage("assistant", `I can't read any text in "${file.name}". It is probably a scanned image. Please upload a PDF with selectable text (e.g. the supplier's original PDF).`, "error");
    }
    pendingQuote = { file, text, pages: pages.length };
    renderAttachment();
    $("aiInput").placeholder = "Add a question about this quote, or just press Send…";
    $("aiInput").focus();
  } catch (e) {
    addMessage("assistant", `The quote could not be read: ${e.message || e}`, "error");
  } finally {
    setBusy(false);
    setThinking(null);
  }
}

function renderAttachment() {
  const el = $("aiAttached");
  el.hidden = !pendingQuote;
  el.innerHTML = pendingQuote
    ? `<span class="ai-chip" title="Sent with your next message">📄 ${esc(pendingQuote.file.name)} <small>· ${pendingQuote.pages} page${pendingQuote.pages === 1 ? "" : "s"}</small>
        <button type="button" data-drop title="Remove the attachment" aria-label="Remove the attachment">×</button></span>` : "";
}
function dropAttachment() {
  pendingQuote = null;
  renderAttachment();
  $("aiInput").placeholder = "Ask about this tender, or upload a supplier quote…";
}

/** Send the message box (and the attached quote, if any). */
async function send(typed) {
  const text = String(typed || "").trim();
  if (chat.busy || (!text && !pendingQuote)) return;
  if (!pendingQuote) return ask(text);
  const att = pendingQuote;
  setBusy(true);
  setThinking(["reading_quote"]);
  let quote;
  try {
    quote = await ctx.store.addQuote(ctx.state.user, ctx.state.project.id, att.file, att.text, att.pages);
  } catch (e) {
    setBusy(false); setThinking(null);
    return addMessage("assistant", `The quote could not be uploaded: ${e.message || e}`, "error");
  }
  setBusy(false);
  setThinking(null);
  dropAttachment();
  const header = `I attached a supplier quote "${quote.filename}" (quote_id ${quote.id}, ${quote.pages} pages). First save its details with save_quote_details.`;
  const request = text || "Then tell me what it covers and how its prices compare with ours.";
  await ask(`${header}\n${text ? `Then answer my message: ${text}` : request}\n\nQuote text:\n${quote.text}`,
    { display: text || `Please review this quote.`, attachment: { quote_id: quote.id, name: quote.filename } });
}

// ---- proposed changes ---------------------------------------------------------------------------

const PARAM_LABELS = {
  "commercial.overhead_pct": "Overhead %", "commercial.target_margin_pct": "Target margin %", "commercial.round_to_chf": "Round bids to CHF",
  "allowances.material_waste_pct": "Material waste %", "allowances.small_material_pct": "Small material %",
  "allowances.transport_equipment_pct": "Transport & equipment %", "allowances.supplier_package_contingency_pct": "Supplier package contingency %",
};
const paramLabel = (path) => PARAM_LABELS[path]
  || path.split(".").slice(-1)[0].replace(/_(pct|chf|hours|chf_per_h)$/, (m, u) => ({ pct: " %", chf: " (CHF)", hours: " (hours)", chf_per_h: " (CHF/h)" }[u]))
    .replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const fmtNum = (v) => (typeof v === "number" ? v.toLocaleString("de-CH", { maximumFractionDigits: 4 }) : esc(v ?? "–"));

function changeLines(c) {
  if (c.type === "parameter") return `<li><b>${esc(paramLabel(c.path))}</b>: ${fmtNum(c.before)} → <b>${fmtNum(c.after)}</b></li>`;
  const e = c.edit, b = c.before, parts = [];
  if ("quantity" in e) parts.push(`quantity ${fmtNum(b.quantity)} → <b>${fmtNum(e.quantity)}</b> ${esc(b.unit || "")}`);
  if ("unit_price_chf" in e) parts.push(`unit price ${b.unit_price_chf != null ? `CHF ${chf(b.unit_price_chf)}` : "none"} → <b>CHF ${chf(e.unit_price_chf)}</b>${e.price_source ? ` <small>(${esc(e.price_source)})</small>` : ""}`);
  if ("product_id" in e) parts.push(`product ${esc(b.product_id || "none")} → <b>${esc(e.product_id || "none")}</b>`);
  // the status as shown in the app (category), e.g. "Assumption applied → Perfectly Matched"
  const shown = (st, conf) => CATEGORY[categorize({ status: st, match_confidence: conf })]?.label || st || "–";
  if ("status" in e) parts.push(e.status === "calculated"
    ? `<b class="ai-change-ok">✓ confirmed: ${esc(shown(b.status, b.match_confidence))} → Perfectly Matched</b>`
    : `<b class="ai-change-status">status ${esc(shown(b.status, b.match_confidence))} → ${esc(shown(e.status, b.match_confidence))}</b>`);
  if (e.note) parts.push(`note: “${esc(e.note)}”`);
  return `<li><b>${esc(c.label)}</b> <small>(${esc(c.lv_id)}, page ${esc(c.page ?? "–")})</small><br>${parts.join(" · ")}</li>`;
}

function renderChangeCard(el, m) {
  el.className = `ai-change ${m.state || "pending"}`;
  const n = m.changes.length;
  el.innerHTML = `<div class="ai-change-head"><b>✎ Proposed change${n > 1 ? "s" : ""}</b>
      <small>${m.state === "applied" ? "applied" : m.state === "dismissed" ? "dismissed" : "not applied yet"}</small></div>
    ${m.summary ? `<p>${esc(m.summary)}</p>` : ""}
    <ul>${m.changes.map(changeLines).join("")}</ul>
    <div class="ai-change-actions">${m.state === "applied"
      ? `<span>${esc(m.result || "Saved.")}</span>`
      : m.state === "dismissed" ? "<span>Not applied.</span>"
      : `<button class="btn ghost small" data-dismiss>Dismiss</button><button class="btn navy small" data-apply>Apply change${n > 1 ? "s" : ""}</button>`}</div>
    <p class="ai-change-err" hidden></p>`;
  el.querySelector("[data-apply]")?.addEventListener("click", () => applyChanges(m, el));
  el.querySelector("[data-dismiss]")?.addEventListener("click", () => { m.state = "dismissed"; renderChangeCard(el, m); persist(); });
}

async function applyChanges(m, el) {
  const err = el.querySelector(".ai-change-err");
  const buttons = el.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  err.hidden = false;
  err.classList.add("working");
  err.textContent = "Saving the changes and updating the prices…";
  try {
    const current = ctx.state.project.parameters?.position_overrides || {};
    const positions = {};
    for (const c of m.changes.filter((x) => x.type === "position")) {
      const { updatedAt, updatedBy, ...keep } = positions[c.lv_id] || current[c.lv_id] || {};
      positions[c.lv_id] = { ...keep, ...c.edit };
    }
    const params = m.changes.filter((c) => c.type === "parameter").map((c) => ({ path: c.path, value: c.after }));
    const r = await Promise.race([
      ctx.saveEdits({ positions, params }, m.summary || "Changes from the assistant"),
      new Promise((_, no) => setTimeout(() => no(new Error("Saving took too long. Please check your connection and try again.")), 90_000)),
    ]);
    m.state = "applied";
    m.appliedAt = new Date().toISOString();
    m.result = r.savedOnly ? `Saved. Applied at the next ${ctx.state.project?.currentVersion ? "Re-compute" : "Compute"} (${r.reason}).`
      : `Saved: prices and totals updated (${r.created ? `new version ${r.version}` : `version ${r.version} updated`}).`;
    renderChangeCard(el, m);
    updateIndicator();
    persist();
  } catch (e) {
    console.error("Applying the changes failed", e);
    buttons.forEach((b) => (b.disabled = false));
    err.classList.remove("working");
    err.textContent = `Not saved: ${e.message || e}`;
    err.hidden = false;
  }
}

function addChangeCard({ summary, changes }) {
  const m = { role: "assistant", kind: "changes", summary, changes, state: "pending", at: new Date().toISOString() };
  chat.messages.push(m);
  render(m);
}

const TOOL_TEXT = { get_overview: "Reading the estimate…", find_positions: "Searching positions…", get_position: "Checking a position…",
  list_catalog: "Checking the catalogue…", show_email_draft: "Writing email drafts…", propose_changes: "Preparing the changes…", retrying: "Trying again…",
  reading_quote: "Reading the quote…", save_quote_details: "Saving the quote…", list_quotes: "Looking at the quotes…", get_quote: "Reading a quote…" };
function setThinking(names) {
  $("aiThinking").hidden = !names && !chat.busy;
  $("aiThinking").textContent = names ? TOOL_TEXT[names[0]] || "Thinking…" : "Thinking…";
}
function setBusy(b) {
  for (const id of ["aiSend", "aiInput", "aiHist", "aiClear", "aiAttach"]) $(id).disabled = b;
  $("aiThinking").hidden = !b;
  if (!b) $("aiInput").focus();
}

function startConversation() {
  freshChat();
  if (pendingQuote) dropAttachment();
  $("aiLog").innerHTML = "";
  showLog();
  render({ role: "assistant", kind: "intro", text: results()
    ? "Hi! Ask me about this estimate: what to do next, which prices are uncertain, or to write a price request to a supplier. Upload a supplier quote with 📎 and I'll read it and compare it. I can also change quantities, prices or settings for you; you confirm each change. Earlier chats are under **History**."
    : "Hi! Once this project has been computed I can explain the estimate, suggest next steps and write price requests to suppliers. Earlier chats are under **History**." });
}

function resetIfProjectChanged() {
  const pid = ctx.state.project?.id || null;
  if (pid === chat.projectId) return;
  chat.projectId = pid;
  startConversation();
}

/** Header line: which project and version the assistant is working on. */
function updateIndicator() {
  const el = $("aiContext");
  if (!el) return;
  const p = ctx.state.project;
  const changed = changesSinceLatest();
  el.innerHTML = !p ? "No project open"
    : `${esc(p.name)} · ${p.currentVersion ? `version ${p.currentVersion}${ctx.state.latest?.results?.edited_in_app ? " (edited)" : ""}` : "not computed yet"}${changed?.length
      ? ' · <span class="ai-stale" title="Saved changes are not in these results yet">changes not computed</span>' : ""}`;
}

function open() {
  resetIfProjectChanged();
  updateIndicator();
  document.documentElement.classList.add("ai-open");
  document.body.classList.add("ai-open");
  $("aiPanel").hidden = false;
  $("aiInput").focus();
}
function close() {
  document.documentElement.classList.remove("ai-open");
  document.body.classList.remove("ai-open");
  $("aiPanel").hidden = true;
}

const ROBOT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 3.6v2.1"/><circle cx="12" cy="2.6" r="1.1" fill="currentColor" stroke="none"/>
  <rect x="4.5" y="5.7" width="15" height="11.6" rx="3.4"/>
  <circle cx="9.3" cy="10.8" r="1.45" fill="currentColor" stroke="none"/><circle cx="14.7" cy="10.8" r="1.45" fill="currentColor" stroke="none"/>
  <path d="M9.6 14.2h4.8"/><path d="M2.6 9.8v3.6M21.4 9.8v3.6"/><path d="M8.6 17.3v2.6h6.8v-2.6"/></svg>`;

export function initAssistant(context) {
  ctx = context;
  if (!AI_RELAY_URL) return;                     // not connected: no button
  document.body.insertAdjacentHTML("beforeend", `
    <button id="aiFab" class="ai-fab" title="Ask BIDBOT, the BIDWISE assistant">
      ${ROBOT_ICON}
      <span>BIDBOT</span>
    </button>
    <aside id="aiPanel" class="ai-panel" hidden aria-label="BIDBOT assistant">
      <header>
        <span class="ai-avatar">${ROBOT_ICON}</span>
        <div><b>BIDBOT</b><small id="aiContext"></small></div>
        <button id="aiHist" class="ai-hbtn" title="Earlier conversations">History</button>
        <button id="aiClear" title="New conversation">↺</button>
        <button id="aiClose" title="Close">×</button>
      </header>
      <div id="aiLog" class="ai-log"></div>
      <div id="aiHistory" class="ai-history" hidden></div>
      <div id="aiThinking" class="ai-thinking" hidden>Thinking…</div>
      <div class="ai-quick">${QUICK.map((q) => `<button data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      <div id="aiAttached" class="ai-attached" hidden></div>
      <form id="aiForm" class="ai-form">
        <button type="button" id="aiAttach" class="ai-attach" title="Upload a supplier quote (PDF)">📎</button>
        <input type="file" id="aiFile" accept="application/pdf,.pdf" hidden>
        <textarea id="aiInput" rows="2" placeholder="Ask about this tender, or upload a supplier quote…"></textarea>
        <button id="aiSend" class="btn navy" type="submit">Send</button>
      </form>
    </aside>`);
  $("aiFab").onclick = () => ($("aiPanel").hidden ? open() : close());
  $("aiClose").onclick = close;
  $("aiClear").onclick = startConversation;
  $("aiHist").onclick = () => ($("aiHistory").hidden ? renderHistory() : showLog());
  $("aiHistory").onclick = async (e) => {
    if (e.target.closest("[data-new]")) return startConversation();
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      if (!confirm("Delete this conversation?")) return;
      await ctx.store.deleteChat(ctx.state.user.uid, chat.projectId, del.dataset.del).catch(() => {});
      if (del.dataset.del === chat.id) freshChat();
      return renderHistory();
    }
    const item = e.target.closest("[data-open]");
    if (item) openChat(item.dataset.open);
  };
  $("aiPanel").querySelector(".ai-quick").onclick = (e) => { const q = e.target.closest("[data-q]"); if (q) send(q.dataset.q); };
  $("aiAttach").onclick = () => { $("aiFile").value = ""; $("aiFile").click(); };
  $("aiFile").onchange = (e) => attachQuote(e.target.files[0]);
  $("aiAttached").onclick = (e) => { if (e.target.closest("[data-drop]")) dropAttachment(); };
  $("aiForm").onsubmit = (e) => { e.preventDefault(); const t = $("aiInput").value; $("aiInput").value = ""; send(t); };
  $("aiInput").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("aiForm").requestSubmit(); } };
}

/** Called after a project is opened or recomputed, so the conversation matches the data. */
export function assistantProjectChanged() {
  if (!AI_RELAY_URL || !$("aiPanel")) return;
  updateIndicator();
  if (!$("aiPanel").hidden) resetIfProjectChanged();
}
