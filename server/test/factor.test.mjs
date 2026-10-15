// Fixture totals follow the Fairways shape (bid items 4015 and 4050 share one activity;
// another activity is scaled by a Bid/TO factor). They are not live HeavyBid dollars.
import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustedLines, applyMaterialAdjustments, capWarnings, formatMoney, isZeroRate, materialReconciliation,
} from "../dist-test/factor.js";

const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const B2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const A3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function bid(id, code, direct, extra = {}) {
  return { id, biditemCode: code, description: `Bid ${code}`, sortCode: code, directTotal: direct, ...extra };
}
function act(id, biditemId, code, direct, extra = {}) {
  return { id, biditemId, activityCode: code, description: code, quantity: 1, directTotal: direct, factorable: "Y", ...extra };
}
function res(activityId, biditemId, total, extra = {}) {
  return {
    id: extra.id ?? `r-${activityId}-${total}`, activityId, biditemId, resourceCode: extra.resourceCode ?? "MAT",
    description: "Aggregate", quantity: extra.quantity ?? 1000, units: "TN", unitPrice: extra.unitPrice ?? 10,
    total, typeCost: extra.typeCost ?? "P", factorable: extra.factorable ?? "Y", percent: 8.25, pieces: 5,
    operatingPercent: 50, ...extra,
  };
}

test("plain activity is unchanged when it already matches HeavyBid", () => {
  const out = adjustedLines(
    [bid(B1, "10", 4440)],
    [act(A1, B1, "10.1", 4440)],
    [res(A1, B1, 4440, { quantity: 80, unitPrice: 55.5, resourceCode: "LAB" })],
  );
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].total, 4440);
  assert.equal(out.lines[0].quantity, 80);
  assert.equal(out.lines[0].unitCost, 55.5);
  assert.equal(out.lines[0].taxOtPct, 8.25);
  assert.equal(out.lines[0].pcsWste, 5);
  assert.equal(out.lines[0].eoePct, 50);
  assert.equal(out.lines[0].eoe, null);
  assert.equal(out.lines[0].burden, null);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.reconciliation.biditems_failed, 0);
});

test("scaled activity applies the Bid/TO factor", () => {
  const out = adjustedLines(
    [bid(B1, "200", 1000)],
    [act(A1, B1, "SCALE", 1000, { factor: 0.1, quantity: 100 })],
    [res(A1, B1, 10000, { quantity: 1000, unitPrice: 10, factor: 0.1 })],
  );
  assert.equal(out.lines[0].total, 1000);
  assert.equal(out.lines[0].quantity, 100);
  assert.equal(out.lines[0].unitCost, 10);
  assert.equal(out.lines[0].pcsWste, 5);
  assert.equal(out.warnings.length, 0);
});

test("factor stored as takeoff/bid (10) is applied as its inverse", () => {
  const out = adjustedLines(
    [bid(B1, "200", 1000)],
    [act(A1, B1, "SCALE", 1000, { factor: 10 })],
    [res(A1, B1, 10000, { factor: 10 })],
  );
  assert.equal(out.lines[0].total, 1000);
  assert.equal(out.warnings.length, 0);
});

test("activity factor is used when the resource factor is 1", () => {
  const out = adjustedLines(
    [bid(B1, "200", 2000)],
    [act(A1, B1, "SCALE", 2000, { factor: 0.25 })],
    [res(A1, B1, 8000, { factor: 1 })],
  );
  assert.equal(out.lines[0].total, 2000);
  assert.equal(out.warnings.length, 0);
});

test("factorable N keeps the full cost", () => {
  const out = adjustedLines(
    [bid(B1, "FEE", 10000)],
    [act(A1, B1, "FEE", 10000, { factor: 0.1, factorable: "N" })],
    [res(A1, B1, 10000, { factor: 0.1, factorable: "N" })],
  );
  assert.equal(out.lines[0].total, 10000);
  assert.equal(out.warnings.length, 0);
});

test("does not scale when HeavyBid sent no direct total", () => {
  const out = adjustedLines(
    [{ id: B1, biditemCode: "200", description: "x", sortCode: "200" }],
    [{ id: A1, biditemId: B1, activityCode: "SCALE", description: "SCALE", quantity: 1, factor: 0.5, factorable: "Y" }],
    [res(A1, B1, 1000, { factor: 0.5 })],
  );
  assert.equal(out.lines[0].total, 1000);
  assert.equal(out.warnings.length, 0);
  assert.match(out.reconciliation.note, /not checked/);
});

test("Fairways-style shared copies on 4015 and 4050 split by activity quantity", () => {
  const biditems = [bid(B1, "4015", 4000), bid(B2, "4050", 36000)];
  const activities = [
    act(A1, B1, "HAUL", 4000, { quantity: 100 }),
    act(A2, B2, "HAUL", 36000, { quantity: 900 }),
  ];
  const resources = [
    res(A1, B1, 40000, { id: "r1", unitPrice: 40 }),
    res(A2, B2, 40000, { id: "r2", unitPrice: 40 }),
  ];
  const before = structuredClone({ biditems, activities, resources });
  const out = adjustedLines(biditems, activities, resources);
  assert.deepEqual(biditems, before.biditems);
  const byBid = Object.fromEntries(out.lines.map((l) => [l.biditem, l.total]));
  assert.deepEqual(byBid, { "4015": 4000, "4050": 36000 });
  assert.equal(out.warnings.length, 0);
  assert.equal(out.lines[0].taxOtPct, 8.25);
  assert.equal(out.lines[0].eoe, null);

  const api = [{
    materials: [{
      resourceCode: "MAT", description: "Aggregate", unitCost: 40, total: 80000,
      biditems: [
        { biditemId: B1, biditemCode: "4015", activityId: A1, activityCode: "HAUL", quantity: 1000, unitCost: 40, total: 40000 },
        { biditemId: B2, biditemCode: "4050", activityId: A2, activityCode: "HAUL", quantity: 1000, unitCost: 40, total: 40000 },
      ],
    }],
  }];
  const mats = applyMaterialAdjustments(api, out.lines, { materialType: "permanent", pricedOnly: false });
  assert.equal(api[0].materials[0].total, 80000);
  const material = mats[0].materials[0];
  assert.equal(material.total, 40000);
  assert.equal(material.unitCost, 40);
  const totals = Object.fromEntries(material.biditems.map((b) => [b.biditemCode, b.total]));
  assert.deepEqual(totals, { "4015": 4000, "4050": 36000 });
  const rec = materialReconciliation(mats, biditems.map((b, i) => ({ ...b, permanentMaterial: i === 0 ? 4000 : 36000 })), "permanent");
  assert.equal(rec.warnings.length, 0);
});

test("shared activity stored only on the owner is split onto 4015 and 4050", () => {
  const out = adjustedLines(
    [bid(B1, "4015", 1000), bid(B2, "4050", 9000)],
    [act(A1, B1, "HAUL", 1000, { quantity: 100 }), act(A2, B2, "HAUL", 9000, { quantity: 900 })],
    [res(A1, B1, 10000, { unitPrice: 10 })],
  );
  const byBid = Object.fromEntries(out.lines.map((l) => [l.biditem, l.total]));
  assert.deepEqual(byBid, { "4015": 1000, "4050": 9000 });
  assert.equal(out.lines.find((l) => l.biditem === "4050").activityId, A2);
  assert.equal(out.warnings.length, 0);
});

test("scaled shared activity applies factor and split together", () => {
  const out = adjustedLines(
    [bid(B1, "4015", 1000), bid(B2, "4050", 9000)],
    [
      act(A1, B1, "HAUL", 1000, { quantity: 1, factor: 0.1 }),
      act(A2, B2, "HAUL", 9000, { quantity: 9, factor: 0.1 }),
    ],
    [
      res(A1, B1, 100000, { id: "r1", factor: 0.1 }),
      res(A2, B2, 100000, { id: "r2", factor: 0.1 }),
    ],
  );
  const byBid = Object.fromEntries(out.lines.map((l) => [l.biditem, l.total]));
  assert.deepEqual(byBid, { "4015": 1000, "4050": 9000 });
  assert.equal(out.warnings.length, 0);
});

test("a stray factor is not applied when the raw total already matches", () => {
  const out = adjustedLines(
    [bid(B1, "10", 4440)],
    [act(A1, B1, "10.1", 4440, { factor: 0.5 })],
    [res(A1, B1, 4440, { quantity: 80, unitPrice: 55.5, factor: 0.5 })],
  );
  assert.equal(out.lines[0].total, 4440);
  assert.equal(out.warnings.length, 0);
});

test("copied activities that still share one quantity are split by HeavyBid direct totals", () => {
  const out = adjustedLines(
    [bid(B1, "4015", 4000), bid(B2, "4050", 36000)],
    [act(A1, B1, "HAUL", 4000, { quantity: 1000 }), act(A2, B2, "HAUL", 36000, { quantity: 1000 })],
    [res(A1, B1, 40000, { id: "r1" }), res(A2, B2, 40000, { id: "r2" })],
  );
  const byBid = Object.fromEntries(out.lines.map((l) => [l.biditem, l.total]));
  assert.deepEqual(byBid, { "4015": 4000, "4050": 36000 });
  assert.equal(out.warnings.length, 0);
});

test("identical independent activities are not treated as shared", () => {
  const out = adjustedLines(
    [bid(B1, "10", 5000), bid(B2, "20", 5000)],
    [act(A1, B1, "PIPE", 5000, { quantity: 10 }), act(A2, B2, "PIPE", 5000, { quantity: 10 })],
    [res(A1, B1, 5000, { id: "r1" }), res(A2, B2, 5000, { id: "r2" })],
  );
  assert.deepEqual(out.lines.map((l) => l.total), [5000, 5000]);
  assert.equal(out.warnings.length, 0);
});

test("unexplained gap warns with both numbers and does not invent a scale", () => {
  const out = adjustedLines(
    [bid(B1, "4015", 1000)],
    [act(A1, B1, "HAUL", 1000)],
    [res(A1, B1, 9000)],
  );
  assert.equal(out.lines[0].total, 9000);
  assert.equal(out.warnings.length, 2);
  for (const w of out.warnings) {
    assert.match(w, /does not reconcile with HeavyBid/);
    assert.match(w, /\$9,000\.00/);
    assert.match(w, /\$1,000\.00/);
  }
  assert.match(out.warnings.join("\n"), /Bid item 4015/);
  assert.match(out.warnings.join("\n"), /Activity 4015 \/ HAUL/);
});

test("$1 is inside tolerance and $2 warns", () => {
  const inside = adjustedLines([bid(B1, "10", 1001)], [act(A1, B1, "A", 1001)], [res(A1, B1, 1000, { quantity: 1, unitPrice: 1000 })]);
  assert.equal(inside.warnings.length, 0);
  const outside = adjustedLines([bid(B1, "10", 1002)], [act(A1, B1, "A", 1002)], [res(A1, B1, 1000, { quantity: 1, unitPrice: 1000 })]);
  assert.equal(outside.lines[0].total, 1000);
  assert.ok(outside.warnings.length >= 1);
});

test("skip-cost lines stay on the report and out of the HeavyBid total", () => {
  const out = adjustedLines(
    [bid(B1, "10", 1000)],
    [act(A1, B1, "A", 1000)],
    [res(A1, B1, 1000, { id: "keep", resourceCode: "MAT" }), res(A1, B1, 5000, { id: "skip", resourceCode: "NOTE", skipCost: "Y" })],
  );
  assert.equal(out.lines.length, 2);
  assert.equal(out.warnings.length, 0);
});

test("non-additive activity is left out of the bid item total", () => {
  const out = adjustedLines(
    [bid(B1, "10", 0)],
    [act(A1, B1, "PLUG", 5000, { nonAdditive: "Y" })],
    [res(A1, B1, 5000)],
  );
  assert.equal(out.lines[0].total, 5000);
  assert.equal(out.warnings.length, 0);
});

test("priced_only drops $0 rate lines and keeps a real rate", () => {
  assert.equal(isZeroRate(0), true);
  assert.equal(isZeroRate("0.00"), true);
  assert.equal(isZeroRate(null), false);
  assert.equal(isZeroRate(12.5), false);
  const records = [{
    materials: [
      { resourceCode: "FREE", unitCost: 0, total: 500, biditems: [{ biditemId: B1, unitCost: 0, total: 500 }] },
      {
        resourceCode: "AGG", unitCost: "0.00", total: 10,
        biditems: [{ biditemId: B1, unitCost: 0, total: 10 }],
      },
      {
        resourceCode: "STONE", unitCost: 12.5, total: 140,
        biditems: [
          { biditemId: B1, activityId: A1, unitCost: 12.5, quantity: 8, total: 100 },
          { biditemId: B2, activityId: A2, unitCost: 0, quantity: 4, total: 40 },
        ],
      },
    ],
  }];
  const kept = applyMaterialAdjustments(records, [], { materialType: "permanent", pricedOnly: true });
  assert.equal(kept[0].materials.length, 1);
  assert.equal(kept[0].materials[0].resourceCode, "STONE");
  assert.equal(kept[0].materials[0].biditems.length, 1);
  assert.equal(kept[0].materials[0].total, 100);
  const all = applyMaterialAdjustments(records, [], { materialType: "permanent", pricedOnly: false });
  assert.equal(all[0].materials.length, 3);
});

test("material list warns when it still does not match HeavyBid", () => {
  const records = [{
    materials: [{
      resourceCode: "MAT", unitCost: 40, total: 80000,
      biditems: [{ biditemId: B1, biditemCode: "4015", activityId: A1, unitCost: 40, total: 80000 }],
    }],
  }];
  const rec = materialReconciliation(records, [bid(B1, "4015", 4000, { permanentMaterial: 4000 })], "permanent");
  assert.equal(rec.warnings.length, 1);
  assert.match(rec.warnings[0], /does not reconcile with HeavyBid/);
  assert.match(rec.warnings[0], /\$80,000\.00/);
  assert.match(rec.warnings[0], /\$4,000\.00/);
  assert.equal(rec.reconciliation.heavybid_field, "permanentMaterial");
});

test("construction materials reconcile to constructionMaterial", () => {
  const lines = adjustedLines(
    [bid(B1, "10", 250)],
    [act(A1, B1, "FORM", 250)],
    [res(A1, B1, 250, { typeCost: "C", resourceCode: "PLY", unitPrice: 2.5, quantity: 100 })],
  ).lines;
  const data = applyMaterialAdjustments(
    [{ materials: [{ resourceCode: "PLY", unitCost: 2.5, total: 999, biditems: [{ biditemId: B1, activityId: A1, unitCost: 2.5, total: 999 }] }] }],
    lines,
    { materialType: "construction", pricedOnly: false },
  );
  assert.equal(data[0].materials[0].total, 250);
  const rec = materialReconciliation(data, [bid(B1, "10", 250, { constructionMaterial: 250 })], "construction");
  assert.equal(rec.warnings.length, 0);
  assert.equal(rec.reconciliation.heavybid_field, "constructionMaterial");
});

test("capWarnings keeps the phrase on the trailer", () => {
  const warnings = capWarnings(["a does not reconcile with HeavyBid: connector $2.00 vs HeavyBid $1.00."], 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /more do not reconcile with HeavyBid/);
});

test("formatMoney", () => {
  assert.equal(formatMoney(9000), "$9,000.00");
  assert.equal(formatMoney(-5), "-$5.00");
});

test("a second activity on the same bid item still rolls into the bid item", () => {
  const out = adjustedLines(
    [bid(B1, "10", 1500)],
    [act(A1, B1, "A", 1000, { factor: 0.1 }), act(A3, B1, "B", 500)],
    [res(A1, B1, 10000, { id: "r1", factor: 0.1, resourceCode: "MAT" }), res(A3, B1, 500, { id: "r2", resourceCode: "LAB", quantity: 10, unitPrice: 50 })],
  );
  assert.equal(out.warnings.length, 0);
  assert.equal(out.lines.reduce((s, l) => s + l.total, 0), 1500);
});
