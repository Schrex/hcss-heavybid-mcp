# schrex-hcss-heavybid: remote MCP connector on Cloudflare Workers (v0.6, Free plan)

Read-only HCSS HeavyBid (Estimate Insights v2) MCP server. It is a plain Workers `fetch` handler using the MCP SDK's `WebStandardStreamableHTTPServerTransport` (stateless Streamable HTTP, JSON responses). Design: `../design.md`. Setup: `../setup-guide.md`.

Requires **Node 22+** (Wrangler 4).
```
npm install
npm run typecheck
npm run build      # wrangler deploy --dry-run --outdir dist
npm run smoke      # builds, runs the Worker under `wrangler dev` against a fake HCSS (placeholder creds)
npm run deploy     # after the KV namespaces + `wrangler secret put ...` (see ../setup-guide.md)
```

## Routes
- `POST /mcp`: MCP. Needs an OAuth access token (`@cloudflare/workers-oauth-provider`), the token's email still on `ALLOWED_USER_EMAIL` and `TOKEN_EPOCH` unchanged. Only allowed from `ALLOWED_CIDRS` (Anthropic `160.79.104.0/21`, checked via `CF-Connecting-IP`)
- `/register`, `/authorize` (email + shared password sign-in page), `/token`, `/.well-known/*`: OAuth (DCR). Access tokens 1 h, refresh 90 days.
- `GET /exports/<id>`: single-use xlsx/csv download from KV (15 min TTL)
- `GET /healthz`

## Config
Secrets (`wrangler secret put` only): `HCSS_CLIENT_ID`, `HCSS_CLIENT_SECRET`, `HCSS_BUSINESS_UNIT_ID`, `ALLOWED_USER_EMAIL` (comma-separated), `ACCESS_PASSWORD_HASH` (`scripts/set-password.sh`), `TOKEN_EPOCH` (rotate to sign everyone out).
Vars (`wrangler.toml`): `HCSS_SCOPE` (`heavybid:read heavybid:system:read`), `HCSS_HIDE_COST_RATES` (`false`), `ALLOWED_CIDRS`, `HCSS_PAGE_SIZE` (1000), `HCSS_MAX_SUBREQUESTS` (45, max 48), `EXPORT_TTL_SECONDS` (900), `PUBLIC_ORIGIN` (canonical OAuth resource origin), plus optional `HCSS_TOKEN_URL` / `HCSS_API_BASE` (sandbox).
Bindings: KV `EXPORTS`, KV `OAUTH_KV` (namespace `HEAVYBID_OAUTH_KV`: OAuth clients/grants/tokens + login throttle).

## Tools
list_business_units, list_estimates, search_estimates, get_estimate, get_bid_items, get_activities, get_resources, get_materials, get_estimate_cost_breakdown, export_estimate (xlsx|csv).

`get_materials` takes `priced_only` (drops unit cost $0). Cost breakdown, materials and export apply HeavyBid's activity Bid/TO factor and sharing split when that matches HeavyBid's direct total; otherwise the tool warns `does not reconcile with HeavyBid` with both amounts. Estimates and bid items default to a compact page (`detail: true` for the full record, `skip` / `next_skip` to page). Material totals use `scope: full_estimate` and are not shrunk by that page. `tax_percent`, `overtime_factor_percent` and `percent_adjustment` are `resource.percent - 100`.

## Reconcile after deploy
Read-only. From `server/`, with secrets in the environment (never in a file in this repo):
```
HCSS_CLIENT_ID=... HCSS_CLIENT_SECRET=... HCSS_BUSINESS_UNIT_ID=... \
  npm run reconcile -- <estimate-uuid> [<estimate-uuid> ...]
```
Prints each bid item's connector total next to HeavyBid `directTotal`, plus `totalCost`, `markup` and `bidPrice`. Exit code 1 when any checked bid item or activity is off by more than $1, or when `directTotal` is missing.

## Files
`src/worker.ts` (routing, IP check, downloads, MCP transport) · `src/tools.ts` · `src/hcss.ts` (token, GET-only, subrequest budget, 429 backoff, paging, isolate cache) · `src/breakdown.ts` (join + CSV) · `src/factor.ts` (Bid/TO factor, sharing split, reconciliation) · `src/xlsx.ts` (minimal xlsx via fflate, level 0) · `src/redact.ts` (optional cost switch) · `src/ip.ts` · `src/config.ts` · `scripts/smoke.mjs` · `scripts/reconcile.mjs`

The Fly.io / Express version (v0.2) has been removed.

## Status
Typechecks, `wrangler deploy --dry-run` builds (835 KiB / 163 KiB gzip), and the offline smoke test passes: 10 tools, a 1,500-row breakdown across 2 pages, xlsx and csv exports, single-use links, bad-path 404. **Not yet deployed or run against real HCSS.** The 10 ms CPU limit on large estimates is untested.
