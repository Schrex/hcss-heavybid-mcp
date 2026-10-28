// Offline smoke test: fake HCSS on :9911 + the real Worker under `wrangler dev` (local workerd, local KV).
// Uses placeholder credentials only. Needs Node 22+ for wrangler (set NODE22=/path/to/node if needed).
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

const E = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", A = "33333333-3333-4333-8333-333333333333";
const resources = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}`, estimateId: E, biditemId: B, activityId: A,
  resourceCode: `LAB${String(i).padStart(4, "0")}`, description: "Laborer", quantity: 80, units: "MH", unitPrice: 55.5, total: 4440, rentPercent: 0, operatingPercent: 0, pieces: 2, percent: 0 }));
const data = {
  biditems: [{ id: B, estimateId: E, biditemCode: "10", description: "Storm pipe 12\" & fittings", sortCode: "10" }],
  activities: [{ id: A, estimateId: E, biditemId: B, activityCode: "10.1", description: "Lay pipe" }],
  resources,
};
let hcssCalls = 0, badUa = 0, basicTokenCalls = 0, bodyTokenCalls = 0;
const BLOCKED = "44444444-4444-4444-8444-444444444444";
const mock = http.createServer((req, res) => {
  hcssCalls++;
  if (req.headers["user-agent"] !== "Mozilla/5.0 SchreiberMCP/0.1" || req.headers["accept"] !== "application/json") badUa++;
  res.setHeader("Content-Type", "application/json");
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/token")) {
    // Simulate an identity server that only accepts HTTP Basic client auth.
    const auth = req.headers["authorization"] ?? "";
    if (!auth.startsWith("Basic ")) { bodyTokenCalls++; res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_client" })); }
    basicTokenCalls++;
    if (Buffer.from(auth.slice(6), "base64").toString() !== "placeholder:placeholder") { res.statusCode = 401; return res.end("{}"); }
    return res.end(JSON.stringify({ access_token: "fake", token_type: "bearer", expires_in: 3600 }));
  }
  if (u.pathname.endsWith(`/estimates/${BLOCKED}`)) {
    res.statusCode = 403; res.setHeader("Content-Type", "text/html");
    return res.end("<html><body><h1>The request is blocked.</h1></body></html>");
  }
  const k = Object.keys(data).find((k) => u.pathname.endsWith(`/${k}`));
  if (k) {
    const top = Number(u.searchParams.get("$top") ?? 100), skip = Number(u.searchParams.get("$skip") ?? 0);
    const all = data[k], page = all.slice(skip, skip + top);
    return res.end(JSON.stringify({ data: page, currentTopValue: top, currentSkipValue: skip, nextSkipValue: skip + top < all.length ? skip + top : null }));
  }
  if (u.pathname.endsWith(`/estimates/${E}`)) return res.end(JSON.stringify({ data: { id: E, code: "26-101", name: "Test" } }));
  res.statusCode = 404; res.end("{}");
}).listen(9911);

const PW = "smoke-test-password", EMAIL = "smoke@schrex.com", salt = randomBytes(16);
const PW_HASH = `pbkdf2$30000$${salt.toString("base64")}$${pbkdf2Sync(PW, salt, 30000, 32, "sha256").toString("base64")}`;
writeFileSync(".dev.vars", `HCSS_CLIENT_ID=placeholder\nHCSS_CLIENT_SECRET=placeholder\nHCSS_BUSINESS_UNIT_ID=${E}\n` +
  `ALLOWED_USER_EMAIL=${EMAIL},other@schrex.com\nACCESS_PASSWORD_HASH=${PW_HASH}\nTOKEN_EPOCH=smoke\n`);
const node = process.env.NODE22 ?? process.execPath;
const dev = spawn(node, ["node_modules/wrangler/bin/wrangler.js", "dev", "--port", "9912", "--ip", "127.0.0.1",
  "--var", "HCSS_TOKEN_URL:http://127.0.0.1:9911/token", "--var", "HCSS_API_BASE:http://127.0.0.1:9911", "--var", "ALLOWED_CIDRS:", "--var", "PUBLIC_ORIGIN:http://127.0.0.1:9912"],
  { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let log = ""; dev.stdout.on("data", (d) => (log += d)); dev.stderr.on("data", (d) => (log += d));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m, "\n", log.slice(-2000)); process.exitCode = 1; throw new Error(m); } console.log("ok -", m); };

const base = "http://127.0.0.1:9912";
let token = "";
const rpc = async (id, method, params) => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : t);
};
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:9912/healthz")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  ok((await fetch(`${base}/mcp`, { method: "POST" })).status === 401, "no token -> 401");

  // OAuth: dynamic client registration -> /authorize login page -> sign in -> code -> /token (PKCE), as Claude does.
  const REDIRECT = "http://127.0.0.1:9999/cb";
  const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "smoke", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
  ok(reg.client_id, "DCR /register -> client_id");
  const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = `${base}/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT,
    scope: "heavybid.read", state: "st", code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/mcp` });
  const signIn = async (email, password) => {
    const g = await fetch(authUrl);
    const html = await g.text();
    const handle = html.match(/name="handle" value="([^"]*)"/)?.[1];
    if (!handle) throw new Error(`no consent handle (${g.status}): ${html.slice(0, 300)}`);
    const cookie = g.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    return fetch(authUrl, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: new URLSearchParams({ handle, email, password, decision: "approve" }) });
  };
  ok((await signIn(EMAIL, "wrong-password")).status === 401, "wrong password -> 401");
  ok((await signIn("nobody@schrex.com", PW)).status === 401, "email not on allowlist -> 401");
  const good = await signIn(EMAIL.toUpperCase(), PW);
  const code = new URL(good.headers.get("location") ?? "http://x").searchParams.get("code");
  ok(good.status === 302 && code, "allowlisted email + password -> redirect with code");
  const tok = await (await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${base}/mcp` }) })).json();
  ok(tok.access_token && tok.refresh_token && tok.expires_in === 3600, `token issued (expires_in ${tok.expires_in})`);
  token = tok.access_token;

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
  ok((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status === 405, "GET /mcp -> 405");
  const blk = await rpc(6, "tools/call", { name: "get_estimate", arguments: { estimate_id: BLOCKED } });
  const blkText = JSON.stringify(blk);
  ok(blkText.includes("HCSS firewall blocked request"), "HTML firewall page -> 'HCSS firewall blocked request' error");
  ok(badUa === 0, "every HCSS call sent User-Agent: Mozilla/5.0 SchreiberMCP/0.1 + Accept: application/json");
  ok(bodyTokenCalls === 1 && basicTokenCalls === 1, "token: 400 invalid_client -> one HTTP Basic fallback");
  console.log(`fake HCSS received ${hcssCalls} calls`);
} finally { dev.kill("SIGINT"); mock.close(); rmSync(".dev.vars", { force: true }); setTimeout(() => process.exit(), 500); }
