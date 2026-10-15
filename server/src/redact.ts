// OPTIONAL switch (HCSS_HIDE_COST_RATES, default false). Field names from the HCSS OpenAPI schemas.
// When on, hides labor, burden, equipment (company, rented, EOE) dollars.

const ESTIMATE_TOTALS_PREFIXES = [
  "baseLabor_", "burden_", "totalLabor_", "companyEquipment_", "rentedEquipment_",
  "equipmentOperatingExpense_", "totalEqp_",
];
const BIDITEM_FIELDS = ["labor", "burden"];
const ACTIVITY_FIELDS = [
  "labor", "burden", "crewCost", "crewCost_WithMaterial", "companyEquipment", "rentedEquipment",
  "equipmentOperatingExpense", "directTotal",
];
// Resource unitPrice/total are where loaded labor & equipment hourly rates live. We hide them for every
// resource because the typeCost code values are not yet confirmed (UNVERIFIED) and could not be filtered safely.
const RESOURCE_FIELDS = ["unitPrice", "total", "subTypeCost"];

const MARK = "[hidden: HCSS_HIDE_COST_RATES]";

type Rec = Record<string, unknown>;

function strip(o: Rec, fields: string[]) {
  for (const f of fields) if (f in o) o[f] = MARK;
}

export function redactEstimate(e: Rec): Rec {
  const totals = e.totals as Rec | undefined;
  if (totals) for (const k of Object.keys(totals)) {
    if (ESTIMATE_TOTALS_PREFIXES.some((p) => k.startsWith(p))) totals[k] = MARK;
  }
  return e;
}
export const redactBiditem = (b: Rec) => (strip(b, BIDITEM_FIELDS), b);
export const redactActivity = (a: Rec) => (strip(a, ACTIVITY_FIELDS), a);
export const redactResource = (r: Rec) => (strip(r, RESOURCE_FIELDS), r);
