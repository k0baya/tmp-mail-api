/**
 * provider-example_workers.js — Cloudflare Workers template for new mail providers
 *
 * This file shows the EXACT structure every provider must follow when
 * targeting Cloudflare Workers instead of Deno.
 *
 * Deploy:
 *   1. Create a KV namespace via `wrangler kv namespace create PROVIDER_KV`
 *   2. Add the binding to wrangler.toml (see bottom of this file)
 *   3. Set secrets: `wrangler secret put PROVIDER_SECRET`
 *   4. Deploy: `wrangler deploy`
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KEY RULES — READ BEFORE YOU START
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. EVERY external HTTP call MUST go through countedFetch().
 *    Using raw fetch() will break the _upstream_calls tracking and
 *    bypass the per-request call budget enforced by the gateway.
 *
 * 2. ALWAYS call authenticateGateway() at the top of the handler.
 *    Without it anyone can invoke your provider directly.
 *
 * 3. Configuration comes from environment bindings (env object),
 *    NOT from process.env or global variables.
 *    Workers receive env as the second argument to fetch().
 *
 * 4. All responses MUST go through providerResponse() so the JSON
 *    envelope { success, data, error, _upstream_calls } is consistent.
 *
 * 5. Throw ProviderError(status, message) for expected failures.
 *    Unexpected errors are caught automatically and returned as 500.
 *
 * 6. Persist session/account data in Workers KV with an appropriate TTL.
 *    TTL MUST NOT exceed 86400 seconds (24 hours). Shorter is better.
 *    KV storage and operations on both Deno Deploy and Cloudflare are
 *    metered — long TTLs waste space and write budget.
 *    Use a UNIQUE key prefix per provider (e.g. "example_account:")
 *    so multiple providers sharing the same KV namespace never collide.
 *    KV TTL is set in SECONDS (not milliseconds like Deno KV).
 *
 * 7. Handle upstream 401 (token expired). Every provider needs a
 *    strategy: either refresh the token and retry, or re-create the
 *    session. Do NOT return 401 to the gateway without trying once.
 *
 * 8. Workers KV is eventually consistent with ~60s propagation delay.
 *    For data that must be read-after-write immediately, use the
 *    cache API or pass data within the same request context.
 *
 * 9. The response field for listing emails is:
 *      { emails: Array<{ id, email_address, from_address, subject, content, html_content }>, count }
 *    "content" = plain text, "html_content" = raw HTML body.
 *    The gateway / downstream clients depend on this exact shape.
 *
 * 10. If your upstream doesn't support a certain operation (e.g. delete),
 *     throw ProviderError(501, "Not implemented.") instead of silently
 *     returning success.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DIFFERENCES FROM DENO VERSION
 * ═══════════════════════════════════════════════════════════════════════
 *
 * | Aspect             | Deno                          | Cloudflare Workers              |
 * |--------------------|-------------------------------|---------------------------------|
 * | Entry point        | Deno.serve(handler)           | export default { fetch }        |
 * | KV API             | Deno.openKv() → kv.get/set    | env.PROVIDER_KV.get/put/delete  |
 * | KV TTL unit        | milliseconds (expireIn)       | seconds (expirationTtl)         |
 * | KV value format    | native JS objects             | JSON strings (must parse/stringify) |
 * | Config access      | Deno.env.get(key)             | env.KEY (bound in wrangler.toml)|
 * | Crypto             | crypto.randomUUID()           | crypto.randomUUID() ✓ same     |
 * | Top-level await    | Supported                     | NOT supported in modules        |
 * | File type          | TypeScript (.ts)              | JavaScript (.js) or bundled TS  |
 * ═══════════════════════════════════════════════════════════════════════
 */

// ─── Error class ─────────────────────────────────────────────────────

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function providerResponse(ctx, status, success, data, error) {
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

function authenticateGateway(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // PROVIDER_SECRET is set via `wrangler secret put PROVIDER_SECRET`
  if (token !== (env.PROVIDER_SECRET ?? "")) {
    throw new ProviderError(401, "Unauthorized.");
  }
}

function parseMaxUpstreamCalls(request) {
  const raw = request.headers.get("X-Max-Upstream-Calls");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Wrapper around fetch() that tracks call count.
 * NEVER call raw fetch() for upstream requests — use this instead.
 */
async function countedFetch(ctx, url, init) {
  if (ctx.maxUpstreamCalls > 0 && ctx.upstreamCalls >= ctx.maxUpstreamCalls) {
    throw new ProviderError(429, "Upstream call budget exhausted.");
  }
  const response = await fetch(url, init);
  ctx.upstreamCalls += 1;
  return response;
}

// ─── Config helper ───────────────────────────────────────────────────
// In Workers, config lives in `env` bindings (wrangler.toml [vars] or secrets).

/**
 * Read a string config value from env bindings.
 * Workers don't have process.env; everything comes through the env object.
 */
function getConfig(env, key, fallback = "") {
  const val = env[key];
  if (val === undefined || val === null) return fallback;
  return String(val);
}

function getConfigPositiveInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── KV persistence ──────────────────────────────────────────────────
// Workers KV differences from Deno KV:
//   - Values are strings — you must JSON.stringify/parse
//   - TTL is in SECONDS (expirationTtl), not milliseconds
//   - KV is eventually consistent (~60s); reads may lag behind writes
//   - API: env.PROVIDER_KV.get(key), .put(key, value, opts), .delete(key)

const KV_PREFIX = "example_account:"; // UNIQUE per provider!
const ACCOUNT_TTL_SEC = 24 * 60 * 60; // 24 hours — hard ceiling, never exceed

async function loadAccount(kv, email) {
  const raw = await kv.get(KV_PREFIX + email);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveAccount(kv, account, ttlSec) {
  const effectiveTtl = Math.min(ttlSec || ACCOUNT_TTL_SEC, 86400);
  await kv.put(KV_PREFIX + account.address, JSON.stringify(account), {
    expirationTtl: effectiveTtl,
  });
}

async function deleteAccount(kv, email) {
  await kv.delete(KV_PREFIX + email);
}

// ─── Upstream helpers ────────────────────────────────────────────────

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

function tokenNeedsRefresh(account, refreshIntervalMs) {
  return Date.now() - account.tokenIssuedAt > refreshIntervalMs;
}

async function fetchToken(ctx, _upstreamBase, _address, _credential) {
  // TODO: Replace with your upstream token endpoint.
  void ctx;
  throw new ProviderError(501, "fetchToken not implemented.");
}

async function getValidToken(ctx, kv, account, env) {
  const refreshMs = getConfigPositiveInt(env, "TOKEN_REFRESH_INTERVAL_MS", 600_000);
  if (!tokenNeedsRefresh(account, refreshMs)) return account.token;

  const upstreamBase = getConfig(env, "UPSTREAM_BASE", "https://api.example.com");
  const newToken = await fetchToken(ctx, upstreamBase, account.address, "");
  account.token = newToken;
  account.tokenIssuedAt = Date.now();
  account.updatedAt = Date.now();
  await saveAccount(kv, account);
  return newToken;
}

// ─── Route handlers ──────────────────────────────────────────────────

async function handleGenerateEmail(ctx, _kv, _env, body) {
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";

  // TODO: Implement — see provider-example.ts (Deno version) for full guidance.
  //
  // 1. Fetch available domains from upstream
  // 2. Create account at upstream via countedFetch()
  // 3. Get auth token via fetchToken()
  // 4. Save to KV via saveAccount()
  // 5. return providerResponse(ctx, 200, true, { email: address }, "");

  void prefix;
  void domain;
  throw new ProviderError(501, "handleGenerateEmail not implemented.");
}

async function handleListEmails(ctx, kv, env, email) {
  const account = await loadAccount(kv, email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  const token = await getValidToken(ctx, kv, account, env);

  // TODO: Implement — fetch message list from upstream.
  //
  // IMPORTANT: handle 401 — refresh token and retry ONCE.
  //   const upstreamBase = getConfig(env, "UPSTREAM_BASE", "...");
  //   const res = await countedFetch(ctx, `${upstreamBase}/messages?page=1`, {
  //     method: "GET",
  //     headers: authHeaders(token),
  //   });
  //   if (res.status === 401) { ... refresh and retry ... }
  //
  // Map to standard shape:
  //   const emails = messages.map(m => ({
  //     id:            m.id,
  //     email_address: email,
  //     from_address:  extractFrom(m.from),
  //     subject:       m.subject ?? "",
  //     content:       m.text ?? "",
  //     html_content:  m.html?.[0] ?? m.body ?? "",
  //   }));
  //   return providerResponse(ctx, 200, true, { emails, count: emails.length }, "");

  void token;
  throw new ProviderError(501, "handleListEmails not implemented.");
}

async function handleGetEmail(ctx, kv, env, email, mailId) {
  const account = await loadAccount(kv, email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  const token = await getValidToken(ctx, kv, account, env);

  // TODO: Fetch single message from upstream.
  //   Same 401-retry pattern as handleListEmails.

  void token;
  void mailId;
  throw new ProviderError(501, "handleGetEmail not implemented.");
}

async function handleDeleteEmail(ctx, kv, env, email, mailId) {
  const account = await loadAccount(kv, email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  const token = await getValidToken(ctx, kv, account, env);

  // TODO: DELETE single message from upstream, or throw 501.

  void token;
  void mailId;
  throw new ProviderError(501, "handleDeleteEmail not implemented.");
}

async function handleClearEmails(ctx, kv, _env, email) {
  const account = await loadAccount(kv, email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email address.");
  }

  // TODO: Delete all messages, or throw 501.
  //   await deleteAccount(kv, email);
  //   return providerResponse(ctx, 200, true, { message: "Cleared.", count: n }, "");

  throw new ProviderError(501, "handleClearEmails not implemented.");
}

// ─── Main handler ────────────────────────────────────────────────────
// Workers entry: export default { async fetch(request, env, ctx) {} }

export default {
  async fetch(request, env, _executionCtx) {
    const url = new URL(request.url);
    const ctx = {
      requestId: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
      route: `${request.method} ${url.pathname}`,
      upstreamCalls: 0,
      maxUpstreamCalls: parseMaxUpstreamCalls(request),
    };

    try {
      // Auth check MUST be the first thing.
      authenticateGateway(request, env);

      // Workers KV is accessed via the binding name defined in wrangler.toml.
      // If you change the binding name, update this line.
      const kv = env.PROVIDER_KV;
      if (!kv) {
        throw new ProviderError(
          500,
          "KV namespace PROVIDER_KV not bound. Check wrangler.toml.",
        );
      }

      const mailMatch = url.pathname.match(/^\/email\/([^/]+)$/);

      // --- POST /generate-email ---
      if (request.method === "POST" && url.pathname === "/generate-email") {
        let body = {};
        try {
          body = await request.json();
        } catch { /* empty body is fine */ }
        return await handleGenerateEmail(ctx, kv, env, body);
      }

      // --- GET /generate-email ---
      if (request.method === "GET" && url.pathname === "/generate-email") {
        return await handleGenerateEmail(ctx, kv, env, {});
      }

      // --- GET /emails?email=<address> ---
      if (request.method === "GET" && url.pathname === "/emails") {
        const email = url.searchParams.get("email") ?? "";
        if (!email) throw new ProviderError(400, "Missing email parameter.");
        return await handleListEmails(ctx, kv, env, email);
      }

      // --- GET /email/<id>?email=<address> ---
      if (mailMatch && request.method === "GET") {
        const email = url.searchParams.get("email") ?? "";
        if (!email) throw new ProviderError(400, "Missing email parameter.");
        return await handleGetEmail(ctx, kv, env, email, mailMatch[1]);
      }

      // --- DELETE /email/<id>?email=<address> ---
      if (mailMatch && request.method === "DELETE") {
        const email = url.searchParams.get("email") ?? "";
        if (!email) throw new ProviderError(400, "Missing email parameter.");
        return await handleDeleteEmail(ctx, kv, env, email, mailMatch[1]);
      }

      // --- DELETE /emails/clear?email=<address> ---
      if (request.method === "DELETE" && url.pathname === "/emails/clear") {
        const email = url.searchParams.get("email") ?? "";
        if (!email) throw new ProviderError(400, "Missing email parameter.");
        return await handleClearEmails(ctx, kv, env, email);
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
      return providerResponse(
        ctx,
        500,
        false,
        null,
        "Internal provider error.",
      );
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════
// wrangler.toml reference — put this in your project root
// ═══════════════════════════════════════════════════════════════════════
//
// name = "provider-example"
// main = "provider-example_workers.js"
// compatibility_date = "2024-01-01"
//
// [vars]
// UPSTREAM_BASE = "https://api.example.com"
// ACCOUNT_TTL_SEC = "86400"
// TOKEN_REFRESH_INTERVAL_MS = "600000"
//
// [[kv_namespaces]]
// binding = "PROVIDER_KV"
// id = "<your-kv-namespace-id>"
//
// # Set secrets (not in toml):
// # wrangler secret put PROVIDER_SECRET
