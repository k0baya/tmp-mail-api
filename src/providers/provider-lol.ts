type JsonRecord = Record<string, unknown>;

type InboxRecord = {
  address: string;
  token: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type LolEmail = {
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  html?: unknown;
  date?: unknown;
};

type CreateInboxResponse = {
  address?: unknown;
  token?: unknown;
  error?: unknown;
  captcha_required?: unknown;
};

type InboxListResponse = {
  emails?: unknown;
  expired?: unknown;
  error?: unknown;
  captcha_required?: unknown;
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
  UPSTREAM_BASE_URL: "https://api.tempmail.lol/v2",
  LOL_API_KEY: "",
  LOL_PERSIST_INBOX_TO_KV: "0",
  INBOX_TTL_MS: 60 * 60 * 1000,
  PROVIDER_MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,
  INBOX_CACHE_CLEANUP_INTERVAL_MS: 60 * 1000,
  PROVIDER_KV_WRITE_MIN_INTERVAL_MS: 180 * 1000,
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

function envBool(key: string, fallback: boolean): boolean {
  const raw = env(key);
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const PROVIDER_SECRET = env("PROVIDER_SECRET");
const UPSTREAM_BASE_URL = env(
  "UPSTREAM_BASE_URL",
  "https://api.tempmail.lol/v2",
).replace(/\/$/, "");
const LOL_API_KEY = env("LOL_API_KEY");
const LOL_PERSIST_INBOX_TO_KV = envBool("LOL_PERSIST_INBOX_TO_KV", false);
const INBOX_TTL_MS = Math.min(
  envPositiveInt("INBOX_TTL_MS", 60 * 60 * 1000),
  30 * 60 * 60 * 1000,
);
const PROVIDER_MEMORY_CACHE_TTL_MS = envPositiveInt(
  "PROVIDER_MEMORY_CACHE_TTL_MS",
  5 * 60 * 1000,
);
const INBOX_CACHE_CLEANUP_INTERVAL_MS = envPositiveInt(
  "INBOX_CACHE_CLEANUP_INTERVAL_MS",
  60 * 1000,
);
const PROVIDER_KV_WRITE_MIN_INTERVAL_MS = Math.min(
  envPositiveInt("PROVIDER_KV_WRITE_MIN_INTERVAL_MS", 180 * 1000),
  180 * 1000,
);

if (!PROVIDER_SECRET) {
  throw new Error("Missing required configuration: PROVIDER_SECRET");
}

const kv = LOL_PERSIST_INBOX_TO_KV ? await Deno.openKv() : null;

const keyBuilders = {
  inbox: (email: string) => ["lol_inbox", email] as const,
};

const inboxCache = new Map<
  string,
  {
    inbox: InboxRecord;
    expiresAt: number;
    lastPersistedAt: number;
    dirty: boolean;
  }
>();
let inboxFlushTimer: ReturnType<typeof setTimeout> | null = null;
let inboxFlushPromise: Promise<void> | null = null;
let nextInboxCacheCleanupAt = 0;

function nowMs(): number {
  return Date.now();
}

function randomPrefix(len = 10): string {
  const raw = new Uint8Array(len);
  crypto.getRandomValues(raw);
  return Array.from(raw, (value) => value.toString(36).padStart(2, "0"))
    .join("")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, len)
    .toLowerCase();
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

function inboxMemoryExpiresAt(inbox: InboxRecord): number {
  return Math.min(nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS, inbox.expiresAt);
}

function maybeCleanupInboxCache(): void {
  const now = nowMs();
  if (now < nextInboxCacheCleanupAt) return;
  nextInboxCacheCleanupAt = now + INBOX_CACHE_CLEANUP_INTERVAL_MS;
  for (const [email, entry] of inboxCache.entries()) {
    if (entry.expiresAt <= now || entry.inbox.expiresAt <= now) {
      inboxCache.delete(email);
    }
  }
}

async function loadInbox(email: string): Promise<InboxRecord | null> {
  maybeCleanupInboxCache();
  const cached = inboxCache.get(email);
  if (cached && cached.expiresAt > nowMs() && cached.inbox.expiresAt > nowMs()) {
    return { ...cached.inbox };
  }
  if (cached) inboxCache.delete(email);
  if (!LOL_PERSIST_INBOX_TO_KV || !kv) return null;
  const entry = await kv.get<InboxRecord>(keyBuilders.inbox(email));
  if (!entry.value) return null;
  if (entry.value.expiresAt <= nowMs()) {
    await kv.delete(keyBuilders.inbox(email));
    return null;
  }
  inboxCache.set(email, {
    inbox: entry.value,
    expiresAt: inboxMemoryExpiresAt(entry.value),
    lastPersistedAt: nowMs(),
    dirty: false,
  });
  return entry.value;
}

function queueInboxFlush(force = false): void {
  if (inboxFlushTimer && !force) return;
  if (inboxFlushTimer) clearTimeout(inboxFlushTimer);
  inboxFlushTimer = setTimeout(() => {
    inboxFlushTimer = null;
    void flushDirtyInboxes();
  }, force ? 0 : PROVIDER_KV_WRITE_MIN_INTERVAL_MS);
}

async function persistInbox(inbox: InboxRecord): Promise<void> {
  const ttlUntilExpiry = inbox.expiresAt - nowMs();
  if (ttlUntilExpiry <= 0) {
    inboxCache.delete(inbox.address);
    if (LOL_PERSIST_INBOX_TO_KV && kv) {
      await kv.delete(keyBuilders.inbox(inbox.address));
    }
    return;
  }
  if (LOL_PERSIST_INBOX_TO_KV && kv) {
    await kv.set(keyBuilders.inbox(inbox.address), inbox, {
      expireIn: Math.min(INBOX_TTL_MS, ttlUntilExpiry),
    });
  }
  inboxCache.set(inbox.address, {
    inbox,
    expiresAt: inboxMemoryExpiresAt(inbox),
    lastPersistedAt: nowMs(),
    dirty: false,
  });
}

async function flushDirtyInboxes(): Promise<void> {
  if (!LOL_PERSIST_INBOX_TO_KV || !kv) return;
  if (inboxFlushPromise) return;
  const dirtyEntries = Array.from(inboxCache.values()).filter((entry) =>
    entry.dirty
  );
  if (dirtyEntries.length === 0) return;
  inboxFlushPromise = (async () => {
    let flushed = 0;
    for (const entry of dirtyEntries) {
      const current = inboxCache.get(entry.inbox.address);
      if (!current?.dirty) continue;
      try {
        await persistInbox(current.inbox);
        flushed += 1;
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          type: "provider_flush_failed",
          provider: "lol",
          email: current.inbox.address,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    if (flushed > 0) {
      console.log(JSON.stringify({
        level: "info",
        type: "provider_flush_ok",
        provider: "lol",
        flushed,
      }));
    }
  })();
  try {
    await inboxFlushPromise;
  } finally {
    inboxFlushPromise = null;
    if (Array.from(inboxCache.values()).some((entry) => entry.dirty)) {
      queueInboxFlush();
    }
  }
}

async function saveInbox(inbox: InboxRecord, force = false): Promise<void> {
  maybeCleanupInboxCache();
  const ttlUntilExpiry = inbox.expiresAt - nowMs();
  if (ttlUntilExpiry <= 0) {
    inboxCache.delete(inbox.address);
    return;
  }
  const cached = inboxCache.get(inbox.address);
  if (!LOL_PERSIST_INBOX_TO_KV || !kv) {
    inboxCache.set(inbox.address, {
      inbox,
      expiresAt: inboxMemoryExpiresAt(inbox),
      lastPersistedAt: nowMs(),
      dirty: false,
    });
    return;
  }
  inboxCache.set(inbox.address, {
    inbox,
    expiresAt: inboxMemoryExpiresAt(inbox),
    lastPersistedAt: cached?.lastPersistedAt ?? 0,
    dirty: true,
  });
  if (force || !cached) {
    await persistInbox(inbox);
    return;
  }
  if (nowMs() - cached.lastPersistedAt < PROVIDER_KV_WRITE_MIN_INTERVAL_MS) {
    console.log(JSON.stringify({
      level: "info",
      type: "provider_write_throttled",
      provider: "lol",
      email: inbox.address,
    }));
    queueInboxFlush();
    return;
  }
  await flushDirtyInboxes();
}

async function deleteInbox(email: string): Promise<void> {
  maybeCleanupInboxCache();
  inboxCache.delete(email);
  if (LOL_PERSIST_INBOX_TO_KV && kv) {
    await kv.delete(keyBuilders.inbox(email));
  }
}

function buildApiHeaders(withJsonBody = false): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (withJsonBody) headers.set("Content-Type", "application/json");
  if (LOL_API_KEY) headers.set("Authorization", `Bearer ${LOL_API_KEY}`);
  return headers;
}

function normalizeErrorPayload(
  payload: JsonRecord | null,
  fallback: string,
): string {
  const message = payload?.error;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

function isCaptchaRequired(payload: JsonRecord | null): boolean {
  return payload?.captcha_required === true;
}

function normalizeCreateFailure(
  status: number,
  payload: JsonRecord | null,
): ProviderError {
  const message = normalizeErrorPayload(payload, "Failed to create tempmail.lol inbox.");
  if (status === 403 && isCaptchaRequired(payload)) {
    return new ProviderError(
      403,
      `${message} This usually means the free tier is blocked for the current server IP/country. Configure LOL_API_KEY or move this provider to an allowed region.`,
    );
  }
  if (status >= 400 && status < 500) return new ProviderError(status, message);
  return new ProviderError(502, message);
}

function normalizeInboxFailure(
  status: number,
  payload: JsonRecord | null,
): ProviderError {
  if (payload?.expired === true || status === 404) {
    return new ProviderError(404, "Inbox expired or token is invalid.");
  }
  const message = normalizeErrorPayload(payload, "Failed to query tempmail.lol inbox.");
  if (status >= 400 && status < 500) return new ProviderError(status, message);
  return new ProviderError(502, message);
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function synthesizeMailId(email: LolEmail): Promise<string> {
  return await sha256Hex(JSON.stringify({
    from: normalizeString(email.from),
    to: normalizeString(email.to),
    subject: normalizeString(email.subject),
    body: normalizeString(email.body),
    html: normalizeString(email.html),
    date: typeof email.date === "number" ? email.date : Number(email.date ?? 0),
  }));
}

async function mapLolEmail(
  emailAddress: string,
  email: LolEmail,
): Promise<Record<string, unknown>> {
  return {
    id: await synthesizeMailId(email),
    email_address: emailAddress,
    from_address: normalizeString(email.from),
    subject: normalizeString(email.subject),
    content: normalizeString(email.body),
    html_content: normalizeString(email.html),
  };
}

async function fetchInboxEmails(
  ctx: ProviderRequestContext,
  inbox: InboxRecord,
): Promise<{ emails: LolEmail[]; expired: boolean }> {
  const response = await countedFetch(
    ctx,
    `${UPSTREAM_BASE_URL}/inbox?token=${encodeURIComponent(inbox.token)}`,
    {
      method: "GET",
      headers: buildApiHeaders(),
    },
  );
  let payload: InboxListResponse | null = null;
  try {
    payload = await response.json() as InboxListResponse;
  } catch {
    throw new ProviderError(502, "tempmail.lol returned invalid JSON.");
  }
  const normalized = payload as JsonRecord | null;
  if (!response.ok && payload?.expired !== true) {
    throw normalizeInboxFailure(response.status, normalized);
  }
  const emails = Array.isArray(payload?.emails)
    ? payload!.emails as LolEmail[]
    : [];
  const expired = payload?.expired === true;
  if (expired) {
    await deleteInbox(inbox.address);
  }
  return { emails, expired };
}

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  const prefix = typeof body.prefix === "string" && body.prefix.trim()
    ? body.prefix.trim()
    : randomPrefix();
  const domain = typeof body.domain === "string" && body.domain.trim()
    ? body.domain.trim()
    : undefined;
  const response = await countedFetch(
    ctx,
    `${UPSTREAM_BASE_URL}/inbox/create`,
    {
      method: "POST",
      headers: buildApiHeaders(true),
      body: JSON.stringify({
        prefix,
        ...(domain ? { domain } : {}),
      }),
    },
  );
  let payload: CreateInboxResponse | null = null;
  try {
    payload = await response.json() as CreateInboxResponse;
  } catch {
    throw new ProviderError(502, "tempmail.lol returned invalid JSON.");
  }
  const address = typeof payload?.address === "string" ? payload.address : "";
  const token = typeof payload?.token === "string" ? payload.token : "";
  if (!response.ok || !address || !token) {
    throw normalizeCreateFailure(response.status, payload as JsonRecord | null);
  }
  const inbox: InboxRecord = {
    address,
    token,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    expiresAt: nowMs() + INBOX_TTL_MS,
  };
  await saveInbox(inbox, true);
  return providerResponse(ctx, 200, true, { email: address }, "");
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const inbox = await loadInbox(email);
  if (!inbox) {
    throw new ProviderError(
      404,
      "No active tempmail.lol inbox token for this email. Generate it first with provider=lol.",
    );
  }
  const { emails, expired } = await fetchInboxEmails(ctx, inbox);
  if (expired) {
    throw new ProviderError(404, "Inbox expired on tempmail.lol.");
  }
  const normalized = await Promise.all(emails.map((item) => mapLolEmail(email, item)));
  return providerResponse(ctx, 200, true, {
    emails: normalized,
    count: normalized.length,
  }, "");
}

async function handleEmailDetail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  const inbox = await loadInbox(email);
  if (!inbox) {
    throw new ProviderError(404, "No active tempmail.lol inbox token for this email.");
  }
  const { emails, expired } = await fetchInboxEmails(ctx, inbox);
  if (expired) {
    throw new ProviderError(404, "Inbox expired on tempmail.lol.");
  }
  for (const item of emails) {
    if (await synthesizeMailId(item) === mailId) {
      return providerResponse(ctx, 200, true, await mapLolEmail(email, item), "");
    }
  }
  throw new ProviderError(404, "Email not found in tempmail.lol inbox.");
}

async function handleDeleteEmail(
  _ctx: ProviderRequestContext,
): Promise<Response> {
  throw new ProviderError(
    501,
    "tempmail.lol free-tier API does not expose email deletion.",
  );
}

async function handleClearEmails(
  _ctx: ProviderRequestContext,
): Promise<Response> {
  throw new ProviderError(
    501,
    "tempmail.lol free-tier API does not expose inbox clearing.",
  );
}

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
      return await handleDeleteEmail(ctx);
    }
    if (request.method === "DELETE" && url.pathname === "/emails/clear") {
      return await handleClearEmails(ctx);
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
