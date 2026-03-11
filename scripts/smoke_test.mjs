const DEFAULT_BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8787";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "password";
const FRONTEND_PROVIDER_BASE_URL = process.env.FRONTEND_PROVIDER_BASE_URL ||
  process.env.FRONTEND_PROVIDER_URL || "";
const PROVIDER_SECRET = process.env.PROVIDER_SECRET || "";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function extractSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function mergeCookies(current, setCookies) {
  const jar = new Map();
  if (current) {
    for (const pair of current.split(/;\s*/)) {
      const [name, ...rest] = pair.split("=");
      if (name && rest.length > 0) jar.set(name, rest.join("="));
    }
  }
  for (const cookie of setCookies) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = pair.split("=");
    if (name && rest.length > 0) jar.set(name, rest.join("="));
  }
  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (request.cookieJar) headers.set("cookie", request.cookieJar);
  const response = await fetch(new URL(path, DEFAULT_BASE_URL), {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: options.redirect || "manual",
  });
  request.cookieJar = mergeCookies(
    request.cookieJar,
    extractSetCookies(response.headers),
  );
  return response;
}
request.cookieJar = "";

async function requestJson(path, options = {}) {
  const response = await request(path, options);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${path}, got: ${text.slice(0, 200)}`);
    }
  }
  return { response, json, text };
}

async function requestProviderRender(path, body) {
  if (!FRONTEND_PROVIDER_BASE_URL || !PROVIDER_SECRET) return null;
  const response = await fetch(new URL(path, FRONTEND_PROVIDER_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${PROVIDER_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, text };
}

async function testProviderRenderContracts() {
  if (!FRONTEND_PROVIDER_BASE_URL || !PROVIDER_SECRET) {
    console.log(
      "Skipping direct provider contract checks (FRONTEND_PROVIDER_BASE_URL / PROVIDER_SECRET not set).",
    );
    return;
  }
  const fixtures = [
    {
      path: "/render/login",
      body: { baseUrl: DEFAULT_BASE_URL, error: null },
    },
    {
      path: "/render/dashboard",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        stats: {
          activeApiKeys: 1,
          totalUpstreamCalls: 2,
          todayUpstreamCalls: 3,
        },
      },
    },
    {
      path: "/render/keys",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        flash: null,
        error: null,
        createdKey: null,
        keys: [],
      },
    },
    {
      path: "/render/docs",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        providers: [{ name: "legacy", isDefault: true }],
        warnings: [],
      },
    },
    {
      path: "/render/settings",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        flash: null,
        providers: [],
        defaultProvider: {
          key: "DEFAULT_PROVIDER",
          value: "legacy",
          source: "config",
          locked: false,
        },
        providerSecret: {
          key: "PROVIDER_SECRET",
          value: "******",
          source: "fallback",
          locked: false,
        },
        mailIdTtl: {
          key: "MAIL_ID_TTL_MS",
          value: "86400000",
          source: "config",
          locked: false,
        },
        adminSessionTtl: {
          key: "ADMIN_SESSION_TTL_SEC",
          value: "86400",
          source: "config",
          locked: false,
        },
        warnings: [],
      },
    },
    {
      path: "/render/docs-page",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        providers: [{ name: "legacy", isDefault: true }],
        warnings: [],
      },
    },
    {
      path: "/render/settings-page",
      body: {
        baseUrl: DEFAULT_BASE_URL,
        flash: null,
        providers: [],
        defaultProvider: {
          key: "DEFAULT_PROVIDER",
          value: "legacy",
          source: "config",
          locked: false,
        },
        providerSecret: {
          key: "PROVIDER_SECRET",
          value: "******",
          source: "fallback",
          locked: false,
        },
        mailIdTtl: {
          key: "MAIL_ID_TTL_MS",
          value: "86400000",
          source: "config",
          locked: false,
        },
        adminSessionTtl: {
          key: "ADMIN_SESSION_TTL_SEC",
          value: "86400",
          source: "config",
          locked: false,
        },
        warnings: [],
      },
    },
  ];
  for (const fixture of fixtures) {
    const result = await requestProviderRender(fixture.path, fixture.body);
    assert(result, `Missing provider result for ${fixture.path}`);
    assert(
      result.response.status === 200,
      `${fixture.path} should return 200`,
    );
    assert(
      (result.response.headers.get("content-type") || "").includes("text/html"),
      `${fixture.path} should return text/html`,
    );
    assert(result.text.trim(), `${fixture.path} should return non-empty html`);
  }
}

async function loginAdmin() {
  const loginPage = await request("/admin/login");
  assert(loginPage.status === 200, "GET /admin/login should return 200");
  const response = await request("/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: DEFAULT_BASE_URL,
    },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
  });
  assert(
    response.status === 303,
    "POST /admin/login should redirect on success",
  );
  assert(
    request.cookieJar.includes("tmpmail_admin="),
    "Admin login should set cookie",
  );
}

async function createApiKey() {
  const response = await request("/admin/keys", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: DEFAULT_BASE_URL,
    },
    body: new URLSearchParams({
      label: "smoke-test-key",
      quotaTotal: "200",
      quotaDaily: "200",
      expiresAt: "",
    }),
  });
  assert(response.status === 303, "POST /admin/keys should redirect");
  const location = response.headers.get("location") || "";
  assert(
    /^\/admin\/keys\?pending=/.test(location),
    "POST /admin/keys should redirect with pending nonce",
  );
  const revealPage = await request(location);
  const html = await revealPage.text();
  assert(revealPage.status === 200, "GET pending key page should return 200");
  const keyMatch = html.match(/id="raw-api-key">([^<]+)</);
  const idMatch = html.match(/id="created-key-id">([^<]+)</);
  assert(keyMatch, "Created key page should include raw API key");
  assert(idMatch, "Created key page should include key id");
  return { rawKey: keyMatch[1], keyId: idMatch[1] };
}

async function createApiKeyMissingLabel() {
  const response = await request("/admin/keys", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: DEFAULT_BASE_URL,
    },
    body: new URLSearchParams({
      label: "",
      quotaTotal: "10",
      quotaDaily: "10",
      expiresAt: "",
    }),
  });
  assert(
    response.status === 303,
    "Invalid key creation should redirect with flash",
  );
  const location = response.headers.get("location") || "";
  assert(
    /^\/admin\/keys\?flash=/.test(location),
    "Invalid key creation should redirect with flash nonce",
  );
  const page = await request(location);
  const html = await page.text();
  assert(page.status === 200, "GET flash page should return 200");
  assert(
    html.includes("Label is required."),
    "Flash page should include validation message",
  );
}

async function deleteApiKey(keyId) {
  const response = await request(
    `/admin/keys/${encodeURIComponent(keyId)}/delete`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: DEFAULT_BASE_URL,
      },
      body: new URLSearchParams({ confirm: "yes" }),
    },
  );
  assert(response.status === 303, `Deleting key ${keyId} should redirect`);
}

async function updateApiKey(keyId, fields) {
  const response = await request(
    `/admin/keys/${encodeURIComponent(keyId)}/update`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: DEFAULT_BASE_URL,
      },
      body: new URLSearchParams(fields),
    },
  );
  assert(response.status === 303, `Updating key ${keyId} should redirect`);
}

async function api(path, rawKey, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("authorization", `Bearer ${rawKey}`);
  return await requestJson(path, { ...options, headers });
}

async function main() {
  console.log(`Smoke testing ${DEFAULT_BASE_URL}`);

  await testProviderRenderContracts();

  const root = await request("/");
  assert(root.status === 302, "GET / should redirect");
  assert(
    root.headers.get("location") === "/docs",
    "GET / should redirect to /docs",
  );

  const docs = await request("/docs");
  const docsText = await docs.text();
  assert(docs.status === 200, "GET /docs should return 200");
  assert(
    docsText.includes('data-page="docs"'),
    "/docs should be rendered by the front-end provider",
  );
  assert(
    docsText.includes("/api/generate-email"),
    "/docs should document endpoints",
  );
  assert(
    docsText.includes("data-theme-cycle") &&
      docsText.includes("data-lang-cycle"),
    "/docs should expose theme and language controls",
  );

  await loginAdmin();

  await createApiKeyMissingLabel();

  const dashboard = await request("/admin");
  const dashboardHtml = await dashboard.text();
  assert(dashboard.status === 200, "GET /admin should return 200 after login");
  assert(
    dashboardHtml.includes('data-page="dashboard-page"'),
    "Dashboard should be rendered by the front-end provider",
  );

  const { rawKey, keyId } = await createApiKey();
  assert(
    /^sk-[0-9a-f]{32}$/.test(rawKey),
    "Raw API key should match required format",
  );
  assert(
    /^\d+$/.test(keyId),
    "API key id should use incrementing numeric text",
  );

  const keysList = await request("/admin/keys");
  const keysHtml = await keysList.text();
  assert(keysList.status === 200, "GET /admin/keys should return 200");
  assert(
    keysHtml.includes('data-page="keys-page"'),
    "Keys page should be rendered by the front-end provider",
  );
  assert(keysHtml.includes(keyId), "Key list should include key id");
  assert(
    !keysHtml.includes(rawKey),
    "Key list must not reveal raw API key again",
  );
  assert(
    keysHtml.includes("edit-key-modal") &&
      keysHtml.includes("create-key-modal") &&
      keysHtml.includes("data-delete-key"),
    "Key list should include create/edit modals and delete action",
  );
  assert(
    !keysHtml.includes("/admin/logs") && !keysHtml.includes(">Logs<"),
    "Admin UI should no longer expose logs page",
  );

  const stats = await api("/api/stats", rawKey);
  assert(stats.response.status === 200, "GET /api/stats should return 200");
  assert(
    typeof stats.json?.data?.proxy?.totalUpstreamCalls === "number",
    "Stats should expose numeric totalUpstreamCalls",
  );

  const noAuth = await requestJson("/api/stats");
  assert(
    noAuth.response.status === 401,
    "GET /api/stats without auth should return 401",
  );

  const generated1 = await api("/api/generate-email", rawKey);
  assert(
    generated1.response.status === 200,
    "GET /api/generate-email should return 200",
  );
  const email1 = generated1.json?.data?.email;
  assert(
    typeof email1 === "string" && email1.includes("@"),
    "Generated email should be returned",
  );

  const inbox = await api(
    `/api/emails?email=${encodeURIComponent(email1)}`,
    rawKey,
  );
  assert(inbox.response.status === 200, "GET /api/emails should return 200");
  assert(
    typeof inbox.json?.data?.count === "number",
    "Inbox response should include count",
  );
  assert(
    Array.isArray(inbox.json?.data?.emails),
    "Inbox response should include emails array",
  );

  const clear = await api(
    `/api/emails/clear?email=${encodeURIComponent(email1)}`,
    rawKey,
    { method: "DELETE" },
  );
  assert(
    clear.response.status === 200,
    "DELETE /api/emails/clear should return 200",
  );

  const prefix = `smoke${Date.now().toString().slice(-6)}`;
  const generated2 = await api("/api/generate-email", rawKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix, domain: "invalid-domain-smoke" }),
  });
  assert(
    generated2.response.status === 200,
    "POST /api/generate-email should return 200",
  );
  const email2 = generated2.json?.data?.email;
  assert(
    typeof email2 === "string" && email2.startsWith(`${prefix}@`),
    "POST /api/generate-email should honor prefix and return actual email",
  );

  const invalidProvider = await api(
    `/api/emails?email=${encodeURIComponent(email2)}&provider=duckmail`,
    rawKey,
  );
  assert(
    invalidProvider.response.status === 400,
    "Unsupported provider should return 400",
  );

  const unresolvedDetail = await api(
    `/api/email/smoke-missing-${Date.now()}`,
    rawKey,
  );
  assert(
    unresolvedDetail.response.status === 404,
    "GET /api/email/:id without mapping or email should fail clearly",
  );

  await updateApiKey(keyId, {
    label: "smoke-test-key-disabled",
    status: "disabled",
    quotaTotal: "200",
    quotaDaily: "200",
    expiresAt: "",
  });

  const disabled = await api("/api/stats", rawKey);
  assert(
    disabled.response.status === 403,
    "Disabled API key should return 403",
  );

  await updateApiKey(keyId, {
    label: "smoke-test-key-active",
    status: "active",
    quotaTotal: "200",
    quotaDaily: "200",
    expiresAt: "",
  });

  await deleteApiKey(keyId);

  const deleted = await api("/api/stats", rawKey);
  assert(
    deleted.response.status === 401,
    "Deleted API key should become invalid",
  );

  const logout = await request("/admin/logout", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: DEFAULT_BASE_URL,
    },
    body: new URLSearchParams({}),
  });
  assert(logout.status === 303, "POST /admin/logout should redirect");

  const postLogoutAdmin = await request("/admin");
  assert(
    postLogoutAdmin.status === 303,
    "GET /admin after logout should redirect",
  );

  const wrongLogin = await request("/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: DEFAULT_BASE_URL,
    },
    body: new URLSearchParams({ password: "wrong-password" }),
  });
  const wrongLoginHtml = await wrongLogin.text();
  assert(
    wrongLogin.status === 403,
    "POST /admin/login with wrong password should return 403",
  );
  assert(
    wrongLoginHtml.includes("Incorrect password."),
    "Wrong login page should include incorrect password message",
  );

  console.log("Smoke tests passed.");
  if (
    Array.isArray(inbox.json?.data?.emails) &&
    inbox.json.data.emails.length === 0
  ) {
    console.log(
      "Note: positive detail/delete mail-id path was skipped because the generated inbox was empty.",
    );
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error.message);
  process.exit(1);
});
