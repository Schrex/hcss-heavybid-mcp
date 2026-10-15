import type { HcssClient } from "./hcss.js";

type Rec = Record<string, any>; // eslint-disable-line

/** Columns of HeavyBid's "bid item > activity > resource" cost report, mapped to Estimate Insights fields. */
export const COLUMNS: { header: string; key: string; source: string; verified: boolean }[] = [
  { header: "Biditem", key: "biditem", source: "biditem.biditemCode", verified: true },
  { header: "Bid Desc", key: "bidDesc", source: "biditem.description", verified: true },
  { header: "Activity", key: "activity", source: "activity.activityCode", verified: true },
  { header: "Actv Desc", key: "actvDesc", source: "activity.description", verified: true },
  { header: "Resource", key: "resource", source: "resource.resourceCode", verified: true },
  { header: "Description", key: "description", source: "resource.description", verified: true },
  { header: "Quantity", key: "quantity", source: "resource.quantity", verified: true },
  { header: "Unit", key: "unit", source: "resource.units", verified: true },
  { header: "Unit Cost", key: "unitCost", source: "resource.unitPrice", verified: true },
  { header: "Tax/OT%", key: "taxOtPct", source: "resource.percent (UNVERIFIED meaning)", verified: false },
  { header: "Pcs/Wste", key: "pcsWste", source: "resource.pieces (UNVERIFIED for waste)", verified: false },
  { header: "Total", key: "total", source: "resource.total", verified: true },
  { header: "Rent%", key: "rentPct", source: "resource.rentPercent", verified: true },
  { header: "EOE%", key: "eoePct", source: "resource.operatingPercent (UNVERIFIED mapping)", verified: false },
  { header: "Supp Desc", key: "suppDesc", source: "resource.supplementalDescription", verified: true },
  { header: "EOE", key: "eoe", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
  { header: "Burden", key: "burden", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
  { header: "Burden%", key: "burdenPct", source: "not in resource schema (UNVERIFIED; blank)", verified: false },
];

const COST_KEYS = ["unitCost", "total", "eoe", "burden"];

export async function costBreakdown(hcss: HcssClient, bu: string, estimateId: string, cap: number, hideCost: boolean) {
  const f = { $filter: `estimateId eq ${estimateId}` };
  const base = `/businessunits/${bu}`;
  // Sequential on purpose: low concurrency against HCSS's shared 20-concurrent / 100-per-minute company limit.
  const bi = await hcss.getAll<Rec>(`${base}/biditems`, f, cap);
  const ac = await hcss.getAll<Rec>(`${base}/activities`, f, cap);
  const rs = await hcss.getAll<Rec>(`${base}/resources`, f, cap);
  const biById = new Map(bi.records.map((b) => [b.id, b]));
  const acById = new Map(ac.records.map((a) => [a.id, a]));

  const rows = rs.records.map((r) => {
    const a = acById.get(r.activityId) ?? {};
    const b = biById.get(r.biditemId ?? a.biditemId) ?? {};
    const row: Rec = {
      biditem: b.biditemCode ?? r.biditemCode ?? null,
      bidDesc: b.description ?? null,
      activity: a.activityCode ?? r.activityCode ?? null,
      actvDesc: a.description ?? null,
      resource: r.resourceCode ?? null,
      description: r.description ?? null,
      quantity: r.quantity ?? null,
      unit: r.units ?? null,
      unitCost: r.unitPrice ?? null,
      taxOtPct: r.percent ?? null,
      pcsWste: r.pieces ?? null,
      total: r.total ?? null,
      rentPct: r.rentPercent ?? null,
      eoePct: r.operatingPercent ?? null,
      suppDesc: r.supplementalDescription ?? null,
      eoe: null,
      burden: null,
      burdenPct: null,
      _sort: [b.sortCode ?? b.biditemCode ?? "", a.activityCode ?? "", r.resourceCode ?? ""].join("\u0000"),
    };
    if (hideCost) for (const k of COST_KEYS) row[k] = "[hidden]";
    return row;
  });
  rows.sort((x, y) => (x._sort < y._sort ? -1 : x._sort > y._sort ? 1 : 0));
  for (const r of rows) delete r._sort;
  return {
    rows,
    truncated: bi.truncated || ac.truncated || rs.truncated,
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
