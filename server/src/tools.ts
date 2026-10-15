import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import type { HcssClient } from "./hcss.js";
import { redactActivity, redactBiditem, redactEstimate, redactResource } from "./redact.js";
import { costBreakdown, toCsv, COLUMNS } from "./breakdown.js";
import { adjustedLines, applyMaterialAdjustments, capWarnings, materialReconciliation } from "./factor.js";
import { toXlsx } from "./xlsx.js";
import type { Env } from "./config.js";

type Rec = Record<string, unknown>;

export function buildServer(cfg: Config, hcss: HcssClient, env: Env, origin: string): McpServer {
  const server = new McpServer({ name: "schrex-hcss-heavybid", version: "0.3.0" });
  const LIST_MAX = 500;
  const BREAKDOWN_MAX = 40_000; // ~45 pages x 1000 rows is the free-plan ceiling anyway

  const guid = z.string().uuid();
  const buArg = { business_unit_id: guid.optional().describe("Defaults to the server's HCSS_BUSINESS_UNIT_ID") };
  const maxArg = { max_records: z.number().int().min(1).max(40000).optional() };

  const bu = (id?: string) => {
    const v = id ?? cfg.businessUnitId;
    if (!v) throw new Error("No business unit id configured. Call list_business_units and pass business_unit_id.");
    return v;
  };
  const quote = (s: string) => s.replace(/'/g, "''");
  const and = (...p: (string | undefined)[]) => p.filter(Boolean).join(" and ") || undefined;
  const reply = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
  const maybe = (rows: Rec[], fn: (r: Rec) => Rec) => (cfg.hideCostRates ? rows.map(fn) : rows);
  const meta = (truncated: boolean, n: number) => ({ count: n, truncated, cost_rates_hidden: cfg.hideCostRates });

  server.tool("list_business_units", "List HeavyBid business units.", {}, async () => {
    const r = await hcss.getAll<Rec>("/businessunits", {}, LIST_MAX);
    return reply({ ...meta(r.truncated, r.records.length), data: r.records });
  });

  server.tool(
    "list_estimates",
    "List HeavyBid estimates, newest-modified first. Optional raw OData $filter (eq, gt, lt, contains, in).",
    { ...buArg, ...maxArg, filter: z.string().optional(), include_excluded: z.boolean().optional() },
    async (a) => {
      const r = await hcss.getAll<Rec>(`/businessunits/${bu(a.business_unit_id)}/estimates`, {
        $filter: a.filter, $orderby: "lastModified desc", includeExcludedEstimates: a.include_excluded,
      }, a.max_records ?? 100);
      return reply({ ...meta(r.truncated, r.records.length), data: maybe(r.records, redactEstimate) });
    },
  );

  server.tool(
    "search_estimates",
    "Search estimates by text in the name, optionally by estimator and bid date.",
    { ...buArg, ...maxArg, text: z.string().min(1), estimator: z.string().optional(), bid_date_after: z.string().optional() },
    async (a) => {
      const filter = and(
        `contains(name,'${quote(a.text)}')`,
        a.estimator ? `filters/estimator eq '${quote(a.estimator)}'` : undefined, // UNVERIFIED
        a.bid_date_after ? `filters/bidDate gt ${new Date(a.bid_date_after).toISOString()}` : undefined, // UNVERIFIED
      );
      const r = await hcss.getAll<Rec>(`/businessunits/${bu(a.business_unit_id)}/estimates`, {
        $filter: filter, $orderby: "lastModified desc",
      }, a.max_records ?? 50);
      return reply({ ...meta(r.truncated, r.records.length), data: maybe(r.records, redactEstimate) });
    },
  );

  server.tool("get_estimate", "Get one estimate (header, filters, totals).", { ...buArg, estimate_id: guid }, async (a) => {
    const r = await hcss.get<{ data: Rec }>(`/businessunits/${bu(a.business_unit_id)}/estimates/${a.estimate_id}`);
    return reply({ cost_rates_hidden: cfg.hideCostRates, data: cfg.hideCostRates ? redactEstimate(r.data) : r.data });
  });

  server.tool("get_bid_items", "Bid items for an estimate.", { ...buArg, ...maxArg, estimate_id: guid }, async (a) => {
    const r = await hcss.getAll<Rec>(`/businessunits/${bu(a.business_unit_id)}/biditems`, {
      $filter: `estimateId eq ${a.estimate_id}`,
    }, a.max_records ?? LIST_MAX);
    return reply({ ...meta(r.truncated, r.records.length), data: maybe(r.records, redactBiditem) });
  });

  server.tool(
    "get_activities",
    "Activities (crew, production, man-hours, costs) for an estimate, optionally one bid item.",
    { ...buArg, ...maxArg, estimate_id: guid, biditem_id: guid.optional() },
    async (a) => {
      const r = await hcss.getAll<Rec>(`/businessunits/${bu(a.business_unit_id)}/activities`, {
        $filter: and(`estimateId eq ${a.estimate_id}`, a.biditem_id ? `biditemId eq ${a.biditem_id}` : undefined),
      }, a.max_records ?? LIST_MAX);
      return reply({ ...meta(r.truncated, r.records.length), data: maybe(r.records, redactActivity) });
    },
  );

  server.tool(
    "get_resources",
    "Resources (labor, equipment, materials, subs) for an estimate, optionally one activity.",
    { ...buArg, ...maxArg, estimate_id: guid, activity_id: guid.optional() },
    async (a) => {
      const r = await hcss.getAll<Rec>(`/businessunits/${bu(a.business_unit_id)}/resources`, {
        $filter: and(`estimateId eq ${a.estimate_id}`, a.activity_id ? `activityId eq ${a.activity_id}` : undefined),
      }, a.max_records ?? LIST_MAX);
      return reply({ ...meta(r.truncated, r.records.length), data: maybe(r.records, redactResource) });
    },
  );

  server.tool(
    "get_materials",
    "Material analysis for an estimate (permanent or construction), with bid-item breakdown. " +
      "Quantities and totals include HeavyBid's activity factor and sharing split. " +
      "priced_only drops lines whose unit cost (rate) is $0.",
    {
      ...buArg, ...maxArg, estimate_id: guid,
      material_type: z.enum(["permanent", "construction"]),
      priced_only: z.boolean().optional().describe("Drop lines whose unit cost (rate) is $0"),
    },
    async (a) => {
      const id = bu(a.business_unit_id);
      const est = a.estimate_id;
      const f = { $filter: `estimateId eq ${est}` };
      const base = `/businessunits/${id}`;
      // Same lists the cost breakdown uses, so the material rollup applies the same factor.
      // Sequential on purpose (HCSS company-wide concurrency limit).
      const bi = await hcss.getAll<Rec>(`${base}/biditems`, f, BREAKDOWN_MAX);
      const ac = await hcss.getAll<Rec>(`${base}/activities`, f, BREAKDOWN_MAX);
      const rs = await hcss.getAll<Rec>(`${base}/resources`, f, BREAKDOWN_MAX);
      const mats = await hcss.getAll<Rec>(
        `${base}/estimates/${est}/materials/${a.material_type}`, {}, a.max_records ?? LIST_MAX,
      );
      const adj = adjustedLines(bi.records, ac.records, rs.records);
      const pricedOnly = a.priced_only ?? false;
      const data = applyMaterialAdjustments(mats.records, adj.lines, { materialType: a.material_type, pricedOnly });
      // Header bid items roll their children's costs up and have no activities of their own.
      const owners = new Set(ac.records.map((row) => String(row.biditemId ?? "")).filter(Boolean));
      const detail = bi.records.filter((row) => owners.has(String(row.id ?? "")));
      const mat = materialReconciliation(data, detail, a.material_type);
      const truncated = bi.truncated || ac.truncated || rs.truncated || mats.truncated;
      if (truncated) mat.reconciliation = { ...mat.reconciliation, note: [mat.reconciliation.note, "Lists were truncated at the row cap; this check may be incomplete."].filter(Boolean).join(" ") };
      return reply({
        ...meta(truncated, data.length), priced_only: pricedOnly,
        warnings: capWarnings(mat.warnings), reconciliation: mat.reconciliation, data,
      });
    },
  );

  server.tool(
    "get_estimate_cost_breakdown",
    "HeavyBid-style cost report: one row per resource, joined to its activity and bid item " +
      `(columns: ${COLUMNS.map((c) => c.header).join(", ")}). Large estimates: use export_estimate instead.`,
    { ...buArg, estimate_id: guid, biditem_code: z.string().optional().describe("Only rows for this bid item code"), limit_rows: z.number().int().min(1).max(2000).optional() },
    async (a) => {
      const b = await costBreakdown(hcss, bu(a.business_unit_id), a.estimate_id, BREAKDOWN_MAX, cfg.hideCostRates);
      let rows = b.rows;
      if (a.biditem_code) rows = rows.filter((r) => String(r.biditem) === a.biditem_code);
      const limit = a.limit_rows ?? 500;
      return reply({
        counts: b.counts, total_rows: rows.length, rows_returned: Math.min(limit, rows.length),
        truncated: b.truncated || rows.length > limit, cost_rates_hidden: cfg.hideCostRates,
        column_sources: Object.fromEntries(COLUMNS.map((c) => [c.header, c.source])),
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
      const buId = bu(a.business_unit_id);
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
      const url = `${origin}/${cfg.pathSecret}/exports/${id}`;
      return reply({
        file: name, rows: b.rows.length, truncated: b.truncated, cost_rates_hidden: cfg.hideCostRates,
        warnings: b.warnings, reconciliation: b.reconciliation,
        download_url: url, hcss_calls: hcss.used, note: `Single-use link, expires in ${Math.round(cfg.exportTtlSeconds / 60)} minutes. Don't share it.`,
      });
    },
  );

  return server;
}
