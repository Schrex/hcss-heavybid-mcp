# schrex-hcss-heavybid: remote MCP connector on Cloudflare Workers (v0.3, Free plan)

Read-only HCSS HeavyBid (Estimate Insights v2) MCP server. It is a plain Workers `fetch` handler using the MCP SDK's `WebStandardStreamableHTTPServerTransport` (stateless Streamable HTTP, JSON responses). Design: `../design.md`. Setup: `../setup-guide.md`.

Requires **Node 22+** (Wrangler 4).
```
npm install
npm run typecheck
npm run build      # wrangler deploy --dry-run --outdir dist
npm run smoke      # builds, runs the Worker under `wrangler dev` against a fake HCSS (placeholder creds)
npm run deploy     # after `wrangler kv namespace create EXPORTS` + `wrangler secret put ...`
```

## Routes
- `POST /<MCP_PATH_SECRET>/mcp`: MCP. Only allowed from `ALLOWED_CIDRS` (Anthropic `160.79.104.0/21`, checked via `CF-Connecting-IP`)
- `GET /<MCP_PATH_SECRET>/exports/<id>`: single-use xlsx/csv download from KV (15 min TTL)
- `GET /healthz`

## Config
Secrets (`wrangler secret put` only): `HCSS_CLIENT_ID`, `HCSS_CLIENT_SECRET`, `HCSS_BUSINESS_UNIT_ID`, `MCP_PATH_SECRET` (32+ chars).
Vars (`wrangler.toml`): `HCSS_SCOPE` (`heavybid:read heavybid:system:read`), `HCSS_HIDE_COST_RATES` (`false`), `ALLOWED_CIDRS`, `HCSS_PAGE_SIZE` (1000), `HCSS_MAX_SUBREQUESTS` (45, max 48), `EXPORT_TTL_SECONDS` (900), plus optional `HCSS_TOKEN_URL` / `HCSS_API_BASE` (sandbox).
Binding: KV `EXPORTS`.

## Tools
list_business_units, list_estimates, search_estimates, get_estimate, get_bid_items, get_activities, get_resources, get_materials, get_estimate_cost_breakdown, export_estimate (xlsx|csv).

## Files
`src/worker.ts` (routing, IP check, downloads, MCP transport) · `src/tools.ts` · `src/hcss.ts` (token, GET-only, subrequest budget, 429 backoff, paging, isolate cache) · `src/breakdown.ts` (join + CSV) · `src/xlsx.ts` (minimal xlsx via fflate, level 0) · `src/redact.ts` (optional cost switch) · `src/ip.ts` · `src/config.ts` · `scripts/smoke.mjs`

The Fly.io / Express version (v0.2) has been removed.

## Status
Typechecks, `wrangler deploy --dry-run` builds (835 KiB / 163 KiB gzip), and the offline smoke test passes: 10 tools, a 1,500-row breakdown across 2 pages, xlsx and csv exports, single-use links, bad-path 404. **Not yet deployed or run against real HCSS.** The 10 ms CPU limit on large estimates is untested.
