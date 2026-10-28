# HeavyBid connector for Claude: setup guide (plain English)

This adds a "Schreiber HeavyBid" connector to our Claude Team workspace. Anyone on the team can then ask Claude about HeavyBid estimates, and pull Ryan's bid item > activity > resource cost report as an Excel file, without exporting anything from the HeavyBid VM. It can only **read** HeavyBid. It cannot change anything.

## Part 1: Sumanth (one time) gets the server running on Cloudflare (free plan)
1. **Cloudflare account:** sign up at dash.cloudflare.com with a **company** email (not a personal one), and stay on the **Free** plan. No credit card is needed for Workers or KV.
2. **New HCSS API client:** have an HCSS admin (HCSS Credentials) create one with **only** `heavybid:read` and `heavybid:system:read`. Don't reuse the existing client that has `myField:admin` etc.
3. **Install Node.js 22 or newer** on your computer (Wrangler requires it). Then, in the `server` folder:
   ```
   npm install
   npx wrangler login                          # opens the browser, approve
   npx wrangler kv namespace create EXPORTS    # copy the printed id into wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID)
   npx wrangler secret put HCSS_CLIENT_ID      # paste when prompted
   npx wrangler secret put HCSS_CLIENT_SECRET
   npx wrangler secret put HCSS_BUSINESS_UNIT_ID
   npx wrangler kv namespace create HEAVYBID_OAUTH_KV   # copy the id into wrangler.toml under binding OAUTH_KV
   npx wrangler secret put ALLOWED_USER_EMAIL  # one line, comma-separated: zach@schrex.com,dave@schrex.com,...
   sh scripts/set-password.sh                  # you type the shared password (hidden, twice); only its hash is stored
   openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH
   npx wrangler deploy
   ```
   The password lives only in Bitwarden (collection "HCSS Connectors", item "HeavyBid MCP connector").
   Wrangler will ask once to pick a `workers.dev` subdomain. The secrets live only in Cloudflare. Never put them in `wrangler.toml`, a file, chat, email or Slack.
4. **Check it:** `https://schrex-hcss-mcp.<your-subdomain>.workers.dev/healthz` should say `ok`.
5. The connector URL is `https://schrex-hcss-mcp.schrex.workers.dev/mcp` (no secret in it). If the workers.dev subdomain isn't `schrex`, change `PUBLIC_ORIGIN` in `wrangler.toml` before deploying.
6. **Monitoring:** Cloudflare dashboard → Workers & Pages → schrex-hcss-mcp → Metrics/Logs. Watch for "Exceeded CPU" (Error 1102) and HCSS 429s.

## Part 2: Claude Team Owner (one time) adds the connector
Only an **Owner or Primary Owner** of the Claude Team workspace can do this.
1. In Claude (claude.ai), open **Settings (or Customize) → Connectors**.
2. Click **Add custom connector**.
3. Name: `Schreiber HeavyBid`. URL: paste the connector URL from Sumanth.
4. Under **Authentication**, choose **OAuth**. Leave the OAuth Client ID/Secret fields empty (Claude registers itself).
5. Save. Everyone in the workspace sees it; only people on `ALLOWED_USER_EMAIL` with the password can sign in.
(Menu names can move around; Anthropic's guide is "Get started with custom connectors using remote MCP" on support.claude.com.)

## Part 3: Every team member (once each)
1. In Claude, open **Settings → Connectors**, find **Schreiber HeavyBid**, and click **Connect**. On the "Schreiber HeavyBid" page, sign in with your own @schrex.com email and the connector password (Bitwarden). Sign-in lasts 90 days. Five wrong passwords lock sign-in from that network for 15 minutes.
2. In a chat, make sure the connector is switched on (the tools / "+" menu under the message box).
3. Ask away:
   - "List the 10 most recently modified HeavyBid estimates."
   - "Find estimates with 'sewer' in the name."
   - "Show the cost breakdown for bid item 10 on estimate 26-101."
   - "Export the full cost breakdown for estimate 26-101 to Excel." Claude replies with a download link. Click it within **15 minutes**. It works **once**, and you shouldn't forward it.

## Good to know
- **Everyone sees all costs**, including labor and equipment rates, burden, EOE and rent.
- Large estimates take time (up to a minute or so). HCSS allows the whole company 100 calls a minute, shared with Zach's nightly sync, so the connector paces itself.
- If an estimate you just changed isn't showing, it may not have synced from HeavyBid to HCSS's cloud yet.
- "403 Forbidden" means the HCSS client is missing a permission. Tell Sumanth.
- **Add/remove a user:** `npx wrangler secret put ALLOWED_USER_EMAIL` with the new list. A removed user is blocked at their next request.
- **Sign everyone out:** `openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH`.
- **Change the password:** `sh scripts/set-password.sh`. Existing sign-ins keep working until you also rotate `TOKEN_EPOCH`.
- Logs (Cloudflare → Workers → schrex-hcss-mcp → Logs) show who called which tool, never the data.
- If a very large estimate fails with "exceeded resource limits", that's the free plan's 10 ms CPU cap. Ask for one bid item at a time, or Sumanth can upgrade to Workers Paid ($5/mo).
- The connector can serve up to 100,000 requests a day on the free plan. That's plenty for us.
