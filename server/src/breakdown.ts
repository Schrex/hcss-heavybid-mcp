import { codeCompare, normCode, type HcssClient } from "./hcss.js";
import { adjustedLines, capWarnings, roundMoney, type Line, type Reconciliation } from "./factor.js";

type Rec = Record<string, any>; // eslint-disable-line

/** Columns of HeavyBid's "bid item > activity > resource" cost report, mapped to Estimate Insights fields. */
export const COLUMNS: { header: string; key: string; source: string; verified: boolean }[] = [
  { header: "Biditem", key: "biditem", source: "biditem.biditemCode (trimmed)", verified: true },
  { header: "Bid Desc", key: "bidDesc", source: "biditem.description", verified: true },
  { header: "Activity", key: "activity", source: "activity.activityCode (trimmed)", verified: true },
  { header: "Actv Desc", key: "actvDesc", source: "activity.description", verified: true },
  { header: "Resource", key: "resource", source: "resource.resourceCode", verified: true },
  { header: "Description", key: "description", source: "resource.description", verified: true },
  { header: "Quantity", key: "quantity", source: "resource.quantity × HeavyBid Bid/TO factor (and a sharing split only when that matches the activity direct total)", verified: true },
  { header: "Unit", key: "unit", source: "resource.units", verified: true },
  { header: "Unit Cost", key: "unitCost", source: "resource.unitPrice", verified: true },
  { header: "Tax/OT%", key: "taxOtPct", source: "resource.percent - 100 (HCSS stores a multiplier: 108 = 8% tax on materials, 110 = 10% overtime on labor). UNVERIFIED mapping; blank when 0/null", verified: false },
  { header: "Pcs/Wste", key: "pcsWste", source: "resource.pieces (UNVERIFIED mapping: may be pieces, not waste)", verified: false },
  { header: "Total", key: "total", source: "resource.total × the same factor / sharing split", verified: true },
  { header: "Rent%", key: "rentPct", source: "resource.rentPercent", verified: true },
  { header: "EOE%", key: "eoePct", source: "resource.operatingPercent (UNVERIFIED mapping: check against the HeavyBid report)", verified: false },
  { header: "Supp Desc", key: "suppDesc", source: "resource.supplementalDescription", verified: true },
  { header: "EOE", key: "eoe", source: "resource.subTypeCost for equipment (typeCost E), per HCSS docs, times the same Bid/TO factor and sharing split as Total. UNVERIFIED against report. Otherwise 'not available from HeavyBid API'", verified: false },
  { header: "Burden", key: "burden", source: "resource.subTypeCost for labor (typeCost L), per HCSS docs, times the same Bid/TO factor and sharing split as Total. UNVERIFIED against report. Burden is already included in the labor line Total. Otherwise 'not available from HeavyBid API'", verified: false },
  { header: "Burden%", key: "burdenPct", source: "not available from HeavyBid API (burden is already included in labor Total)", verified: true },
];

const COST_KEYS = ["unitCost", "total", "eoe", "burden"];
/** resource.percent is a multiplier (108 = +8%). Returns the adjustment (8), or undefined when 0/null. UNVERIFIED. */
export const percentAdj = (p: unknown): number | undefined => {
  const n = Number(p);
  return p == null || !Number.isFinite(n) || n <= 0 ? undefined : Math.round((n - 100) * 1e4) / 1e4;
};
/** Clearly named field for the adjustment by resource type: tax for materials, overtime for labor. */
export const percentField = (typeCost: unknown) => {
  const t = String(typeCost ?? "").trim().toUpperCase();
  return t === "P" || t === "C" ? "tax_percent" : t === "L" ? "overtime_factor_percent" : "percent_adjustment";
};
export const NA = "not available from HeavyBid API";

function subtypeDollars(line: Line): number | null {
  if (line.subTypeCost == null) return null;
  // Factor 1 (no Bid/TO scale and no sharing split) keeps the raw HCSS value.
  if (line.appliedFactor === 1) return line.subTypeCost;
  return roundMoney(line.subTypeCost * line.appliedFactor);
}

function reportRow(line: Line): Rec {
  const taxOtPct = percentAdj(line.taxOtPct) ?? null;
  const subtype = subtypeDollars(line);
  const row: Rec = {
    biditem: normCode(line.biditem) || null,
    bidDesc: line.bidDesc ?? null,
    activity: normCode(line.activity) || null,
    actvDesc: line.actvDesc ?? null,
    resource: line.resource ?? null,
    description: line.description ?? null,
    quantity: line.quantity ?? null,
    unit: line.unit ?? null,
    unitCost: line.unitCost ?? null,
    taxOtPct,
    pcsWste: line.pcsWste ?? null,
    total: line.total ?? null,
    rentPct: line.rentPct ?? null,
    eoePct: line.eoePct ?? null,
    suppDesc: line.suppDesc ?? null,
    typeCost: line.typeCost ?? null,
    eoe: line.typeCost === "E" && subtype != null ? subtype : NA,
    burden: line.typeCost === "L" && subtype != null ? subtype : NA,
    burdenPct: NA,
    _s: [line.sortCode ?? line.biditem, line.activity, line.resource],
  };
  if (row.taxOtPct != null) row[percentField(line.typeCost)] = row.taxOtPct;
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
  rows.sort((x, y) => codeCompare(x._s[0], y._s[0]) || codeCompare(x._s[1], y._s[1]) || codeCompare(x._s[2], y._s[2]));
  for (const row of rows) {
    delete row._s;
    if (hideCost) for (const k of COST_KEYS) if (row[k] !== NA) row[k] = "[hidden]";
  }
  let reconciliation: Reconciliation = adj.reconciliation;
  if (hideCost) reconciliation = { ...reconciliation, note: "Costs are hidden; reconciliation amounts were not returned." };
  else if (truncated) reconciliation = { ...reconciliation, note: [reconciliation.note, "Lists were truncated at the row cap; this check may be incomplete."].filter(Boolean).join(" ") };
  return {
    rows,
    warnings: hideCost ? [] : capWarnings(adj.warnings),
    reconciliation,
    truncated,
    biditemCodes: bi.records.map((x) => normCode(x.biditemCode)).filter(Boolean).sort(codeCompare),
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
