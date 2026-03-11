type JsonRecord = Record<string, unknown>;

type ApiKeyRecord = {
  id: string;
  label: string;
  keyHash: string;
  status: "active" | "disabled";
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  quotaTotal: number | null;
  quotaDaily: number | null;
};

type NormalizedMail = JsonRecord & {
  id: string;
  email_address: string;
  from_address: string;
  subject: string;
  content: string;
  html_content: string;
};

type RequestContext = {
  requestId: string;
  route: string;
  request: Request;
  url: URL;
  startedAt: number;
};

type ApiAuthContext = {
  keyId: string;
  keyRecord: ApiKeyRecord;
};

type AdminSessionPayload = {
  exp: number;
  sid?: string;
};

type AdminSession = {
  exp: number;
  sid: string;
};

type ProviderTarget = {
  name: string;
  url: string;
};

type ProviderEnvelope = {
  success?: boolean;
  data?: unknown;
  error?: string;
  _upstream_calls?: number;
};

type ProviderResponse = {
  success: boolean;
  data: unknown;
  error: string;
  upstreamCalls: number;
  status: number;
};

type ConfigSource = "env" | "kv" | "config" | "fallback";

type ProviderSummary = {
  name: string;
  isDefault: boolean;
};

type ResolvedProviderEntry = {
  name: string;
  url: string;
  source: ConfigSource;
  locked: boolean;
  disabled: boolean;
  disabledSource: ConfigSource;
  disableLocked: boolean;
};

type SettingsFlashTone = "success" | "error" | "warn";

type SettingsFlash = {
  tone: SettingsFlashTone;
  key?: string;
  message?: string;
  params?: Record<string, string>;
};

type RenderFailureReason =
  | "not_configured"
  | "auth_failed"
  | "timeout"
  | "render_error";

type RenderResult =
  | { ok: true; html: string }
  | { ok: false; reason: RenderFailureReason };

type ResolvedConfigValue = {
  key: string;
  value: string;
  source: ConfigSource;
  locked: boolean;
};

type Locale = "en" | "zh";
type ThemeMode = "system" | "light" | "dark";

class HttpError extends Error {
  status: number;
  exposeMessage: string;

  constructor(status: number, exposeMessage: string) {
    super(exposeMessage);
    this.status = status;
    this.exposeMessage = exposeMessage;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const CONFIG = {
  PROVIDER_SECRET: "",
  FRONTEND_PROVIDER_URL: "",
  DEFAULT_PROVIDER: "legacy",
  PROVIDER_URL_LEGACY: "",
  PROVIDER_URL_LINSHIYOUXIANG: "",
  ADMIN_PASSWORD: "",
  ADMIN_COOKIE_SECRET: "",
  ADMIN_COOKIE_NAME: "tmpmail_admin",
  ADMIN_SESSION_TTL_SEC: 86_400,
  MAIL_ID_TTL_MS: 24 * 60 * 60 * 1000,
} as const;

function envSync(key: string, fallback?: string): string {
  return Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString() ?? fallback ?? "";
}

function envPositiveIntSync(key: string, fallback: number): number {
  const raw = Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString();
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envNonNegativeIntSync(key: string, fallback: number): number {
  const raw = Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString();
  if (raw === undefined || raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const ADMIN_PASSWORD = envSync("ADMIN_PASSWORD");
const ADMIN_COOKIE_SECRET = envSync("ADMIN_COOKIE_SECRET");
const ADMIN_COOKIE_NAME = envSync("ADMIN_COOKIE_NAME", "tmpmail_admin");
const MAX_UPSTREAM_CALLS_PER_REQUEST = 50;
const DOCS_CACHE_TTL_MS = 60_000;

let docsPageCache = new Map<string, { html: string; expiresAt: number }>();

if (!ADMIN_PASSWORD) {
  throw new Error("Missing required configuration: ADMIN_PASSWORD");
}
if (!ADMIN_COOKIE_SECRET) {
  throw new Error("Missing required configuration: ADMIN_COOKIE_SECRET");
}

const kv = await Deno.openKv();
const adminCookieKeyPromise = importHmacKey(ADMIN_COOKIE_SECRET);

const keyBuilders = {
  apiKey: (id: string) => ["api_key", id] as const,
  apiKeyHash: (hash: string) => ["api_key_hash", hash] as const,
  apiUsageTotal: (id: string) => ["api_usage_total", id] as const,
  apiUsageDaily: (id: string, yyyymmdd: string) =>
    ["api_usage_daily", id, yyyymmdd] as const,
  apiKeyCounter: () => ["meta", "api_key_next_id"] as const,
  mailToEmail: (provider: string, mailId: string) =>
    ["mail_to_email", provider, mailId] as const,
  failureGuardrailDaily: (id: string, yyyymmdd: string) =>
    ["failure_guardrail_daily", id, yyyymmdd] as const,
  metric: (name: string) => ["metric", name] as const,
  metricDay: (name: string, yyyymmdd: string) =>
    ["metric_day", name, yyyymmdd] as const,
  config: (key: string) => ["config", key] as const,
  pendingKey: (sid: string, nonce: string) =>
    ["pending_key", sid, nonce] as const,
  adminFlash: (sid: string, nonce: string) => ["flash", sid, nonce] as const,
};

let configCache: Record<string, string> | null = null;
let configCacheAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000;

async function loadKvConfig(): Promise<Record<string, string>> {
  const now = Date.now();
  if (configCache && now - configCacheAt < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }
  const next: Record<string, string> = {};
  for await (const entry of kv.list<string>({ prefix: ["config"] })) {
    const key = typeof entry.key[1] === "string" ? entry.key[1] : "";
    if (key && typeof entry.value === "string") {
      next[key] = entry.value;
    }
  }
  configCache = next;
  configCacheAt = now;
  return next;
}

function invalidateConfigCache(): void {
  configCache = null;
  configCacheAt = 0;
}

async function envAsync(key: string, fallback?: string): Promise<string> {
  const fromEnv = Deno.env.get(key);
  if (fromEnv !== undefined) return fromEnv;
  const kvConfig = await loadKvConfig();
  if (kvConfig[key] !== undefined) return kvConfig[key];
  const fromConfig = (CONFIG as Record<string, unknown>)[key];
  if (fromConfig !== undefined && fromConfig !== null && fromConfig !== "") {
    return String(fromConfig);
  }
  return fallback ?? "";
}

async function envPositiveIntAsync(key: string, fallback: number): Promise<number> {
  const raw = await envAsync(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function envNonNegativeIntAsync(key: string, fallback: number): Promise<number> {
  const raw = await envAsync(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function resolveConfigValue(
  key: string,
  fallback = "",
): Promise<ResolvedConfigValue> {
  const fromEnv = Deno.env.get(key);
  if (fromEnv !== undefined) {
    return { key, value: fromEnv, source: "env", locked: true };
  }
  const kvConfig = await loadKvConfig();
  if (kvConfig[key] !== undefined) {
    return { key, value: kvConfig[key], source: "kv", locked: false };
  }
  const fromConfig = (CONFIG as Record<string, unknown>)[key];
  if (fromConfig !== undefined && fromConfig !== null && fromConfig !== "") {
    return { key, value: String(fromConfig), source: "config", locked: false };
  }
  return { key, value: fallback, source: "fallback", locked: false };
}

function parseConfigBoolean(value: string): boolean {
  return ["1", "true", "yes", "on", "disabled"].includes(
    value.trim().toLowerCase(),
  );
}

function providerDisabledConfigKey(name: string): string {
  return `PROVIDER_DISABLED_${name.toUpperCase()}`;
}

async function resolveProviderDisabledConfig(
  name: string,
): Promise<ResolvedConfigValue & { disabled: boolean }> {
  const resolved = await resolveConfigValue(providerDisabledConfigKey(name));
  return {
    ...resolved,
    disabled: parseConfigBoolean(resolved.value),
  };
}

async function getProviderEndpoints(): Promise<Record<string, string>> {
  const endpoints: Record<string, string> = {};
  for (const entry of await getResolvedProviderEntries()) {
    if (!entry.disabled) {
      endpoints[entry.name] = entry.url;
    }
  }
  return endpoints;
}

async function getProviderSummaries(): Promise<ProviderSummary[]> {
  const rawDefault = (await envAsync("DEFAULT_PROVIDER", "legacy")).trim()
    .toLowerCase();
  return (await getResolvedProviderEntries())
    .filter((entry) => !entry.disabled)
    .map((entry) => ({
      name: entry.name,
      isDefault: entry.name === rawDefault,
    }));
}

await migrateLegacyApiKeyIds();


function isNumericApiKeyId(value: string): boolean {
  return /^\d+$/.test(value);
}

function parseApiKeyNumber(value: string): number | null {
  if (!isNumericApiKeyId(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function ensureApiKeyCounterAtLeast(target: number): Promise<void> {
  if (!Number.isSafeInteger(target) || target < 0) return;
  while (true) {
    const entry = await kv.get<number>(keyBuilders.apiKeyCounter());
    const current = typeof entry.value === "number" && entry.value > 0
      ? entry.value
      : 0;
    if (current >= target) return;
    const result = await kv.atomic()
      .check({
        key: keyBuilders.apiKeyCounter(),
        versionstamp: entry.versionstamp,
      })
      .set(keyBuilders.apiKeyCounter(), target)
      .commit();
    if (result.ok) return;
  }
}

async function allocateNextApiKeyId(): Promise<string> {
  while (true) {
    const entry = await kv.get<number>(keyBuilders.apiKeyCounter());
    const current = typeof entry.value === "number" && entry.value > 0
      ? entry.value
      : 0;
    const next = current + 1;
    const result = await kv.atomic()
      .check({
        key: keyBuilders.apiKeyCounter(),
        versionstamp: entry.versionstamp,
      })
      .set(keyBuilders.apiKeyCounter(), next)
      .commit();
    if (result.ok) return String(next);
  }
}

async function migrateLegacyApiKeyIds(): Promise<void> {
  const records: ApiKeyRecord[] = [];
  let maxNumericId = 0;
  for await (const entry of kv.list<ApiKeyRecord>({ prefix: ["api_key"] })) {
    records.push(entry.value);
    const numericId = parseApiKeyNumber(entry.value.id);
    if (numericId && numericId > maxNumericId) {
      maxNumericId = numericId;
    }
  }
  await ensureApiKeyCounterAtLeast(maxNumericId);
  for (const record of records) {
    if (isNumericApiKeyId(record.id)) continue;
    const newId = await allocateNextApiKeyId();
    const totalEntry = await kv.get<bigint | number>(
      keyBuilders.apiUsageTotal(record.id),
    );
    const dailyEntries: Array<
      {
        key: readonly ["api_usage_daily", string, string];
        value: bigint | number | null;
      }
    > = [];
    for await (
      const entry of kv.list<bigint | number>({
        prefix: ["api_usage_daily", record.id],
      })
    ) {
      dailyEntries.push({
        key: entry.key as readonly ["api_usage_daily", string, string],
        value: entry.value,
      });
    }
    const nextRecord: ApiKeyRecord = {
      ...record,
      id: newId,
      updatedAt: nowMs(),
    };
    let operation = kv.atomic()
      .check({ key: keyBuilders.apiKey(newId), versionstamp: null })
      .set(keyBuilders.apiKey(newId), nextRecord)
      .set(keyBuilders.apiKeyHash(record.keyHash), newId)
      .delete(keyBuilders.apiKey(record.id));
    if (totalEntry.value != null) {
      operation = operation.set(
        keyBuilders.apiUsageTotal(newId),
        totalEntry.value,
      )
        .delete(keyBuilders.apiUsageTotal(record.id));
    }
    for (const daily of dailyEntries) {
      operation = operation.set(
        keyBuilders.apiUsageDaily(newId, daily.key[2]),
        daily.value,
      )
        .delete(daily.key);
    }
    const result = await operation.commit();
    if (!result.ok) {
      console.error(JSON.stringify({
        level: "error",
        msg: "api_key_id_migration_failed",
        fromId: record.id,
        toId: newId,
      }));
      continue;
    }
    console.log(JSON.stringify({
      level: "info",
      type: "migration",
      msg: "api_key_id_migrated",
      fromId: record.id,
      toId: newId,
    }));
  }
}

function nowMs(): number {
  return Date.now();
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function utcDayStamp(timestampMs = Date.now()): string {
  return new Date(timestampMs).toISOString().slice(0, 10).replaceAll("-", "");
}

function randomHex(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/g,
    "",
  );
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signAdminSession(payload: AdminSession): Promise<string> {
  const payloadB64 = bytesToBase64Url(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const key = await adminCookieKeyPromise;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadB64)),
  );
  return `${payloadB64}.${bytesToBase64Url(signature)}`;
}

async function verifyAdminSession(
  value: string | undefined,
): Promise<AdminSessionPayload | null> {
  if (!value) return null;
  const [payloadB64, signatureB64] = value.split(".");
  if (!payloadB64 || !signatureB64) return null;
  const key = await adminCookieKeyPromise;
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadB64)),
  );
  const actual = base64UrlToBytes(signatureB64);
  if (!timingSafeEqual(bytesToBase64Url(expected), bytesToBase64Url(actual))) {
    return null;
  }
  try {
    const payload = JSON.parse(
      textDecoder.decode(base64UrlToBytes(payloadB64)),
    ) as AdminSessionPayload;
    if (!payload?.exp || payload.exp <= nowSec()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(rawCookie: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!rawCookie) return cookies;
  for (const part of rawCookie.split(/;\s*/)) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function buildCookie(name: string, value: string, options: {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  maxAge?: number;
  expires?: Date;
} = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly ?? true) parts.push("HttpOnly");
  if (options.secure ?? true) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Strict"}`);
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  return parts.join("; ");
}

function clearAdminSessionCookie(): string {
  return buildCookie(ADMIN_COOKIE_NAME, "", {
    maxAge: 0,
    expires: new Date(0),
    sameSite: "Strict",
    secure: true,
    httpOnly: true,
  });
}

async function getAdminSessionState(request: Request): Promise<
  | { kind: "missing" }
  | { kind: "legacy" }
  | { kind: "valid"; session: AdminSession }
> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const session = await verifyAdminSession(cookies[ADMIN_COOKIE_NAME]);
  if (!session) return { kind: "missing" };
  if (!session.sid) return { kind: "legacy" };
  return {
    kind: "valid",
    session: {
      exp: session.exp,
      sid: session.sid,
    },
  };
}

function jsonEnvelope(
  status: number,
  success: boolean,
  data: unknown,
  error: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ success, data, error }), {
    status,
    headers: responseHeaders,
  });
}

function htmlResponse(
  status: number,
  html: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status, headers: responseHeaders });
}

function redirectResponse(
  location: string,
  status = 302,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("location", location);
  return new Response(null, { status, headers: responseHeaders });
}

function apiError(status: number, message: string): Response {
  return jsonEnvelope(status, false, null, message);
}

function parseNullableInteger(
  value: FormDataEntryValue | string | null | undefined,
): number | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `Invalid numeric value: ${normalized}`);
  }
  return parsed;
}

function parseNullableDateTime(
  value: FormDataEntryValue | string | null | undefined,
): number | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `Invalid date value: ${normalized}`);
  }
  return parsed;
}

function normalizeProviderName(value: string): string {
  return value.trim().toLowerCase();
}

function validateProviderName(value: string): string {
  const normalized = normalizeProviderName(value);
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(normalized)) {
    throw new HttpError(
      400,
      "Provider name must match /^[a-z][a-z0-9_]{0,31}$/.",
    );
  }
  return normalized;
}

function normalizeProviderUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, "Provider URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, "Provider URL must be a valid absolute URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "Provider URL must start with http:// or https://.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function parsePositiveIntegerInput(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new HttpError(400, `${fieldName} must be a positive integer.`);
  }
  return normalized;
}

function buildSettingsLocation(
  flash: string,
  extras: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ flash });
  for (const [key, value] of Object.entries(extras)) {
    params.set(key, value);
  }
  return `/admin/settings?${params.toString()}`;
}

function resolveSettingsFlash(url: URL): SettingsFlash | null {
  const flash = url.searchParams.get("flash") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const current = url.searchParams.get("current") ?? "";
  const next = url.searchParams.get("next") ?? "";
  const message = url.searchParams.get("message") ?? "";
  switch (flash) {
    case "provider_saved":
      return {
        tone: "success",
        key: "settings.flash.provider_saved",
        params: { name },
      };
    case "provider_deleted":
      return {
        tone: "success",
        key: "settings.flash.provider_deleted",
        params: { name },
      };
    case "provider_enabled":
      return {
        tone: "success",
        key: "settings.flash.provider_enabled",
        params: { name },
      };
    case "provider_disabled":
      return {
        tone: "warn",
        key: "settings.flash.provider_disabled",
        params: { name },
      };
    case "default_changed":
      return {
        tone: "success",
        key: "settings.flash.default_changed",
        params: { name },
      };
    case "default_reassigned":
      return next
        ? {
          tone: "warn",
          message: `Provider \"${current}\" was the default. Default has been changed to \"${next}\".`,
        }
        : {
          tone: "warn",
          message: `Provider \"${current}\" was the default. No default provider remains.`,
        };
    case "provider_disabled_reassigned":
      return next
        ? {
          tone: "warn",
          message:
            `Provider \"${current}\" was disabled. Default has been changed to \"${next}\".`,
        }
        : {
          tone: "warn",
          message:
            `Provider \"${current}\" was disabled. No default provider remains.`,
        };
    case "secret_saved":
      return { tone: "success", key: "settings.flash.secret_saved" };
    case "secret_deleted":
      return { tone: "warn", key: "settings.flash.secret_deleted" };
    case "advanced_saved":
      return {
        tone: "success",
        key: "settings.flash.advanced_saved",
        params: { name },
      };
    case "advanced_deleted":
      return {
        tone: "warn",
        key: "settings.flash.advanced_deleted",
        params: { name },
      };
    case "error":
      return { tone: "error", message: message || "Settings update failed." };
    default:
      return null;
  }
}

async function writeAdminFlash(
  session: AdminSession,
  flash: SettingsFlash,
): Promise<string> {
  const nonce = crypto.randomUUID();
  await kv.set(keyBuilders.adminFlash(session.sid, nonce), flash, {
    expireIn: 30_000,
  });
  return nonce;
}

async function readAdminFlash(
  session: AdminSession,
  url: URL,
): Promise<SettingsFlash | null> {
  const nonce = url.searchParams.get("flash") ?? "";
  if (!nonce) return null;
  const entry = await kv.get<SettingsFlash>(keyBuilders.adminFlash(session.sid, nonce));
  if (!entry.value) return null;
  await kv.delete(keyBuilders.adminFlash(session.sid, nonce));
  return entry.value;
}

async function writePendingKey(
  session: AdminSession,
  value: { id: string; rawKey: string },
): Promise<string> {
  const nonce = crypto.randomUUID();
  await kv.set(keyBuilders.pendingKey(session.sid, nonce), value, {
    expireIn: 180_000,
  });
  return nonce;
}

async function readPendingKey(
  session: AdminSession,
  url: URL,
): Promise<{ nonce: string; value: { id: string; rawKey: string } | null }> {
  const nonce = url.searchParams.get("pending") ?? "";
  if (!nonce) return { nonce: "", value: null };
  const entry = await kv.get<{ id: string; rawKey: string }>(
    keyBuilders.pendingKey(session.sid, nonce),
  );
  return { nonce, value: entry.value ?? null };
}

function configSourceLabel(source: ConfigSource): string {
  switch (source) {
    case "env":
      return "ENV";
    case "kv":
      return "KV";
    case "config":
      return "CONFIG";
    default:
      return "FALLBACK";
  }
}

async function getResolvedProviderEntries(): Promise<ResolvedProviderEntry[]> {
  const entries = new Map<
    string,
    { name: string; url: string; source: ConfigSource; locked: boolean }
  >();
  const kvConfig = await loadKvConfig();
  for (const [key, value] of Object.entries(CONFIG)) {
    const match = key.match(/^PROVIDER_URL_(\w+)$/);
    if (match && typeof value === "string" && value) {
      const name = match[1].toLowerCase();
      entries.set(name, { name, url: value.replace(/\/$/, ""), source: "config", locked: false });
    }
  }
  for (const [key, value] of Object.entries(kvConfig)) {
    const match = key.match(/^PROVIDER_URL_(\w+)$/);
    if (match && value) {
      const name = match[1].toLowerCase();
      entries.set(name, { name, url: value.replace(/\/$/, ""), source: "kv", locked: false });
    }
  }
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    const match = key.match(/^PROVIDER_URL_(\w+)$/);
    if (match && value) {
      const name = match[1].toLowerCase();
      entries.set(name, { name, url: value.replace(/\/$/, ""), source: "env", locked: true });
    }
  }
  const rows = await Promise.all(
    Array.from(entries.values()).map(async (entry) => {
      const disabledConfig = await resolveProviderDisabledConfig(entry.name);
      return {
        ...entry,
        disabled: disabledConfig.disabled,
        disabledSource: disabledConfig.source,
        disableLocked: disabledConfig.locked,
      } satisfies ResolvedProviderEntry;
    }),
  );
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

async function assertMailOperationsConfigured(): Promise<void> {
  const endpoints = await getProviderEndpoints();
  if (Object.keys(endpoints).length === 0) {
    throw new HttpError(
      503,
      "No mail providers are configured. Contact the administrator.",
    );
  }
  const providerSecret = await envAsync("PROVIDER_SECRET");
  if (!providerSecret) {
    throw new HttpError(
      503,
      "Provider authentication is not configured. Contact the administrator.",
    );
  }
}

async function resolveProvider(providerParam: unknown): Promise<ProviderTarget> {
  const endpoints = await getProviderEndpoints();
  const defaultProvider = (await envAsync("DEFAULT_PROVIDER", "legacy")).trim().toLowerCase();
  const requested =
    providerParam === undefined || providerParam === null || providerParam === ""
      ? defaultProvider
      : String(providerParam).trim().toLowerCase();
  const url = endpoints[requested];
  if (url) return { name: requested, url };
  // Fallback to default provider when the requested one is unknown or disabled.
  const defaultUrl = endpoints[defaultProvider];
  if (defaultUrl) return { name: defaultProvider, url: defaultUrl };
  throw new HttpError(
    503,
    `No available provider. Requested "${requested}" is unavailable and default provider "${defaultProvider}" is also unavailable.`,
  );
}

function auditConfigChange(key: string, action: "set" | "delete", valuePreview: string): void {
  console.log(JSON.stringify({
    level: "info",
    type: "config_change",
    key,
    action,
    source: "admin_ui",
    valuePreview,
    timestamp: new Date().toISOString(),
  }));
}

async function requireAdminSession(request: Request): Promise<AdminSession> {
  const state = await getAdminSessionState(request);
  if (state.kind !== "valid") {
    throw new HttpError(403, "Admin authentication required.");
  }
  return state.session;
}

function verifyAdminPostOrigin(request: Request, url: URL): void {
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  const expectedOrigin = url.origin;
  const actualOrigin = originHeader ??
    (refererHeader ? new URL(refererHeader).origin : null);
  if (!actualOrigin || actualOrigin !== expectedOrigin) {
    throw new HttpError(403, "Invalid admin request origin.");
  }
}

async function authenticateApiRequest(
  request: Request,
): Promise<ApiAuthContext> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Missing or invalid bearer token.");
  const rawKey = match[1].trim();
  if (!rawKey) throw new HttpError(401, "Missing or invalid bearer token.");
  const keyHash = await sha256Hex(rawKey);
  const keyIdEntry = await kv.get<string>(keyBuilders.apiKeyHash(keyHash));
  if (!keyIdEntry.value) {
    throw new HttpError(401, "Missing or invalid bearer token.");
  }
  const keyRecordEntry = await kv.get<ApiKeyRecord>(
    keyBuilders.apiKey(keyIdEntry.value),
  );
  const keyRecord = keyRecordEntry.value;
  if (!keyRecord) throw new HttpError(401, "Missing or invalid bearer token.");
  if (!timingSafeEqual(keyRecord.keyHash, keyHash)) {
    throw new HttpError(401, "Missing or invalid bearer token.");
  }
  if (keyRecord.status !== "active") {
    throw new HttpError(403, "API key is disabled.");
  }
  if (keyRecord.expiresAt && keyRecord.expiresAt <= nowMs()) {
    throw new HttpError(403, "API key is expired.");
  }
  return { keyId: keyRecord.id, keyRecord };
}

async function readUsageCounters(
  keyId: string,
): Promise<{ total: number; daily: number }> {
  const [totalEntry, dailyEntry] = await kv.getMany(
    [
      keyBuilders.apiUsageTotal(keyId),
      keyBuilders.apiUsageDaily(keyId, utcDayStamp()),
    ] as const,
  );
  return {
    total: totalEntry.value ? Number(totalEntry.value) : 0,
    daily: dailyEntry.value ? Number(dailyEntry.value) : 0,
  };
}

async function assertQuotaAvailable(auth: ApiAuthContext): Promise<void> {
  const usage = await readUsageCounters(auth.keyId);
  if (
    auth.keyRecord.quotaTotal !== null &&
    usage.total >= auth.keyRecord.quotaTotal
  ) {
    throw new HttpError(429, "Total quota exhausted.");
  }
  if (
    auth.keyRecord.quotaDaily !== null &&
    usage.daily >= auth.keyRecord.quotaDaily
  ) {
    throw new HttpError(429, "Daily quota exhausted.");
  }
}

async function computeRemainingQuota(auth: ApiAuthContext): Promise<number | null> {
  const usage = await readUsageCounters(auth.keyId);
  const candidates: number[] = [];
  if (auth.keyRecord.quotaTotal !== null) {
    candidates.push(Math.max(0, auth.keyRecord.quotaTotal - usage.total));
  }
  if (auth.keyRecord.quotaDaily !== null) {
    candidates.push(Math.max(0, auth.keyRecord.quotaDaily - usage.daily));
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

async function incrementUsageCountersBy(keyId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const day = utcDayStamp();
  const n = BigInt(count);
  const result = await kv.atomic()
    .sum(keyBuilders.apiUsageTotal(keyId), n)
    .sum(keyBuilders.apiUsageDaily(keyId, day), n)
    .sum(keyBuilders.metric("upstream_total"), n)
    .sum(keyBuilders.metricDay("upstream_total", day), n)
    .commit();
  if (!result.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "usage_increment_failed",
        keyId,
        count,
      }),
    );
  }
}

async function incrementFailureGuardrail(keyId: string, count: number): Promise<void> {
  if (count <= 0) return;
  const day = utcDayStamp();
  const n = BigInt(count);
  const result = await kv.atomic()
    .sum(keyBuilders.failureGuardrailDaily(keyId, day), n)
    .sum(keyBuilders.metric("upstream_failed_total"), n)
    .sum(keyBuilders.metricDay("upstream_failed_total", day), n)
    .commit();
  if (!result.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "failure_guardrail_increment_failed",
        keyId,
        count,
      }),
    );
  }
}

async function createApiKeyRecord(params: {
  label: string;
  quotaTotal: number | null;
  quotaDaily: number | null;
  expiresAt: number | null;
}): Promise<{ record: ApiKeyRecord; rawKey: string }> {
  const id = await allocateNextApiKeyId();
  const rawKey = `sk-${randomHex(16)}`;
  const keyHash = await sha256Hex(rawKey);
  const timestamp = nowMs();
  const record: ApiKeyRecord = {
    id,
    label: params.label,
    keyHash,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: params.expiresAt,
    quotaTotal: params.quotaTotal,
    quotaDaily: params.quotaDaily,
  };
  const result = await kv.atomic()
    .check({ key: keyBuilders.apiKey(id), versionstamp: null })
    .check({ key: keyBuilders.apiKeyHash(keyHash), versionstamp: null })
    .set(keyBuilders.apiKey(id), record)
    .set(keyBuilders.apiKeyHash(keyHash), id)
    .commit();
  if (!result.ok) {
    throw new HttpError(500, "Failed to create API key.");
  }
  return { record, rawKey };
}

async function updateApiKeyRecord(keyId: string, updates: {
  label: string;
  status: "active" | "disabled";
  quotaTotal: number | null;
  quotaDaily: number | null;
  expiresAt: number | null;
}): Promise<void> {
  const existing = await kv.get<ApiKeyRecord>(keyBuilders.apiKey(keyId));
  if (!existing.value) throw new HttpError(404, "API key not found.");
  const record: ApiKeyRecord = {
    ...existing.value,
    ...updates,
    updatedAt: nowMs(),
  };
  await kv.set(keyBuilders.apiKey(keyId), record);
}

async function deleteApiKeyRecord(keyId: string): Promise<void> {
  const existing = await kv.get<ApiKeyRecord>(keyBuilders.apiKey(keyId));
  if (!existing.value) throw new HttpError(404, "API key not found.");
  let operation = kv.atomic()
    .delete(keyBuilders.apiKey(keyId))
    .delete(keyBuilders.apiKeyHash(existing.value.keyHash))
    .delete(keyBuilders.apiUsageTotal(keyId));
  for await (
    const entry of kv.list<bigint | number>({
      prefix: ["api_usage_daily", keyId],
    })
  ) {
    operation = operation.delete(entry.key);
  }
  const result = await operation.commit();
  if (!result.ok) {
    throw new HttpError(500, "Failed to delete API key.");
  }
}

async function listApiKeysWithUsage(): Promise<
  Array<ApiKeyRecord & { usageTotal: number; usageDaily: number }>
> {
  const items: Array<
    ApiKeyRecord & { usageTotal: number; usageDaily: number }
  > = [];
  const day = utcDayStamp();
  const records: ApiKeyRecord[] = [];
  for await (const entry of kv.list<ApiKeyRecord>({ prefix: ["api_key"] })) {
    records.push(entry.value);
  }
  records.sort((left, right) => right.createdAt - left.createdAt);
  for (const record of records) {
    const [usageTotalEntry, usageDailyEntry] = await kv.getMany(
      [
        keyBuilders.apiUsageTotal(record.id),
        keyBuilders.apiUsageDaily(record.id, day),
      ] as const,
    );
    items.push({
      ...record,
      usageTotal: usageTotalEntry.value ? Number(usageTotalEntry.value) : 0,
      usageDaily: usageDailyEntry.value ? Number(usageDailyEntry.value) : 0,
    });
  }
  return items;
}

async function countActiveApiKeys(): Promise<number> {
  let count = 0;
  for await (const entry of kv.list<ApiKeyRecord>({ prefix: ["api_key"] })) {
    if (entry.value.status === "active") count += 1;
  }
  return count;
}

async function getProxyStats(): Promise<{
  totalUpstreamCalls: number;
  todayUpstreamCalls: number;
  activeApiKeys: number;
}> {
  const [totalEntry, dailyEntry] = await kv.getMany(
    [
      keyBuilders.metric("upstream_total"),
      keyBuilders.metricDay("upstream_total", utcDayStamp()),
    ] as const,
  );
  return {
    totalUpstreamCalls: totalEntry.value ? Number(totalEntry.value) : 0,
    todayUpstreamCalls: dailyEntry.value ? Number(dailyEntry.value) : 0,
    activeApiKeys: await countActiveApiKeys(),
  };
}

async function saveMailIdMapping(
  provider: string,
  mailId: string,
  email: string,
): Promise<void> {
  const ttlMs = await envPositiveIntAsync(
    "MAIL_ID_TTL_MS",
    24 * 60 * 60 * 1000,
  );
  await kv.set(keyBuilders.mailToEmail(provider, mailId), email, {
    expireIn: ttlMs,
  });
}

async function getMailIdMapping(
  provider: string,
  mailId: string,
): Promise<string | null> {
  const entry = await kv.get<string>(keyBuilders.mailToEmail(provider, mailId));
  return entry.value ?? null;
}

function tryExtractMailId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

async function hydrateMailMappings(
  provider: string,
  email: string,
  data: unknown,
): Promise<void> {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  const emails = Array.isArray(record.emails) ? record.emails : [];
  for (const item of emails) {
    if (!item || typeof item !== "object") continue;
    const mailId = tryExtractMailId((item as Record<string, unknown>).id);
    if (mailId) {
      await saveMailIdMapping(provider, mailId, email);
    }
  }
  const directId = tryExtractMailId(record.id);
  if (directId) {
    await saveMailIdMapping(provider, directId, email);
  }
}

async function callProvider(
  ctx: RequestContext,
  auth: ApiAuthContext,
  provider: ProviderTarget,
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: unknown,
): Promise<ProviderResponse> {
  const providerSecret = await envAsync("PROVIDER_SECRET");
  if (!providerSecret) {
    throw new HttpError(
      503,
      "Provider authentication is not configured. Contact the administrator.",
    );
  }
  const targetUrl = new URL(path, provider.url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      targetUrl.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${providerSecret}`,
    "X-Request-Id": ctx.requestId,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const remaining = await computeRemainingQuota(auth);
  if (remaining !== null && remaining > 0) {
    headers["X-Max-Upstream-Calls"] = String(remaining);
  }

  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(targetUrl.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      type: "provider_unreachable",
      requestId: ctx.requestId,
      provider: provider.name,
      providerUrl: targetUrl.toString(),
      error: error instanceof Error ? error.message : String(error),
    }));
    throw new HttpError(502, `Provider "${provider.name}" is unreachable.`);
  }

  let json: ProviderEnvelope;
  try {
    json = await response.json() as ProviderEnvelope;
  } catch {
    throw new HttpError(502, `Provider "${provider.name}" returned invalid JSON.`);
  }

  if (response.status === 401) {
    console.error(JSON.stringify({
      level: "error",
      type: "provider_auth_rejected",
      requestId: ctx.requestId,
      provider: provider.name,
    }));
    throw new HttpError(
      502,
      `Provider "${provider.name}" rejected the request (auth misconfiguration).`,
    );
  }

  const rawCalls = json._upstream_calls;
  const upstreamCalls =
    typeof rawCalls === "number" && Number.isInteger(rawCalls) && rawCalls >= 0
      ? Math.min(rawCalls, MAX_UPSTREAM_CALLS_PER_REQUEST)
      : 0;

  console.log(JSON.stringify({
    level: "info",
    type: "provider_call",
    requestId: ctx.requestId,
    provider: provider.name,
    method,
    path,
    providerStatus: response.status,
    upstreamCalls,
    durationMs: Math.round(performance.now() - start),
  }));

  return {
    success: json.success ?? false,
    data: json.data ?? null,
    error: json.error ?? "",
    upstreamCalls,
    status: response.status,
  };
}

async function handleGenerateEmail(
  ctx: RequestContext,
  auth: ApiAuthContext,
): Promise<Response> {
  await assertMailOperationsConfigured();
  await assertQuotaAvailable(auth);
  let providerParam: unknown;
  let payload: JsonRecord = {};
  if (ctx.request.method === "POST") {
    try {
      payload = await ctx.request.json() as JsonRecord;
    } catch {
      throw new HttpError(400, "Invalid JSON body.");
    }
    providerParam = payload.provider;
  } else {
    providerParam = ctx.url.searchParams.get("provider") ?? undefined;
  }
  const provider = await resolveProvider(providerParam);
  const prefix = typeof payload.prefix === "string" && payload.prefix.trim()
    ? payload.prefix.trim()
    : undefined;
  const domain = typeof payload.domain === "string" && payload.domain.trim()
    ? payload.domain.trim()
    : undefined;
  const result = await callProvider(
    ctx,
    auth,
    provider,
    "POST",
    "/generate-email",
    undefined,
    {
      ...(prefix ? { prefix } : {}),
      ...(domain ? { domain } : {}),
    },
  );
  if (!result.success) {
    await incrementFailureGuardrail(auth.keyId, result.upstreamCalls);
    throw new HttpError(
      result.status >= 400 ? result.status : 502,
      result.error || "Provider operation failed.",
    );
  }
  await incrementUsageCountersBy(auth.keyId, result.upstreamCalls);
  return jsonEnvelope(200, true, result.data, "");
}

async function handleListEmails(
  ctx: RequestContext,
  auth: ApiAuthContext,
): Promise<Response> {
  await assertMailOperationsConfigured();
  await assertQuotaAvailable(auth);
  const email = ctx.url.searchParams.get("email");
  if (!email) throw new HttpError(400, "Query parameter email is required.");
  const provider = await resolveProvider(
    ctx.url.searchParams.get("provider") ?? undefined,
  );
  const result = await callProvider(
    ctx,
    auth,
    provider,
    "GET",
    "/emails",
    { email },
  );
  if (!result.success) {
    await incrementFailureGuardrail(auth.keyId, result.upstreamCalls);
    throw new HttpError(
      result.status >= 400 ? result.status : 502,
      result.error || "Provider operation failed.",
    );
  }
  await incrementUsageCountersBy(auth.keyId, result.upstreamCalls);
  await hydrateMailMappings(provider.name, email, result.data);
  return jsonEnvelope(200, true, result.data, "");
}

async function resolveEmailForMailOperation(
  mailId: string,
  url: URL,
  providerName: string,
): Promise<string | null> {
  const mapped = await getMailIdMapping(providerName, mailId);
  if (mapped) return mapped;
  const hinted = url.searchParams.get("email");
  if (hinted) return hinted;
  return null;
}

async function handleEmailDetail(
  ctx: RequestContext,
  auth: ApiAuthContext,
  mailId: string,
): Promise<Response> {
  await assertMailOperationsConfigured();
  await assertQuotaAvailable(auth);
  const provider = await resolveProvider(
    ctx.url.searchParams.get("provider") ?? undefined,
  );
  const email = await resolveEmailForMailOperation(mailId, ctx.url, provider.name);
  if (!email) {
    throw new HttpError(
      404,
      "Unable to resolve email address for this mail id. Provide email=... or retry after listing the inbox.",
    );
  }
  const result = await callProvider(
    ctx,
    auth,
    provider,
    "GET",
    `/email/${encodeURIComponent(mailId)}`,
    { email },
  );
  if (!result.success) {
    await incrementFailureGuardrail(auth.keyId, result.upstreamCalls);
    throw new HttpError(
      result.status >= 400 ? result.status : 502,
      result.error || "Provider operation failed.",
    );
  }
  await incrementUsageCountersBy(auth.keyId, result.upstreamCalls);
  await hydrateMailMappings(provider.name, email, result.data);
  return jsonEnvelope(200, true, result.data, "");
}

async function handleDeleteEmail(
  ctx: RequestContext,
  auth: ApiAuthContext,
  mailId: string,
): Promise<Response> {
  await assertMailOperationsConfigured();
  await assertQuotaAvailable(auth);
  const provider = await resolveProvider(
    ctx.url.searchParams.get("provider") ?? undefined,
  );
  const email = await resolveEmailForMailOperation(mailId, ctx.url, provider.name);
  if (!email) {
    throw new HttpError(
      404,
      "Unable to resolve email address for this mail id. Provide email=... or retry after listing the inbox.",
    );
  }
  const result = await callProvider(
    ctx,
    auth,
    provider,
    "DELETE",
    `/email/${encodeURIComponent(mailId)}`,
    { email },
  );
  if (!result.success) {
    await incrementFailureGuardrail(auth.keyId, result.upstreamCalls);
    throw new HttpError(
      result.status >= 400 ? result.status : 502,
      result.error || "Provider operation failed.",
    );
  }
  await incrementUsageCountersBy(auth.keyId, result.upstreamCalls);
  return jsonEnvelope(200, true, result.data, "");
}

async function handleClearEmails(
  ctx: RequestContext,
  auth: ApiAuthContext,
): Promise<Response> {
  await assertMailOperationsConfigured();
  await assertQuotaAvailable(auth);
  const email = ctx.url.searchParams.get("email");
  if (!email) throw new HttpError(400, "Query parameter email is required.");
  const provider = await resolveProvider(
    ctx.url.searchParams.get("provider") ?? undefined,
  );
  const result = await callProvider(
    ctx,
    auth,
    provider,
    "DELETE",
    "/emails/clear",
    { email },
  );
  if (!result.success) {
    await incrementFailureGuardrail(auth.keyId, result.upstreamCalls);
    throw new HttpError(
      result.status >= 400 ? result.status : 502,
      result.error || "Provider operation failed.",
    );
  }
  await incrementUsageCountersBy(auth.keyId, result.upstreamCalls);
  return jsonEnvelope(200, true, result.data, "");
}

async function getRuntimeWarnings(): Promise<string[]> {
  const warnings: string[] = [];
  const allProviders = await getResolvedProviderEntries();
  const enabledProviders = allProviders.filter((provider) => !provider.disabled);
  const providerSecret = await envAsync("PROVIDER_SECRET");
  if (allProviders.length === 0) {
    warnings.push(
      "No mail providers configured. API endpoints are unavailable. Go to Admin → Settings to add a provider.",
    );
  }
  if (allProviders.length > 0 && enabledProviders.length === 0) {
    warnings.push(
      "All configured providers are currently disabled. Re-enable at least one provider to restore API operations.",
    );
  }
  if (enabledProviders.length > 0 && !providerSecret) {
    warnings.push(
      "Provider authentication is not configured. Mail API operations are unavailable until PROVIDER_SECRET is set.",
    );
  }
  return warnings;
}

function previewConfigValue(key: string, value: string): string {
  if (key === "PROVIDER_SECRET") return "(secret)";
  return value.length > 24 ? `${value.slice(0, 24)}...` : value;
}

async function setKvConfigValue(key: string, value: string): Promise<void> {
  await kv.set(keyBuilders.config(key), value);
  invalidateConfigCache();
  auditConfigChange(key, "set", previewConfigValue(key, value));
}

async function deleteKvConfigValue(key: string): Promise<void> {
  await kv.delete(keyBuilders.config(key));
  invalidateConfigCache();
  auditConfigChange(key, "delete", key === "PROVIDER_SECRET" ? "(secret)" : "(deleted)");
}

async function buildSettingsPageModel(url: URL): Promise<{
  baseUrl: string;
  flash: SettingsFlash | null;
  providers: Array<ResolvedProviderEntry & { isDefault: boolean }>;
  defaultProvider: ResolvedConfigValue;
  providerSecret: ResolvedConfigValue;
  mailIdTtl: ResolvedConfigValue;
  adminSessionTtl: ResolvedConfigValue;
  warnings: string[];
}> {
  const defaultProvider = await resolveConfigValue("DEFAULT_PROVIDER", "legacy");
  const providerSecret = await resolveConfigValue("PROVIDER_SECRET");
  const rawDefault = defaultProvider.value.trim().toLowerCase();
  return {
    baseUrl: url.origin,
    flash: resolveSettingsFlash(url),
    providers: (await getResolvedProviderEntries()).map((provider) => ({
      ...provider,
      isDefault: provider.name === rawDefault,
    })),
    defaultProvider,
    providerSecret,
    mailIdTtl: await resolveConfigValue(
      "MAIL_ID_TTL_MS",
      String(CONFIG.MAIL_ID_TTL_MS),
    ),
    adminSessionTtl: await resolveConfigValue(
      "ADMIN_SESSION_TTL_SEC",
      String(CONFIG.ADMIN_SESSION_TTL_SEC),
    ),
    warnings: await getRuntimeWarnings(),
  };
}

const GITHUB_FOOTER_HTML = `<footer style="position:fixed;bottom:0;left:0;right:0;text-align:center;padding:12px;font-size:13px"><a href="https://github.com/k0baya/tmp-mail-api" target="_blank" rel="noopener noreferrer" style="color:#888;text-decoration:none;display:inline-flex;align-items:center;gap:6px"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>k0baya/tmp-mail-api</a></footer>`;

function fallbackResponse(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Service Unavailable</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fafafa}.c{text-align:center;max-width:480px;padding:2rem}h1{font-size:3rem;font-weight:200;margin:0 0 1rem}p{color:#888;line-height:1.6}</style></head><body><div class="c"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>${GITHUB_FOOTER_HTML}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function errorPage(status: number, title: string, message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fafafa}.c{text-align:center;max-width:480px;padding:2rem}h1{font-size:3rem;font-weight:200;margin:0 0 1rem}p{color:#888;line-height:1.6}a{color:#60a5fa}</style></head><body><div class="c"><h1>${status}</h1><p>${escapeHtml(message)}</p></div>${GITHUB_FOOTER_HTML}</body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

const PAGE_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;

async function renderFrontendPage(
  path:
    | "/render/login"
    | "/render/dashboard"
    | "/render/keys"
    | "/render/docs"
    | "/render/settings",
  model: unknown,
): Promise<RenderResult> {
  const frontendProviderUrl = await envAsync("FRONTEND_PROVIDER_URL");
  if (!frontendProviderUrl) {
    return { ok: false, reason: "not_configured" };
  }
  const providerSecret = await envAsync("PROVIDER_SECRET");
  if (!providerSecret) {
    return { ok: false, reason: "auth_failed" };
  }
  let response: Response;
  try {
    response = await fetch(new URL(path, frontendProviderUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${providerSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(model),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, reason: "timeout" };
  }
  if (response.status === 401) {
    return { ok: false, reason: "auth_failed" };
  }
  if (!response.ok) return { ok: false, reason: "render_error" };
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const html = await response.text();
  if (!contentType.includes("text/html") || !html.trim()) {
    return { ok: false, reason: "render_error" };
  }
  return { ok: true, html };
}

function mapRenderFailure(reason: RenderFailureReason): Response {
  switch (reason) {
    case "not_configured":
      return fallbackResponse(
        503,
        "Front-End Provider is not configured. The API is operational. Set FRONTEND_PROVIDER_URL to enable the web interface.",
      );
    case "auth_failed":
      return fallbackResponse(
        502,
        "Front-End Provider authentication failed. Check PROVIDER_SECRET configuration.",
      );
    case "timeout":
      return fallbackResponse(
        503,
        "Front-End Provider is temporarily unavailable. The API is operational.",
      );
    default:
      return fallbackResponse(
        502,
        "Front-End Provider encountered a rendering error. The API is operational.",
      );
  }
}

function frontendHtmlResponse(html: string): Response {
  return htmlResponse(200, html, PAGE_SECURITY_HEADERS);
}

function buildLoginPageModel(baseUrl: string, error: string | null = null) {
  return { baseUrl, error };
}

async function buildDashboardPageModel(baseUrl: string) {
  return {
    baseUrl,
    stats: await getProxyStats(),
  };
}

async function buildKeysPageModel(
  url: URL,
  session: AdminSession,
): Promise<{
  baseUrl: string;
  flash: SettingsFlash | null;
  error: string | null;
  createdKey: { id: string; rawKey: string } | null;
  keys: Array<Omit<ApiKeyRecord, "status"> & {
    usageTotal: number;
    usageDaily: number;
    status: "active" | "disabled" | "expired";
  }>;
  pendingNonce: string;
}> {
  const [flash, pending, records] = await Promise.all([
    readAdminFlash(session, url),
    readPendingKey(session, url),
    listApiKeysWithUsage(),
  ]);
  return {
    baseUrl: url.origin,
    flash,
    error: null,
    createdKey: pending.value,
    pendingNonce: pending.nonce,
    keys: records.map((record) => ({
      ...record,
      status: record.expiresAt && record.expiresAt <= nowMs()
        ? "expired"
        : record.status,
    })),
  };
}

async function renderDocsViaFrontendProvider(baseUrl: string): Promise<RenderResult> {
  const cacheKey = `docs-page:${baseUrl}`;
  const cached = docsPageCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { ok: true, html: cached.html };
  }
  const result = await renderFrontendPage("/render/docs", {
    baseUrl,
    providers: await getProviderSummaries(),
    warnings: await getRuntimeWarnings(),
  });
  if (result.ok) {
    docsPageCache.set(cacheKey, { html: result.html, expiresAt: now + DOCS_CACHE_TTL_MS });
  }
  return result;
}

async function renderSettingsViaFrontendProvider(url: URL): Promise<RenderResult> {
  return await renderFrontendPage(
    "/render/settings",
    await buildSettingsPageModel(url),
  );
}

async function testProviderConnection(
  providerUrl: string,
): Promise<{ ok: boolean; status: number; latencyMs: number; email?: string; error?: string }> {
  const startedAt = performance.now();
  const providerSecret = await envAsync("PROVIDER_SECRET");
  try {
    const response = await fetch(
      new URL("/generate-email", providerUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      },
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: `Provider returned ${response.status}. ${text}`.trim(),
      };
    }
    let json: { success?: boolean; data?: { email?: string } };
    try {
      json = await response.json();
    } catch {
      return { ok: false, status: response.status, latencyMs, error: "Invalid JSON response." };
    }
    const email = json?.data?.email;
    if (json?.success && typeof email === "string" && email.includes("@")) {
      // Best-effort cleanup: ask provider to clear the test session.
      const clearUrl = new URL("/emails/clear", providerUrl);
      clearUrl.searchParams.set("email", email);
      fetch(clearUrl.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${providerSecret}` },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      return { ok: true, status: response.status, latencyMs, email };
    }
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: "Provider did not return a valid email address.",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "Connection failed.",
    };
  }
}

async function deleteProviderAndAdjustDefault(name: string): Promise<string> {
  const normalized = normalizeProviderName(name);
  const rows = await getResolvedProviderEntries();
  const provider = rows.find((row) => row.name === normalized);
  if (!provider) throw new HttpError(404, `Provider "${normalized}" not found.`);
  if (provider.source !== "kv") {
    throw new HttpError(400, `Provider "${normalized}" is not KV-managed.`);
  }
  const defaultConfig = await resolveConfigValue("DEFAULT_PROVIDER", "legacy");
  const currentDefault = defaultConfig.value.trim().toLowerCase();
  if (currentDefault === normalized && defaultConfig.source === "env") {
    throw new HttpError(
      400,
      `Cannot delete provider "${normalized}" 鈥?it is the current default and DEFAULT_PROVIDER is locked by environment variable. Remove or change the DEFAULT_PROVIDER env var first.`,
    );
  }
  await deleteKvConfigValue(`PROVIDER_URL_${normalized.toUpperCase()}`);
  const remaining = (await getResolvedProviderEntries())
    .map((row) => row.name)
    .filter((providerName) => providerName !== normalized)
    .filter((providerName) => {
      const row = rows.find((item) => item.name === providerName);
      return row ? !row.disabled : true;
    })
    .sort((left, right) => left.localeCompare(right));
  if (currentDefault === normalized) {
    if (remaining.length > 0) {
      await setKvConfigValue("DEFAULT_PROVIDER", remaining[0]);
      return buildSettingsLocation("default_reassigned", {
        current: normalized,
        next: remaining[0],
      });
    }
    await setKvConfigValue("DEFAULT_PROVIDER", "");
    return buildSettingsLocation("default_reassigned", { current: normalized });
  }
  return buildSettingsLocation("provider_deleted", { name: normalized });
}

async function setProviderDisabledState(
  name: string,
  disabled: boolean,
): Promise<string> {
  const normalized = normalizeProviderName(name);
  const rows = await getResolvedProviderEntries();
  const provider = rows.find((row) => row.name === normalized);
  if (!provider) {
    throw new HttpError(404, `Provider "${normalized}" not found.`);
  }

  const disabledConfig = await resolveProviderDisabledConfig(normalized);
  const disabledKey = providerDisabledConfigKey(normalized);

  if (!disabled) {
    if (disabledConfig.disabled && disabledConfig.locked) {
      throw new HttpError(
        400,
        `Provider "${normalized}" is disabled by environment variable and cannot be enabled here.`,
      );
    }
    if (disabledConfig.source === "config" && disabledConfig.disabled) {
      await setKvConfigValue(disabledKey, "0");
    } else {
      await deleteKvConfigValue(disabledKey);
    }
    return buildSettingsLocation("provider_enabled", { name: normalized });
  }

  if (provider.disabled) {
    return buildSettingsLocation("provider_disabled", { name: normalized });
  }

  const defaultConfig = await resolveConfigValue("DEFAULT_PROVIDER", "legacy");
  const currentDefault = defaultConfig.value.trim().toLowerCase();
  if (currentDefault === normalized && defaultConfig.locked) {
    throw new HttpError(
      400,
      `Cannot disable provider "${normalized}" because DEFAULT_PROVIDER is locked by environment variable and still points to it.`,
    );
  }

  await setKvConfigValue(disabledKey, "1");

  if (currentDefault === normalized) {
    const remaining = (await getResolvedProviderEntries())
      .filter((row) => row.name !== normalized && !row.disabled)
      .map((row) => row.name)
      .sort((left, right) => left.localeCompare(right));
    if (remaining.length > 0) {
      await setKvConfigValue("DEFAULT_PROVIDER", remaining[0]);
      return buildSettingsLocation("provider_disabled_reassigned", {
        current: normalized,
        next: remaining[0],
      });
    }
    await setKvConfigValue("DEFAULT_PROVIDER", "");
    return buildSettingsLocation("provider_disabled_reassigned", {
      current: normalized,
    });
  }

  return buildSettingsLocation("provider_disabled", { name: normalized });
}

async function saveProviderDefinition(
  oldName: string | null,
  name: string,
  url: string,
): Promise<string> {
  const normalizedName = normalizeProviderName(name);
  const normalizedOld = oldName ? normalizeProviderName(oldName) : null;
  const rows = await getResolvedProviderEntries();
  const existing = rows.find((provider) => provider.name === normalizedName);
  const current = normalizedOld
    ? rows.find((provider) => provider.name === normalizedOld)
    : null;

  if (normalizedOld && !current) {
    throw new HttpError(404, `Provider "${normalizedOld}" not found.`);
  }
  if (normalizedOld && current && current.source !== "kv") {
    throw new HttpError(400, `Provider "${normalizedOld}" cannot be edited here.`);
  }

  if (normalizedOld && normalizedOld !== normalizedName) {
    if (existing) {
      throw new HttpError(400, `Provider "${normalizedName}" already exists.`);
    }
    const disabledConfig = await resolveProviderDisabledConfig(normalizedOld);
    if (disabledConfig.locked) {
      throw new HttpError(
        400,
        `Provider "${normalizedOld}" has a disabled state locked by environment variable and cannot be renamed here.`,
      );
    }
    const defaultConfig = await resolveConfigValue("DEFAULT_PROVIDER", "legacy");
    if (
      defaultConfig.locked &&
      defaultConfig.value.trim().toLowerCase() === normalizedOld
    ) {
      throw new HttpError(
        400,
        `Provider "${normalizedOld}" is referenced by a locked DEFAULT_PROVIDER and cannot be renamed here.`,
      );
    }

    await setKvConfigValue(`PROVIDER_URL_${normalizedName.toUpperCase()}`, url);
    if (disabledConfig.source === "kv") {
      await setKvConfigValue(
        providerDisabledConfigKey(normalizedName),
        disabledConfig.value,
      );
      await deleteKvConfigValue(providerDisabledConfigKey(normalizedOld));
    }
    await deleteKvConfigValue(`PROVIDER_URL_${normalizedOld.toUpperCase()}`);

    if (defaultConfig.value.trim().toLowerCase() === normalizedOld) {
      await setKvConfigValue("DEFAULT_PROVIDER", normalizedName);
    }
    return buildSettingsLocation("provider_saved", { name: normalizedName });
  }

  if (existing && existing.source !== "kv") {
    throw new HttpError(
      400,
      `Provider "${normalizedName}" already exists (source: ${existing.source}).`,
    );
  }
  await setKvConfigValue(`PROVIDER_URL_${normalizedName.toUpperCase()}`, url);
  return buildSettingsLocation("provider_saved", { name: normalizedName });
}

async function handleStats(): Promise<Response> {
  const stats = await getProxyStats();
  return jsonEnvelope(200, true, {
    proxy: stats,
    providers: await getProviderSummaries(),
  }, "");
}

async function routeAdmin(ctx: RequestContext): Promise<Response> {
  if (ctx.request.method === "GET" && ctx.url.pathname === "/admin/login") {
    const result = await renderFrontendPage(
      "/render/login",
      buildLoginPageModel(ctx.url.origin),
    );
    return result.ok ? frontendHtmlResponse(result.html) : mapRenderFailure(result.reason);
  }
  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/login") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const form = await ctx.request.formData();
    const password = String(form.get("password") ?? "");
    if (!timingSafeEqual(password, ADMIN_PASSWORD)) {
      const result = await renderFrontendPage(
        "/render/login",
        buildLoginPageModel(ctx.url.origin, "login.incorrectPassword"),
      );
      return result.ok
        ? htmlResponse(403, result.html, PAGE_SECURITY_HEADERS)
        : mapRenderFailure(result.reason);
    }
    const adminSessionTtlSec = await envPositiveIntAsync(
      "ADMIN_SESSION_TTL_SEC",
      86_400,
    );
    const value = await signAdminSession({
      exp: nowSec() + adminSessionTtlSec,
      sid: crypto.randomUUID(),
    });
    return redirectResponse("/admin", 303, {
      "set-cookie": buildCookie(ADMIN_COOKIE_NAME, value, {
        maxAge: adminSessionTtlSec,
        sameSite: "Strict",
        secure: true,
        httpOnly: true,
      }),
      "cache-control": "no-store",
    });
  }
  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/logout") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    return redirectResponse("/admin/login", 303, {
      "set-cookie": clearAdminSessionCookie(),
      "cache-control": "no-store",
    });
  }

  const sessionState = await getAdminSessionState(ctx.request);
  if (sessionState.kind === "legacy") {
    return redirectResponse("/admin/login", 303, {
      "set-cookie": clearAdminSessionCookie(),
      "cache-control": "no-store",
    });
  }
  if (sessionState.kind !== "valid") {
    return redirectResponse("/admin/login", 303, {
      "cache-control": "no-store",
    });
  }
  const session = sessionState.session;

  if (ctx.request.method === "GET" && ctx.url.pathname === "/admin") {
    const result = await renderFrontendPage(
      "/render/dashboard",
      await buildDashboardPageModel(ctx.url.origin),
    );
    return result.ok ? frontendHtmlResponse(result.html) : mapRenderFailure(result.reason);
  }
  if (ctx.request.method === "GET" && ctx.url.pathname === "/admin/keys") {
    const model = await buildKeysPageModel(ctx.url, session);
    const result = await renderFrontendPage("/render/keys", model);
    if (!result.ok) return mapRenderFailure(result.reason);
    if (model.createdKey && model.pendingNonce) {
      await kv.delete(keyBuilders.pendingKey(session.sid, model.pendingNonce));
    }
    return frontendHtmlResponse(result.html);
  }
  if (ctx.request.method === "GET" && ctx.url.pathname === "/admin/settings") {
    const result = await renderSettingsViaFrontendProvider(ctx.url);
    return result.ok ? frontendHtmlResponse(result.html) : mapRenderFailure(result.reason);
  }
  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/keys") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    try {
      const form = await ctx.request.formData();
      const label = String(form.get("label") ?? "").trim();
      if (!label) throw new HttpError(400, "Label is required.");
      const created = await createApiKeyRecord({
        label,
        quotaTotal: parseNullableInteger(form.get("quotaTotal")),
        quotaDaily: parseNullableInteger(form.get("quotaDaily")),
        expiresAt: parseNullableDateTime(form.get("expiresAt")),
      });
      const pendingNonce = await writePendingKey(session, {
        id: created.record.id,
        rawKey: created.rawKey,
      });
      return redirectResponse(`/admin/keys?pending=${encodeURIComponent(pendingNonce)}`, 303, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const flashNonce = await writeAdminFlash(session, {
          tone: "error",
          message: error.exposeMessage,
        });
        return redirectResponse(`/admin/keys?flash=${encodeURIComponent(flashNonce)}`, 303, {
          "cache-control": "no-store",
        });
      }
      throw error;
    }
  }
  const updateMatch = ctx.url.pathname.match(
    /^\/admin\/keys\/([^/]+)\/update$/,
  );
  if (ctx.request.method === "POST" && updateMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    try {
      const keyId = decodeURIComponent(updateMatch[1]);
      const form = await ctx.request.formData();
      const statusValue = String(form.get("status") ?? "active");
      if (statusValue !== "active" && statusValue !== "disabled") {
        throw new HttpError(400, "Invalid API key status.");
      }
      const label = String(form.get("label") ?? "").trim();
      if (!label) throw new HttpError(400, "Label is required.");
      await updateApiKeyRecord(keyId, {
        label,
        status: statusValue,
        quotaTotal: parseNullableInteger(form.get("quotaTotal")),
        quotaDaily: parseNullableInteger(form.get("quotaDaily")),
        expiresAt: parseNullableDateTime(form.get("expiresAt")),
      });
      return redirectResponse("/admin/keys", 303, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const flashNonce = await writeAdminFlash(session, {
          tone: "error",
          message: error.exposeMessage,
        });
        return redirectResponse(`/admin/keys?flash=${encodeURIComponent(flashNonce)}`, 303, {
          "cache-control": "no-store",
        });
      }
      throw error;
    }
  }
  const deleteMatch = ctx.url.pathname.match(
    /^\/admin\/keys\/([^/]+)\/delete$/,
  );
  if (ctx.request.method === "POST" && deleteMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    try {
      await deleteApiKeyRecord(decodeURIComponent(deleteMatch[1]));
      return redirectResponse("/admin/keys", 303, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof HttpError) {
        const flashNonce = await writeAdminFlash(session, {
          tone: "error",
          message: error.exposeMessage,
        });
        return redirectResponse(`/admin/keys?flash=${encodeURIComponent(flashNonce)}`, 303, {
          "cache-control": "no-store",
        });
      }
      throw error;
    }
  }

  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/settings/provider") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const form = await ctx.request.formData();
    const oldNameRaw = String(form.get("oldName") ?? "").trim();
    const name = validateProviderName(String(form.get("name") ?? ""));
    const url = normalizeProviderUrl(String(form.get("url") ?? ""));
    const nextLocation = await saveProviderDefinition(
      oldNameRaw || null,
      name,
      url,
    );
    return redirectResponse(nextLocation, 303, {
      "cache-control": "no-store",
    });
  }

  const settingsDeleteMatch = ctx.url.pathname.match(
    /^\/admin\/settings\/provider\/([^/]+)\/delete$/,
  );
  if (ctx.request.method === "POST" && settingsDeleteMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const nextLocation = await deleteProviderAndAdjustDefault(
      decodeURIComponent(settingsDeleteMatch[1]),
    );
    return redirectResponse(nextLocation, 303, {
      "cache-control": "no-store",
    });
  }

  const settingsDefaultMatch = ctx.url.pathname.match(
    /^\/admin\/settings\/provider\/([^/]+)\/default$/,
  );
  if (ctx.request.method === "POST" && settingsDefaultMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const defaultConfig = await resolveConfigValue("DEFAULT_PROVIDER", "legacy");
    if (defaultConfig.locked) {
      throw new HttpError(400, "DEFAULT_PROVIDER is locked by environment variable.");
    }
    const providerName = normalizeProviderName(
      decodeURIComponent(settingsDefaultMatch[1]),
    );
    const providers = await getProviderEndpoints();
    if (!providers[providerName]) {
      throw new HttpError(
        400,
        `Cannot set default to "${providerName}" 鈥?no such provider configured.`,
      );
    }
    await setKvConfigValue("DEFAULT_PROVIDER", providerName);
    return redirectResponse(buildSettingsLocation("default_changed", { name: providerName }), 303, {
      "cache-control": "no-store",
    });
  }

  const settingsDisableMatch = ctx.url.pathname.match(
    /^\/admin\/settings\/provider\/([^/]+)\/disable$/,
  );
  if (ctx.request.method === "POST" && settingsDisableMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const nextLocation = await setProviderDisabledState(
      decodeURIComponent(settingsDisableMatch[1]),
      true,
    );
    return redirectResponse(nextLocation, 303, {
      "cache-control": "no-store",
    });
  }

  const settingsEnableMatch = ctx.url.pathname.match(
    /^\/admin\/settings\/provider\/([^/]+)\/enable$/,
  );
  if (ctx.request.method === "POST" && settingsEnableMatch) {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const nextLocation = await setProviderDisabledState(
      decodeURIComponent(settingsEnableMatch[1]),
      false,
    );
    return redirectResponse(nextLocation, 303, {
      "cache-control": "no-store",
    });
  }

  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/settings/secret") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const providerSecret = await resolveConfigValue("PROVIDER_SECRET");
    if (providerSecret.locked) {
      throw new HttpError(400, "PROVIDER_SECRET is locked by environment variable.");
    }
    const form = await ctx.request.formData();
    const intent = String(form.get("intent") ?? "save");
    if (intent === "delete") {
      await deleteKvConfigValue("PROVIDER_SECRET");
      return redirectResponse(buildSettingsLocation("secret_deleted"), 303, {
        "cache-control": "no-store",
      });
    }
    await setKvConfigValue("PROVIDER_SECRET", String(form.get("value") ?? "").trim());
    return redirectResponse(buildSettingsLocation("secret_saved"), 303, {
      "cache-control": "no-store",
    });
  }

  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/settings/advanced") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const form = await ctx.request.formData();
    const key = String(form.get("key") ?? "").trim();
    if (!["MAIL_ID_TTL_MS", "ADMIN_SESSION_TTL_SEC"].includes(key)) {
      throw new HttpError(400, "Unsupported advanced setting.");
    }
    const resolved = await resolveConfigValue(key, String((CONFIG as Record<string, unknown>)[key] ?? ""));
    if (resolved.locked) {
      throw new HttpError(400, `${key} is locked by environment variable.`);
    }
    const intent = String(form.get("intent") ?? "save");
    if (intent === "delete") {
      await deleteKvConfigValue(key);
      return redirectResponse(buildSettingsLocation("advanced_deleted", { name: key }), 303, {
        "cache-control": "no-store",
      });
    }
    const value = parsePositiveIntegerInput(String(form.get("value") ?? ""), key);
    await setKvConfigValue(key, value);
    return redirectResponse(buildSettingsLocation("advanced_saved", { name: key }), 303, {
      "cache-control": "no-store",
    });
  }

  if (ctx.request.method === "POST" && ctx.url.pathname === "/admin/settings/test-provider") {
    verifyAdminPostOrigin(ctx.request, ctx.url);
    const form = await ctx.request.formData();
    const name = normalizeProviderName(String(form.get("name") ?? ""));
    const provider = (await getResolvedProviderEntries()).find((row) => row.name === name);
    if (!provider) {
      return jsonEnvelope(404, false, null, `Provider "${name}" not found.`, {
        "cache-control": "no-store",
      });
    }
    const result = await testProviderConnection(provider.url);
    return jsonEnvelope(200, true, result, "", {
      "cache-control": "no-store",
    });
  }

  return errorPage(404, "Not Found", "The requested page was not found.");
}

async function routeApi(ctx: RequestContext): Promise<Response> {
  const auth = await authenticateApiRequest(ctx.request);
  const pathname = ctx.url.pathname;
  if (ctx.request.method === "GET" && pathname === "/api/generate-email") {
    return await handleGenerateEmail(ctx, auth);
  }
  if (ctx.request.method === "POST" && pathname === "/api/generate-email") {
    return await handleGenerateEmail(ctx, auth);
  }
  if (ctx.request.method === "GET" && pathname === "/api/emails") {
    return await handleListEmails(ctx, auth);
  }
  if (ctx.request.method === "DELETE" && pathname === "/api/emails/clear") {
    return await handleClearEmails(ctx, auth);
  }
  if (ctx.request.method === "GET" && pathname === "/api/stats") {
    return await handleStats();
  }
  const mailMatch = pathname.match(/^\/api\/email\/([^/]+)$/);
  if (mailMatch && ctx.request.method === "GET") {
    return await handleEmailDetail(ctx, auth, decodeURIComponent(mailMatch[1]));
  }
  if (mailMatch && ctx.request.method === "DELETE") {
    return await handleDeleteEmail(ctx, auth, decodeURIComponent(mailMatch[1]));
  }
  return apiError(404, "API endpoint not found.");
}

function handleError(error: unknown, ctx: RequestContext): Response {
  if (error instanceof HttpError) {
    if (ctx.url.pathname.startsWith("/api/")) {
      return apiError(error.status, error.exposeMessage);
    }
    if (ctx.request.method === "POST" && ctx.url.pathname.startsWith("/admin/settings")) {
      return redirectResponse(buildSettingsLocation("error", {
        message: error.exposeMessage,
      }), 303, {
        "cache-control": "no-store",
      });
    }
    return errorPage(error.status, "Error", error.exposeMessage);
  }
  console.error(
    JSON.stringify({
      level: "error",
      requestId: ctx.requestId,
      route: ctx.route,
      stack: error instanceof Error ? error.stack : String(error),
    }),
  );
  if (ctx.url.pathname.startsWith("/api/")) {
    return apiError(500, "Internal proxy failure.");
  }
  return errorPage(500, "Internal Error", "The proxy hit an unexpected failure.");
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname !== "/" &&
    /\/+$/.test(url.pathname)
  ) {
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    return redirectResponse(
      `${normalizedPath || "/"}${url.search}`,
      308,
    );
  }
  const ctx: RequestContext = {
    requestId: crypto.randomUUID(),
    route: `${request.method} ${url.pathname}`,
    request,
    url,
    startedAt: Date.now(),
  };
  try {
    let response: Response;
    if (request.method === "GET" && url.pathname === "/") {
      response = redirectResponse("/docs");
    } else if (request.method === "GET" && url.pathname === "/docs") {
      const result = await renderDocsViaFrontendProvider(url.origin);
      response = result.ok ? frontendHtmlResponse(result.html) : mapRenderFailure(result.reason);
    } else if (url.pathname.startsWith("/admin")) {
      response = await routeAdmin(ctx);
    } else if (url.pathname.startsWith("/api/")) {
      response = await routeApi(ctx);
    } else {
      response = errorPage(404, "Not Found", `No route matches ${url.pathname}.`);
    }
    console.log(
      JSON.stringify({
        level: "info",
        type: "request",
        requestId: ctx.requestId,
        route: ctx.route,
        status: response.status,
        durationMs: Date.now() - ctx.startedAt,
      }),
    );
    return response;
  } catch (error) {
    const response = handleError(error, ctx);
    console.error(JSON.stringify({
      level: "error",
      type: "request",
      requestId: ctx.requestId,
      route: ctx.route,
      status: response.status,
      durationMs: Date.now() - ctx.startedAt,
      error: error instanceof Error ? error.message : String(error),
    }));
    return response;
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


