// HeavyBid stores resource quantity and total BEFORE the Bid/TO factor.
// resource.factor / activity.factor is that multiplier (bid quantity ÷ takeoff quantity,
// or the inverse — both are tried). A shared activity is either copied onto each bid item
// at the full quantity, or stored once on an owner bid item. We apply a factor or a split
// only when the activity's lines then match HeavyBid's own directTotal within $1.
// Otherwise the raw lines are returned and the tool warns. Nothing is scaled "blind".

export const RECONCILE_TOLERANCE = 1;

export type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Line {
  biditem: unknown;
  bidDesc: unknown;
  activity: unknown;
  actvDesc: unknown;
  resource: unknown;
  description: unknown;
  quantity: number | null;
  unit: unknown;
  unitCost: number | null;
  taxOtPct: unknown;
  pcsWste: unknown;
  total: number | null;
  rentPct: unknown;
  eoePct: unknown;
  suppDesc: unknown;
  eoe: null;
  burden: null;
  burdenPct: null;
  _sort: string;
  /** Bid-item sort code. Ordering only; not part of the rollup. */
  sortCode: unknown;
  /** Raw resource.subTypeCost. The report scales it by appliedFactor; the rollup does not read it. */
  subTypeCost: number | null;
  /** Bid/TO multiplier times sharing share already applied to quantity and total. */
  appliedFactor: number;
  activityId: string | null;
  biditemId: string | null;
  typeCost: string | null;
  skip: boolean;
  nonAdditive: boolean;
}

export interface Check {
  kind: "biditem" | "activity" | "material";
  label: string;
  connector: number;
  heavybid: number | null;
  checked: boolean;
  ok: boolean;
}

export interface Reconciliation {
  tolerance_dollars: number;
  heavybid_field: string;
  biditems_checked: number;
  biditems_failed: number;
  activities_checked: number;
  activities_failed: number;
  note?: string;
}

export interface Adjustment {
  lines: Line[];
  warnings: string[];
  checks: Check[];
  reconciliation: Reconciliation;
}

type Mode = "raw" | "factor" | "activity" | "inverse" | "inverse-activity";

const MODES: Mode[] = ["raw", "factor", "activity", "inverse", "inverse-activity"];

interface Attempt {
  mode: Mode;
  shares: Map<string, number> | null;
}

interface Plan {
  target: Rec;
  source: Rec;
  resources: Rec[];
  mode: Mode;
  share: number;
}

export function isZeroRate(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n === 0;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A usable Bid/TO factor. 0 and blanks mean "not set" (HCSS examples use 0 for unused numbers). */
function finiteFactor(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n;
}

function heavybidDirect(row: Rec | undefined): number | null {
  if (!row) return null;
  const v = row.directTotal;
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isSkip(resource: Rec): boolean {
  return String(resource.skipCost ?? "").trim().toUpperCase() === "Y";
}

function isNonAdditive(activity: Rec | undefined): boolean {
  return String(activity?.nonAdditive ?? "").trim().toUpperCase() === "Y";
}

function factorable(resource: Rec, activity: Rec | undefined): boolean {
  const flag = resource.factorable != null && resource.factorable !== ""
    ? resource.factorable
    : activity?.factorable;
  return String(flag ?? "").trim().toUpperCase() !== "N";
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundQty(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function within(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= RECONCILE_TOLERANCE + 1e-6;
}

export function formatMoney(n: number): string {
  const neg = n < 0;
  const [dollars, cents] = Math.abs(n).toFixed(2).split(".");
  return `${neg ? "-" : ""}$${dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

function resourceMultiplier(resource: Rec, activity: Rec | undefined, mode: Mode): number {
  if (!factorable(resource, activity)) return 1;
  const fromResource = finiteFactor(resource.factor);
  const fromActivity = finiteFactor(activity?.factor);
  const res = fromResource ?? fromActivity ?? 1;
  const act = fromActivity ?? 1;
  switch (mode) {
    case "raw": return 1;
    case "factor": return res;
    case "activity": return act;
    case "inverse": return 1 / res;
    case "inverse-activity": return 1 / act;
    default: return 1;
  }
}

function sumCost(resources: Rec[], activity: Rec | undefined, mode: Mode, share: number): number {
  let s = 0;
  for (const r of resources) {
    if (isSkip(r)) continue;
    s += roundMoney(num(r.total) * resourceMultiplier(r, activity, mode) * share);
  }
  return roundMoney(s);
}

function codeKey(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function fingerprint(resources: Rec[]): string {
  return resources
    .map((r) => [codeKey(r.resourceCode), num(r.quantity), num(r.unitPrice), num(r.total), codeKey(r.units), codeKey(r.typeCost), codeKey(r.skipCost)].join("|"))
    .sort()
    .join("\n");
}

function sharesFromWeights(ids: string[], weights: number[]): Map<string, number> | null {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const map = new Map<string, number>();
  ids.forEach((id, i) => map.set(id, weights[i] / sum));
  return map;
}

function quantityShares(activities: Rec[]): Map<string, number> | null {
  return sharesFromWeights(activities.map((a) => String(a.id)), activities.map((a) => Math.abs(num(a.quantity))));
}

function directShares(activities: Rec[]): Map<string, number> | null {
  if (!activities.every((a) => heavybidDirect(a) !== null)) return null;
  return sharesFromWeights(activities.map((a) => String(a.id)), activities.map((a) => Math.abs(heavybidDirect(a) ?? 0)));
}

/** True when every activity that has a HeavyBid directTotal lands within tolerance. False if none do. */
function reconciles(activities: Rec[], resourcesOf: (a: Rec) => Rec[], mode: Mode, shares: Map<string, number> | null, factorActivity: (a: Rec) => Rec): boolean {
  let saw = false;
  for (const a of activities) {
    const hb = heavybidDirect(a);
    if (hb === null) continue;
    saw = true;
    const share = shares?.get(String(a.id)) ?? 1;
    const cost = sumCost(resourcesOf(a), factorActivity(a), mode, share);
    if (!within(cost, hb)) return false;
  }
  return saw;
}

function chooseAttempt(activities: Rec[], resourcesOf: (a: Rec) => Rec[]): Attempt {
  const attempts: Attempt[] = [];
  for (const mode of MODES) {
    attempts.push({ mode, shares: null });
    if (activities.length > 1) {
      const byQuantity = quantityShares(activities);
      if (byQuantity) attempts.push({ mode, shares: byQuantity });
      const byDirect = directShares(activities);
      if (byDirect) attempts.push({ mode, shares: byDirect });
    }
  }
  for (const attempt of attempts) {
    if (reconciles(activities, resourcesOf, attempt.mode, attempt.shares, (a) => a)) return attempt;
  }
  return { mode: "raw", shares: null };
}

function chooseSplit(owner: Rec, empties: Rec[], resources: Rec[]): { mode: Mode; shares: Map<string, number> } | null {
  const members = [owner, ...empties];
  if (!members.every((a) => heavybidDirect(a) !== null)) return null;
  const ids = members.map((a) => String(a.id));
  const weightSets = [
    members.map((a) => Math.abs(heavybidDirect(a) ?? 0)),
    members.map((a) => Math.abs(num(a.quantity))),
  ];
  const resourcesOf = () => resources;
  for (const mode of MODES) {
    for (const weights of weightSets) {
      const shares = sharesFromWeights(ids, weights);
      if (!shares) continue;
      if (reconciles(members, resourcesOf, mode, shares, () => owner)) return { mode, shares };
    }
  }
  return null;
}

function buildLine(resource: Rec, source: Rec, target: Rec, bid: Rec, mode: Mode, share: number): Line {
  const mult = resourceMultiplier(resource, source, mode) * share;
  const quantity = resource.quantity === null || resource.quantity === undefined || resource.quantity === ""
    ? null
    : roundQty(num(resource.quantity) * mult);
  const total = resource.total === null || resource.total === undefined || resource.total === ""
    ? null
    : roundMoney(num(resource.total) * mult);
  const bidCode = bid.biditemCode ?? resource.biditemCode ?? null;
  const actCode = target.activityCode ?? source.activityCode ?? resource.activityCode ?? null;
  return {
    biditem: bidCode,
    bidDesc: bid.description ?? null,
    activity: actCode,
    actvDesc: target.description ?? source.description ?? null,
    resource: resource.resourceCode ?? null,
    description: resource.description ?? null,
    quantity,
    unit: resource.units ?? null,
    unitCost: resource.unitPrice === undefined ? null : resource.unitPrice,
    taxOtPct: resource.percent === undefined ? null : resource.percent,
    pcsWste: resource.pieces === undefined ? null : resource.pieces,
    total,
    rentPct: resource.rentPercent === undefined ? null : resource.rentPercent,
    eoePct: resource.operatingPercent === undefined ? null : resource.operatingPercent,
    suppDesc: resource.supplementalDescription === undefined ? null : resource.supplementalDescription,
    eoe: null,
    burden: null,
    burdenPct: null,
    _sort: [bid.sortCode ?? bidCode ?? "", actCode ?? "", resource.resourceCode ?? ""].join("\u0000"),
    sortCode: bid.sortCode ?? bidCode ?? null,
    subTypeCost: resource.subTypeCost === null || resource.subTypeCost === undefined || resource.subTypeCost === ""
      ? null
      : num(resource.subTypeCost),
    appliedFactor: mult,
    activityId: target.id ?? null,
    biditemId: (target.biditemId ?? bid.id ?? resource.biditemId ?? null) as string | null,
    typeCost: resource.typeCost == null || resource.typeCost === "" ? null : String(resource.typeCost),
    skip: isSkip(resource),
    nonAdditive: isNonAdditive(target),
  };
}

function plansFor(activities: Rec[], resourcesByActivity: Map<string, Rec[]>): Plan[] {
  const groups = new Map<string, Rec[]>();
  for (const a of activities) {
    const key = codeKey(a.activityCode) ? `code:${codeKey(a.activityCode)}` : `id:${a.id}`;
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }

  const plans: Plan[] = [];
  for (const group of groups.values()) {
    const nonEmpty = group.filter((a) => (resourcesByActivity.get(String(a.id)) ?? []).length > 0);
    const empties = group.filter((a) => (resourcesByActivity.get(String(a.id)) ?? []).length === 0);
    const clusters = new Map<string, Rec[]>();
    for (const a of nonEmpty) {
      const fp = fingerprint(resourcesByActivity.get(String(a.id)) ?? []);
      const list = clusters.get(fp) ?? [];
      list.push(a);
      clusters.set(fp, list);
    }

    const clusterPlans = new Map<string, Plan[]>();
    for (const cluster of clusters.values()) {
      const resourcesOf = (a: Rec) => resourcesByActivity.get(String(a.id)) ?? [];
      const attempt = chooseAttempt(cluster, resourcesOf);
      clusterPlans.set(String(cluster[0].id), cluster.map((a) => ({
        target: a,
        source: a,
        resources: resourcesOf(a),
        mode: attempt.mode,
        share: attempt.shares?.get(String(a.id)) ?? 1,
      })));
    }

    const onlyOwner = nonEmpty.length === 1 && empties.length > 0 && clusters.size === 1;
    if (onlyOwner) {
      const owner = nonEmpty[0];
      const resources = resourcesByActivity.get(String(owner.id)) ?? [];
      const ownerAttempt = chooseAttempt([owner], () => resources);
      const ownerOk = reconciles([owner], () => resources, ownerAttempt.mode, null, (a) => a);
      const split = ownerOk ? null : chooseSplit(owner, empties, resources);
      if (split) {
        for (const member of [owner, ...empties]) {
          plans.push({
            target: member,
            source: owner,
            resources,
            mode: split.mode,
            share: split.shares.get(String(member.id)) ?? 0,
          });
        }
        continue;
      }
    }

    for (const list of clusterPlans.values()) plans.push(...list);
  }
  return plans;
}

function warningFor(check: Check): string {
  return `${check.label} does not reconcile with HeavyBid: connector ${formatMoney(check.connector)} vs HeavyBid ${formatMoney(check.heavybid ?? 0)}.`;
}

function summarize(checks: Check[], field: string): Reconciliation {
  const bid = checks.filter((c) => c.kind === "biditem");
  const act = checks.filter((c) => c.kind === "activity");
  const bidChecked = bid.filter((c) => c.checked);
  const actChecked = act.filter((c) => c.checked);
  const noteParts = [
    bidChecked.length + actChecked.length === 0
      ? "No HeavyBid directTotal on these bid items or activities, so the rollup was not checked."
      : "",
  ].filter(Boolean);
  const reconciliation: Reconciliation = {
    tolerance_dollars: RECONCILE_TOLERANCE,
    heavybid_field: field,
    biditems_checked: bidChecked.length,
    biditems_failed: bidChecked.filter((c) => !c.ok).length,
    activities_checked: actChecked.length,
    activities_failed: actChecked.filter((c) => !c.ok).length,
  };
  if (noteParts.length) reconciliation.note = noteParts.join(" ");
  return reconciliation;
}

export function adjustedLines(biditems: Rec[], activities: Rec[], resources: Rec[]): Adjustment {
  const bidById = new Map(biditems.map((b) => [String(b.id), b]));
  const activityById = new Map(activities.map((a) => [String(a.id), a]));
  const resourcesByActivity = new Map<string, Rec[]>();
  const orphans: Rec[] = [];
  for (const r of resources) {
    const id = r.activityId == null ? "" : String(r.activityId);
    if (!id || !activityById.has(id)) { orphans.push(r); continue; }
    const list = resourcesByActivity.get(id) ?? [];
    list.push(r);
    resourcesByActivity.set(id, list);
  }

  const plans = plansFor(activities, resourcesByActivity);
  const lines: Line[] = [];
  for (const plan of plans) {
    const bid = bidById.get(String(plan.target.biditemId ?? "")) ?? bidById.get(String(plan.source.biditemId ?? "")) ?? {};
    for (const resource of plan.resources) {
      lines.push(buildLine(resource, plan.source, plan.target, bid, plan.mode, plan.share));
    }
  }
  for (const resource of orphans) {
    const bid = bidById.get(String(resource.biditemId ?? "")) ?? {};
    lines.push(buildLine(resource, {}, {}, bid, "raw", 1));
  }
  lines.sort((x, y) => (x._sort < y._sort ? -1 : x._sort > y._sort ? 1 : 0));

  const checks: Check[] = [];
  const activityHasBid = new Set(activities.map((a) => String(a.biditemId ?? "")).filter(Boolean));
  for (const b of biditems) {
    const id = String(b.id ?? "");
    const ownsActivity = activityHasBid.has(id);
    const ownsLine = lines.some((l) => l.biditemId === id);
    if (!ownsActivity && !ownsLine) continue;
    const connector = roundMoney(lines
      .filter((l) => l.biditemId === id && !l.skip && !l.nonAdditive)
      .reduce((s, l) => s + (l.total ?? 0), 0));
    const hb = heavybidDirect(b);
    const label = `Bid item ${codeKey(b.biditemCode) || id}`;
    checks.push({ kind: "biditem", label, connector, heavybid: hb, checked: hb !== null, ok: hb === null || within(connector, hb) });
  }
  for (const a of activities) {
    const id = String(a.id ?? "");
    const connector = roundMoney(lines
      .filter((l) => l.activityId === id && !l.skip)
      .reduce((s, l) => s + (l.total ?? 0), 0));
    const hb = heavybidDirect(a);
    const bid = bidById.get(String(a.biditemId ?? ""));
    const bidCode = codeKey(bid?.biditemCode ?? a.biditemCode);
    const actCode = codeKey(a.activityCode) || id;
    const label = bidCode ? `Activity ${bidCode} / ${actCode}` : `Activity ${actCode}`;
    checks.push({ kind: "activity", label, connector, heavybid: hb, checked: hb !== null, ok: hb === null || within(connector, hb) });
  }

  const warnings = checks.filter((c) => c.checked && !c.ok).map(warningFor);
  return { lines, warnings, checks, reconciliation: summarize(checks, "directTotal") };
}

function materialField(materialType: "permanent" | "construction"): string {
  return materialType === "construction" ? "constructionMaterial" : "permanentMaterial";
}

function materialLabel(code: string, materialType: "permanent" | "construction"): string {
  const kind = materialType === "construction" ? "construction" : "permanent";
  return `Bid item ${code} ${kind} material`;
}

interface Grouped {
  biditemId: string | null;
  biditemCode: unknown;
  activityId: string | null;
  activityCode: unknown;
  unit: unknown;
  unitCost: number | null;
  quantity: number;
  total: number;
}

function groupMaterialLines(lines: Line[]): Grouped[] {
  const groups = new Map<string, Grouped>();
  for (const line of lines) {
    const key = `${line.activityId ?? ""}\0${line.biditemId ?? ""}\0${codeKey(line.biditem)}`;
    const g = groups.get(key) ?? {
      biditemId: line.biditemId,
      biditemCode: line.biditem,
      activityId: line.activityId,
      activityCode: line.activity,
      unit: line.unit,
      unitCost: line.unitCost,
      quantity: 0,
      total: 0,
    };
    g.quantity = roundQty(g.quantity + (line.quantity ?? 0));
    g.total = roundMoney(g.total + (line.total ?? 0));
    if (g.unitCost == null) g.unitCost = line.unitCost;
    groups.set(key, g);
  }
  return [...groups.values()];
}

function lineKey(activityId: unknown, biditemId: unknown): string {
  return `${activityId ?? ""}\0${biditemId ?? ""}`;
}

/** Replace material bid-item totals with the adjusted resource lines. Drops $0 rates when pricedOnly. */
export function applyMaterialAdjustments(
  records: Rec[],
  lines: Line[],
  opts: { materialType: "permanent" | "construction"; pricedOnly: boolean },
): Rec[] {
  const type = opts.materialType === "construction" ? "C" : "P";
  const typed = lines.filter((l) => (l.typeCost ?? "").toUpperCase() === type && !l.skip);
  const copy = JSON.parse(JSON.stringify(records)) as Rec[];
  const nested = copy.some((r) => Array.isArray(r?.materials));
  if (nested) {
    for (const rec of copy) {
      if (Array.isArray(rec.materials)) rec.materials = adjustMaterialList(rec.materials, typed, opts.pricedOnly);
    }
    return copy;
  }
  return adjustMaterialList(copy, typed, opts.pricedOnly);
}

function adjustMaterialList(materials: Rec[], typed: Line[], pricedOnly: boolean): Rec[] {
  const byCode = new Map<string, Line[]>();
  for (const line of typed) {
    const code = codeKey(line.resource);
    if (!code) continue;
    const list = byCode.get(code) ?? [];
    list.push(line);
    byCode.set(code, list);
  }
  const adjusted = materials.map((material) => {
    const matched = byCode.get(codeKey(material.resourceCode)) ?? [];
    if (matched.length === 0) return material;
    const groups = groupMaterialLines(matched);
    const previous = new Map<string, Rec>();
    for (const row of Array.isArray(material.biditems) ? material.biditems as Rec[] : []) {
      previous.set(lineKey(row.activityId, row.biditemId), row);
    }
    const template = (Array.isArray(material.biditems) ? material.biditems[0] : null) ?? {};
    material.biditems = groups.map((g) => {
      const prev = previous.get(lineKey(g.activityId, g.biditemId)) ?? {};
      return {
        percent: template.percent,
        escalationPercent: template.escalationPercent,
        units: template.units ?? g.unit,
        ...prev,
        biditemId: g.biditemId,
        biditemCode: prev.biditemCode ?? g.biditemCode,
        activityId: g.activityId,
        activityCode: prev.activityCode ?? g.activityCode,
        quantity: g.quantity,
        unitCost: prev.unitCost ?? g.unitCost ?? material.unitCost ?? null,
        total: g.total,
      };
    });
    material.total = roundMoney((material.biditems as Rec[]).reduce((s, row) => s + num(row.total), 0));
    return material;
  });
  if (!pricedOnly) return adjusted;
  return adjusted.filter((material) => !isZeroRate(material.unitCost)).map((material) => {
    if (!Array.isArray(material.biditems)) return material;
    const biditems = (material.biditems as Rec[]).filter((row) => !isZeroRate(row.unitCost));
    return { ...material, biditems, total: roundMoney(biditems.reduce((s, row) => s + num(row.total), 0)) };
  });
}

export function materialReconciliation(
  records: Rec[],
  biditems: Rec[],
  materialType: "permanent" | "construction",
): { warnings: string[]; checks: Check[]; reconciliation: Reconciliation } {
  const field = materialField(materialType);
  const totals = new Map<string, number>();
  const materials = records.flatMap((r) => Array.isArray(r?.materials) ? r.materials as Rec[] : [r]);
  for (const material of materials) {
    const rows = Array.isArray(material?.biditems) ? material.biditems as Rec[] : [];
    for (const row of rows) {
      const id = row.biditemId == null ? "" : String(row.biditemId);
      if (!id) continue;
      totals.set(id, roundMoney((totals.get(id) ?? 0) + num(row.total)));
    }
  }
  const checks: Check[] = [];
  for (const b of biditems) {
    const hbRaw = b[field];
    if (hbRaw === null || hbRaw === undefined || hbRaw === "") continue;
    const hb = num(hbRaw);
    const id = String(b.id ?? "");
    const connector = totals.get(id) ?? 0;
    if (connector === 0 && hb === 0) continue;
    const label = materialLabel(codeKey(b.biditemCode) || id, materialType);
    checks.push({ kind: "material", label, connector, heavybid: hb, checked: true, ok: within(connector, hb) });
  }
  const warnings = checks.filter((c) => !c.ok).map(warningFor);
  const failed = checks.filter((c) => !c.ok).length;
  const reconciliation: Reconciliation = {
    tolerance_dollars: RECONCILE_TOLERANCE,
    heavybid_field: field,
    biditems_checked: checks.length,
    biditems_failed: failed,
    activities_checked: 0,
    activities_failed: 0,
  };
  if (checks.length === 0) reconciliation.note = `No HeavyBid ${field} on these bid items, so the material list was not checked.`;
  return { warnings, checks, reconciliation };
}

export function capWarnings(warnings: string[], cap = 100): string[] {
  if (warnings.length <= cap) return warnings;
  return [...warnings.slice(0, cap), `and ${warnings.length - cap} more do not reconcile with HeavyBid.`];
}
