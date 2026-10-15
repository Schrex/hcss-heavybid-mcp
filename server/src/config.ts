export interface Env {
  // secrets (wrangler secret put)
  HCSS_CLIENT_ID: string;
  HCSS_CLIENT_SECRET: string;
  MCP_PATH_SECRET: string;
  HCSS_BUSINESS_UNIT_ID?: string;
  // vars (wrangler.toml)
  HCSS_SCOPE?: string;
  HCSS_TOKEN_URL?: string;
  HCSS_API_BASE?: string;
  HCSS_HIDE_COST_RATES?: string;
  ALLOWED_CIDRS?: string;
  HCSS_PAGE_SIZE?: string;
  HCSS_MAX_SUBREQUESTS?: string;
  EXPORT_TTL_SECONDS?: string;
  EXPORTS: KVNamespace;
}

export interface Config {
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenUrl: string;
  apiBase: string;
  businessUnitId?: string;
  hideCostRates: boolean;
  pageSize: number;
  maxSubrequests: number;
  pathSecret: string;
  allowedCidrs: string[];
  exportTtlSeconds: number;
}

const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : !["false", "0", "no", "off"].includes(v.trim().toLowerCase());
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Env): Config {
  if (!env.HCSS_CLIENT_ID || !env.HCSS_CLIENT_SECRET) throw new Error("HCSS_CLIENT_ID / HCSS_CLIENT_SECRET secrets are not set.");
  if (!env.MCP_PATH_SECRET || env.MCP_PATH_SECRET.length < 32) throw new Error("MCP_PATH_SECRET secret must be 32+ characters.");
  return {
    clientId: env.HCSS_CLIENT_ID,
    clientSecret: env.HCSS_CLIENT_SECRET,
    scope: env.HCSS_SCOPE || "heavybid:read heavybid:system:read", // never add write/admin scopes
    tokenUrl: env.HCSS_TOKEN_URL || "https://api.hcssapps.com/identity/connect/token",
    apiBase: (env.HCSS_API_BASE || "https://api.hcssapps.com/heavybid/api/v2/integration").replace(/\/$/, ""),
    businessUnitId: env.HCSS_BUSINESS_UNIT_ID || undefined,
    hideCostRates: bool(env.HCSS_HIDE_COST_RATES, false),
    // Free plan: 50 subrequests per invocation, so use big pages ($top) and a hard budget.
    pageSize: Math.min(5000, num(env.HCSS_PAGE_SIZE, 1000)),
    maxSubrequests: Math.min(48, num(env.HCSS_MAX_SUBREQUESTS, 45)),
    pathSecret: env.MCP_PATH_SECRET,
    allowedCidrs: (env.ALLOWED_CIDRS ?? "160.79.104.0/21").split(",").map((s) => s.trim()).filter(Boolean),
    exportTtlSeconds: Math.max(60, num(env.EXPORT_TTL_SECONDS, 900)), // KV minimum TTL is 60 s
  };
}
