import type { Config } from "./config.js";

interface Paged<T> { data: T[]; nextSkipValue?: number | null }
type Query = Record<string, string | number | boolean | undefined>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolate-scoped (best effort; an isolate is reused across requests but can be evicted any time).
let tokenCache: { token: string; exp: number; key: string } | undefined;
const getCache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60_000;

export class BudgetError extends Error {}

// HCSS sits behind an Azure firewall that blocks some default user agents with an HTML
// "The request is blocked" page, so every outbound HCSS call sends these headers.
export const HCSS_HEADERS = { "User-Agent": "Mozilla/5.0 SchreiberMCP/0.1", Accept: "application/json" } as const;

/** Read a response as JSON, turning an HTML firewall/error page into a clear error. */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get("Content-Type") ?? "";
  const head = text.trimStart().slice(0, 15).toLowerCase();
  if (ct.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html") || /request is blocked/i.test(text.slice(0, 2000))) {
    throw new Error(`HCSS firewall blocked request (${what}: HTTP ${res.status}, HTML response instead of JSON)`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HCSS returned non-JSON for ${what} (HTTP ${res.status})`);
  }
}

/**
 * GET-only HCSS client, created per Worker invocation so it can count subrequests
 * (free plan: 50 per invocation; token + every HCSS page + KV ops count).
 */
export class HcssClient {
  used = 0;
  constructor(private cfg: Config) {}

  private spend() {
    if (++this.used > this.cfg.maxSubrequests) {
      throw new BudgetError(`Request too large for the Workers free plan (${this.cfg.maxSubrequests} HCSS calls/invocation). Narrow it (one bid item) or export.`);
    }
  }

  private async token(): Promise<string> {
    const key = this.cfg.clientId + "|" + this.cfg.scope;
    if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
    const form = (withClientInBody: boolean) => {
      const f = new URLSearchParams({ grant_type: "client_credentials", scope: this.cfg.scope });
      if (withClientInBody) { f.set("client_id", this.cfg.clientId); f.set("client_secret", this.cfg.clientSecret); }
      return f;
    };
    const post = (body: URLSearchParams, basic: boolean) => {
      this.spend();
      const headers: Record<string, string> = { ...HCSS_HEADERS, "Content-Type": "application/x-www-form-urlencoded" };
      if (basic) {
        // RFC 6749 §2.3.1: form-encode id and secret, then base64("id:secret").
        headers.Authorization = "Basic " + btoa(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`);
      }
      return fetch(this.cfg.tokenUrl, { method: "POST", headers, body });
    };

    let res = await post(form(true), false);
    if (res.status === 400) {
      const err = await readJson<{ error?: string }>(res, "token");
      if (err.error !== "invalid_client") throw new Error(`HCSS token request failed: HTTP 400 ${err.error ?? ""}`.trim());
      // Fall back once to HTTP Basic client authentication.
      res = await post(form(false), true);
    }
    if (!res.ok) {
      const ct = res.headers.get("Content-Type") ?? "";
      if (ct.includes("text/html")) await readJson(res, "token"); // throws the firewall error
      throw new Error(`HCSS token request failed: HTTP ${res.status}`); // never echo secrets
    }
    const j = await readJson<{ access_token: string; expires_in?: number }>(res, "token");
    tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key };
    return j.access_token;
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(this.cfg.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const key = url.toString();
    const hit = getCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

    for (let attempt = 0; attempt < 4; attempt++) {
      const auth = `Bearer ${await this.token()}`;
      this.spend();
      const res = await fetch(url.toString(), { headers: { ...HCSS_HEADERS, Authorization: auth } });
      if (res.status === 401 && attempt === 0) { tokenCache = undefined; continue; }
      if (res.status === 429 || res.status >= 500) {
        // Waiting is wall-clock, not CPU time, so it's fine on the free plan. Retries spend subrequests.
        const ra = Number(res.headers.get("Retry-After"));
        await sleep(Math.min(20_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, `GET ${url.pathname}`);
      if (res.status === 403) throw new Error("HCSS 403 Forbidden: the API client lacks a scope for this call.");
      if (!res.ok) throw new Error(`HCSS GET ${url.pathname} failed: HTTP ${res.status}`);
      const value = await readJson<T>(res, `GET ${url.pathname}`);
      getCache.set(key, { at: Date.now(), value });
      if (getCache.size > 50) getCache.delete(getCache.keys().next().value as string); // stay well under 128 MB
      return value;
    }
    throw new Error(`HCSS GET ${url.pathname}: gave up after repeated 429/5xx (HCSS limit is 100/min per company, shared).`);
  }

  /** Follows nextSkipValue. Uses large $top pages to fit the free-plan subrequest budget. */
  async getAll<T>(path: string, query: Query, maxRecords: number) {
    const out: T[] = [];
    let skip = 0;
    let truncated = false;
    for (;;) {
      const top = Math.min(this.cfg.pageSize, maxRecords - out.length);
      const page = await this.get<Paged<T>>(path, { ...query, $top: top, $skip: skip });
      const rows = page.data ?? [];
      out.push(...rows);
      const next = page.nextSkipValue;
      if (next === undefined || next === null || next <= skip || rows.length === 0) break;
      if (out.length >= maxRecords) { truncated = true; break; }
      skip = next;
    }
    return { records: out, truncated };
  }
}
