type JsonRecord = Record<string, unknown>;

type EduMailSessionRecord = {
  email: string;
  cookies: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type LivewireComponentSnapshot = {
  fingerprint: JsonRecord;
  serverMemo: JsonRecord;
  effects?: JsonRecord;
};

type EduMailPageState = {
  cookies: Record<string, string>;
  csrfToken: string;
  components: Map<string, LivewireComponentSnapshot>;
  currentEmail: string | null;
};

type EduMailMessage = JsonRecord & {
  sender_email?: unknown;
  subject?: unknown;
  content?: unknown;
  created_at?: unknown;
  date?: unknown;
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
  UPSTREAM_BASE_URL: "https://edumail.su",
  PROVIDER_MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,
  SESSION_CACHE_CLEANUP_INTERVAL_MS: 60 * 1000,
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
const UPSTREAM_BASE_URL = env("UPSTREAM_BASE_URL", "https://edumail.su")
  .replace(/\/$/, "");
const PROVIDER_MEMORY_CACHE_TTL_MS = envPositiveInt(
  "PROVIDER_MEMORY_CACHE_TTL_MS",
  5 * 60 * 1000,
);
const SESSION_CACHE_CLEANUP_INTERVAL_MS = envPositiveInt(
  "SESSION_CACHE_CLEANUP_INTERVAL_MS",
  60 * 1000,
);

if (!PROVIDER_SECRET) {
  throw new Error("Missing required configuration: PROVIDER_SECRET");
}

const sessionCache = new Map<
  string,
  { session: EduMailSessionRecord; expiresAt: number }
>();
let nextSessionCacheCleanupAt = 0;

function nowMs(): number {
  return Date.now();
}

function randomHex(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join("");
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

function randomActionId(len = 4): string {
  return randomHex(len).slice(0, len);
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

function sessionMemoryExpiresAt(): number {
  return nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS;
}

function maybeCleanupSessionCache(): void {
  const now = nowMs();
  if (now < nextSessionCacheCleanupAt) return;
  nextSessionCacheCleanupAt = now + SESSION_CACHE_CLEANUP_INTERVAL_MS;
  for (const [email, entry] of sessionCache.entries()) {
    if (entry.expiresAt <= now || entry.session.expiresAt <= now) {
      sessionCache.delete(email);
    }
  }
}

async function loadSession(email: string): Promise<EduMailSessionRecord | null> {
  maybeCleanupSessionCache();
  const cached = sessionCache.get(email);
  if (cached && cached.expiresAt > nowMs() && cached.session.expiresAt > nowMs()) {
    console.log(JSON.stringify({
      level: "info",
      type: "provider_memory_hit",
      provider: "edumailsu",
      email,
    }));
    return {
      ...cached.session,
      cookies: { ...cached.session.cookies },
    };
  }
  if (cached) sessionCache.delete(email);
  console.log(JSON.stringify({
    level: "info",
    type: "provider_memory_miss",
    provider: "edumailsu",
    email,
  }));
  return null;
}

async function saveSession(session: EduMailSessionRecord): Promise<void> {
  maybeCleanupSessionCache();
  sessionCache.set(session.email, {
    session: { ...session, cookies: { ...session.cookies }, updatedAt: nowMs() },
    expiresAt: sessionMemoryExpiresAt(),
  });
}

async function deleteSession(email: string): Promise<void> {
  sessionCache.delete(email);
}

function mergeSetCookies(
  existing: Record<string, string>,
  headers: Headers,
): Record<string, string> {
  const merged = { ...existing };
  let rawCookies: string[] = [];
  try {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    rawCookies = typeof getSetCookie === "function" ? getSetCookie.call(headers) : [];
  } catch {
    rawCookies = [];
  }
  if (rawCookies.length === 0) {
    const raw = headers.get("set-cookie");
    if (raw) rawCookies = raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/);
  }
  for (const raw of rawCookies) {
    const eqIdx = raw.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = raw.slice(0, eqIdx).trim();
    const rest = raw.slice(eqIdx + 1);
    const semiIdx = rest.indexOf(";");
    const value = semiIdx >= 0 ? rest.slice(0, semiIdx).trim() : rest.trim();
    merged[name] = value;
  }
  return merged;
}

function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractCsrfToken(html: string): string | null {
  const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  return match?.[1] ?? null;
}

function extractLivewireComponents(html: string): Map<string, LivewireComponentSnapshot> {
  const components = new Map<string, LivewireComponentSnapshot>();
  const regex = /wire:id="([^"]+)"[^>]*wire:initial-data="([^"]+)"/g;
  for (const match of html.matchAll(regex)) {
    const raw = decodeHtmlAttribute(match[2]);
    try {
      const parsed = JSON.parse(raw) as LivewireComponentSnapshot;
      if (
        parsed?.fingerprint &&
        typeof parsed.fingerprint === "object" &&
        typeof parsed.fingerprint["name"] === "string"
      ) {
        if (!parsed.fingerprint["id"]) parsed.fingerprint["id"] = match[1];
        components.set(String(parsed.fingerprint["name"]), parsed);
      }
    } catch {
      // ignore malformed component blocks
    }
  }
  return components;
}

function extractCurrentEmail(components: Map<string, LivewireComponentSnapshot>): string | null {
  const actionsEmail = components.get("frontend.actions")?.serverMemo?.["data"];
  if (actionsEmail && typeof actionsEmail === "object") {
    const email = (actionsEmail as JsonRecord)["email"];
    if (typeof email === "string" && email.includes("@")) return email;
  }
  const appEmail = components.get("frontend.app")?.serverMemo?.["data"];
  if (appEmail && typeof appEmail === "object") {
    const email = (appEmail as JsonRecord)["email"];
    if (typeof email === "string" && email.includes("@")) return email;
  }
  return null;
}

function extractMessagesFromPayload(payload: JsonRecord): EduMailMessage[] {
  const serverMemo = payload["serverMemo"];
  if (!serverMemo || typeof serverMemo !== "object") return [];
  const data = (serverMemo as JsonRecord)["data"];
  if (!data || typeof data !== "object") return [];
  const messages = (data as JsonRecord)["messages"];
  return Array.isArray(messages) ? messages as EduMailMessage[] : [];
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function splitEmailAddress(email: string): { user: string; domain: string } {
  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    throw new ProviderError(400, `Invalid email address: ${email}`);
  }
  return {
    user: email.slice(0, atIndex),
    domain: email.slice(atIndex + 1),
  };
}

async function fetchPageState(
  ctx: ProviderRequestContext,
  path: "/" | "/mailbox",
  cookies: Record<string, string>,
): Promise<EduMailPageState> {
  const headers = new Headers({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  const serialized = serializeCookies(cookies);
  if (serialized) headers.set("cookie", serialized);
  const response = await countedFetch(
    ctx,
    new URL(path, UPSTREAM_BASE_URL).toString(),
    {
      method: "GET",
      headers,
      redirect: "manual",
    },
  );
  const html = await response.text();
  const mergedCookies = mergeSetCookies(cookies, response.headers);
  const csrfToken = extractCsrfToken(html);
  const components = extractLivewireComponents(html);
  if (!csrfToken) {
    throw new ProviderError(502, "Failed to extract edumail.su CSRF token.");
  }
  if (!components.size) {
    throw new ProviderError(502, "Failed to extract edumail.su Livewire components.");
  }
  return {
    cookies: mergedCookies,
    csrfToken,
    components,
    currentEmail: extractCurrentEmail(components),
  };
}

function mergeLivewireComponent(
  original: LivewireComponentSnapshot,
  payload: JsonRecord,
): LivewireComponentSnapshot {
  const nextServerMemo = (payload["serverMemo"] && typeof payload["serverMemo"] === "object")
    ? payload["serverMemo"] as JsonRecord
    : {};
  const nextData = (nextServerMemo["data"] && typeof nextServerMemo["data"] === "object")
    ? nextServerMemo["data"] as JsonRecord
    : {};
  const originalMemo = original.serverMemo ?? {};
  const originalData = (originalMemo["data"] && typeof originalMemo["data"] === "object")
    ? originalMemo["data"] as JsonRecord
    : {};
  return {
    ...original,
    serverMemo: {
      ...originalMemo,
      ...nextServerMemo,
      data: {
        ...originalData,
        ...nextData,
      },
    },
    effects: payload["effects"] && typeof payload["effects"] === "object"
      ? payload["effects"] as JsonRecord
      : original.effects,
  };
}

async function callLivewire(
  ctx: ProviderRequestContext,
  state: EduMailPageState,
  componentName: string,
  updates: JsonRecord[],
): Promise<{ cookies: Record<string, string>; payload: JsonRecord; component: LivewireComponentSnapshot }> {
  const component = state.components.get(componentName);
  if (!component) {
    throw new ProviderError(502, `edumail.su component "${componentName}" not found.`);
  }
  const body = JSON.stringify({
    fingerprint: component.fingerprint,
    serverMemo: component.serverMemo,
    updates,
  });
  const refererPathRaw = component.fingerprint["path"];
  const refererPath = typeof refererPathRaw === "string"
    ? refererPathRaw.startsWith("/") ? refererPathRaw : `/${refererPathRaw}`
    : "/mailbox";
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: "text/html, application/xhtml+xml",
    "X-Livewire": "true",
    "X-CSRF-TOKEN": state.csrfToken,
    Referer: new URL(refererPath, UPSTREAM_BASE_URL).toString(),
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const serialized = serializeCookies(state.cookies);
  if (serialized) headers.set("cookie", serialized);

  const response = await countedFetch(
    ctx,
    new URL(`/livewire/message/${componentName}`, UPSTREAM_BASE_URL).toString(),
    {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    },
  );
  const mergedCookies = mergeSetCookies(state.cookies, response.headers);
  let payload: JsonRecord;
  try {
    payload = await response.json() as JsonRecord;
  } catch {
    throw new ProviderError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      `edumail.su returned invalid Livewire response for ${componentName}.`,
    );
  }
  if (!response.ok) {
    const message = typeof payload["message"] === "string"
      ? String(payload["message"])
      : `edumail.su Livewire request failed (${response.status}).`;
    throw new ProviderError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      message,
    );
  }
  return {
    cookies: mergedCookies,
    payload,
    component: mergeLivewireComponent(component, payload),
  };
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

async function synthesizeMailId(message: EduMailMessage): Promise<string> {
  return await sha256Hex(JSON.stringify({
    sender_email: message.sender_email ?? "",
    subject: message.subject ?? "",
    content: message.content ?? "",
    created_at: message.created_at ?? message.date ?? "",
  }));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

async function mapMessage(
  emailAddress: string,
  message: EduMailMessage,
): Promise<Record<string, unknown>> {
  const html = normalizeString(message.content);
  return {
    id: await synthesizeMailId(message),
    email_address: emailAddress,
    from_address: normalizeString(message.sender_email),
    subject: normalizeString(message.subject),
    content: stripHtml(html),
    html_content: html,
  };
}

function buildSession(email: string, cookies: Record<string, string>): EduMailSessionRecord {
  return {
    email,
    cookies,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
  };
}

async function createMailboxViaHomepage(
  ctx: ProviderRequestContext,
  target: { user?: string; domain?: string; random: boolean },
): Promise<EduMailSessionRecord> {
  const rootState = await fetchPageState(ctx, "/", {});
  const actions = rootState.components.get("frontend.actions");
  if (!actions) {
    throw new ProviderError(502, "Failed to locate edumail.su actions component.");
  }
  const actionData = (actions.serverMemo["data"] as JsonRecord | undefined) ?? {};
  const defaultDomain = typeof actionData["domain"] === "string"
    ? String(actionData["domain"])
    : undefined;
  const domains = Array.isArray(actionData["domains"])
    ? actionData["domains"].filter((value) => typeof value === "string") as string[]
    : [];

  let updates: JsonRecord[];
  if (target.random) {
    updates = [{
      type: "callMethod",
      payload: { id: randomActionId(), method: "random", params: [] },
    }];
  } else {
    const user = target.user?.trim() || randomPrefix();
    const domain = target.domain?.trim() || defaultDomain || domains[0];
    if (!domain) {
      throw new ProviderError(502, "edumail.su did not expose any available domains.");
    }
    updates = [
      {
        type: "callMethod",
        payload: { id: randomActionId(), method: "$set", params: ["user", user] },
      },
      {
        type: "callMethod",
        payload: { id: randomActionId(), method: "$set", params: ["domain", domain] },
      },
      {
        type: "callMethod",
        payload: { id: randomActionId(), method: "create", params: [] },
      },
    ];
  }

  const created = await callLivewire(ctx, rootState, "frontend.actions", updates);
  const mailboxState = await fetchPageState(ctx, "/mailbox", created.cookies);
  const currentEmail = mailboxState.currentEmail;
  if (!currentEmail || !currentEmail.includes("@")) {
    throw new ProviderError(502, "edumail.su did not return a mailbox email.");
  }
  const session = buildSession(currentEmail, mailboxState.cookies);
  await saveSession(session);
  return session;
}

async function rebuildMailboxForEmail(
  ctx: ProviderRequestContext,
  email: string,
): Promise<EduMailSessionRecord> {
  console.log(JSON.stringify({
    level: "info",
    type: "provider_session_rebuild",
    provider: "edumailsu",
    email,
    requestId: ctx.requestId,
  }));
  const split = splitEmailAddress(email);
  const session = await createMailboxViaHomepage(ctx, {
    user: split.user,
    domain: split.domain,
    random: false,
  });
  if (session.email !== email) {
    throw new ProviderError(
      502,
      `edumail.su rebuilt mailbox "${session.email}" instead of requested "${email}".`,
    );
  }
  return session;
}

async function getOrRefreshMailboxSession(
  ctx: ProviderRequestContext,
  email: string,
  forceRefresh = false,
): Promise<EduMailSessionRecord> {
  if (!forceRefresh) {
    const cached = await loadSession(email);
    if (cached) return cached;
  }
  return await rebuildMailboxForEmail(ctx, email);
}

async function fetchMessagesForEmail(
  ctx: ProviderRequestContext,
  email: string,
  forceRefresh = false,
): Promise<EduMailMessage[]> {
  const session = await getOrRefreshMailboxSession(ctx, email, forceRefresh);
  const mailboxState = await fetchPageState(ctx, "/mailbox", session.cookies);
  if (mailboxState.currentEmail !== email) {
    if (forceRefresh) {
      throw new ProviderError(404, "No active session for this email.");
    }
    return await fetchMessagesForEmail(ctx, email, true);
  }
  const result = await callLivewire(ctx, mailboxState, "frontend.app", [
    {
      type: "fireEvent",
      payload: { id: randomActionId(), event: "fetchMessages", params: [] },
    },
  ]);
  const nextSession = buildSession(email, result.cookies);
  await saveSession(nextSession);
  return extractMessagesFromPayload(result.payload);
}

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  const prefix = typeof body.prefix === "string" && body.prefix.trim()
    ? body.prefix.trim()
    : undefined;
  const domain = typeof body.domain === "string" && body.domain.trim()
    ? body.domain.trim()
    : undefined;
  const session = await createMailboxViaHomepage(ctx, {
    user: prefix,
    domain,
    random: !prefix && !domain,
  });
  return providerResponse(ctx, 200, true, { email: session.email }, "");
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const messages = await fetchMessagesForEmail(ctx, email);
  const normalized = await Promise.all(
    messages.map((message) => mapMessage(email, message)),
  );
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
  const messages = await fetchMessagesForEmail(ctx, email);
  for (const message of messages) {
    if (await synthesizeMailId(message) === mailId) {
      return providerResponse(ctx, 200, true, await mapMessage(email, message), "");
    }
  }
  throw new ProviderError(404, "Email not found.");
}

async function handleDeleteEmail(
  _ctx: ProviderRequestContext,
): Promise<Response> {
  throw new ProviderError(
    501,
    "edumail.su does not expose per-message deletion via this provider.",
  );
}

async function handleClearEmails(
  _ctx: ProviderRequestContext,
): Promise<Response> {
  throw new ProviderError(
    501,
    "edumail.su does not expose inbox clearing via this provider.",
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
