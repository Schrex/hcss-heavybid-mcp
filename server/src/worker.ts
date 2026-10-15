import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Env } from "./config.js";
import { HcssClient } from "./hcss.js";
import { buildServer } from "./tools.js";
import { ipAllowed } from "./ip.js";

/** Plain Workers fetch handler: stateless Streamable HTTP MCP. No Durable Objects (keeps us on the free plan). */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");

    let cfg;
    try { cfg = loadConfig(env); } catch (e) { console.error((e as Error).message); return new Response("misconfigured", { status: 500 }); }
    const base = `/${cfg.pathSecret}`;

    // One-time export download. Fetched by the user's browser (not Anthropic), so no IP check.
    if (request.method === "GET" && url.pathname.startsWith(`${base}/exports/`)) {
      const id = url.pathname.slice(`${base}/exports/`.length);
      if (!/^[a-f0-9]{64}$/.test(id)) return new Response("Not found", { status: 404 });
      const { value, metadata } = await env.EXPORTS.getWithMetadata<{ name: string; mime: string }>(`export:${id}`, "arrayBuffer");
      if (!value || !metadata) return new Response("Link expired or already used. Ask Claude to export again.", { status: 404 });
      await env.EXPORTS.delete(`export:${id}`); // single use (KV is eventually consistent: UNVERIFIED that a 2nd fetch within ~60 s fails everywhere)
      return new Response(value, { headers: {
        "Content-Type": metadata.mime,
        "Content-Disposition": `attachment; filename="${metadata.name}"`,
        "Cache-Control": "no-store",
      } });
    }

    if (url.pathname !== `${base}/mcp`) return new Response(null, { status: 404 });
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    if (!ipAllowed(ip, cfg.allowedCidrs)) return new Response(null, { status: 403 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

    const hcss = new HcssClient(cfg); // per invocation: counts the 50-subrequest budget
    const server = buildServer(cfg, hcss, env, url.origin);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } catch (e) {
      console.error("mcp error", (e as Error).message);
      return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
