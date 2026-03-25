/**
 * provider-example.ts — Template for developing new mail providers
 *
 * This file shows the EXACT structure every provider must follow.
 * Copy it, rename it to provider-<name>.ts, then fill in your upstream logic.
 *
 * Run:
 *   PORT=8099 PROVIDER_SECRET=test-secret deno run --allow-net --allow-env --unstable-kv provider-example.ts
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY RULES — READ BEFORE YOU START
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. EVERY external HTTP call MUST go through countedFetch().
 *    Using raw fetch() will break the _upstream_calls tracking and
 *    bypass the per-request call budget enforced by the gateway.
 *
 * 2. ALWAYS call authenticateGateway() at the top of handleRequest().
 *    Without it anyone can invoke your provider directly.
 *
 * 3. The CONFIG block + env() priority chain is MANDATORY.
 *    Priority: Deno.env.get(key)  >  CONFIG[key]  >  fallback argument.
 *    This lets operators override settings via env vars at deploy time
 *    without touching source code.
 *
 * 4. All responses MUST go through providerResponse() so the JSON
 *    envelope { success, data, error, _upstream_calls } is consistent.
 *
 * 5. Throw ProviderError(status, message) for expected failures.
 *    Unexpected errors are caught automatically and returned as 500.
 *
 * 6. Persist session/account data in Deno KV with an appropriate TTL,
 *    but prefer a MEMORY-FIRST pattern on hot paths:
 *    - read from in-process cache first
 *    - use KV as fallback / cold-start recovery
 *    - throttle KV writes when only timestamps or refresh tokens changed
 *    TTL MUST NOT exceed 86 400 000 ms (24 hours). Shorter is better.
 *    Deno Deploy KV space is limited (1 GiB free / 5 GiB pro) and
 *    write units are billed monthly. Long TTLs waste both.
 *    Use a UNIQUE key prefix per provider (e.g. ["example_session", email])
 *    so multiple providers sharing the same KV store never collide.
 *
 * 7. Handle upstream 401 (token expired). Every provider needs a
 *    strategy: either refresh the token and retry, or re-create the
 *    session. Do NOT return 401 to the gateway without trying once.
 *
 * 8. Deno.serve() must be guarded by `if (import.meta.main)` and must
 *    read PORT from env. This keeps the module importable for tests.
 *
 * 9. The response field for listing emails is:
 *      { emails: Array<{ id, email_address, from_address, subject, content, html_content }>, count }
 *    "content" = plain text, "html_content" = raw HTML body.
 *    The gateway / downstream clients depend on this exact shape.
 *
 * 10. If your upstream doesn't support a certain operation (e.g. delete),
 *     throw ProviderError(501, "Not implemented.") instead of silently
 *     returning success.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ─── Types ───────────────────────────────────────────────────────────

/** Shape of the session/account record persisted in Deno KV. */
type AccountRecord = {
  id: string;
  address: string;
  /** Store a credential that lets you call the upstream API. */
  token: string;
  tokenIssuedAt: number;
  createdAt: number;
  updatedAt: number;
};

type ProviderRequestContext = {
  requestId: string;
  route: string;
  upstreamCalls: number;
  maxUpstreamCalls: number;
};

type JsonRecord = Record<string, unknown>;

class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── CONFIG ──────────────────────────────────────────────────────────
// Every hardcoded default lives here so operators can override via env.

const CONFIG = {
  /** Gateway → provider shared secret. Set via env in production. */
  PROVIDER_SECRET: "",
  /** Base URL of the upstream mail service. */
  UPSTREAM_BASE: "https://api.example.com",
  /** How long a created account stays valid in KV (ms). Max 86400000 (24h). */
  ACCOUNT_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours — hard ceiling, never exceed
  /** If the token is older than this, refresh before use (ms). */
  TOKEN_REFRESH_INTERVAL_MS: 10 * 60 * 1000, // 10 minutes
  /** Optional in-memory hot cache TTL (ms). */
  PROVIDER_MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,
  /** Optional minimum interval between KV writes for the same record (ms). */
  PROVIDER_KV_WRITE_MIN_INTERVAL_MS: 180 * 1000,
} as const;

// ─── Env helpers ─────────────────────────────────────────────────────
// Priority:  Deno.env.get(key)  >  CONFIG[key]  >  fallback

function env(key: string, fallback?: string): string {
  return Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString() ?? fallback ?? "";
}

function envPositiveInt(key: string, fallback: number): number {
  const raw = Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString();
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── Resolved config ─────────────────────────────────────────────────

const PROVIDER_SECRET = env("PROVIDER_SECRET");
const UPSTREAM_BASE = env("UPSTREAM_BASE", "https://api.example.com");
const ACCOUNT_TTL_MS = Math.min(
  envPositiveInt("ACCOUNT_TTL_MS", 24 * 3600_000),
  24 * 3600_000, // Hard ceiling: 24 hours. KV space on Deno Deploy is limited.
);
const TOKEN_REFRESH_INTERVAL_MS = envPositiveInt(
  "TOKEN_REFRESH_INTERVAL_MS",
  600_000,
);
const PROVIDER_MEMORY_CACHE_TTL_MS = envPositiveInt(
  "PROVIDER_MEMORY_CACHE_TTL_MS",
  300_000,
);
const PROVIDER_KV_WRITE_MIN_INTERVAL_MS = Math.min(
  envPositiveInt("PROVIDER_KV_WRITE_MIN_INTERVAL_MS", 180_000),
  180_000,
);

// ─── Deno KV ─────────────────────────────────────────────────────────

const kv = await Deno.openKv();

/**
 * IMPORTANT: use a prefix unique to THIS provider.
 * If you copy-paste from provider-mailtm and forget to rename the key,
 * two providers will overwrite each other's data.
 */
const keyBuilders = {
  account: (email: string) => ["example_account", email] as const,
};
const accountCache = new Map<
  string,
  {
    account: AccountRecord;
    expiresAt: number;
    lastPersistedAt: number;
    dirty: boolean;
  }
>();
let accountFlushTimer: ReturnType<typeof setTimeout> | null = null;
let accountFlushPromise: Promise<void> | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function providerResponse(
  ctx: ProviderRequestContext,
  status: number,
  success: boolean,
  data: unknown,
  error: string,
): Response {
  return new Response(
    JSON.stringify({
      success,
      data,
      error,
      _upstream_calls: ctx.upstreamCalls,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function authenticateGateway(request: Request): void {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== PROVIDER_SECRET) {
    throw new ProviderError(401, "Unauthorized.");
  }
}

function parseMaxUpstreamCalls(request: Request): number {
  const raw = request.headers.get("X-Max-Upstream-Calls");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Wrapper around fetch() that tracks call count.
 * NEVER call raw fetch() for upstream requests — use this instead.
 */
async function countedFetch(
  ctx: ProviderRequestContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (ctx.maxUpstreamCalls > 0 && ctx.upstreamCalls >= ctx.maxUpstreamCalls) {
    throw new ProviderError(429, "Upstream call budget exhausted.");
  }
  const response = await fetch(url, init);
  ctx.upstreamCalls += 1;
  return response;
}

// ─── KV persistence ──────────────────────────────────────────────────

async function loadAccount(email: string): Promise<AccountRecord | null> {
  const cached = accountCache.get(email);
  if (cached && cached.expiresAt > nowMs()) {
    return { ...cached.account };
  }
  if (cached) accountCache.delete(email);
  const entry = await kv.get<AccountRecord>(keyBuilders.account(email));
  if (entry.value) {
    accountCache.set(email, {
      account: entry.value,
      expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
      lastPersistedAt: nowMs(),
      dirty: false,
    });
  }
  return entry.value ?? null;
}

function queueAccountFlush(force = false): void {
  if (accountFlushTimer && !force) return;
  if (accountFlushTimer) clearTimeout(accountFlushTimer);
  accountFlushTimer = setTimeout(() => {
    accountFlushTimer = null;
    void flushDirtyAccounts();
  }, force ? 0 : PROVIDER_KV_WRITE_MIN_INTERVAL_MS);
}

async function persistAccount(account: AccountRecord): Promise<void> {
  await kv.set(keyBuilders.account(account.address), account, {
    expireIn: ACCOUNT_TTL_MS,
  });
  accountCache.set(account.address, {
    account,
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
    lastPersistedAt: nowMs(),
    dirty: false,
  });
}

async function flushDirtyAccounts(): Promise<void> {
  if (accountFlushPromise) return;
  const dirtyEntries = Array.from(accountCache.values()).filter((entry) =>
    entry.dirty
  );
  if (dirtyEntries.length === 0) return;
  accountFlushPromise = (async () => {
    let flushed = 0;
    for (const entry of dirtyEntries) {
      const current = accountCache.get(entry.account.address);
      if (!current?.dirty) continue;
      try {
        await persistAccount(current.account);
        flushed += 1;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          type: "provider_flush_failed",
          provider: "example",
          email: current.account.address,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (flushed > 0) {
      console.log(JSON.stringify({
        level: "info",
        type: "provider_flush_ok",
        provider: "example",
        flushed,
      }));
    }
  })();
  try {
    await accountFlushPromise;
  } finally {
    accountFlushPromise = null;
    if (Array.from(accountCache.values()).some((entry) => entry.dirty)) {
      queueAccountFlush();
    }
  }
}

async function saveAccount(account: AccountRecord, force = false): Promise<void> {
  const cached = accountCache.get(account.address);
  accountCache.set(account.address, {
    account,
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
    lastPersistedAt: cached?.lastPersistedAt ?? 0,
    dirty: true,
  });
  if (force || !cached) {
    await persistAccount(account);
    return;
  }
  if (nowMs() - cached.lastPersistedAt < PROVIDER_KV_WRITE_MIN_INTERVAL_MS) {
    queueAccountFlush();
    return;
  }
  await flushDirtyAccounts();
}

async function deleteAccount(email: string): Promise<void> {
  accountCache.delete(email);
  await kv.delete(keyBuilders.account(email));
}

// ─── Upstream helpers ────────────────────────────────────────────────
// Replace these with real upstream API calls.

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

/**
 * Check if the token should be refreshed.
 * Many API tokens (e.g. JWTs from mail.tm) expire silently.
 * Proactively refreshing avoids 401 surprises.
 */
function tokenNeedsRefresh(account: AccountRecord): boolean {
  return nowMs() - account.tokenIssuedAt > TOKEN_REFRESH_INTERVAL_MS;
}

/**
 * Obtain a fresh token from the upstream service.
 * This is usually POST /token with credentials.
 */
async function fetchToken(
  ctx: ProviderRequestContext,
  _address: string,
  _credential: string,
): Promise<string> {
  // TODO: Replace with your upstream token endpoint.
  //
  // Example (mail.tm style):
  //   const res = await countedFetch(ctx, `${UPSTREAM_BASE}/token`, {
  //     method: "POST",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({ address, password: credential }),
  //   });
  //   if (!res.ok) throw new ProviderError(502, "Upstream token request failed.");
  //   const json = await res.json();
  //   return json.token;
  void ctx;
  throw new ProviderError(501, "fetchToken not implemented.");
}

/**
 * Get a valid token, refreshing if needed.
 * On 401 from the upstream, call fetchToken() and retry once.
 */
async function getValidToken(
  ctx: ProviderRequestContext,
  account: AccountRecord,
): Promise<string> {
  if (!tokenNeedsRefresh(account)) return account.token;

  const newToken = await fetchToken(ctx, account.address, /* credential */ "");
  account.token = newToken;
  account.tokenIssuedAt = nowMs();
  account.updatedAt = nowMs();
  await saveAccount(account);
  return newToken;
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  // 1. Parse optional prefix / domain from request body
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";

  // 2. (Optional) Fetch available domains from upstream
  //    const domains = await fetchDomains(ctx);
  //    if (domain && !domains.includes(domain)) {
  //      throw new ProviderError(400, `Domain "${domain}" not available.`);
  //    }

  // 3. Create account at upstream
  //    const address = `${prefix || randomPrefix()}@${domain || domains[0]}`;
  //    const res = await countedFetch(ctx, `${UPSTREAM_BASE}/accounts`, { ... });
  //    if (!res.ok) throw new ProviderError(502, "Failed to create upstream account.");

  // 4. Get auth token
  //    const token = await fetchToken(ctx, address, password);

  // 5. Save to KV
  //    await saveAccount({ id, address, token, ... });

  // 6. Return
  //    return providerResponse(ctx, 200, true, { email: address }, "");

  void prefix;
  void domain;
  throw new ProviderError(501, "handleGenerateEmail not implemented.");
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  // 1. Load account from KV — 404 if not found
  const account = await loadAccount(email);
  if (!account) {
    throw new ProviderError(
      404,
      "No active session for this email address.",
    );
  }

  // 2. Ensure token is valid
  const token = await getValidToken(ctx, account);

  // 3. Fetch message list from upstream
  //    const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages?page=1`, {
  //      method: "GET",
  //      headers: authHeaders(token),
  //    });
  //
  //    IMPORTANT: handle 401 — refresh token and retry ONCE.
  //    if (res.status === 401) {
  //      const newToken = await fetchToken(ctx, account.address, ...);
  //      account.token = newToken; account.tokenIssuedAt = nowMs();
  //      await saveAccount(account);
  //      const retry = await countedFetch(ctx, ..., { headers: authHeaders(newToken) });
  //      // parse retry
  //    }

  // 4. Map upstream response to standard shape:
  //    const emails = messages.map(m => ({
  //      id:            m.id,
  //      email_address: email,
  //      from_address:  extractFrom(m.from),     // normalize sender format
  //      subject:       m.subject ?? "",
  //      content:       m.text ?? "",             // plain text
  //      html_content:  m.html?.[0] ?? m.body ?? "",  // raw HTML
  //    }));

  void token;
  throw new ProviderError(501, "handleListEmails not implemented.");

  // 5. Return standard envelope
  //    return providerResponse(ctx, 200, true, { emails, count: emails.length }, "");
}

async function handleGetEmail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  const token = await getValidToken(ctx, account);

  // Fetch single message from upstream
  //   const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages/${mailId}`, { ... });
  //   if (res.status === 404) throw new ProviderError(404, "Message not found.");
  //   Same 401-retry pattern as listEmails.
  //
  //   return providerResponse(ctx, 200, true, {
  //     id, email_address, from_address, subject, content, html_content
  //   }, "");

  void token;
  void mailId;
  throw new ProviderError(501, "handleGetEmail not implemented.");
}

async function handleDeleteEmail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  const token = await getValidToken(ctx, account);

  // DELETE upstream message
  //   const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages/${mailId}`, {
  //     method: "DELETE", headers: authHeaders(token),
  //   });
  //   if (!res.ok && res.status !== 404) throw new ProviderError(502, "...");

  // If your upstream doesn't support delete, throw 501:
  //   throw new ProviderError(501, "Not implemented.");

  void token;
  void mailId;
  throw new ProviderError(501, "handleDeleteEmail not implemented.");
}

async function handleClearEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  // Option A: Delete all messages one by one via upstream
  // Option B: Delete upstream account + local KV record
  // Option C: throw 501 if not supported
  //
  //   await deleteAccount(email);
  //   return providerResponse(ctx, 200, true, { message: "Cleared.", count: n }, "");

  throw new ProviderError(501, "handleClearEmails not implemented.");
}

// ─── Main router ─────────────────────────────────────────────────────

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ctx: ProviderRequestContext = {
    requestId: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
    route: `${request.method} ${url.pathname}`,
    upstreamCalls: 0,
    maxUpstreamCalls: parseMaxUpstreamCalls(request),
  };

  try {
    // Auth check MUST be the first thing.
    authenticateGateway(request);

    const mailMatch = url.pathname.match(/^\/email\/([^/]+)$/);

    // --- POST /generate-email ---
    if (request.method === "POST" && url.pathname === "/generate-email") {
      let body: JsonRecord = {};
      try {
        body = (await request.json()) as JsonRecord;
      } catch { /* empty body is fine */ }
      return await handleGenerateEmail(ctx, body);
    }

    // --- GET /generate-email (convenience alias — same as POST with empty body) ---
    if (request.method === "GET" && url.pathname === "/generate-email") {
      return await handleGenerateEmail(ctx, {});
    }

    // --- GET /emails?email=<address> ---
    if (request.method === "GET" && url.pathname === "/emails") {
      const email = url.searchParams.get("email") ?? "";
      if (!email) throw new ProviderError(400, "Missing email parameter.");
      return await handleListEmails(ctx, email);
    }

    // --- GET /email/<id>?email=<address> ---
    if (mailMatch && request.method === "GET") {
      const email = url.searchParams.get("email") ?? "";
      if (!email) throw new ProviderError(400, "Missing email parameter.");
      return await handleGetEmail(ctx, email, mailMatch[1]);
    }

    // --- DELETE /email/<id>?email=<address> ---
    if (mailMatch && request.method === "DELETE") {
      const email = url.searchParams.get("email") ?? "";
      if (!email) throw new ProviderError(400, "Missing email parameter.");
      return await handleDeleteEmail(ctx, email, mailMatch[1]);
    }

    // --- DELETE /emails/clear?email=<address> ---
    if (request.method === "DELETE" && url.pathname === "/emails/clear") {
      const email = url.searchParams.get("email") ?? "";
      if (!email) throw new ProviderError(400, "Missing email parameter.");
      return await handleClearEmails(ctx, email);
    }

    return providerResponse(ctx, 404, false, null, "Not found.");
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerResponse(ctx, error.status, false, null, error.message);
    }
    console.error(
      JSON.stringify({
        level: "error",
        requestId: ctx.requestId,
        route: ctx.route,
        error: error instanceof Error ? error.stack : String(error),
      }),
    );
    return providerResponse(ctx, 500, false, null, "Internal provider error.");
  }
}

// ─── Entry point ─────────────────────────────────────────────────────

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve(
    Number.isInteger(port) && port > 0 ? { port } : {},
    handleRequest,
  );
}
