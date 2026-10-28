import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config, Env } from "./config.js";
import { codeCompare, codeEq, normCode, type HcssClient } from "./hcss.js";
import { redactActivity, redactBiditem, redactEstimate, redactResource } from "./redact.js";
import { costBreakdown, toCsv, COLUMNS, percentAdj, percentField } from "./breakdown.js";
import {
  adjustedLines, applyMaterialAdjustments, capWarnings, isZeroRate, materialReconciliation,
  type Line, type Rec as FactorRec,
} from "./factor.js";
import { toXlsx } from "./xlsx.js";

// Isolate-scoped cache of the auto-selected business unit (only used when exactly one exists).
let autoBu: string | undefined;

type Rec = Record<string, unknown>;

const money = (n: number) => Math.round(n * 100) / 100;

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function codeKey(v: unknown): string {
  return normCode(v).toUpperCase();
}

/** HCSS returns { data: [ { materials: [...] } ] }. Also accept a flat material row. */
function unwrapMaterials(data: unknown): FactorRec[] {
  const out: FactorRec[] = [];
  if (!Array.isArray(data)) return out;
  for (const rep of data) {
    if (!rep || typeof rep !== "object") continue;
    const row = rep as FactorRec;
    if (Array.isArray(row.materials)) out.push(...(row.materials as FactorRec[]));
    else if (row.resourceCode !== undefined) out.push(row);
  }
  return out;
}

/** One report row per resource code. A non-zero rate wins so priced_only does not drop the code because a $0 duplicate was last. */
function mergeReport(report: FactorRec[]): FactorRec[] {
  const groups = new Map<string, FactorRec[]>();
  const bare: FactorRec[] = [];
  for (const m of report) {
    const code = codeKey(m.resourceCode);
    if (!code) { bare.push(m); continue; }
    const list = groups.get(code) ?? [];
    list.push(m);
    groups.set(code, list);
  }
  const merged = [...groups.values()].map((rows) => {
    const priced = rows.find((m) => !isZeroRate(m.unitCost));
    const head = priced ?? rows[rows.length - 1];
    return { ...head, unitCost: priced ? priced.unitCost : head.unitCost };
  });
  return [...bare, ...merged];
}

function headerUnitCost(lines: Line[]): number | null {
  let sawZero = false;
  for (const line of lines) {
    if (typeof line.unitCost === "number" && Number.isFinite(line.unitCost) && line.unitCost !== 0) return line.unitCost;
    if (isZeroRate(line.unitCost)) sawZero = true;
  }
  return sawZero ? 0 : null;
}

function syntheticMaterials(lines: Line[], present: Set<string>): FactorRec[] {
  const byCode = new Map<string, Line[]>();
  for (const line of lines) {
    const code = codeKey(line.resource);
    if (!code || present.has(code)) continue;
    const list = byCode.get(code) ?? [];
    list.push(line);
    byCode.set(code, list);
  }
  return [...byCode.values()].map((group) => ({
    resourceCode: normCode(group[0].resource),
    description: group[0].description,
    units: group[0].unit,
    unitCost: headerUnitCost(group),
    total: 0,
    biditems: [],
  }));
}

function linesFor(lines: Line[], code: string, units: string, split: boolean): Line[] {
  const matched = lines.filter((l) => codeKey(l.resource) === code);
  if (!split || !units) return matched;
  return matched.filter((l) => codeKey(l.unit) === units);
}

function weightedUnitPrice(lines: Line[]): number | null {
  let qty = 0;
  let ext = 0;
  let fallback: number | null = null;
  for (const line of lines) {
    if (typeof line.unitCost !== "number" || !Number.isFinite(line.unitCost)) continue;
    if (fallback === null) fallback = line.unitCost;
    const q = line.quantity ?? 0;
    if (q) { qty += q; ext += q * line.unitCost; }
  }
  if (qty) return money(ext / qty);
  return fallback === null ? null : money(fallback);
}

function taxFor(lines: Line[]): { tax_percent?: number | "varies"; tax_amount?: number; rawTax: number } {
  const pcts = new Set<number>();
  let rawTax = 0;
  for (const line of lines) {
    const adj = percentAdj(line.taxOtPct);
    if (adj === undefined) continue;
    pcts.add(adj);
    rawTax += (line.total ?? 0) * (adj / 100);
  }
  if (!pcts.size) return { rawTax: 0 };
  return { tax_percent: pcts.size === 1 ? [...pcts][0] : "varies", tax_amount: money(rawTax), rawTax };
}

interface Shaped { row: FactorRec; rawTax: number }

function shapeMaterials(materials: FactorRec[], lines: Line[], pricedOnly: boolean): Shaped[] {
  const pool = pricedOnly ? lines.filter((l) => !isZeroRate(l.unitCost)) : lines;
  const shaped: Shaped[] = [];
  for (const m of materials) {
    const code = codeKey(m.resourceCode);
    const biditems = Array.isArray(m.biditems) ? m.biditems as FactorRec[] : [];
    const groups = new Map<string, FactorRec[]>();
    for (const b of biditems) {
      const u = codeKey(b.units ?? m.units);
      const list = groups.get(u) ?? [];
      list.push(b);
      groups.set(u, list);
    }
    const emit = (group: FactorRec[], unitsKey: string, only: boolean) => {
      const qty = group.reduce((s, b) => s + num(b.quantity), 0) || (group.length ? 0 : num(m.quantity));
      const summed = group.reduce((s, b) => s + num(b.total), 0);
      const total = only && typeof m.total === "number" ? m.total : money(summed || (group.length ? 0 : num(m.total)));
      const matched = linesFor(pool, code, unitsKey, groups.size > 1);
      const tax = taxFor(matched);
      const unitFromLines = weightedUnitPrice(matched);
      const row: FactorRec = {
        resource_code: normCode(m.resourceCode),
        description: m.description ?? matched[0]?.description ?? null,
        units: normCode(group[0]?.units ?? m.units ?? matched[0]?.unit) || null,
        quantity: Math.round(qty * 1e4) / 1e4,
        unit_cost: unitFromLines ?? (typeof m.unitCost === "number" && Number.isFinite(m.unitCost) ? money(m.unitCost) : m.unitCost ?? null),
        total: group.length || typeof m.total === "number" ? total : null,
        biditems: group.map((b) => ({
          ...b,
          biditemCode: b.biditemCode !== undefined ? normCode(b.biditemCode) : b.biditemCode,
          activityCode: b.activityCode !== undefined ? normCode(b.activityCode) : b.activityCode,
        })),
      };
      if (tax.tax_percent !== undefined) row.tax_percent = tax.tax_percent;
      if (tax.tax_amount !== undefined) row.tax_amount = tax.tax_amount;
      shaped.push({ row, rawTax: tax.rawTax });
    };
    if (groups.size <= 1) emit(biditems, [...groups.keys()][0] ?? "", true);
    else for (const [u, group] of groups) emit(group, u, false);
  }
  shaped.sort((a, b) => codeCompare(a.row.resource_code, b.row.resource_code) || codeCompare(a.row.units, b.row.units));
  return shaped;
}

export function buildServer(cfg: Config, hcss: HcssClient, env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-heavybid", version: "0.5.0" });
  const LIST_MAX = 500;
  const BREAKDOWN_MAX = 40_000; // ~45 pages x 1000 rows is the free-plan ceiling anyway

  const guid = z.string().uuid();
  const buArg = { business_unit_id: guid.optional().describe("Defaults to the server's HCSS_BUSINESS_UNIT_ID") };
  const maxArg = { max_records: z.number().int().min(1).max(40000).optional() };

  const bu = async (id?: string): Promise<string> => {
    const v = id ?? cfg.businessUnitId ?? autoBu;
    if (v) return v;
    // One extra subrequest, once per isolate.
    const r = await hcss.get<{ data?: Rec[] }>("/businessunits");
    const units = realUnits(r.data ?? []);
    if (units.length === 1 && typeof units[0].id === "string") return (autoBu = units[0].id);
    throw new Error(`No default business unit (HCSS_BUSINESS_UNIT_ID unset) and ${units.length} distinct units exist (${units.map((u) => u.code).join(", ")}). Call list_business_units and pass business_unit_id.`);
  };
  // Drop placeholder units (all-zero GUID, no code) and dedupe by unit code (HCSS can list one unit per partition).
  // When a code repeats, the first record returned is kept: UNVERIFIED whether partitions' ids are interchangeable.
  const realUnits = (rows: Rec[]) => {
    const seen = new Map<string, Rec>();
    for (const u of rows) {
      const id = String(u.id ?? "");
      const code = normCode(u.code ?? u.businessUnitCode ?? u.description).toUpperCase();
      if (!id || /^[0-]+$/.test(id) || !code) continue;
      if (!seen.has(code)) seen.set(code, u);
    }
    return [...seen.values()];
  };
  const isoDate = (field: string, v: string) => {
    const m = /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? new Date(v.trim() + "T00:00:00Z") : new Date(NaN);
    if (Number.isNaN(m.getTime())) throw new Error(`Invalid ${field}: '${v}'. Expected a date in YYYY-MM-DD format, e.g. 2026-10-01.`);
    return m.toISOString();
  };
  const sortBiditems = (rows: Rec[]) => [...rows].sort((x, y) => codeCompare(x.sortCode ?? x.biditemCode, y.sortCode ?? y.biditemCode) || codeCompare(x.biditemCode, y.biditemCode));
  const isPriced = (r: Rec) => ["totalCost", "bidPrice", "totalTakeoff", "directTotal"].some((k) => Number(r[k] ?? 0) !== 0);
  const biditemHint = (code: string, codes: string[]) =>
    `No bid item '${normCode(code)}'; this estimate has ${codes.length} bid items` + (codes.length ? ` (e.g. ${codes.slice(0, 8).join(", ")}${codes.length > 8 ? ", ..." : ""}).` : ".");
  const quote = (s: string) => s.replace(/'/g, "''");
  const and = (...p: (string | undefined)[]) => p.filter(Boolean).join(" and ") || undefined;
  // Trim float noise (e.g. 252.00000000003) everywhere: non-integers to 4 decimals.
  const noNoise = (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, noNoise, 2) }] });
  const FILTER_HELP = "Raw OData $filter: eq, ne, gt, lt, ge, le, and, or, contains(field,'x'), startswith(field,'x'), in. Quote strings with single quotes; escape an apostrophe by doubling it ('O''Reilly'). Dates as ISO, e.g. filters/bidDate gt 2026-10-01T00:00:00Z.";
  // Compact estimate summary: the full record is ~9 KB (notes + ~150 totals fields).
  const pick = (r: Rec, k: string) => r[k] ?? (r.filters as Rec | undefined)?.[k] ?? (r.totals as Rec | undefined)?.[k];
  const SUMMARY = ["id", "code", "name", "description", "status", "processedStatus", "estimator", "engineer", "owner", "bidDate", "startDate",
    "projectName", "projectNumber", "typeOfWork", "state", "isActiveEstimate", "lastModified"];
  const TOTALS = ["totalCost_Takeoff", "bidTotal_Takeoff", "totalCost_Bid", "bidTotal_Bid", "balancedBid_Bid", "actualMarkup_Bid",
    "totalLabor_Total", "permanentMaterial_Total", "constructionMaterial_Total", "subcontract_Total", "totalEqp_Total", "manhours_Total"];
  const shapeEstimate = (r: Rec, detail?: boolean, fields?: string[]): Rec => {
    if (detail) return r;
    const o: Rec = {};
    for (const k of fields?.length ? fields : SUMMARY) { const v = pick(r, k); if (v !== undefined) o[k] = v; }
    if (!fields?.length) {
      const t: Rec = {};
      for (const k of TOTALS) { const v = pick(r, k); if (v !== undefined) t[k] = v; }
      o.totals = t;
      const n = typeof r.notes === "string" ? r.notes : "";
      if (n) o.notes = n.length > 200 ? n.slice(0, 200) + "..." : n;
    }
    return o;
  };
  // Compact bid item (full record has ~95 fields). Field names from the HCSS biditem schema.
  const BIDITEM_SUMMARY = ["id", "estimateId", "biditemCode", "description", "type", "quantity", "bidQuantity", "units", "bidPrice",
    "totalCost", "directTotal", "indirectTotal", "manhours", "labor", "burden", "permanentMaterial", "constructionMaterial",
    "subcontract", "equipmentOperatingExpense", "companyEquipment", "rentedEquipment", "markup", "parent", "subtotalLevel"];
  const shapeBiditem = (r: Rec, detail?: boolean, fields?: string[]): Rec => {
    const o: Rec = {};
    if (detail) Object.assign(o, r);
    else for (const k of fields?.length ? fields : BIDITEM_SUMMARY) if (r[k] !== undefined) o[k] = r[k];
    if (o.biditemCode !== undefined) o.biditemCode = normCode(o.biditemCode);
    if (!detail && !fields?.length) {
      const q = Number(r.quantity ?? 0);
      if (q && typeof r.totalCost === "number") o.unitCost = money(r.totalCost / q); // derived: totalCost / quantity
    }
    return o;
  };
  const listArgs = {
    detail: z.boolean().default(false).describe("Full HCSS records (~9 KB each). Default: compact summary"),
    fields: z.array(z.string()).optional().describe("Return only these fields (top-level, filters/ or totals/ names), e.g. [\"code\",\"bidDate\"]"),
    skip: z.number().int().min(0).optional().describe("Paging: records to skip (use next_skip from the previous call)"),
  };
  const maybe = (rows: Rec[], fn: (r: Rec) => Rec) => (cfg.hideCostRates ? rows.map(fn) : rows);
  const meta = (truncated: boolean, n: number) => ({ count: n, truncated, cost_rates_hidden: cfg.hideCostRates });

  server.tool("list_business_units", "List HeavyBid business units.", {}, async () => {
    const r = await hcss.getAll<Rec>("/businessunits", {}, LIST_MAX);
    const real = new Set(realUnits(r.records));
    return reply({ ...meta(r.truncated, r.records.length), distinct_real_units: real.size, data: r.records.map((u) => ({ ...u, default_candidate: real.has(u) })) });
  });

  server.tool(
    "list_estimates",
    "List HeavyBid estimates, newest-modified first, as compact summaries (detail:true for full records). " + FILTER_HELP,
    { ...buArg, ...maxArg, ...listArgs, filter: z.string().optional().describe(FILTER_HELP), include_excluded: z.boolean().optional() },
    async (a) => {
      const r = await hcss.getAll<Rec>(`/businessunits/${(await bu(a.business_unit_id))}/estimates`, {
        $filter: a.filter, $orderby: "lastModified desc", includeExcludedEstimates: a.include_excluded,
      }, a.max_records ?? 25, a.skip ?? 0);
      return reply({ ...meta(r.truncated, r.records.length), next_skip: r.nextSkip, data: maybe(r.records, redactEstimate).map((x) => shapeEstimate(x, a.detail, a.fields)) });
    },
  );

  server.tool(
    "search_estimates",
    "Search estimates by text in the name, optionally by estimator and bid date (YYYY-MM-DD). Compact summaries unless detail:true. For other conditions use list_estimates filter (" + "supports startswith(), ne/ge/le, and/or).",
    { ...buArg, ...maxArg, ...listArgs, text: z.string().min(1), estimator: z.string().optional(), bid_date_after: z.string().optional().describe("YYYY-MM-DD") },
    async (a) => {
      const filter = and(
        `contains(name,'${quote(a.text)}')`,
        a.estimator ? `filters/estimator eq '${quote(a.estimator)}'` : undefined, // UNVERIFIED
        a.bid_date_after ? `filters/bidDate gt ${isoDate("bid_date_after", a.bid_date_after)}` : undefined, // UNVERIFIED
      );
      const r = await hcss.getAll<Rec>(`/businessunits/${(await bu(a.business_unit_id))}/estimates`, {
        $filter: filter, $orderby: "lastModified desc",
      }, a.max_records ?? 25, a.skip ?? 0);
      return reply({ ...meta(r.truncated, r.records.length), next_skip: r.nextSkip, data: maybe(r.records, redactEstimate).map((x) => shapeEstimate(x, a.detail, a.fields)) });
    },
  );

  server.tool("get_estimate", "Get one estimate (header, filters, totals).", { ...buArg, estimate_id: guid }, async (a) => {
    const r = await hcss.get<{ data: Rec }>(`/businessunits/${(await bu(a.business_unit_id))}/estimates/${a.estimate_id}`);
    return reply({ cost_rates_hidden: cfg.hideCostRates, data: cfg.hideCostRates ? redactEstimate(r.data) : r.data });
  });

  server.tool(
    "get_bid_items",
    "Bid items for an estimate, sorted by item code. Codes are matched ignoring HeavyBid's leading spaces.",
    {
      ...buArg, ...maxArg, estimate_id: guid,
      biditem_code: z.string().optional().describe("Only this bid item code, e.g. 2010"),
      priced_only: z.boolean().default(false).describe("Hide $0 bid items (e.g. rate lines)"),
      ...listArgs,
    },
    async (a) => {
      // Fetch all bid items (sort + priced_only are client-side), then page with skip/max_records.
      const r = await hcss.getAll<Rec>(`/businessunits/${(await bu(a.business_unit_id))}/biditems`, {
        $filter: `estimateId eq ${a.estimate_id}`,
      }, 10_000);
      let rows = sortBiditems(r.records);
      const all = rows.length;
      if (a.priced_only) rows = rows.filter(isPriced);
      if (a.biditem_code) {
        rows = rows.filter((x) => codeEq(x.biditemCode, a.biditem_code));
        if (!rows.length) return reply({ count: 0, hint: biditemHint(a.biditem_code, r.records.map((x) => normCode(x.biditemCode)).sort(codeCompare)) });
      }
      const skip = a.skip ?? 0;
      const cap = a.max_records ?? 100;
      const page = rows.slice(skip, skip + cap);
      const more = skip + page.length < rows.length;
      return reply({
        ...meta(r.truncated || more, page.length), total_matching: rows.length, skip, next_skip: more ? skip + page.length : undefined,
        hidden_unpriced: all - (a.priced_only ? rows.length : all),
        data: maybe(page, redactBiditem).map((x) => shapeBiditem(x, a.detail, a.fields)),
      });
    },
  );

  server.tool(
    "get_activities",
    "Activities (crew, production, man-hours, costs) for an estimate, optionally one bid item (by id or code, e.g. 2010).",
    { ...buArg, ...maxArg, estimate_id: guid, biditem_id: guid.optional(), biditem_code: z.string().optional() },
    async (a) => {
      const base = `/businessunits/${(await bu(a.business_unit_id))}`;
      let biditemId = a.biditem_id;
      if (!biditemId && a.biditem_code) {
        const bi = await hcss.getAll<Rec>(`${base}/biditems`, { $filter: `estimateId eq ${a.estimate_id}` }, LIST_MAX * 4);
        const hit = bi.records.find((x) => codeEq(x.biditemCode, a.biditem_code));
        if (!hit) return reply({ count: 0, hint: biditemHint(a.biditem_code, bi.records.map((x) => normCode(x.biditemCode)).sort(codeCompare)) });
        biditemId = String(hit.id);
      }
      const r = await hcss.getAll<Rec>(`${base}/activities`, {
        $filter: and(`estimateId eq ${a.estimate_id}`, biditemId ? `biditemId eq ${biditemId}` : undefined),
      }, a.max_records ?? LIST_MAX);
      const rows = [...r.records].sort((x, y) => codeCompare(x.activityCode, y.activityCode));
      return reply({ ...meta(r.truncated, rows.length), data: maybe(rows, redactActivity) });
    },
  );

  server.tool(
    "get_resources",
    "Resources (labor, equipment, materials, subs) for an estimate, optionally one activity.",
    { ...buArg, ...maxArg, estimate_id: guid, activity_id: guid.optional() },
    async (a) => {
      const r = await hcss.getAll<Rec>(`/businessunits/${(await bu(a.business_unit_id))}/resources`, {
        $filter: and(`estimateId eq ${a.estimate_id}`, a.activity_id ? `activityId eq ${a.activity_id}` : undefined),
      }, a.max_records ?? LIST_MAX);
      const rows = r.records.map((x) => { const adj = percentAdj(x.percent); return adj === undefined ? x : { ...x, [percentField(x.typeCost)]: adj }; });
      return reply({ ...meta(r.truncated, rows.length), note: "percent is a multiplier (108 = +8%); see the labelled tax_percent / overtime_factor_percent / percent_adjustment field (UNVERIFIED).", data: maybe(rows, redactResource) });
    },
  );

  server.tool(
    "get_materials",
    "Material list for an estimate (permanent or construction): each material with units, pre-tax unit cost, factored total and the bid items it is used in. " +
      "Quantities and totals include HeavyBid's activity factor and sharing split. " +
      "priced_only drops lines whose unit cost (rate) is $0.",
    {
      ...buArg, ...maxArg, estimate_id: guid, material_type: z.enum(["permanent", "construction"]),
      priced_only: z.boolean().optional().describe("Drop lines whose unit cost (rate) is $0"),
      skip: z.number().int().min(0).optional().describe("Paging: lines to skip (use next_skip from the previous call). Totals always cover the whole estimate."),
    },
    async (a) => {
      const base = `/businessunits/${(await bu(a.business_unit_id))}`;
      const est = a.estimate_id;
      const cap = a.max_records ?? 100;
      const skip = a.skip ?? 0;
      const t = a.material_type === "permanent" ? "P" : "C";
      const f = { $filter: `estimateId eq ${est}` };
      // 1) Material analysis endpoint. Response: { data: [ { materials: [...] } ] }.
      //    Its own total can include sales tax. Quantity and total below come from factored resources instead.
      let report: FactorRec[] = [];
      let note = "";
      try {
        const r = await hcss.get<{ data?: { materials?: FactorRec[] | null }[] | null }>(
          `${base}/estimates/${est}/materials/${a.material_type}`, { $top: Math.min(5000, cfg.pageSize * 5) },
        );
        report = unwrapMaterials(r.data);
      } catch (e) {
        if (e instanceof Error && /HTTP 404/.test(e.message)) throw e;
        note = `materials endpoint failed (${e instanceof Error ? e.message.slice(0, 120) : "error"}); `;
      }
      // 2) Same lists the cost breakdown uses, so the material rollup applies the same factor.
      //    Sequential on purpose (HCSS company-wide concurrency limit).
      const bi = await hcss.getAll<FactorRec>(`${base}/biditems`, f, BREAKDOWN_MAX);
      const ac = await hcss.getAll<FactorRec>(`${base}/activities`, f, BREAKDOWN_MAX);
      const rs = await hcss.getAll<FactorRec>(`${base}/resources`, f, BREAKDOWN_MAX);
      const adj = adjustedLines(bi.records, ac.records, rs.records);
      const typed = adj.lines.filter((l) => (l.typeCost ?? "").toUpperCase() === t && !l.skip);
      const reportRows = mergeReport(report);
      const present = new Set(reportRows.map((m) => codeKey(m.resourceCode)).filter(Boolean));
      const pricedOnly = a.priced_only ?? false;
      const adjusted = applyMaterialAdjustments(
        [...reportRows, ...syntheticMaterials(typed, present)],
        adj.lines,
        { materialType: a.material_type, pricedOnly },
      );
      const owners = new Set(ac.records.map((row) => String(row.biditemId ?? "")).filter(Boolean));
      const detail = bi.records.filter((row) => owners.has(String(row.id ?? "")));
      let mat = materialReconciliation(adjusted, detail, a.material_type);
      const truncated = bi.truncated || ac.truncated || rs.truncated;
      if (truncated) mat = { ...mat, reconciliation: { ...mat.reconciliation, note: [mat.reconciliation.note, "Lists were truncated at the row cap; this check may be incomplete."].filter(Boolean).join(" ") } };
      const shaped = shapeMaterials(adjusted, typed, pricedOnly);
      const source = note + (report.length ? "materials endpoint + resources (pre-tax costs, tax from resource.percent)" : `derived from resources (typeCost '${t}')`);
      const sum = (k: string) => money(shaped.reduce((s2, m) => s2 + (typeof m.row[k] === "number" ? (m.row[k] as number) : 0), 0));
      const fullTotal = sum("total");
      const rawTax = shaped.reduce((s2, m) => s2 + m.rawTax, 0);
      const taxed = shaped.some((m) => m.row.tax_amount !== undefined);
      const scope = rs.truncated
        ? "partial (resource fetch hit the row cap; totals are a lower bound)"
        : truncated
          ? "partial (bid item or activity fetch hit the row cap; totals are a lower bound)"
          : "full_estimate";
      const totals = cfg.hideCostRates ? "[hidden]" : {
        scope,
        line_count_total: shaped.length,
        total: fullTotal,
        ...(taxed ? { tax_amount: money(rawTax), total_with_tax: money(fullTotal + rawTax) } : {}),
      };
      const page = shaped.slice(skip, skip + cap).map((s) => s.row);
      if (cfg.hideCostRates) for (const m of page) for (const k of ["unit_cost", "total", "tax_amount"]) if (k in m) m[k] = "[hidden]";
      const more = skip + page.length < shaped.length;
      const warnings = cfg.hideCostRates ? [] : capWarnings(mat.warnings);
      const reconciliation = cfg.hideCostRates
        ? { ...mat.reconciliation, note: "Costs are hidden; reconciliation amounts were not returned." }
        : mat.reconciliation;
      return reply({
        ...meta(truncated || more, page.length), priced_only: pricedOnly, source,
        line_count_total: shaped.length, lines_returned: page.length, skip, next_skip: more ? skip + page.length : undefined,
        totals, warnings, reconciliation,
        note: "quantity and total are the cost-breakdown figures (resource.quantity and resource.total after the Bid/TO factor and sharing split, cent-rounded per line). unit_cost is the pre-tax resource unit price. tax_percent = resource.percent - 100 (108 -> 8%), UNVERIFIED as sales tax; omitted when 0/none. tax_amount applies that percent to the factored total. total_with_tax = total + tax_amount.",
        data: page,
      });
    },
  );

  server.tool(
    "get_estimate_cost_breakdown",
    "HeavyBid-style cost report: one row per resource, joined to its activity and bid item " +
      `(columns: ${COLUMNS.map((c) => c.header).join(", ")}). Large estimates: use export_estimate instead.`,
    { ...buArg, estimate_id: guid, biditem_code: z.string().optional().describe("Only rows for this bid item code"), limit_rows: z.number().int().min(1).max(2000).optional() },
    async (a) => {
      const b = await costBreakdown(hcss, (await bu(a.business_unit_id)), a.estimate_id, BREAKDOWN_MAX, cfg.hideCostRates);
      let rows = b.rows;
      if (a.biditem_code) {
        rows = rows.filter((r) => codeEq(r.biditem, a.biditem_code));
        if (!rows.length) return reply({ counts: b.counts, total_rows: 0, hint: biditemHint(a.biditem_code, b.biditemCodes), warnings: b.warnings, reconciliation: b.reconciliation });
      }
      const limit = a.limit_rows ?? 500;
      return reply({
        counts: b.counts, total_rows: rows.length, rows_returned: Math.min(limit, rows.length),
        truncated: b.truncated || rows.length > limit, cost_rates_hidden: cfg.hideCostRates,
        column_sources: Object.fromEntries(COLUMNS.map((c) => [c.header, c.source])),
        column_notes: "Quantity and Total include HeavyBid's Bid/TO factor and sharing split when that matches the activity direct total; otherwise they are the raw resource values and reconciliation warns. Labor Total already includes burden. Columns marked UNVERIFIED (Tax/OT%, Pcs/Wste, EOE%, EOE, Burden) are best-guess mappings; check against HeavyBid before relying on them.",
        warnings: b.warnings, reconciliation: b.reconciliation,
        rows: rows.slice(0, limit),
      });
    },
  );

  server.tool(
    "export_estimate",
    "Export the full cost breakdown as an Excel (.xlsx) or CSV file. Returns a one-time download link (expires in minutes).",
    { ...buArg, estimate_id: guid, format: z.enum(["xlsx", "csv"]).default("xlsx") },
    async (a) => {
      const buId = await bu(a.business_unit_id);
      const [est, b] = await Promise.all([
        hcss.get<{ data: Rec }>(`/businessunits/${buId}/estimates/${a.estimate_id}`),
        costBreakdown(hcss, buId, a.estimate_id, BREAKDOWN_MAX, cfg.hideCostRates),
      ]);
      const code = String(est.data?.code ?? a.estimate_id).replace(/[^\w.-]+/g, "_");
      const name = `${code}-cost-breakdown.${a.format}`;
      const buf = a.format === "csv"
        ? new TextEncoder().encode("\ufeff" + toCsv(b.rows))
        : toXlsx(b.rows, `${est.data?.code ?? ""} ${est.data?.name ?? ""}`.trim(), b.warnings);
      const mime = a.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (buf.byteLength > 24 * 1024 * 1024) throw new Error("Export exceeds the 25 MiB KV value limit; export one bid item range at a time.");
      const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      // KV free plan: 1,000 writes/day. One write per export; TTL auto-deletes it.
      await env.EXPORTS.put(`export:${id}`, buf, { expirationTtl: cfg.exportTtlSeconds, metadata: { name, mime } });
      const url = `${origin}/exports/${id}`;
      return reply({
        file: name, rows: b.rows.length, truncated: b.truncated, cost_rates_hidden: cfg.hideCostRates,
        warnings: b.warnings, reconciliation: b.reconciliation,
        download_url: url, hcss_calls: hcss.used, note: `Single-use link, expires in ${Math.round(cfg.exportTtlSeconds / 60)} minutes. Don't share it.`,
      });
    },
  );

  return server;
}
