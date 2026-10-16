#!/usr/bin/env node
// Read-only check: roll up one or more estimates the way the connector does, then
// compare each bid item and activity to HeavyBid's own directTotal.
// GET + token only. No secrets are written. Run from server/ via `npm run reconcile`.
//
//   HCSS_CLIENT_ID=... HCSS_CLIENT_SECRET=... HCSS_BUSINESS_UNIT_ID=... \
//     npm run reconcile -- <estimate-uuid> [<estimate-uuid> ...]
//
// Optional env: HCSS_TOKEN_URL, HCSS_API_BASE, HCSS_SCOPE.
// Optional flag: --business-unit <uuid> overrides HCSS_BUSINESS_UNIT_ID.
// The table also prints totalCost, markup and bidPrice so a live run can show
// whether a HeavyBid report is using a column other than direct cost.

import { existsSync } from "node:fs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run reconcile -- <estimate-uuid> [<estimate-uuid> ...]

Compares the connector's cost-breakdown totals to HeavyBid bid-item and activity
directTotal (tolerance $1). Read-only.

Env: HCSS_CLIENT_ID, HCSS_CLIENT_SECRET, HCSS_BUSINESS_UNIT_ID
Optional: HCSS_TOKEN_URL, HCSS_API_BASE, HCSS_SCOPE, --business-unit <uuid>`);
  process.exit(0);
}

const factorUrl = new URL("../dist-test/factor.js", import.meta.url);
if (!existsSync(factorUrl)) {
  console.error("Missing build of src/factor.ts. From server/: npm run reconcile -- <estimate-uuid>...");
  process.exit(2);
}
const { adjustedLines, formatMoney, RECONCILE_TOLERANCE } = await import(factorUrl.href);

const ids = [];
let businessUnit = process.env.HCSS_BUSINESS_UNIT_ID || "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--business-unit") businessUnit = args[++i] ?? "";
  else ids.push(args[i]);
}
if (!process.env.HCSS_CLIENT_ID || !process.env.HCSS_CLIENT_SECRET) {
  console.error("Set HCSS_CLIENT_ID and HCSS_CLIENT_SECRET in the environment. Do not put them in a file in the repo.");
  process.exit(2);
}
if (!businessUnit || !UUID.test(businessUnit)) {
  console.error("Set HCSS_BUSINESS_UNIT_ID or pass --business-unit <uuid>.");
  process.exit(2);
}
if (ids.length === 0 || ids.some((id) => !UUID.test(id))) {
  console.error("Pass one or more estimate UUIDs. Example: npm run reconcile -- 483e8356-7c9d-4949-b882-154072a8e38a");
  process.exit(2);
}

const tokenUrl = process.env.HCSS_TOKEN_URL || "https://api.hcssapps.com/identity/connect/token";
const apiBase = (process.env.HCSS_API_BASE || "https://api.hcssapps.com/heavybid/api/v2/integration").replace(/\/$/, "");
const scope = process.env.HCSS_SCOPE || "heavybid:read heavybid:system:read";
const headers = { "User-Agent": "Mozilla/5.0 SchreiberMCP/0.1", Accept: "application/json" };

async function readJson(res, what) {
  const text = await res.text();
  const head = text.trimStart().slice(0, 15).toLowerCase();
  if ((res.headers.get("Content-Type") ?? "").includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html")) {
    throw new Error(`HCSS firewall blocked request (${what}: HTTP ${res.status})`);
  }
  try { return JSON.parse(text); } catch { throw new Error(`HCSS returned non-JSON for ${what} (HTTP ${res.status})`); }
}

let cached;
async function token() {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const form = (withClient) => {
    const f = new URLSearchParams({ grant_type: "client_credentials", scope });
    if (withClient) { f.set("client_id", process.env.HCSS_CLIENT_ID); f.set("client_secret", process.env.HCSS_CLIENT_SECRET); }
    return f;
  };
  const post = (body, basic) => {
    const h = { ...headers, "Content-Type": "application/x-www-form-urlencoded" };
    if (basic) h.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(process.env.HCSS_CLIENT_ID)}:${encodeURIComponent(process.env.HCSS_CLIENT_SECRET)}`).toString("base64");
    return fetch(tokenUrl, { method: "POST", headers: h, body });
  };
  let res = await post(form(true), false);
  if (res.status === 400) {
    const err = await readJson(res, "token");
    if (err.error !== "invalid_client") throw new Error(`HCSS token request failed: HTTP 400 ${err.error ?? ""}`.trim());
    res = await post(form(false), true);
  }
  if (!res.ok) throw new Error(`HCSS token request failed: HTTP ${res.status}`);
  const j = await readJson(res, "token");
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

async function getAll(path, query) {
  const out = [];
  let skip = 0;
  for (;;) {
    const url = new URL(apiBase + path);
    for (const [k, v] of Object.entries({ ...query, $top: 1000, $skip: skip })) url.searchParams.set(k, String(v));
    const res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${await token()}` } });
    if (!res.ok) throw new Error(`HCSS GET ${url.pathname} failed: HTTP ${res.status}`);
    const page = await readJson(res, `GET ${url.pathname}`);
    const rows = page.data ?? [];
    out.push(...rows);
    const next = page.nextSkipValue;
    if (next == null || next <= skip || rows.length === 0) break;
    skip = next;
  }
  return out;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
function moneyOrBlank(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? formatMoney(n) : "";
}

let failed = false;
const base = `/businessunits/${businessUnit}`;
for (const estimateId of ids) {
  const filter = { $filter: `estimateId eq ${estimateId}` };
  const biditems = await getAll(`${base}/biditems`, filter);
  const activities = await getAll(`${base}/activities`, filter);
  const resources = await getAll(`${base}/resources`, filter);
  const adj = adjustedLines(biditems, activities, resources);
  const byId = new Map(biditems.map((b) => [String(b.id), b]));
  console.log(`\nEstimate ${estimateId}`);
  console.log(`${pad("Bid item", 12)} ${pad("Connector", 16)} ${pad("HeavyBid direct", 18)} ${pad("Diff", 14)} ${pad("totalCost", 16)} ${pad("markup", 14)} ${pad("bidPrice", 14)} Status`);
  const bidChecks = adj.checks.filter((c) => c.kind === "biditem");
  for (const check of bidChecks) {
    const code = check.label.replace(/^Bid item /, "");
    const bid = [...byId.values()].find((b) => String(b.biditemCode ?? "").trim() === code || String(b.id) === code);
    const diff = check.heavybid == null ? "" : formatMoney(Math.round((check.connector - check.heavybid) * 100) / 100);
    const status = !check.checked ? "not checked" : check.ok ? "ok" : "DOES NOT RECONCILE";
    if (check.checked && !check.ok) failed = true;
    console.log(`${pad(code, 12)} ${pad(formatMoney(check.connector), 16)} ${pad(check.heavybid == null ? "" : formatMoney(check.heavybid), 18)} ${pad(diff, 14)} ${pad(moneyOrBlank(bid?.totalCost), 16)} ${pad(moneyOrBlank(bid?.markup), 14)} ${pad(moneyOrBlank(bid?.bidPrice), 14)} ${status}`);
  }
  const actFails = adj.checks.filter((c) => c.kind === "activity" && c.checked && !c.ok);
  const actChecked = adj.checks.filter((c) => c.kind === "activity" && c.checked);
  if (actFails.length) {
    failed = true;
    console.log("Activities:");
    for (const check of actFails) console.log(`  ${check.label} does not reconcile with HeavyBid: connector ${formatMoney(check.connector)} vs HeavyBid ${formatMoney(check.heavybid)}`);
  }
  console.log(`${bidChecks.filter((c) => c.checked).length} bid items checked, ${bidChecks.filter((c) => c.checked && !c.ok).length} failed; ${actChecked.length} activities checked, ${actFails.length} failed; ${resources.length} resources.`);
  if (adj.reconciliation.note) console.log(adj.reconciliation.note);
  if (bidChecks.filter((c) => c.checked).length === 0) failed = true;
}

if (failed) {
  console.error("\nOne or more estimates do not reconcile with HeavyBid, or HeavyBid directTotal was missing.");
  process.exit(1);
}
console.log("\nAll checked bid items and activities reconcile with HeavyBid within $" + RECONCILE_TOLERANCE + ".");
