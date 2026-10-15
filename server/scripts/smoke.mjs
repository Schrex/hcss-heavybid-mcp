// Offline smoke test: fake HCSS on :9911 + the real Worker under `wrangler dev` (local workerd, local KV).
// Uses placeholder credentials only. Needs Node 22+ for wrangler (set NODE22=/path/to/node if needed).
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const E = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", A = "33333333-3333-4333-8333-333333333333";
const resources = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}`, estimateId: E, biditemId: B, activityId: A,
  resourceCode: `LAB${String(i).padStart(4, "0")}`, description: "Laborer", quantity: 80, units: "MH", unitPrice: 55.5, total: 4440, rentPercent: 0, operatingPercent: 0, pieces: 2, percent: 0 }));
const data = {
  biditems: [{ id: B, estimateId: E, biditemCode: "10", description: "Storm pipe 12\" & fittings", sortCode: "10" }],
  activities: [{ id: A, estimateId: E, biditemId: B, activityCode: "10.1", description: "Lay pipe" }],
  resources,
};
let hcssCalls = 0;
const mock = http.createServer((req, res) => {
  hcssCalls++;
  res.setHeader("Content-Type", "application/json");
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/token")) return res.end(JSON.stringify({ access_token: "fake", token_type: "bearer", expires_in: 3600 }));
  const k = Object.keys(data).find((k) => u.pathname.endsWith(`/${k}`));
  if (k) {
    const top = Number(u.searchParams.get("$top") ?? 100), skip = Number(u.searchParams.get("$skip") ?? 0);
    const all = data[k], page = all.slice(skip, skip + top);
    return res.end(JSON.stringify({ data: page, currentTopValue: top, currentSkipValue: skip, nextSkipValue: skip + top < all.length ? skip + top : null }));
  }
  if (u.pathname.endsWith(`/estimates/${E}`)) return res.end(JSON.stringify({ data: { id: E, code: "26-101", name: "Test" } }));
  res.statusCode = 404; res.end("{}");
}).listen(9911);

const SECRET = "x".repeat(40);
writeFileSync(".dev.vars", `HCSS_CLIENT_ID=placeholder\nHCSS_CLIENT_SECRET=placeholder\nMCP_PATH_SECRET=${SECRET}\nHCSS_BUSINESS_UNIT_ID=${E}\n`);
const node = process.env.NODE22 ?? process.execPath;
const dev = spawn(node, ["node_modules/wrangler/bin/wrangler.js", "dev", "--port", "9912", "--ip", "127.0.0.1",
  "--var", "HCSS_TOKEN_URL:http://127.0.0.1:9911/token", "--var", "HCSS_API_BASE:http://127.0.0.1:9911", "--var", "ALLOWED_CIDRS:"],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let log = ""; dev.stdout.on("data", (d) => (log += d)); dev.stderr.on("data", (d) => (log += d));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m, "\n", log.slice(-2000)); process.exitCode = 1; throw new Error(m); } console.log("ok -", m); };

const base = `http://127.0.0.1:9912/${SECRET}`;
const rpc = async (id, method, params) => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : t);
};
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:9912/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const tools = (await rpc(2, "tools/list", {})).result.tools.map((t) => t.name);
  ok(tools.length === 10 && tools.includes("get_estimate_cost_breakdown") && tools.includes("export_estimate"), `10 tools: ${tools.join(", ")}`);
  const cb = JSON.parse((await rpc(3, "tools/call", { name: "get_estimate_cost_breakdown", arguments: { estimate_id: E, limit_rows: 2 } })).result.content[0].text);
  ok(cb.counts.resources === 1500 && cb.rows[0].biditem === "10" && cb.rows[0].unitCost === 55.5, `breakdown joined 1500 resources across 2 pages (row0 ${cb.rows[0].resource})`);
  const ex = JSON.parse((await rpc(4, "tools/call", { name: "export_estimate", arguments: { estimate_id: E, format: "xlsx" } })).result.content[0].text);
  const d1 = await fetch(ex.download_url); const bytes = new Uint8Array(await d1.arrayBuffer());
  ok(d1.status === 200 && bytes[0] === 0x50 && bytes[1] === 0x4b, `xlsx download ${bytes.length} bytes (${d1.headers.get("content-disposition")}), hcss_calls=${ex.hcss_calls}`);
  writeFileSync("/tmp/smoke-export.xlsx", bytes);
  ok((await fetch(ex.download_url)).status === 404, "export link is single-use");
  const csv = JSON.parse((await rpc(5, "tools/call", { name: "export_estimate", arguments: { estimate_id: E, format: "csv" } })).result.content[0].text);
  const ctext = await (await fetch(csv.download_url)).text();
  ok(ctext.split("\r\n").length === 1501 && ctext.includes('"Storm pipe 12"" & fittings"'), "csv export 1500 rows, quoting ok");
  ok((await fetch(`http://127.0.0.1:9912/wrong/mcp`, { method: "POST" })).status === 404, "wrong secret path -> 404");
  ok((await fetch(`${base}/mcp`)).status === 405, "GET /mcp -> 405");
  console.log(`fake HCSS received ${hcssCalls} calls`);
} finally { dev.kill("SIGINT"); mock.close(); rmSync(".dev.vars", { force: true }); setTimeout(() => process.exit(), 500); }
