/**
 * Provider: mail.tm (api.mail.tm v3)
 *
 * Upstream API: https://api.mail.tm
 * Flow: POST /accounts → POST /token → GET /messages → GET /messages/{id} → DELETE /messages/{id}
 * Auth: JWT Bearer token obtained via POST /token with {address, password}.
 * Message.from is {address, name} (v3 format).
 */

type JsonRecord = Record<string, unknown>;

type AccountRecord = {
  id: string;
  address: string;
  password: string;
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

class ProviderError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CONFIG = {
  PROVIDER_SECRET: "",
  UPSTREAM_BASE: "https://api.mail.tm",
  ACCOUNT_TTL_MS: 24 * 60 * 60 * 1000,
  TOKEN_REFRESH_INTERVAL_MS: 10 * 60 * 1000,
  PROVIDER_MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,
  PROVIDER_KV_WRITE_MIN_INTERVAL_MS: 30 * 1000,
} as const;

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

const PROVIDER_SECRET = env("PROVIDER_SECRET");
const UPSTREAM_BASE = env("UPSTREAM_BASE", "https://api.mail.tm").replace(/\/$/, "");
const ACCOUNT_TTL_MS = envPositiveInt("ACCOUNT_TTL_MS", 24 * 60 * 60 * 1000);
const TOKEN_REFRESH_INTERVAL_MS = envPositiveInt("TOKEN_REFRESH_INTERVAL_MS", 10 * 60 * 1000);
const PROVIDER_MEMORY_CACHE_TTL_MS = envPositiveInt(
  "PROVIDER_MEMORY_CACHE_TTL_MS",
  5 * 60 * 1000,
);
const PROVIDER_KV_WRITE_MIN_INTERVAL_MS = envPositiveInt(
  "PROVIDER_KV_WRITE_MIN_INTERVAL_MS",
  30 * 1000,
);

if (!PROVIDER_SECRET) {
  throw new Error("Missing required configuration: PROVIDER_SECRET");
}

const kv = await Deno.openKv();

const keyBuilders = {
  account: (email: string) => ["mailtm_account", email] as const,
};
const accountCache = new Map<
  string,
  { account: AccountRecord; expiresAt: number; lastPersistedAt: number }
>();

function nowMs(): number {
  return Date.now();
}

function randomPassword(len = 16): string {
  const raw = new Uint8Array(len);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, len);
}

function randomPrefix(len = 8): string {
  const raw = new Uint8Array(len);
  crypto.getRandomValues(raw);
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

function providerResponse(
  ctx: ProviderRequestContext,
  status: number,
  success: boolean,
  data: unknown,
  error: string,
): Response {
  return new Response(
    JSON.stringify({ success, data, error, _upstream_calls: ctx.upstreamCalls }),
    { status, headers: { "Content-Type": "application/json" } },
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

// ── Upstream helpers ──

async function fetchDomains(ctx: ProviderRequestContext): Promise<string[]> {
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/domains`, {
    method: "GET",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new ProviderError(502, "Failed to fetch mail.tm domains.");
  const raw = await res.json();
  const members: JsonRecord[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as JsonRecord)["hydra:member"])
      ? (raw as JsonRecord)["hydra:member"] as JsonRecord[]
      : [];
  if (members.length === 0) {
    throw new ProviderError(502, "No active mail.tm domains available.");
  }
  return members
    .filter((d) => d.isActive !== false)
    .map((d) => String(d.domain));
}

async function createUpstreamAccount(
  ctx: ProviderRequestContext,
  address: string,
  password: string,
): Promise<{ id: string; address: string }> {
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(502, `Failed to create mail.tm account: ${res.status} ${text}`);
  }
  const json = await res.json() as JsonRecord;
  return { id: String(json.id), address: String(json.address) };
}

async function fetchToken(
  ctx: ProviderRequestContext,
  address: string,
  password: string,
): Promise<string> {
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ address, password }),
  });
  if (!res.ok) {
    throw new ProviderError(502, `Failed to obtain mail.tm token: ${res.status}`);
  }
  const json = await res.json() as JsonRecord;
  const token = json.token;
  if (typeof token !== "string" || !token) {
    throw new ProviderError(502, "mail.tm returned empty token.");
  }
  return token;
}

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
    });
  }
  return entry.value ?? null;
}

async function saveAccount(account: AccountRecord, force = false): Promise<void> {
  const cached = accountCache.get(account.address);
  accountCache.set(account.address, {
    account,
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
    lastPersistedAt: cached?.lastPersistedAt ?? 0,
  });
  if (
    !force &&
    cached &&
    nowMs() - cached.lastPersistedAt < PROVIDER_KV_WRITE_MIN_INTERVAL_MS
  ) {
    console.log(JSON.stringify({
      level: "info",
      type: "provider_write_throttled",
      provider: "mailtm",
      email: account.address,
    }));
    return;
  }
  await kv.set(keyBuilders.account(account.address), account, { expireIn: ACCOUNT_TTL_MS });
  accountCache.set(account.address, {
    account,
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
    lastPersistedAt: nowMs(),
  });
}

async function getValidToken(
  ctx: ProviderRequestContext,
  account: AccountRecord,
): Promise<string> {
  if (nowMs() - account.tokenIssuedAt < TOKEN_REFRESH_INTERVAL_MS) {
    return account.token;
  }
  const token = await fetchToken(ctx, account.address, account.password);
  account.token = token;
  account.tokenIssuedAt = nowMs();
  account.updatedAt = nowMs();
  await saveAccount(account);
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ── mail.tm v3: from = {address, name} ──

function extractFrom(msg: JsonRecord): string {
  const from = msg.from;
  if (from && typeof from === "object" && !Array.isArray(from)) {
    const obj = from as Record<string, unknown>;
    return String(obj.address ?? obj.name ?? "");
  }
  if (typeof from === "string") return from;
  return "";
}

function mapMessage(msg: JsonRecord, emailAddress: string): Record<string, unknown> {
  return {
    id: msg.id,
    email_address: emailAddress,
    from_address: extractFrom(msg),
    subject: msg.subject ?? "",
    content: msg.text ?? "",
    html_content: Array.isArray(msg.html) ? (msg.html as string[]).join("") : (msg.html ?? ""),
  };
}

// ── Route handlers ──

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  const domains = await fetchDomains(ctx);
  const prefix = typeof body.prefix === "string" && body.prefix.trim()
    ? body.prefix.trim()
    : randomPrefix();
  const domain = typeof body.domain === "string" && body.domain.trim()
    ? body.domain.trim()
    : domains[Math.floor(Math.random() * domains.length)];
  if (!domains.includes(domain)) {
    throw new ProviderError(400, `Domain "${domain}" is not available on mail.tm.`);
  }
  const address = `${prefix}@${domain}`;
  const password = randomPassword();
  const { id } = await createUpstreamAccount(ctx, address, password);
  const token = await fetchToken(ctx, address, password);
  const account: AccountRecord = {
    id,
    address,
    password,
    token,
    tokenIssuedAt: nowMs(),
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
  await saveAccount(account, true);
  return providerResponse(ctx, 200, true, { email: address }, "");
}

function parseMessageList(raw: unknown): JsonRecord[] {
  if (Array.isArray(raw)) return raw as JsonRecord[];
  const obj = raw as JsonRecord;
  if (Array.isArray(obj["hydra:member"])) return obj["hydra:member"] as JsonRecord[];
  return [];
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) {
    throw new ProviderError(404, "No active session for this email. Generate it first with provider=mailtm.");
  }
  const token = await getValidToken(ctx, account);
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages?page=1`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 401) {
    const newToken = await fetchToken(ctx, account.address, account.password);
    account.token = newToken;
    account.tokenIssuedAt = nowMs();
    account.updatedAt = nowMs();
    await saveAccount(account);
    const retry = await countedFetch(ctx, `${UPSTREAM_BASE}/messages?page=1`, {
      method: "GET",
      headers: authHeaders(newToken),
    });
    if (!retry.ok) throw new ProviderError(502, "Failed to list mail.tm messages after token refresh.");
    const retryRaw = await retry.json();
    const members = parseMessageList(retryRaw);
    return providerResponse(ctx, 200, true, {
      emails: members.map((m) => mapMessage(m, email)),
      count: members.length,
    }, "");
  }
  if (!res.ok) throw new ProviderError(502, `Failed to list mail.tm messages: ${res.status}`);
  const listRaw = await res.json();
  const members = parseMessageList(listRaw);
  return providerResponse(ctx, 200, true, {
    emails: members.map((m) => mapMessage(m, email)),
    count: members.length,
  }, "");
}

async function handleEmailDetail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) throw new ProviderError(404, "No active session for this email.");
  const token = await getValidToken(ctx, account);
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages/${encodeURIComponent(mailId)}`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!res.ok) throw new ProviderError(res.status === 404 ? 404 : 502, `Failed to fetch mail.tm message: ${res.status}`);
  const msg = await res.json() as JsonRecord;
  return providerResponse(ctx, 200, true, mapMessage(msg, email), "");
}

async function handleDeleteEmail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) throw new ProviderError(404, "No active session for this email.");
  const token = await getValidToken(ctx, account);
  const res = await countedFetch(ctx, `${UPSTREAM_BASE}/messages/${encodeURIComponent(mailId)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!res.ok && res.status !== 204) {
    throw new ProviderError(res.status === 404 ? 404 : 502, `Failed to delete mail.tm message: ${res.status}`);
  }
  return providerResponse(ctx, 200, true, { message: "Deleted email." }, "");
}

async function handleClearEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const account = await loadAccount(email);
  if (!account) throw new ProviderError(404, "No active session for this email.");
  const token = await getValidToken(ctx, account);
  const listRes = await countedFetch(ctx, `${UPSTREAM_BASE}/messages?page=1`, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (!listRes.ok) throw new ProviderError(502, "Failed to list messages for clearing.");
  const clearRaw = await listRes.json();
  const members = parseMessageList(clearRaw);
  let deleted = 0;
  for (const msg of members) {
    const id = String(msg.id);
    const delRes = await countedFetch(ctx, `${UPSTREAM_BASE}/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    if (delRes.ok || delRes.status === 204) deleted += 1;
  }
  return providerResponse(ctx, 200, true, { message: "Cleared emails.", count: deleted }, "");
}

// ── Router ──

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ctx: ProviderRequestContext = {
    requestId: request.headers.get("X-Request-Id") ?? crypto.randomUUID(),
    route: `${request.method} ${url.pathname}`,
    upstreamCalls: 0,
    maxUpstreamCalls: parseMaxUpstreamCalls(request),
  };

  try {
    authenticateGateway(request);

    const mailMatch = url.pathname.match(/^\/email\/([^/]+)$/);

    if (request.method === "POST" && url.pathname === "/generate-email") {
      const body = await request.json().catch(() => ({})) as JsonRecord;
      return await handleGenerateEmail(ctx, body);
    }
    if (request.method === "GET" && url.pathname === "/emails") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleListEmails(ctx, email);
    }
    if (mailMatch && request.method === "GET") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleEmailDetail(ctx, email, decodeURIComponent(mailMatch[1]));
    }
    if (mailMatch && request.method === "DELETE") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleDeleteEmail(ctx, email, decodeURIComponent(mailMatch[1]));
    }
    if (request.method === "DELETE" && url.pathname === "/emails/clear") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleClearEmails(ctx, email);
    }

    return providerResponse(ctx, 404, false, null, "Not found.");
  } catch (error) {
    if (error instanceof ProviderError) {
      return providerResponse(ctx, error.status, false, null, error.message);
    }
    console.error(JSON.stringify({
      level: "error",
      requestId: ctx.requestId,
      route: ctx.route,
      error: error instanceof Error ? error.stack : String(error),
    }));
    return providerResponse(ctx, 500, false, null, "Internal provider error.");
  }
}

export { handleRequest };

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve(
    Number.isInteger(port) && port > 0 ? { port } : {},
    handleRequest,
  );
}
