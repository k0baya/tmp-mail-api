import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";

type JsonRecord = Record<string, unknown>;

type LinshiSessionRecord = {
  cookies: Record<string, string>;
  mailCode: string;
  email: string;
  createdAt: number;
  updatedAt: number;
};

type LinshiMailMeta = {
  sender: string;
  subject: string;
  timestamp: string;
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
  LINSHI_BASE_URL: "https://www.linshiyouxiang.net",
  LINSHI_SESSION_TTL_MS: 3_000_000,
  LINSHI_MAX_DETAIL_FETCH: 0,
  PROVIDER_MEMORY_CACHE_TTL_MS: 5 * 60 * 1000,
  PROVIDER_KV_WRITE_MIN_INTERVAL_MS: 30 * 1000,
  LINSHI_MAIL_META_TTL_MS: 15 * 60 * 1000,
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

function envNonNegativeInt(key: string, fallback: number): number {
  const raw = Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString();
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const PROVIDER_SECRET = env("PROVIDER_SECRET");
const LINSHI_BASE_URL = env(
  "LINSHI_BASE_URL",
  "https://www.linshiyouxiang.net",
).replace(/\/$/, "");
const LINSHI_SESSION_TTL_MS = envPositiveInt("LINSHI_SESSION_TTL_MS", 3_000_000);
const LINSHI_MAX_DETAIL_FETCH = envNonNegativeInt("LINSHI_MAX_DETAIL_FETCH", 0);
const PROVIDER_MEMORY_CACHE_TTL_MS = envPositiveInt(
  "PROVIDER_MEMORY_CACHE_TTL_MS",
  5 * 60 * 1000,
);
const PROVIDER_KV_WRITE_MIN_INTERVAL_MS = envPositiveInt(
  "PROVIDER_KV_WRITE_MIN_INTERVAL_MS",
  30 * 1000,
);
const LINSHI_MAIL_META_TTL_MS = envPositiveInt(
  "LINSHI_MAIL_META_TTL_MS",
  15 * 60 * 1000,
);

if (!PROVIDER_SECRET) {
  throw new Error("Missing required configuration: PROVIDER_SECRET");
}

const kv = await Deno.openKv();

const keyBuilders = {
  linshiSession: (email: string) => ["linshi_session", email] as const,
  linshiMailMeta: (email: string, mailId: string) =>
    ["linshi_mail_meta", email, mailId] as const,
};
const linshiSessionCache = new Map<
  string,
  { session: LinshiSessionRecord; expiresAt: number; lastPersistedAt: number }
>();
const linshiMailMetaCache = new Map<
  string,
  { meta: LinshiMailMeta; expiresAt: number }
>();

function nowMs(): number {
  return Date.now();
}

function randomHex(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join("");
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

async function loadLinshiSession(
  email: string,
): Promise<LinshiSessionRecord | null> {
  const cached = linshiSessionCache.get(email);
  if (cached && cached.expiresAt > nowMs()) {
    return {
      ...cached.session,
      cookies: { ...cached.session.cookies },
    };
  }
  if (cached) linshiSessionCache.delete(email);
  const entry = await kv.get<LinshiSessionRecord>(keyBuilders.linshiSession(email));
  if (entry.value) {
    linshiSessionCache.set(email, {
      session: entry.value,
      expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
      lastPersistedAt: nowMs(),
    });
  }
  return entry.value ?? null;
}

async function saveLinshiSession(
  session: LinshiSessionRecord,
  force = false,
): Promise<void> {
  const cached = linshiSessionCache.get(session.email);
  linshiSessionCache.set(session.email, {
    session,
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
      provider: "linshiyouxiang",
      email: session.email,
    }));
    return;
  }
  await kv.set(keyBuilders.linshiSession(session.email), session, {
    expireIn: LINSHI_SESSION_TTL_MS,
  });
  linshiSessionCache.set(session.email, {
    session,
    expiresAt: nowMs() + PROVIDER_MEMORY_CACHE_TTL_MS,
    lastPersistedAt: nowMs(),
  });
}

function linshiMailMetaCacheKey(email: string, mailId: string): string {
  return `${email}:${mailId}`;
}

function setLinshiMailMeta(
  email: string,
  mailId: string,
  meta: LinshiMailMeta,
): void {
  linshiMailMetaCache.set(linshiMailMetaCacheKey(email, mailId), {
    meta,
    expiresAt: nowMs() + LINSHI_MAIL_META_TTL_MS,
  });
}

function getLinshiMailMeta(email: string, mailId: string): LinshiMailMeta | null {
  const cacheKey = linshiMailMetaCacheKey(email, mailId);
  const entry = linshiMailMetaCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    linshiMailMetaCache.delete(cacheKey);
    return null;
  }
  return entry.meta;
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
    if (raw) rawCookies = raw.split(/,(?=\s*\w+=)/);
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
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join("; ");
}

function linshiBuildHeaders(
  cookies: Record<string, string>,
  extra: HeadersInit = {},
): Headers {
  const headers = new Headers({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    "Origin": LINSHI_BASE_URL,
    "Referer": `${LINSHI_BASE_URL}/`,
  });
  for (const [key, value] of new Headers(extra).entries()) {
    headers.set(key, value);
  }
  if (Object.keys(cookies).length > 0) {
    headers.set("cookie", serializeCookies(cookies));
  }
  return headers;
}

async function linshiFetchHome(
  ctx: ProviderRequestContext,
  cookies: Record<string, string>,
): Promise<{ html: string; cookies: Record<string, string>; mailCode: string }> {
  const response = await countedFetch(ctx, `${LINSHI_BASE_URL}/`, {
    method: "GET",
    headers: linshiBuildHeaders(cookies),
  });
  const html = await response.text();
  const mergedCookies = mergeSetCookies(cookies, response.headers);
  const match = html.match(/window\.mailCodeGlobal\s*=\s*['"]([a-f0-9]+)['"]/);
  if (!response.ok || !match?.[1]) {
    throw new ProviderError(502, "Failed to initialize linshiyouxiang session.");
  }
  return { html, cookies: mergedCookies, mailCode: match[1] };
}

async function linshiInitSession(
  ctx: ProviderRequestContext,
): Promise<{ cookies: Record<string, string>; mailCode: string }> {
  const result = await linshiFetchHome(ctx, {});
  return { cookies: result.cookies, mailCode: result.mailCode };
}

async function linshiGetGmail(
  ctx: ProviderRequestContext,
  cookies: Record<string, string>,
): Promise<{ email: string; cookies: Record<string, string> }> {
  const template = Math.random() < 0.5 ? "a.b.c@gmail.com" : "abc+hello@gmail.com";
  const response = await countedFetch(ctx, `${LINSHI_BASE_URL}/change-to-gmail`, {
    method: "POST",
    headers: linshiBuildHeaders(cookies, {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
    }),
    body: JSON.stringify({ type: "gmail_alias", template }),
  });
  let json: Record<string, unknown>;
  try {
    json = await response.json();
  } catch {
    throw new ProviderError(502, "Linshiyouxiang upstream returned invalid JSON.");
  }
  const email = typeof json.email === "string" ? json.email : null;
  if (!response.ok || !email) {
    throw new ProviderError(502, "Failed to generate linshiyouxiang Gmail alias.");
  }
  return { email, cookies: mergeSetCookies(cookies, response.headers) };
}

async function linshiRefreshMessages(
  ctx: ProviderRequestContext,
  session: LinshiSessionRecord,
): Promise<LinshiSessionRecord> {
  let nextSession = { ...session };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await countedFetch(ctx, `${LINSHI_BASE_URL}/get-messages?lang=zh`, {
      method: "POST",
      headers: linshiBuildHeaders(nextSession.cookies, {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      }),
      body: JSON.stringify({ email: nextSession.email, code: nextSession.mailCode }),
    });
    let json: JsonRecord | null = null;
    try {
      json = await response.json() as JsonRecord;
    } catch {
      json = null;
    }
    nextSession = {
      ...nextSession,
      cookies: mergeSetCookies(nextSession.cookies, response.headers),
      updatedAt: nowMs(),
    };
    if (response.ok && json?.success === true) {
      return nextSession;
    }
    if (response.status !== 400 || attempt > 0) {
      throw new ProviderError(502, "Failed to refresh linshiyouxiang inbox.");
    }
    const refreshed = await linshiFetchHome(ctx, nextSession.cookies);
    nextSession = {
      ...nextSession,
      cookies: refreshed.cookies,
      mailCode: refreshed.mailCode,
      updatedAt: nowMs(),
    };
  }
  throw new ProviderError(502, "Failed to refresh linshiyouxiang inbox.");
}

function linshiParseMailList(html: string): Array<{
  id: string;
  type: string;
  sender: string;
  subject: string;
  timestamp: string;
}> {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) return [];
    const tbody = doc.getElementById("message-list");
    if (!tbody) return [];
    const results: Array<{
      id: string;
      type: string;
      sender: string;
      subject: string;
      timestamp: string;
    }> = [];
    for (const row of tbody.querySelectorAll("tr.unread, tr.read")) {
      if ((row as { id?: string }).id === "loading-row") continue;
      const links = row.querySelectorAll("a");
      if (!links.length) continue;
      const href = links[0].getAttribute("href") ?? "";
      const hrefMatch = href.match(/\/mail\/view\/([a-f0-9]+)(?:\/(\w+))?/);
      if (!hrefMatch) continue;
      const tds = row.querySelectorAll("td");
      if (tds.length < 3) continue;
      const timeLink = tds[2].querySelector("a.receiveTime");
      results.push({
        id: hrefMatch[1],
        type: hrefMatch[2] || "",
        sender: tds[0].textContent?.trim() ?? "",
        subject: tds[1].textContent?.trim() ?? "",
        timestamp: timeLink?.textContent?.trim() ?? "",
      });
    }
    return results;
  } catch {
    return [];
  }
}

async function linshiGetMailContent(
  ctx: ProviderRequestContext,
  session: LinshiSessionRecord,
  mailId: string,
): Promise<{ html: string; session: LinshiSessionRecord }> {
  const response = await countedFetch(
    ctx,
    `${LINSHI_BASE_URL}/mail/gmail-content/${encodeURIComponent(mailId)}`,
    {
      method: "GET",
      headers: linshiBuildHeaders(session.cookies, {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      }),
    },
  );
  let json: JsonRecord;
  try {
    json = await response.json() as JsonRecord;
  } catch {
    throw new ProviderError(502, "Linshiyouxiang upstream returned invalid mail detail JSON.");
  }
  const result = json.result;
  const html = result && typeof result === "object" &&
      typeof (result as JsonRecord).content === "string"
    ? String((result as JsonRecord).content)
    : null;
  if (!response.ok || html === null) {
    throw new ProviderError(502, "Failed to fetch linshiyouxiang mail content.");
  }
  return {
    html,
    session: {
      ...session,
      cookies: mergeSetCookies(session.cookies, response.headers),
      updatedAt: nowMs(),
    },
  };
}

function linshiHtmlToText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc?.documentElement?.textContent?.trim() ?? "";
  } catch {
    return html.replace(/<[^>]*>/g, "").trim();
  }
}

async function refreshAndCacheMailList(
  ctx: ProviderRequestContext,
  session: LinshiSessionRecord,
  email: string,
): Promise<{ session: LinshiSessionRecord; rawList: Array<{
  id: string;
  type: string;
  sender: string;
  subject: string;
  timestamp: string;
}>; }> {
  const refreshedSession = await linshiRefreshMessages(ctx, session);
  const home = await linshiFetchHome(ctx, refreshedSession.cookies);
  const nextSession: LinshiSessionRecord = {
    ...refreshedSession,
    cookies: home.cookies,
    mailCode: home.mailCode,
    updatedAt: nowMs(),
  };
  const rawList = linshiParseMailList(home.html);
  for (const item of rawList) {
    setLinshiMailMeta(email, item.id, {
      sender: item.sender,
      subject: item.subject,
      timestamp: item.timestamp,
    } satisfies LinshiMailMeta);
  }
  await saveLinshiSession(nextSession);
  return { session: nextSession, rawList };
}

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  if (body.prefix || body.domain) {
    throw new ProviderError(
      400,
      "The linshiyouxiang provider does not support prefix or domain options.",
    );
  }
  const initial = await linshiInitSession(ctx);
  const gmail = await linshiGetGmail(ctx, initial.cookies);
  const refreshed = await linshiFetchHome(ctx, gmail.cookies);
  const session: LinshiSessionRecord = {
    cookies: refreshed.cookies,
    mailCode: refreshed.mailCode,
    email: gmail.email,
    createdAt: nowMs(),
    updatedAt: nowMs(),
  };
  await saveLinshiSession(session, true);
  return providerResponse(ctx, 200, true, { email: gmail.email }, "");
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const session = await loadLinshiSession(email);
  if (!session) {
    throw new ProviderError(
      404,
      "No active session for this email. Generate it first with provider=linshiyouxiang.",
    );
  }
  const { session: nextSession, rawList } = await refreshAndCacheMailList(
    ctx,
    session,
    email,
  );
  const limit = LINSHI_MAX_DETAIL_FETCH > 0
    ? Math.min(LINSHI_MAX_DETAIL_FETCH, rawList.length)
    : rawList.length;
  const emails: Array<Record<string, unknown>> = [];
  let workingSession = nextSession;
  for (let index = 0; index < rawList.length; index += 1) {
    const item = rawList[index];
    if (index < limit) {
      const detail = await linshiGetMailContent(ctx, workingSession, item.id);
      workingSession = detail.session;
      emails.push({
        id: item.id,
        email_address: email,
        from_address: item.sender,
        subject: item.subject,
        content: linshiHtmlToText(detail.html),
        html_content: detail.html,
      });
      continue;
    }
    emails.push({
      id: item.id,
      email_address: email,
      from_address: item.sender,
      subject: item.subject,
      content: "",
      html_content: "",
    });
  }
  await saveLinshiSession({ ...workingSession, updatedAt: nowMs() });
  return providerResponse(ctx, 200, true, { emails, count: rawList.length }, "");
}

async function handleEmailDetail(
  ctx: ProviderRequestContext,
  email: string,
  mailId: string,
): Promise<Response> {
  let session = await loadLinshiSession(email);
  if (!session) throw new ProviderError(404, "No active session for this email.");
  const detail = await linshiGetMailContent(ctx, session, mailId);
  session = detail.session;
  let meta = getLinshiMailMeta(email, mailId);
  if (!meta) {
    const refreshed = await refreshAndCacheMailList(ctx, session, email);
    session = refreshed.session;
    meta = getLinshiMailMeta(email, mailId);
  }
  await saveLinshiSession({ ...session, updatedAt: nowMs() });
  return providerResponse(ctx, 200, true, {
    id: mailId,
    email_address: email,
    from_address: meta?.sender ?? "",
    subject: meta?.subject ?? "",
    content: linshiHtmlToText(detail.html),
    html_content: detail.html,
  }, "");
}

async function handleDeleteEmail(
  ctx: ProviderRequestContext,
  _email: string,
  _mailId: string,
): Promise<Response> {
  return providerResponse(
    ctx,
    501,
    false,
    null,
    "The linshiyouxiang provider does not support single email deletion.",
  );
}

async function handleClearEmails(
  ctx: ProviderRequestContext,
  _email: string,
): Promise<Response> {
  return providerResponse(
    ctx,
    501,
    false,
    null,
    "The linshiyouxiang provider does not support clearing emails.",
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
  Deno.serve(handleRequest);
}
