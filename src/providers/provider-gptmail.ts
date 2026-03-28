type JsonRecord = Record<string, unknown>;

type UpstreamEnvelope = {
  success?: boolean;
  data?: unknown;
  error?: unknown;
  usage?: unknown;
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
  UPSTREAM_BASE_URL: "https://mail.chatgpt.org.uk",
  GPTMAIL_API_KEY: "gpt-test",
} as const;

function env(key: string, fallback?: string): string {
  return Deno.env.get(key) ??
    (CONFIG as Record<string, unknown>)[key]?.toString() ?? fallback ?? "";
}

const PROVIDER_SECRET = env("PROVIDER_SECRET");
const UPSTREAM_BASE_URL = env(
  "UPSTREAM_BASE_URL",
  "https://mail.chatgpt.org.uk",
).replace(/\/$/, "");
const GPTMAIL_API_KEY = env("GPTMAIL_API_KEY", "gpt-test");

if (!PROVIDER_SECRET) {
  throw new Error("Missing required configuration: PROVIDER_SECRET");
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

function normalizeError(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function buildApiHeaders(withJsonBody = false): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("X-API-Key", GPTMAIL_API_KEY);
  if (withJsonBody) headers.set("Content-Type", "application/json");
  return headers;
}

async function callUpstreamJson(
  ctx: ProviderRequestContext,
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: JsonRecord,
): Promise<UpstreamEnvelope> {
  const url = new URL(path, UPSTREAM_BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await countedFetch(ctx, url.toString(), {
    method,
    headers: buildApiHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json: UpstreamEnvelope;
  try {
    json = await response.json() as UpstreamEnvelope;
  } catch {
    throw new ProviderError(502, "gptmail upstream returned invalid JSON.");
  }

  if (!response.ok) {
    throw new ProviderError(
      response.status,
      normalizeError(json.error, `gptmail upstream returned ${response.status}.`),
    );
  }
  if (json.success === false) {
    throw new ProviderError(
      response.status >= 400 ? response.status : 502,
      normalizeError(json.error, "gptmail upstream request failed."),
    );
  }
  return json;
}

async function handleGenerateEmail(
  ctx: ProviderRequestContext,
  body: JsonRecord,
): Promise<Response> {
  const payload: JsonRecord = {};
  if (typeof body.prefix === "string" && body.prefix.trim()) {
    payload.prefix = body.prefix.trim();
  }
  if (typeof body.domain === "string" && body.domain.trim()) {
    payload.domain = body.domain.trim();
  }
  const result = await callUpstreamJson(
    ctx,
    "POST",
    "/api/generate-email",
    undefined,
    payload,
  );
  return providerResponse(ctx, 200, true, result.data ?? null, "");
}

async function handleListEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const result = await callUpstreamJson(
    ctx,
    "GET",
    "/api/emails",
    { email },
  );
  return providerResponse(ctx, 200, true, result.data ?? { emails: [], count: 0 }, "");
}

async function handleEmailDetail(
  ctx: ProviderRequestContext,
  mailId: string,
): Promise<Response> {
  const result = await callUpstreamJson(
    ctx,
    "GET",
    `/api/email/${encodeURIComponent(mailId)}`,
  );
  return providerResponse(ctx, 200, true, result.data ?? null, "");
}

async function handleDeleteEmail(
  ctx: ProviderRequestContext,
  mailId: string,
): Promise<Response> {
  const result = await callUpstreamJson(
    ctx,
    "DELETE",
    `/api/email/${encodeURIComponent(mailId)}`,
  );
  return providerResponse(ctx, 200, true, result.data ?? { message: "Email deleted" }, "");
}

async function handleClearEmails(
  ctx: ProviderRequestContext,
  email: string,
): Promise<Response> {
  const result = await callUpstreamJson(
    ctx,
    "DELETE",
    "/api/emails/clear",
    { email },
  );
  return providerResponse(ctx, 200, true, result.data ?? { message: "Cleared emails" }, "");
}

async function handleStats(
  ctx: ProviderRequestContext,
): Promise<Response> {
  const result = await callUpstreamJson(ctx, "GET", "/api/stats");
  return providerResponse(ctx, 200, true, result.data ?? null, "");
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

    if (
      (request.method === "POST" || request.method === "GET") &&
      url.pathname === "/generate-email"
    ) {
      const body = request.method === "POST"
        ? await request.json().catch(() => ({})) as JsonRecord
        : Object.fromEntries(url.searchParams.entries()) as JsonRecord;
      return await handleGenerateEmail(ctx, body);
    }
    if (request.method === "GET" && url.pathname === "/emails") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleListEmails(ctx, email);
    }
    if (mailMatch && request.method === "GET") {
      return await handleEmailDetail(ctx, decodeURIComponent(mailMatch[1]));
    }
    if (mailMatch && request.method === "DELETE") {
      return await handleDeleteEmail(ctx, decodeURIComponent(mailMatch[1]));
    }
    if (request.method === "DELETE" && url.pathname === "/emails/clear") {
      const email = url.searchParams.get("email");
      if (!email) return providerResponse(ctx, 400, false, null, "email is required.");
      return await handleClearEmails(ctx, email);
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return await handleStats(ctx);
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
