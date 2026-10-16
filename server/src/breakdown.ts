import type { HcssClient } from "./hcss.js";
import { adjustedLines, capWarnings, type Line, type Reconciliation } from "./factor.js";

type Rec = Record<string, any>; // eslint-disable-line

/** Columns of HeavyBid's "bid item > activity > resource" cost report, mapped to Estimate Insights fields. */
export const COLUMNS: { header: string; key: string; source: string; verified: boolean }[] = [
  { header: "Biditem", key: "biditem", source: "biditem.biditemCode", verified: true },
  { header: "Bid Desc", key: "bidDesc", source: "biditem.description", verified: true },
  { header: "Activity", key: "activity", source: "activity.activityCode", verified: true },
  { header: "Actv Desc", key: "actvDesc", source: "activity.description", verified: true },
  { header: "Resource", key: "resource", source: "resource.resourceCode", verified: true },
  { header: "Description", key: "description", source: "resource.description", verified: true },
  { header: "Quantity", key: "quantity", source: "resource.quantity × HeavyBid Bid/TO factor (and a sharing split only when that matches the activity direct total)", verified: true },
  { header: "Unit", key: "unit", source: "resource.units", verified: true },
  { header: "Unit Cost", key: "unitCost", source: "resource.unitPrice", verified: true },
  { header: "Tax/OT%", key: "taxOtPct", source: "resource.percent (UNVERIFIED meaning)", verified: false },
  { header: "Pcs/Wste", key: "pcsWste", source: "resource.pieces (UNVERIFIED for waste)", verified: false },
  { header: "Total", key: "total", source: "resource.total × the same factor / sharing split", verified: true },
  { header: "Rent%", key: "rentPct", source: "resource.rentPercent", verified: true },
  { header: "EOE%", key: "eoePct", source: "resource.operatingPercent (UNVERIFIED mapping)", verified: false },
  { header: "Supp Desc", key: "suppDesc", source: "resource.supplementalDescription", verified: true },
  { header: "EOE", key: "eoe", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
  { header: "Burden", key: "burden", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
  { header: "Burden%", key: "burdenPct", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
];

const COST_KEYS = ["unitCost", "total", "eoe", "burden"];

function reportRow(line: Line): Rec {
  const row: Rec = {};
  for (const c of COLUMNS) row[c.key] = (line as Rec)[c.key] ?? null;
  return row;
}

export async function costBreakdown(hcss: HcssClient, bu: string, estimateId: string, cap: number, hideCost: boolean) {
  const f = { $filter: `estimateId eq ${estimateId}` };
  const base = `/businessunits/${bu}`;
  // Sequential on purpose: low concurrency against HCSS's shared 20-concurrent / 100-per-minute company limit.
  const bi = await hcss.getAll<Rec>(`${base}/biditems`, f, cap);
  const ac = await hcss.getAll<Rec>(`${base}/activities`, f, cap);
  const rs = await hcss.getAll<Rec>(`${base}/resources`, f, cap);
  const truncated = bi.truncated || ac.truncated || rs.truncated;
  const adj = adjustedLines(bi.records, ac.records, rs.records);
  const rows = adj.lines.map(reportRow);
  if (hideCost) for (const row of rows) for (const k of COST_KEYS) row[k] = "[hidden]";
  let reconciliation: Reconciliation = adj.reconciliation;
  if (hideCost) reconciliation = { ...reconciliation, note: "Costs are hidden; reconciliation amounts were not returned." };
  else if (truncated) reconciliation = { ...reconciliation, note: [reconciliation.note, "Lists were truncated at the row cap; this check may be incomplete."].filter(Boolean).join(" ") };
  return {
    rows,
    warnings: hideCost ? [] : capWarnings(adj.warnings),
    reconciliation,
    truncated,
    counts: { biditems: bi.records.length, activities: ac.records.length, resources: rs.records.length },
  };
}

export function toCsv(rows: Rec[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.map((c) => c.header).join(","), ...rows.map((r) => COLUMNS.map((c) => esc(r[c.key])).join(","))].join("\r\n");
}
