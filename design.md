# HCSS HeavyBid connector for Claude Team: design (v0.5, Cloudflare Workers free plan, revised 2026-10-27)

**v0.5 change:** Deployed v0.4 behavior (trimmed codes and natural sort, compact estimates and bid items, `skip` / `next_skip` paging, business-unit auto-pick, HCSS 4xx bodies, and `tax_percent` / `overtime_factor_percent` / `percent_adjustment`) is merged with the quantity-factor rollup. Quantity and Total still use that rollup. Tax/OT% is `resource.percent - 100`. EOE and Burden come from `resource.subTypeCost` and are scaled by the same factor as Total.

**v0.3 change:** Sumanth chose **Cloudflare Workers (Free plan)** for hosting. The Node/Express/Fly version was removed (Dockerfile, fly.toml and the Express server are deleted). The server is now a plain Workers `fetch` handler that uses the MCP SDK's `WebStandardStreamableHTTPServerTransport` (stateless, JSON responses). It has no Durable Objects and no `McpAgent`, because those aren't needed for a stateless, authless server and this keeps us inside the free plan. Exports are stored in Workers KV. See §11 for the free-plan limits and how the design fits them.

**What changed from v0.1 (per Sumanth):** this is now **one company-wide remote MCP server** for Schreiber's whole Claude Team workspace (Zach, Ryan Irish, everyone). The Claude Team admin adds it once as a custom connector. **Everyone sees everything**, including loaded labor and equipment rates, EOE, burden and rent, so `HCSS_HIDE_COST_RATES` now defaults to **false**. It is still **read-only**, and it still calls the **HCSS APIs directly, with no Supabase**.

> **Heads-up for Sumanth:** Zach previously treated loaded labor and equipment dollar rates as private ("dollar rates never exposed publicly", systems.md). Please let Zach know before go-live that every Claude Team member will see them through this connector. The switch can turn hiding back on with one env var.

**Source note:** Zach's `hcss-api` skill and the edge function code are not on the box, so every HCSS endpoint below comes from the public HCSS docs (developer.hcssapps.com OpenAPI specs, fetched 2026-10-15). Claude connector facts come from support.claude.com and claude.com/docs/connectors (fetched 2026-10-15).

## 1. Architecture
```
Claude Team members (claude.ai / Desktop / mobile)
        |  Anthropic cloud calls the connector (egress 160.79.104.0/21)
        v
https://schrex-hcss-mcp.schrex.workers.dev/mcp   (OAuth: email allowlist + shared password, since v0.6)
        |  Cloudflare Worker (free plan), stateless Streamable HTTP, one invocation per MCP POST
        |  secrets via `wrangler secret put`; KV namespace EXPORTS for 15-min export files
        v
https://api.hcssapps.com  (GET only, scopes heavybid:read heavybid:system:read)
```
- Claude reaches the connector **from Anthropic's cloud**, so the Worker must be public (VERIFIED in Claude docs). Nothing lives on laptops.
- Each MCP request runs in one Worker invocation: build the MCP server, handle the request, return JSON. GET on `/mcp` returns 405.
- The only outbound calls are GETs, plus the token POST. No tool writes to HCSS.

## 2. HCSS auth (server to HCSS), VERIFIED from HCSS docs
- `POST https://api.hcssapps.com/identity/connect/token` with `grant_type=client_credentials`, `client_id`, `client_secret` and `scope=heavybid:read heavybid:system:read`. The token lasts 3600 s. The server caches it, refreshes it 60 s early, and retries once on a 401.
- **Use a dedicated new API client with only `heavybid:read` and `heavybid:system:read`.** Do **not** reuse Sumanth's existing client: it also carries `myField:admin` and many other scopes, so if this internet-facing server were ever compromised, that one secret would expose admin rights across HCSS products. Scopes are set per client by an admin in HCSS Credentials (VERIFIED from docs), so a narrow client is possible.
- UNVERIFIED: whether `heavybid:system:read` is actually needed. The HCSS how-to lists it, and including it is harmless. Also UNVERIFIED: whether the license includes Estimate Insights and allows another client.

## 3. Tools and endpoints (base `https://api.hcssapps.com/heavybid/api/v2/integration`)
| Tool | HCSS endpoint(s) | Status |
|---|---|---|
| list_business_units | `GET /businessunits` | VERIFIED |
| list_estimates | `GET /businessunits/{bu}/estimates` | VERIFIED |
| search_estimates | same + `$filter=contains(name,'…')` | VERIFIED. `filters/estimator` and `filters/bidDate` filters are UNVERIFIED |
| get_estimate | `GET /businessunits/{bu}/estimates/{id}` | VERIFIED |
| get_bid_items | `GET /businessunits/{bu}/biditems?$filter=estimateId eq {id}` | VERIFIED |
| get_activities | `GET /businessunits/{bu}/activities` (+ `biditemId` filter) | endpoint VERIFIED; `biditemId` filter UNVERIFIED |
| get_resources | `GET /businessunits/{bu}/resources` (+ `activityId` filter) | endpoint VERIFIED; `activityId` filter UNVERIFIED |
| get_materials | `GET /businessunits/{bu}/estimates/{id}/materials/{permanent\|construction}` | VERIFIED |
| **get_estimate_cost_breakdown** | biditems + activities + resources for one estimate, joined in the server | endpoints VERIFIED; column mapping partly UNVERIFIED (see §4) |
| **export_estimate** (xlsx or csv) | same as above, plus get_estimate for the file name | see §5 |

Documented by HCSS but not exposed: by-id lookups, attachments, quote folders, KPIs, codebooks. The one codebook `PUT` is a write and is **deliberately excluded**.

## 4. Cost breakdown (Ryan's "bid item > activity > resource" report)
Ryan's HeavyBid runs in a VM and exporting reports is painful, so this tool rebuilds the report from the API. There is one row per resource, joined to its activity (`resource.activityId`) and bid item (`resource.biditemId` or `activity.biditemId`), and sorted by bid item sortCode, then activity code, then resource code.

| Report column | Field | Status |
|---|---|---|
| Biditem / Bid Desc | biditem.biditemCode / description | VERIFIED field |
| Activity / Actv Desc | activity.activityCode / description | VERIFIED field |
| Resource / Description | resource.resourceCode / description | VERIFIED field |
| Quantity / Unit | resource.quantity × Bid/TO factor (and a sharing split only when that matches the activity direct total) / units | VERIFIED field; the factor is applied only when the activity then matches `directTotal` within $1 |
| Unit Cost | resource.unitPrice | VERIFIED field; meaning matches the report (check against one report) |
| Tax/OT% | resource.percent − 100 (108 = 8% tax on materials, 110 = 10% overtime on labor). Blank when 0/null | **UNVERIFIED** mapping |
| Pcs/Wste | resource.pieces | **UNVERIFIED** (may be pieces, not waste) |
| Total | resource.total × the same factor / sharing split, rounded to the cent per line | VERIFIED field; the factor is the same one as Quantity |
| Rent% | resource.rentPercent | VERIFIED field |
| EOE% | resource.operatingPercent | **UNVERIFIED** mapping |
| Supp Desc | resource.supplementalDescription | VERIFIED field |
| EOE | resource.subTypeCost when typeCost is E, times the same factor as Total. Otherwise "not available from HeavyBid API" | **UNVERIFIED** against a HeavyBid report. HCSS docs describe subTypeCost this way |
| Burden | resource.subTypeCost when typeCost is L, times the same factor as Total. Burden is already inside the labor line Total. Otherwise "not available from HeavyBid API" | **UNVERIFIED** against a HeavyBid report |
| Burden% | not available from the HeavyBid API | left as that sentence |

**Quantity factor and shared activities.** Estimate Insights `resource.total` / `resource.quantity` are the unfactored lines. `resource.factor` and `activity.factor` are the Bid/TO factor (bid quantity ÷ takeoff quantity, sometimes stored as the inverse). A shared activity is either copied onto each bid item at the full quantity, or stored once on an owner bid item. The cost breakdown, the material list and the export apply a factor or a sharing split only when that makes the activity match HeavyBid's own `directTotal` within $1. If nothing matches, the raw line is returned and the tool says it does not reconcile with HeavyBid, with both numbers. `priced_only` on `get_materials` drops lines whose unit cost is $0. Material `total` is the sum of those factored resource totals (not `quantity × unitPrice`, and not the materials-endpoint total, which can include sales tax). `tax_percent` is `resource.percent - 100`, and `tax_amount` is that percent times the factored total. EOE and Burden dollars use `subTypeCost` and the same factor; Tax/OT%, EOE% and Pcs/Wste stay best-guess mappings.

**Validation step:** have Ryan export this report from HeavyBid for one estimate, then compare it row by row with `export_estimate` before we rely on it. After deploy, run `npm run reconcile -- <estimate-uuid> ...` in `server/` against 5–10 estimates (Fairways and Save A Lot included).

Volume: the three lists are pulled one after another with `$top=1000` pages. A 3,000-resource estimate takes about 5 HCSS calls. The ceiling is 40,000 rows, bounded by the 45-call budget (§11), and `truncated` or a clear error tells you when it's hit. The chat tool returns at most 500 rows (`limit_rows` up to 2,000, or a `biditem_code` filter). Full estimates should go through export.

## 5. Export (xlsx or CSV)
- The Worker builds the file in memory. **XLSX** is a minimal hand-written workbook (a "Cost Breakdown" sheet with frozen header and autofilter, plus a "Notes" sheet giving each column's HCSS source), zipped with `fflate` at **compression level 0** to save CPU. **CSV** is UTF-8 with a BOM. `exceljs` was dropped because it is too heavy for 10 ms of CPU. The smoke test's 1,500-row xlsx opens in openpyxl.
- It is stored in **Workers KV** under a random 256-bit key, with `expirationTtl` = `EXPORT_TTL_SECONDS` (900; KV's minimum is 60). The tool returns `https://<worker>/exports/<id>` (the 256-bit id is the capability). The download deletes the key, so the link works once.
- KV free limits (VERIFIED, developers.cloudflare.com/kv/platform/limits): 1,000 writes/day (deletes count against a similar 1,000/day), 100,000 reads/day, 1 GB storage, 25 MiB per value. Each export uses 1 write and 1 delete, so roughly **500 exports/day**, far above what we need. The Worker refuses files over 24 MiB.
- KV is eventually consistent, so for up to about 60 s a deleted link might still work from another Cloudflare location (UNVERIFIED in practice). The TTL still applies.
- The user's browser fetches the link, not Anthropic, so the IP allowlist doesn't apply to downloads.
- UNVERIFIED: whether Claude shows the link as clickable on every surface.
- R2 isn't needed. Its free tier exists (10 GB) but requires adding a payment method to enable R2 (UNVERIFIED for current policy), so we avoid it.

## 6. User auth (Claude to connector): options and recommendation
**Update 2026-10-28 (v0.6):** replaced A with the HeavyJob connector's sign-in, same as ClearStory. Claude connects with OAuth (DCR); the Worker's own `/authorize` page takes an email on `ALLOWED_USER_EMAIL` plus one shared password (`ACCESS_PASSWORD_HASH`, PBKDF2, in Bitwarden). Access tokens 1 h, refresh 90 days. Every `/mcp` call and every refresh re-checks the allowlist and `TOKEN_EPOCH`. `MCP_PATH_SECRET` is gone. The text below is the original v1 analysis.

VERIFIED from Claude docs (2026-10-15):
- On Team plans, only **Owners and Primary Owners** can add custom connectors. Members then connect and enable it themselves.
- The supported auth types are OAuth 2.0 with DCR or CIMD (default), `none` (authless, default), and `static_headers` (a fixed API key entered by the Owner; **beta, limited set of organizations**). `oauth_anthropic_creds` and `custom_connection` require contacting Anthropic.
- Anthropic's traffic comes from **160.79.104.0/21**. The OAuth redirect URI is `https://claude.ai/api/mcp/auth_callback`. The add dialog offers "Sign in now / Sign in when needed / No sign in".
- Docs: with a shared credential, "everyone who uses it gets that credential's access". That is true here by design (everyone sees everything).

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Authless + secret path + IP allowlist (recommended for v1)** | URL `https://<host>/<40+ random chars>/mcp`; server rejects non-Anthropic IPs | Simplest, works today on Team, no IdP needed | The IP filter only proves the call came *via Claude*, not *via Schreiber's* Claude: any Claude user anywhere who has the URL gets in. So the URL is the secret, and rotating it means re-adding the connector. No per-user audit trail. |
| B. Static header API key | Owner enters `Authorization: Bearer <key>` when adding | Secret isn't in the URL or logs | **Beta and limited** (UNVERIFIED whether Schreiber's org has it); same lack of per-user identity |
| C. OAuth via Microsoft 365 or Google Workspace | Put an OAuth layer in front of the server (e.g. Cloudflare `workers-oauth-provider`, or Cloudflare Access as the IdP bridge) and allow only `@schrex.com` / Schreiber tenant users | Real per-user sign-in and audit, and leavers lose access automatically | More build and ops work; the IdP must support DCR or CIMD (Entra and Google need a bridge for that); UNVERIFIED which email/IdP Schreiber uses |

**Recommendation:** ship **A** now, with these mitigations: a 40+ character random path, the Anthropic IP allowlist, read-only scopes, per-invocation HCSS call budget, no logging of request URLs or bodies, and URL rotation whenever someone leaves. Plan **C** as v2 once usage is proven, or sooner if contractors (Syed, Zubair) or anyone outside the company gets Claude Team seats. The server is structured so an OAuth layer can be added in front without touching the tools.

## 7. Hosting: Cloudflare Workers Free (decided)
- One Worker, `schrex-hcss-mcp`, on `*.workers.dev`. `wrangler.toml` holds only non-secret vars and the KV binding.
- Secrets are set **only** with `wrangler secret put`: `HCSS_CLIENT_ID`, `HCSS_CLIENT_SECRET`, `HCSS_BUSINESS_UNIT_ID`, `ALLOWED_USER_EMAIL`, `ACCESS_PASSWORD_HASH`, `TOKEN_EPOCH` (`MCP_PATH_SECRET` until v0.5).
- Bundle: 835 KiB, 163 KiB gzipped (`wrangler deploy --dry-run`). The free limit is 3 MB compressed (UNVERIFIED that it's unchanged; we're far under it either way).
- **Auth v2** (per-user OAuth): Cloudflare's `@cloudflare/workers-oauth-provider` library wraps this same handler and supports DCR, which Claude needs. Members would sign in with Microsoft 365 or Google as the upstream IdP. That needs a KV namespace for tokens: a few writes per login and refresh, which fits the free plan (UNVERIFIED at our scale).
- Wrangler 4 needs **Node 22+** on the machine that deploys.

## 8. Rate limits (HCSS: 100 requests/min and 20 concurrent, **per company**, VERIFIED)
- The limit is shared by every Claude user and Zach's Supabase pulls (hcss-nightly-sync 03:00 ET).
- A Worker has **no shared memory across invocations or locations**, so the v0.2 global 60/min limiter could not be ported for free. A true global limiter would need a Durable Object or the Rate Limiting binding; both are UNVERIFIED for free-plan suitability and are skipped.
- Instead:
  - **Fewer calls:** `$top=1000`, so a 3,000-resource estimate is about 3 to 7 HCSS calls, not 30 or more.
  - **Sequential page pulls,** never parallel, so each invocation has one HCSS call in flight.
  - **A per-invocation budget** of 45 HCSS calls (the free-plan subrequest cap, §11).
  - **On a 429 or 5xx:** wait for `Retry-After` (seconds) or back off exponentially (capped at 20 s), up to 4 tries. Waiting costs wall time, not CPU.
  - **Isolate-level caches** of the token and of GET results (5 min, max 50 entries). They're best effort, since isolates get evicted.
- Risk: many people pulling big exports at once *could* hit HCSS's 100/min and slow Zach's sync. Usage is expected to be light; watch for 429s in the Workers logs.
- Cache API: **not used.** VERIFIED in Cloudflare's Cache API docs that `cache.put` has no effect on `*.workers.dev`; it only works on a custom domain. If we later move to a custom domain on Cloudflare (for example `hcss.schrex.com`, if schrex.com DNS moves to Cloudflare; today it's on Netlify, UNVERIFIED), we can add a 5-min Cache API layer.

## 9. Cost-rate switch
`HCSS_HIDE_COST_RATES` (default **false**). When `true`, it hides labor, burden and equipment (company, rented, EOE) dollars in totals, bid items and activities, plus resource `unitPrice`/`total`/`subTypeCost`, and the breakdown and export show `[hidden]` for Unit Cost, Total, EOE and Burden. It applies to everyone, since there's a single shared server.

## 11. Workers Free plan limits that matter (VERIFIED, developers.cloudflare.com/workers/platform/limits, page dated 2026-10-08)
| Limit (Free) | Value | Impact | How the design fits |
|---|---|---|---|
| Requests | **100,000/day** (resets 00:00 UTC; Error 1027 after) | Each MCP message is 1 request; downloads add 1 each | A team of about 10 will use hundreds a day. Fine. |
| CPU time | **10 ms per request** (network waits don't count) | **The biggest risk.** JSON-parsing large HCSS pages and building xlsx is CPU work. A benchmark here: parsing 3,000 slim resource rows (1.3 MB) took about 8 ms; real rows have about 50 fields, so a big estimate's breakdown or export can **exceed 10 ms → Error 1102** | xlsx is uncompressed and hand-built, rows are mapped once, caches are small. Small and medium estimates should be fine (UNVERIFIED until we test on real data). **If 1102 shows up on big estimates, the fix is Workers Paid ($5/mo, 30 s default CPU)** or exporting one bid-item range at a time. |
| Subrequests | **50 per invocation** (external fetches; KV and other internal services have a separate 1,000) | Every HCSS page plus the token counts | Big pages (`$top=1000`) and a hard budget of 45, with a clear "narrow your request" error. The breakdown supports about 42,000 resource rows at most. |
| Memory | 128 MB per isolate | Large estimates are held in memory during the join | A 25k-row breakdown is roughly 20 to 40 MB. OK. |
| Duration | No hard limit while the client is connected | 429 backoff waits are OK | |

**HCSS side:** `$top=1000` is allowed today (HCSS: "we don't currently limit the maximum value of $top… may enforce strict pagination in the future"). If HCSS caps `$top` at 100, big estimates would need more than 45 calls and fail on the free plan. That would also push us to Workers Paid (10,000 subrequests).

## 10. Open questions
1. Zach heads-up done? (rates are now visible to all members)
2. A new HCSS API client with `heavybid:read heavybid:system:read` only: who creates it (an HCSS admin, in HCSS Credentials)? Does the license include Estimate Insights?
3. Business unit id(s).
4. Is Schreiber's Claude Team org eligible for `static_headers` (option B)? Who is the Team Owner who will add the connector?
5. Are there contractors or outside people in the Claude Team workspace? If so, move to OAuth (option C) sooner.
6. Ryan's sample report export, to validate the Tax/OT%, Pcs/Wste and EOE% mapping and to find where EOE, Burden and Burden% per resource come from.
7. Cloudflare account owner (a company email, not personal), and approval to upgrade to Workers Paid ($5/mo) if the 10 ms CPU limit bites.
8. Are only *processed* estimates visible through Estimate Insights? How long after a desktop/VM edit?
9. Zach's `hcss-api` skill and edge function code, to cross-check endpoints.
