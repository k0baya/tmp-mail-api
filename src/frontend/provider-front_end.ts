const CONFIG = {
  PROVIDER_SECRET: "",
} as const;

type FlashTone = "success" | "error" | "warn";

type UiFlash = {
  tone: FlashTone;
  key?: string;
  message?: string;
  params?: Record<string, string>;
} | null;

type ResolvedConfigValue = {
  key: string;
  value: string;
  source: string;
  locked: boolean;
};

type SettingsProviderEntry = {
  name: string;
  url: string;
  source: string;
  locked: boolean;
  disabled: boolean;
  disabledSource: string;
  disableLocked: boolean;
  isDefault: boolean;
};

type LoginPageModel = {
  baseUrl: string;
  error: string | null;
};

type DashboardPageModel = {
  baseUrl: string;
  stats: {
    activeApiKeys: number;
    totalUpstreamCalls: number;
    todayUpstreamCalls: number;
  };
};

type KeysPageModel = {
  baseUrl: string;
  flash: UiFlash;
  error: string | null;
  createdKey: { id: string; rawKey: string } | null;
  keys: Array<{
    id: string;
    label: string;
    status: "active" | "disabled" | "expired";
    quotaTotal: number | null;
    quotaDaily: number | null;
    usageTotal: number;
    usageDaily: number;
    expiresAt: number | null;
  }>;
};

type DocsPageModel = {
  baseUrl: string;
  providers: Array<{ name: string; isDefault: boolean }>;
  warnings: string[];
};

type SettingsPageModel = {
  baseUrl: string;
  flash: UiFlash;
  providers: SettingsProviderEntry[];
  defaultProvider: ResolvedConfigValue;
  providerSecret: ResolvedConfigValue;
  mailIdTtl: ResolvedConfigValue;
  adminSessionTtl: ResolvedConfigValue;
  warnings: string[];
};

function env(key: keyof typeof CONFIG, fallback = ""): string {
  return Deno.env.get(key) ?? CONFIG[key]?.toString() ?? fallback;
}

const PROVIDER_SECRET = env("PROVIDER_SECRET");

function authenticateGateway(request: Request): void {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  if (!PROVIDER_SECRET || token !== PROVIDER_SECRET) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJsonAttr(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

const uiDictionary = {
  en: {
    global: {
      brand: "Temporary Mail API",
      subtitle: "Gateway control plane for disposable mail workflows",
      language: "Language",
      theme: "Theme",
      skipToContent: "Skip to main content",
      consoleEyebrow: "Control plane",
      docsEyebrow: "Reference",
      adminEyebrow: "Operations",
    },
    theme: {
      auto: "Auto",
      system: "System",
      light: "Light",
      dark: "Dark",
    },
    lang: {
      auto: "Auto",
      zh: "中文",
      en: "EN",
    },
    cycle: {
      themeSystem: "System",
      themeLight: "Light",
      themeDark: "Dark",
      langAuto: "Auto",
      langZh: "中文",
      langEn: "EN",
    },
    nav: {
      dashboard: "Dashboard",
      keys: "API Keys",
      settings: "Settings",
      docs: "Docs",
      logout: "Logout",
    },
    common: {
      save: "Save",
      cancel: "Cancel",
      create: "Create",
      edit: "Edit",
      delete: "Delete",
      copy: "Copy",
      copied: "Copied",
      actions: "Actions",
      never: "Never",
      notFound: "Not found",
      close: "Close",
      readOnly: "Read only",
      enable: "Enable",
      disable: "Disable",
      testing: "Testing...",
      menu: "Menu",
      current: "Current",
      viewDocs: "Open docs",
      required: "Required",
      source: "Source",
      status: "Status",
      openMenu: "Open menu",
      closeMenu: "Close menu",
    },
    login: {
      title: "Temporary Mail API Admin",
      subtitle:
        "A focused operator surface for keys, providers, and runtime controls.",
      loginTitle: "Sign in",
      password: "Password",
      submit: "Sign in",
      incorrectPassword: "Incorrect password.",
      helper:
        "One control plane for the gateway, provider routing, and API keys.",
    },
    dashboard: {
      title: "Dashboard",
      subtitle: "Gateway status and common admin actions.",
      activeApiKeys: "Active API keys",
      totalUpstreamCalls: "Total upstream calls",
      todayUpstreamCalls: "Today's upstream calls (UTC)",
      metricsTitle: "Gateway metrics",
      metricsSubtitle: "Counters that matter for key usage and upstream load.",
      quickActionsTitle: "Quick actions",
      quickActionsSubtitle: "Jump straight to the pages used most often.",
      goKeys: "Manage keys",
      goSettings: "Open settings",
      readDocs: "Read docs",
      keyMeta: "Keys currently allowed to call upstream providers.",
      totalMeta: "Total provider requests recorded by the gateway.",
      todayMeta: "Provider requests counted since today's UTC rollover.",
    },
    keys: {
      title: "API Keys",
      subtitle: "Key hashes persist. Raw keys do not.",
      createTitle: "Create key",
      createHint:
        "Create quota-scoped keys for automation workflows. Zero means unlimited.",
      createOpen: "Create key",
      existingTitle: "Issued keys",
      existingSubtitle: "",
      createdTitle: "New API key",
      createdHint: "Copy it now. This reveal is intentionally one-time.",
      id: "ID",
      keyId: "Key ID",
      label: "Label",
      status: "Status",
      totalQuota: "Total quota / used",
      dailyQuota: "Daily quota / used",
      totalQuotaInput: "Total quota",
      dailyQuotaInput: "Daily quota",
      expires: "Expires",
      rawKey: "Raw API key",
      noKeys: "No keys yet.",
      quotaTotalPlaceholder: "Leave blank or 0 for unlimited",
      quotaDailyPlaceholder: "Leave blank or 0 for unlimited",
      expiresPlaceholder: "Expiry time",
      quotaHint: "Leave blank or 0 for unlimited.",
      expiresHint: "Leave empty for no expiry.",
      createButton: "Create key",
      editButton: "Edit",
      deleteButton: "Delete",
      editTitle: "Edit API key",
      editSubtitle:
        "Adjust label, state, quota, and expiry without reissuing the secret.",
      deleteConfirm:
        "Delete API key #{id} ({label})? This cannot be undone.",
      revealTitle: "Issued secret",
      formLabelHint: "Human-readable owner or use case.",
      mobileActions: "Actions",
      flash: {
        created: "API key created successfully.",
      },
    },
    status: {
      active: "active",
      disabled: "disabled",
      expired: "expired",
    },
    docs: {
      title: "API Documentation",
      subtitle:
        "Public gateway endpoints for mailbox generation, polling, cleanup, and stats.",
      overview: "Overview",
      auth: "Auth",
      introTitle: "Use cases and basics",
      introSummary: "Use the API to generate temporary inboxes, poll messages, read a specific mail, and clean up after verification flows.",
      introAuth: "All endpoints use Authorization: Bearer <api-key>.",
      introRouting: "Pass provider when you need deterministic routing across multiple upstream providers.",
      generateGet: "GET Generate",
      generatePost: "POST Generate",
      list: "List",
      fields: "Fields",
      detail: "Detail",
      delete: "Delete",
      clear: "Clear",
      stats: "Stats",
      statsFields: "Stats Fields",
      examples: "Examples",
      tips: "Practical Tips",
      providers: "Providers",
      defaultValue: "Default",
      noProviders: "No enabled providers configured.",
      baseUrl: "Base URL",
      contact: "Use provider and email hints for deterministic routing.",
      authMeta: "Bearer token",
      stepCreateKey: "Create an API key in the admin panel.",
      stepGenerate: "Call GET /api/generate-email.",
      stepPoll: "Poll GET /api/emails?email=... for OTP mail.",
      authHeader: "Authorization header",
      commonEnvelope: "Common envelope",
      generateMailboxTitle: "Generate mailbox",
      generatePayloadTitle: "Generate mailbox with payload",
      listMailboxTitle: "List mailbox",
      deleteMailTitle: "Delete one mail",
      clearMailboxTitle: "Clear mailbox",
      readStatsTitle: "Read stats",
      statsEnvelopeTitle: "Stats envelope",
      detailMailboxTitle: "Get one mail",
      responseExampleTitle: "Response example",
      javascriptLabel: "JavaScript",
      pythonLabel: "Python",
      requestFormat: "Request format",
      responseFormat: "Response format",
      encodingLabel: "Encoding",
      providerLabel: "Provider",
      providerHint: "Available providers: {providers}. Pass ?provider=<name> or provider in JSON.",
      errorNote: "Use both HTTP status and the common response envelope to handle failures.",
      field: "Field",
      type: "Type",
      requiredLabel: "Required",
      description: "Description",
      yes: "Yes",
      no: "No",
      prefixDesc: "Mailbox prefix.",
      domainDesc: "Requested domain.",
      providerDesc: "Explicit provider name.",
      mailId: "Mail identifier.",
      emailAddress: "Mailbox address.",
      fromAddress: "Sender address.",
      subjectDesc: "Subject line.",
      contentDesc: "Plain-text body.",
      htmlContentDesc: "Rendered HTML body.",
      detailNote: "Providing email improves lookup reliability.",
      statsTotalCalls: "Total upstream calls recorded by the gateway.",
      statsTodayCalls: "Today's upstream calls in UTC.",
      statsActiveKeys: "Currently active API key count.",
      statsProvidersDesc: "List of configured and enabled providers.",
      tipPoll: "Poll every 2-5 seconds for OTP workflows.",
      tipListFirst: "List the mailbox first to build the mail-id mapping.",
      tipPreferHtml: "Prefer html_content when rendered email fidelity matters.",
      tipPassEmail: "Pass email explicitly for detail and delete operations.",
    },
    settings: {
      title: "Settings",
      subtitle: "Manage providers, shared secret, and runtime values.",
      providerTitle: "Provider routing",
      providerSubtitle: "Provider addresses and routing switches.",
      securityTitle: "Shared secret",
      securitySubtitle:
        "This token must match every mail provider deployment.",
      advancedTitle: "Runtime values",
      advancedSubtitle: "Low-frequency values that affect expiry and session duration.",
      addProvider: "Add provider",
      providerName: "Provider name",
      providerUrl: "Provider URL",
      source: "Source",
      current: "Current value",
      defaultValue: "Default",
      saveProvider: "Save provider",
      createProvider: "Add provider",
      saveSecret: "Save secret",
      saveAdvanced: "Save advanced settings",
      setDefault: "Set default",
      testConnection: "Test connection",
      reveal: "Reveal",
      hide: "Hide",
      hiddenSecret: "Hidden",
      providerSecret: "Provider secret",
      noProviders: "No providers configured.",
      locked: "Locked",
      deleteProvider: "Delete provider",
      defaultFlag: "default",
      status: "Status",
      latency: "Latency",
      unreachable: "Connection failed.",
      actions: "Actions",
      enabled: "Enabled",
      disabled: "Disabled",
      currentValue: "Current",
      readOnlyMeta: "This value is inherited and cannot be edited here.",
      secretHint: "Current value is loaded into the field. Use Reveal to inspect it.",
      mailIdTtlHint: "How long a mail-id to email mapping is retained, in milliseconds.",
      adminSessionTtlHint: "How long the admin session remains valid, in seconds.",
      testIdle: "No test run yet.",
      statusDefault: "Default route",
      flash: {
        provider_saved: 'Provider "{name}" saved.',
        provider_deleted: 'Provider "{name}" deleted.',
        provider_enabled: 'Provider "{name}" enabled.',
        provider_disabled: 'Provider "{name}" disabled.',
        default_changed: 'Default provider changed to "{name}".',
        secret_saved: "Provider secret saved.",
        secret_deleted: "Provider secret deleted.",
        advanced_saved: "{name} saved.",
        advanced_deleted: "{name} deleted from KV.",
      },
    },
  },
  zh: {
    global: {
      brand: "Temporary Mail API",
      subtitle: "临时邮箱网关的控制台与文档入口",
      language: "语言",
      theme: "主题",
      skipToContent: "跳转到主内容",
      consoleEyebrow: "控制台",
      docsEyebrow: "文档",
      adminEyebrow: "运维",
    },
    theme: {
      auto: "自动",
      system: "跟随系统",
      light: "浅色",
      dark: "深色",
    },
    lang: {
      auto: "自动",
      zh: "中文",
      en: "EN",
    },
    cycle: {
      themeSystem: "跟随系统",
      themeLight: "浅色",
      themeDark: "深色",
      langAuto: "自动",
      langZh: "中文",
      langEn: "EN",
    },
    nav: {
      dashboard: "仪表盘",
      keys: "API 密钥",
      settings: "设置",
      docs: "文档",
      logout: "退出登录",
    },
    common: {
      save: "保存",
      cancel: "取消",
      create: "创建",
      edit: "编辑",
      delete: "删除",
      copy: "复制",
      copied: "已复制",
      actions: "操作",
      never: "永不",
      notFound: "未找到",
      close: "关闭",
      readOnly: "只读",
      enable: "启用",
      disable: "禁用",
      testing: "测试中...",
      menu: "菜单",
      current: "当前",
      viewDocs: "打开文档",
      required: "必填",
      source: "来源",
      status: "状态",
      openMenu: "打开菜单",
      closeMenu: "关闭菜单",
    },
    login: {
      title: "Temporary Mail API 管理台",
      subtitle: "聚焦 API 密钥、Provider 路由与运行时配置的运维界面。",
      loginTitle: "登录",
      password: "密码",
      submit: "登录",
      incorrectPassword: "密码错误。",
      helper: "统一管理网关、Provider 路由与 API 密钥。",
    },
    dashboard: {
      title: "仪表盘",
      subtitle: "查看网关状态并直接进入常用管理页面。",
      activeApiKeys: "启用中的 API 密钥",
      totalUpstreamCalls: "累计上游调用",
      todayUpstreamCalls: "今日上游调用（UTC）",
      metricsTitle: "网关指标",
      metricsSubtitle: "只保留和密钥使用、上游负载直接相关的计数。",
      quickActionsTitle: "快捷入口",
      quickActionsSubtitle: "直接进入最常用的页面。",
      goKeys: "管理密钥",
      goSettings: "打开设置",
      readDocs: "查看文档",
      keyMeta: "当前仍可调用上游 Provider 的密钥数量。",
      totalMeta: "网关累计记录的 Provider 请求总数。",
      todayMeta: "按 UTC 自今日零点起累计的 Provider 请求数。",
    },
    keys: {
      title: "API 密钥",
      subtitle: "系统只保存 key hash，不会重复展示原始密钥。",
      createTitle: "创建密钥",
      createHint: "为自动化流程创建配额受控的密钥。填写 0 表示不限制。",
      createOpen: "创建密钥",
      existingTitle: "已签发密钥",
      existingSubtitle: "",
      createdTitle: "新密钥",
      createdHint: "现在立即复制。这个明文展示只会出现一次。",
      id: "ID",
      keyId: "Key ID",
      label: "标签",
      status: "状态",
      totalQuota: "总配额 / 已用",
      dailyQuota: "日配额 / 已用",
      totalQuotaInput: "总配额",
      dailyQuotaInput: "日配额",
      expires: "过期时间",
      rawKey: "原始密钥",
      noKeys: "还没有任何密钥。",
      quotaTotalPlaceholder: "留空或填 0 表示不限制",
      quotaDailyPlaceholder: "留空或填 0 表示不限制",
      expiresPlaceholder: "过期时间",
      quotaHint: "留空或填 0 表示不限制。",
      expiresHint: "留空则永不过期。",
      createButton: "创建密钥",
      editButton: "编辑",
      deleteButton: "删除",
      editTitle: "编辑 API 密钥",
      editSubtitle: "无需重新签发即可调整标签、状态、配额和过期时间。",
      deleteConfirm: "确定删除 API 密钥 #{id}（{label}）吗？该操作不可撤销。",
      revealTitle: "本次签发的密钥",
      formLabelHint: "建议填写使用场景或负责人名称。",
      mobileActions: "操作",
      flash: {
        created: "API 密钥创建成功。",
      },
    },
    status: {
      active: "active",
      disabled: "disabled",
      expired: "expired",
    },
    docs: {
      title: "API 文档",
      subtitle: "公开网关接口：生成邮箱、拉取邮件、清理邮箱与统计。",
      overview: "概览",
      auth: "鉴权",
      introTitle: "使用场景与基本信息",
      introSummary: "适用于注册、验证码、一次性通知等临时收件场景。支持生成邮箱、轮询列表、读取单封邮件和清理邮箱。",
      introAuth: "所有接口都使用 Authorization: Bearer <api-key>。",
      introRouting: "需要固定路由时，请显式传入 provider。",
      generateGet: "GET 生成邮箱",
      generatePost: "POST 生成邮箱",
      list: "收件列表",
      fields: "字段说明",
      detail: "邮件详情",
      delete: "删除邮件",
      clear: "清空邮箱",
      stats: "统计接口",
      statsFields: "统计字段",
      examples: "示例",
      tips: "实用建议",
      providers: "Provider 列表",
      defaultValue: "默认",
      noProviders: "当前没有已启用的 Provider。",
      baseUrl: "基础地址",
      contact: "需要稳定路由时，请显式传 provider 和 email。",
      authMeta: "Bearer Token",
      stepCreateKey: "先在管理页创建 API 密钥。",
      stepGenerate: "调用 GET /api/generate-email 生成邮箱。",
      stepPoll: "使用 GET /api/emails?email=... 轮询 OTP 邮件。",
      authHeader: "Authorization 请求头",
      commonEnvelope: "通用响应结构",
      generateMailboxTitle: "生成邮箱请求",
      generatePayloadTitle: "带请求体的生成邮箱请求",
      listMailboxTitle: "查询收件列表",
      deleteMailTitle: "删除单封邮件",
      clearMailboxTitle: "清空邮箱",
      readStatsTitle: "查询统计",
      statsEnvelopeTitle: "统计响应结构",
      detailMailboxTitle: "读取单封邮件",
      responseExampleTitle: "响应示例",
      javascriptLabel: "JavaScript",
      pythonLabel: "Python",
      requestFormat: "请求格式",
      responseFormat: "响应格式",
      encodingLabel: "编码",
      providerLabel: "Provider",
      providerHint: "可用 Provider：{providers}。可通过 ?provider=<name> 或 JSON 内 provider 指定。",
      errorNote: "处理失败时，同时检查 HTTP 状态码和统一响应结构。",
      field: "字段",
      type: "类型",
      requiredLabel: "必填",
      description: "说明",
      yes: "是",
      no: "否",
      prefixDesc: "邮箱前缀。",
      domainDesc: "指定域名。",
      providerDesc: "显式指定 Provider 名称。",
      mailId: "邮件标识。",
      emailAddress: "邮箱地址。",
      fromAddress: "发件人地址。",
      subjectDesc: "主题。",
      contentDesc: "纯文本正文。",
      htmlContentDesc: "渲染后的 HTML 正文。",
      detailNote: "传入 email 可以提高查找可靠性。",
      statsTotalCalls: "网关记录的累计上游调用次数。",
      statsTodayCalls: "按 UTC 统计的今日上游调用次数。",
      statsActiveKeys: "当前处于启用状态的 API 密钥数量。",
      statsProvidersDesc: "已配置且启用的 Provider 列表。",
      tipPoll: "OTP 场景建议每 2 到 5 秒轮询一次。",
      tipListFirst: "先获取收件列表，再建立 mail-id 映射。",
      tipPreferHtml: "需要还原邮件样式时，优先使用 html_content。",
      tipPassEmail: "查看详情和删除邮件时，建议显式传入 email。",
    },
    settings: {
      title: "设置",
      subtitle: "集中管理 Provider、共享密钥和运行时参数。",
      providerTitle: "Provider 路由",
      providerSubtitle: "在这里维护 Provider 地址与启停状态。",
      securityTitle: "共享密钥",
      securitySubtitle: "该值必须与所有邮件 Provider 部署保持一致。",
      advancedTitle: "运行时参数",
      advancedSubtitle: "低频配置，影响邮件保留和管理员会话时长。",
      addProvider: "添加 Provider",
      providerName: "Provider 名称",
      providerUrl: "Provider 地址",
      source: "来源",
      current: "当前值",
      defaultValue: "默认值",
      saveProvider: "保存 Provider",
      createProvider: "添加 Provider",
      saveSecret: "保存密钥",
      saveAdvanced: "保存高级设置",
      setDefault: "设为默认",
      testConnection: "测试连接",
      reveal: "显示",
      hide: "隐藏",
      hiddenSecret: "已隐藏",
      providerSecret: "Provider 密钥",
      noProviders: "当前没有任何 Provider。",
      locked: "锁定",
      deleteProvider: "删除 Provider",
      defaultFlag: "默认",
      status: "状态",
      latency: "延迟",
      unreachable: "连接失败。",
      actions: "操作",
      enabled: "已启用",
      disabled: "已禁用",
      currentValue: "当前",
      readOnlyMeta: "该值来自上层配置，不能在这里修改。",
      secretHint: "当前值已载入输入框，点击显示即可查看。",
      mailIdTtlHint: "mail-id 到邮箱映射的保留时长，单位毫秒。",
      adminSessionTtlHint: "管理员会话有效期，单位秒。",
      testIdle: "尚未执行测试。",
      statusDefault: "默认路由",
      flash: {
        provider_saved: 'Provider “{name}” 已保存。',
        provider_deleted: 'Provider “{name}” 已删除。',
        provider_enabled: 'Provider “{name}” 已启用。',
        provider_disabled: 'Provider “{name}” 已禁用。',
        default_changed: '默认 Provider 已切换为 “{name}”。',
        secret_saved: "Provider 密钥已保存。",
        secret_deleted: "Provider 密钥已删除。",
        advanced_saved: "{name} 已保存。",
        advanced_deleted: "{name} 已从 KV 删除。",
      },
    },
  },
} as const;

const icons = {
  dashboard:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  key:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m21 15-3.5 3.5-2-2L13 19l-2-2"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.93 4.93 2.12 2.12"/><path d="m16.95 16.95 2.12 2.12"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="m4.93 19.07 2.12-2.12"/><path d="m16.95 7.05 2.12-2.12"/><circle cx="12" cy="12" r="4"/></svg>',
  docs:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16l4-2 4 2 4-2 4 2V8Z"/><path d="M14 2v6h6"/></svg>',
  logout:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  external:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12"/><path d="m6 6 12 12"/></svg>',
  menu:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>',
  lock:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  eye:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  monitor:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>',
  sun:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.93 4.93 2.12 2.12"/><path d="m16.95 16.95 2.12 2.12"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.93 19.07 2.12-2.12"/><path d="m16.95 7.05 2.12-2.12"/></svg>',
  moon:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3c-.07.32-.11.65-.11 1a8 8 0 0 0 9 8c.35 0 .69-.04 1-.11Z"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 4 9 14 14 0 0 1-4 9 14 14 0 0 1-4-9 14 14 0 0 1 4-9"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>',
  zap:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>',
  spark:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4"/><path d="M12 17v4"/><path d="m5.6 5.6 2.8 2.8"/><path d="m15.6 15.6 2.8 2.8"/><path d="M3 12h4"/><path d="M17 12h4"/><path d="m5.6 18.4 2.8-2.8"/><path d="m15.6 8.4 2.8-2.8"/></svg>',
  save:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3"/><path d="M9 21v-7h6v7"/></svg>',
} as const;

function readDictionary(
  locale: keyof typeof uiDictionary,
  key: string,
): string | undefined {
  let current: unknown = uiDictionary[locale];
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(
  template: string,
  params: Record<string, string> = {},
): string {
  let next = template;
  for (const [key, value] of Object.entries(params)) {
    next = next.replaceAll(`{${key}}`, value).replaceAll(`#{${key}}`, value);
  }
  return next;
}

function translateServer(
  key: string,
  params: Record<string, string> = {},
  locale: keyof typeof uiDictionary = "en",
): string {
  const template = readDictionary(locale, key) ?? key;
  return interpolate(template, params);
}

function icon(name: keyof typeof icons, className = ""): string {
  return `<span class="icon ${escapeHtml(className)}" aria-hidden="true">${icons[name]}</span>`;
}

function normalizeLoginModel(raw: Record<string, unknown>): LoginPageModel {
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    error: typeof raw.error === "string" && raw.error ? raw.error : null,
  };
}

function normalizeDashboardModel(
  raw: Record<string, unknown>,
): DashboardPageModel {
  const stats = raw.stats && typeof raw.stats === "object"
    ? raw.stats as Record<string, unknown>
    : {};
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    stats: {
      activeApiKeys: Number(stats.activeApiKeys ?? 0) || 0,
      totalUpstreamCalls: Number(stats.totalUpstreamCalls ?? 0) || 0,
      todayUpstreamCalls: Number(stats.todayUpstreamCalls ?? 0) || 0,
    },
  };
}

function normalizeFlash(raw: unknown): UiFlash {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const tone = entry.tone === "success" || entry.tone === "error" ||
      entry.tone === "warn"
    ? entry.tone
    : "success";
  const params = entry.params && typeof entry.params === "object"
    ? Object.fromEntries(
      Object.entries(entry.params as Record<string, unknown>).map((
        [key, value],
      ) => [key, String(value ?? "")]),
    )
    : undefined;
  const key = typeof entry.key === "string" && entry.key ? entry.key : undefined;
  const message = typeof entry.message === "string" && entry.message
    ? entry.message
    : undefined;
  if (!key && !message) return null;
  return { tone, key, message, params };
}

function normalizeKeysModel(raw: Record<string, unknown>): KeysPageModel {
  const keys = Array.isArray(raw.keys) ? raw.keys : [];
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    flash: normalizeFlash(raw.flash),
    error: typeof raw.error === "string" && raw.error ? raw.error : null,
    createdKey: raw.createdKey && typeof raw.createdKey === "object"
      ? {
        id: String((raw.createdKey as Record<string, unknown>).id ?? ""),
        rawKey: String((raw.createdKey as Record<string, unknown>).rawKey ?? ""),
      }
      : null,
    keys: keys.map((entry) => {
      const record = entry as Record<string, unknown>;
      return {
        id: String(record.id ?? ""),
        label: String(record.label ?? ""),
        status: record.status === "disabled" || record.status === "expired"
          ? record.status
          : "active",
        quotaTotal: typeof record.quotaTotal === "number"
          ? record.quotaTotal
          : null,
        quotaDaily: typeof record.quotaDaily === "number"
          ? record.quotaDaily
          : null,
        usageTotal: Number(record.usageTotal ?? 0) || 0,
        usageDaily: Number(record.usageDaily ?? 0) || 0,
        expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
      };
    }),
  };
}

function normalizeDocsModel(raw: Record<string, unknown>): DocsPageModel {
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    providers: Array.isArray(raw.providers)
      ? raw.providers.map((provider) => {
        const record = provider as Record<string, unknown>;
        return {
          name: String(record.name ?? ""),
          isDefault: Boolean(record.isDefault),
        };
      })
      : [],
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map((warning) => String(warning))
      : [],
  };
}

function normalizeResolvedConfigValue(
  raw: unknown,
  fallbackKey: string,
  fallbackValue = "",
): ResolvedConfigValue {
  const entry = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  return {
    key: typeof entry.key === "string" && entry.key ? entry.key : fallbackKey,
    value: typeof entry.value === "string" ? entry.value : fallbackValue,
    source: typeof entry.source === "string" && entry.source
      ? entry.source
      : "fallback",
    locked: Boolean(entry.locked),
  };
}

function normalizeSettingsModel(
  raw: Record<string, unknown>,
): SettingsPageModel {
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    flash: normalizeFlash(raw.flash),
    providers: providers.map((provider) => {
      const entry = provider as Record<string, unknown>;
      return {
        name: String(entry.name ?? ""),
        url: String(entry.url ?? ""),
        source: String(entry.source ?? "fallback"),
        locked: Boolean(entry.locked),
        disabled: Boolean(entry.disabled),
        disabledSource: String(entry.disabledSource ?? "fallback"),
        disableLocked: Boolean(entry.disableLocked),
        isDefault: Boolean(entry.isDefault),
      };
    }),
    defaultProvider: normalizeResolvedConfigValue(
      raw.defaultProvider,
      "DEFAULT_PROVIDER",
      "",
    ),
    providerSecret: normalizeResolvedConfigValue(
      raw.providerSecret,
      "PROVIDER_SECRET",
      "••••••••",
    ),
    mailIdTtl: normalizeResolvedConfigValue(raw.mailIdTtl, "MAIL_ID_TTL_MS", ""),
    adminSessionTtl: normalizeResolvedConfigValue(
      raw.adminSessionTtl,
      "ADMIN_SESSION_TTL_SEC",
      "",
    ),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.map((warning) => String(warning))
      : [],
  };
}

function renderFlash(flash: UiFlash): string {
  if (!flash) return "";
  const toneClass = `tone-${flash.tone}`;
  const role = flash.tone === "error" ? "alert" : "status";
  if (flash.key) {
    const fallbackText = translateServer(flash.key, flash.params);
    return `<div class="flash ${toneClass}" role="${role}">
      <div class="flash-copy" data-i18n="${escapeHtml(flash.key)}" data-i18n-params="${safeJsonAttr(flash.params ?? {})}">${escapeHtml(fallbackText)}</div>
      <button type="button" class="ghost-btn flash-dismiss" data-flash-dismiss data-i18n="common.close">Close</button>
    </div>`;
  }
  return `<div class="flash ${toneClass}" role="${role}">
      <div class="flash-copy">${escapeHtml(flash.message ?? "")}</div>
      <button type="button" class="ghost-btn flash-dismiss" data-flash-dismiss data-i18n="common.close">Close</button>
    </div>`;
}

function renderThemeLanguageControls(): string {
  return `<div class="toolbar-cluster">
    <button type="button" class="cycle-btn" data-lang-cycle data-control-key="language" data-aria-label-i18n="global.language">
      <span class="cycle-icon" data-lang-cycle-icon>${icon("globe")}</span>
    </button>
    <button type="button" class="cycle-btn" data-theme-cycle data-control-key="theme" data-aria-label-i18n="global.theme">
      <span class="cycle-icon" data-theme-cycle-icon>${icon("monitor")}</span>
    </button>
  </div>`;
}

function renderSidebar(active: "dashboard" | "keys" | "settings"): string {
  const navItems = [
    { href: "/admin", key: "dashboard", iconName: "dashboard" as const },
    { href: "/admin/keys", key: "keys", iconName: "key" as const },
    { href: "/admin/settings", key: "settings", iconName: "settings" as const },
  ];
  return `<aside class="admin-sidebar" id="app-drawer">
    <div class="sidebar-main">
      <nav class="nav-stack" aria-label="Admin">
        ${navItems.map((item) => {
    const isActive = item.key === active;
    return `<a class="nav-item ${isActive ? "is-active" : ""}" href="${item.href}" ${
      isActive ? 'aria-current="page"' : ""
    }>${icon(item.iconName)}<span data-i18n="nav.${item.key}">${
      translateServer(`nav.${item.key}`)
    }</span></a>`;
  }).join("")}
      </nav>
    </div>
    <div class="sidebar-utility">
      <a class="nav-item nav-item-subtle" href="/docs" target="_blank" rel="noopener">${icon("external")}<span data-i18n="common.viewDocs">Open docs</span></a>
      <form method="post" action="/admin/logout">
        <button type="submit" class="nav-item nav-item-danger">${icon("logout")}<span data-i18n="nav.logout">Logout</span></button>
      </form>
    </div>
  </aside>`;
}

function renderAdminPage(options: {
  active: "dashboard" | "keys" | "settings";
  title: string;
  subtitle: string;
  titleKey: string;
  subtitleKey: string;
  bodyHtml: string;
  flashHtml?: string;
  pageClass: string;
}): string {
  return renderDocument({
    title: options.title,
    pageId: options.pageClass,
    bodyClass: "admin-body",
    bodyHtml: `<a class="skip-link" href="#main-content" data-i18n="global.skipToContent">Skip to main content</a>
      <header class="topbar">
        <div class="topbar-brand">
          <button type="button" class="icon-btn drawer-toggle" data-drawer-toggle aria-controls="app-drawer" aria-expanded="false" data-aria-label-i18n="common.openMenu">${icon("menu")}</button>
          <a class="brand-lockup" href="/admin">
            <span class="eyebrow" data-i18n="global.adminEyebrow">Operations</span>
            <span class="brand-title" data-i18n="global.brand">Temporary Mail API</span>
          </a>
        </div>
        ${renderThemeLanguageControls()}
      </header>
      <div class="drawer-backdrop" data-drawer-backdrop></div>
      <div class="admin-layout">
        ${renderSidebar(options.active)}
        <main class="admin-main ${escapeHtml(options.pageClass)}" id="main-content">
          <section class="page-head">
            <p class="eyebrow mono" data-i18n="global.consoleEyebrow">Control plane</p>
            <h1 data-i18n="${escapeHtml(options.titleKey)}">${escapeHtml(options.title)}</h1>
            <p class="page-subtitle" data-i18n="${escapeHtml(options.subtitleKey)}">${escapeHtml(options.subtitle)}</p>
          </section>
          ${options.flashHtml ?? ""}
          ${options.bodyHtml}
        </main>
      </div>`,
  });
}

function renderLoginPage(rawModel: Record<string, unknown>): string {
  const model = normalizeLoginModel(rawModel);
  const flashHtml = model.error
    ? `<div class="flash tone-error" role="alert">
        <div class="flash-copy" data-i18n="${escapeHtml(model.error)}">${escapeHtml(translateServer(model.error))}</div>
      </div>`
    : "";
  return renderDocument({
    title: "Temporary Mail API Admin Login",
    pageId: "login",
    bodyClass: "login-body",
    bodyHtml: `<a class="skip-link" href="#main-content" data-i18n="global.skipToContent">Skip to main content</a>
      <main class="login-main" id="main-content">
        <section class="login-shell">
          <div class="login-brand">
            <p class="eyebrow mono" data-i18n="global.consoleEyebrow">Control plane</p>
            <h1 data-i18n="login.title">Temporary Mail API Admin</h1>
            <p class="login-copy" data-i18n="login.subtitle">A focused operator surface for keys, providers, and runtime controls.</p>
            <p class="login-helper" data-i18n="login.helper">One control plane for the gateway, provider routing, and API keys.</p>
          </div>
          <section class="login-panel">
            <div class="login-panel-head">
              <h2 data-i18n="login.loginTitle">Sign in</h2>
              ${renderThemeLanguageControls()}
            </div>
            ${flashHtml}
            <form method="post" action="/admin/login" class="login-form">
              <label class="field">
                <span class="field-label" data-i18n="login.password">Password</span>
                <input type="password" name="password" autocomplete="current-password" required />
              </label>
              <button type="submit" class="primary-btn" data-i18n="login.submit">Sign in</button>
            </form>
          </section>
        </section>
      </main>`,
  });
}

function renderDashboardPage(rawModel: Record<string, unknown>): string {
  const model = normalizeDashboardModel(rawModel);
  return renderAdminPage({
    active: "dashboard",
    title: translateServer("dashboard.title"),
    subtitle: translateServer("dashboard.subtitle"),
    titleKey: "dashboard.title",
    subtitleKey: "dashboard.subtitle",
    pageClass: "dashboard-page",
    bodyHtml: `<section class="surface-block">
        <div class="section-head">
          <div>
            <h2 data-i18n="dashboard.metricsTitle">Gateway metrics</h2>
            <p class="section-copy" data-i18n="dashboard.metricsSubtitle">Numbers that directly map to quota, provider load, and admin actions.</p>
          </div>
        </div>
        <div class="metric-grid">
          <article class="metric-card">
            <p class="metric-label" data-i18n="dashboard.activeApiKeys">Active API keys</p>
            <p class="metric-value">${model.stats.activeApiKeys}</p>
            <p class="metric-meta" data-i18n="dashboard.keyMeta">Keys currently able to authenticate upstream calls.</p>
          </article>
          <article class="metric-card">
            <p class="metric-label" data-i18n="dashboard.totalUpstreamCalls">Total upstream calls</p>
            <p class="metric-value">${model.stats.totalUpstreamCalls}</p>
            <p class="metric-meta" data-i18n="dashboard.totalMeta">Gateway-wide accumulated provider traffic.</p>
          </article>
          <article class="metric-card">
            <p class="metric-label" data-i18n="dashboard.todayUpstreamCalls">Today's upstream calls (UTC)</p>
            <p class="metric-value">${model.stats.todayUpstreamCalls}</p>
            <p class="metric-meta" data-i18n="dashboard.todayMeta">Daily operational load against active providers.</p>
          </article>
        </div>
      </section>
      <section class="surface-block">
        <div class="section-head">
          <div>
          <h2 data-i18n="dashboard.quickActionsTitle">Quick actions</h2>
          <p class="section-copy" data-i18n="dashboard.quickActionsSubtitle">Common admin destinations without extra dashboard chrome.</p>
          </div>
        </div>
        <div class="quick-actions">
          <a class="secondary-link" href="/admin/keys">${icon("key")}<span data-i18n="dashboard.goKeys">Manage keys</span></a>
          <a class="secondary-link" href="/admin/settings">${icon("settings")}<span data-i18n="dashboard.goSettings">Open settings</span></a>
          <a class="secondary-link" href="/docs" target="_blank" rel="noopener">${icon("docs")}<span data-i18n="dashboard.readDocs">Read docs</span></a>
        </div>
      </section>`,
  });
}

function formatQuota(quota: number | null, usage: number): {
  ratioText: string;
  ratioClass: string;
  width: number;
  limitLabel: string;
} {
  if (quota === null || quota === 0) {
    return {
      ratioText: "Unlimited",
      ratioClass: "is-unlimited",
      width: Math.min(usage > 0 ? 14 : 6, 20),
      limitLabel: `∞ / ${usage}`,
    };
  }
  const ratio = Math.max(0, Math.min(100, Math.round((usage / quota) * 100)));
  return {
    ratioText: `${ratio}%`,
    ratioClass: ratio >= 100 ? "is-danger" : ratio >= 80 ? "is-warn" : "",
    width: ratio,
    limitLabel: `${quota} / ${usage}`,
  };
}

function formatDateValue(epochMs: number | null): string {
  if (!epochMs) return translateServer("common.never");
  return new Date(epochMs).toISOString();
}

function formatDatetimeLocal(epochMs: number | null): string {
  if (!epochMs) return "";
  const date = new Date(epochMs);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderLocalTime(epochMs: number | null): string {
  if (!epochMs) return `<span data-i18n="common.never">Never</span>`;
  const iso = new Date(epochMs).toISOString();
  return `<time datetime="${escapeHtml(iso)}" data-local-time="${epochMs}">${escapeHtml(iso.replace("T", " ").slice(0, 16))}</time>`;
}

function renderQuotaMeter(quota: number | null, usage: number): string {
  const meter = formatQuota(quota, usage);
  return `<div class="quota-meter ${meter.ratioClass}">
    <div class="quota-head">
      <span class="quota-label">${escapeHtml(meter.limitLabel)}</span>
      <span class="quota-ratio">${escapeHtml(meter.ratioText)}</span>
    </div>
    <div class="quota-track"><span class="quota-fill" style="width:${meter.width}%"></span></div>
  </div>`;
}

function renderKeysPage(rawModel: Record<string, unknown>): string {
  const model = normalizeKeysModel(rawModel);
  const flashHtml = renderFlash(model.flash);
  const createdPanel = model.createdKey
    ? `<section class="surface-block reveal-block">
        <div class="section-head">
          <div>
            <h2 data-i18n="keys.createdTitle">New API key</h2>
            <p class="section-copy" data-i18n="keys.createdHint">Copy it now. This reveal is intentionally one-time.</p>
          </div>
          <button type="button" class="ghost-btn" data-copy-text-target="raw-api-key">${icon("copy")}<span data-i18n="common.copy">Copy</span></button>
        </div>
        <p class="reveal-meta"><span class="reveal-meta-label" data-i18n="keys.keyId">Key ID</span> <code id="created-key-id">${escapeHtml(model.createdKey.id)}</code></p>
        <div class="reveal-code" id="raw-api-key">${escapeHtml(model.createdKey.rawKey)}</div>
      </section>`
    : "";
  const rows = model.keys.map((record) => `
      <tr>
        <td data-label="ID" data-label-i18n="keys.id"><code>${escapeHtml(record.id)}</code></td>
        <td data-label="Label" data-label-i18n="keys.label">${escapeHtml(record.label)}</td>
        <td data-label="Status" data-label-i18n="keys.status"><span class="status-chip status-${escapeHtml(record.status)}" data-status-value="${escapeHtml(record.status)}">${escapeHtml(translateServer(`status.${record.status}`))}</span></td>
        <td data-label="Total quota / used" data-label-i18n="keys.totalQuota">${renderQuotaMeter(record.quotaTotal, record.usageTotal)}</td>
        <td data-label="Daily quota / used" data-label-i18n="keys.dailyQuota">${renderQuotaMeter(record.quotaDaily, record.usageDaily)}</td>
        <td data-label="Expires" data-label-i18n="keys.expires">${renderLocalTime(record.expiresAt)}</td>
        <td data-label="Actions" data-label-i18n="common.actions">
          <div class="table-actions">
            <button type="button" class="ghost-btn" data-open-edit data-edit-action="/admin/keys/${encodeURIComponent(record.id)}/update" data-key-id="${escapeHtml(record.id)}" data-key-label="${escapeHtml(record.label)}" data-key-status="${escapeHtml(record.status === "expired" ? "active" : record.status)}" data-key-total="${record.quotaTotal ?? ""}" data-key-daily="${record.quotaDaily ?? ""}" data-key-expires="${escapeHtml(formatDatetimeLocal(record.expiresAt))}">${icon("edit")}<span data-i18n="keys.editButton">Edit</span></button>
            <button type="button" class="danger-btn" data-delete-key data-delete-action="/admin/keys/${encodeURIComponent(record.id)}/delete" data-key-id="${escapeHtml(record.id)}" data-key-label="${escapeHtml(record.label)}">${icon("trash")}<span data-i18n="keys.deleteButton">Delete</span></button>
          </div>
        </td>
      </tr>`).join("");
  const mobileCards = model.keys.map((record) => `
      <article class="row-card">
        <div class="row-card-head">
          <div>
            <p class="row-card-title">${escapeHtml(record.label || record.id)}</p>
            <p class="row-card-meta"><code>${escapeHtml(record.id)}</code></p>
          </div>
          <span class="status-chip status-${escapeHtml(record.status)}" data-status-value="${escapeHtml(record.status)}">${escapeHtml(translateServer(`status.${record.status}`))}</span>
        </div>
        <div class="row-card-grid">
          <div><span class="mini-label" data-i18n="keys.totalQuota">Total quota / used</span>${renderQuotaMeter(record.quotaTotal, record.usageTotal)}</div>
          <div><span class="mini-label" data-i18n="keys.dailyQuota">Daily quota / used</span>${renderQuotaMeter(record.quotaDaily, record.usageDaily)}</div>
          <div><span class="mini-label" data-i18n="keys.expires">Expires</span><p class="meta-line">${renderLocalTime(record.expiresAt)}</p></div>
        </div>
        <div class="row-card-actions">
          <button type="button" class="ghost-btn" data-open-edit data-edit-action="/admin/keys/${encodeURIComponent(record.id)}/update" data-key-id="${escapeHtml(record.id)}" data-key-label="${escapeHtml(record.label)}" data-key-status="${escapeHtml(record.status === "expired" ? "active" : record.status)}" data-key-total="${record.quotaTotal ?? ""}" data-key-daily="${record.quotaDaily ?? ""}" data-key-expires="${escapeHtml(formatDatetimeLocal(record.expiresAt))}">${icon("edit")}<span data-i18n="keys.editButton">Edit</span></button>
          <button type="button" class="danger-btn" data-delete-key data-delete-action="/admin/keys/${encodeURIComponent(record.id)}/delete" data-key-id="${escapeHtml(record.id)}" data-key-label="${escapeHtml(record.label)}">${icon("trash")}<span data-i18n="keys.deleteButton">Delete</span></button>
        </div>
      </article>`).join("");
  return renderAdminPage({
    active: "keys",
    title: translateServer("keys.title"),
    subtitle: translateServer("keys.subtitle"),
    titleKey: "keys.title",
    subtitleKey: "keys.subtitle",
    pageClass: "keys-page",
    flashHtml: flashHtml || (model.error ? `<div class="flash tone-error" role="alert"><div class="flash-copy">${escapeHtml(model.error)}</div></div>` : ""),
    bodyHtml: `${createdPanel}
      <section class="surface-block">
        <div class="section-head">
          <div>
            <h2 data-i18n="keys.existingTitle">Issued keys</h2>
          </div>
          <button type="button" class="primary-btn" data-open-create>${icon("plus")}<span data-i18n="keys.createOpen">Create key</span></button>
        </div>
        <div class="desktop-table">
          <table class="data-table">
            <thead><tr><th data-i18n="keys.id">ID</th><th data-i18n="keys.label">Label</th><th data-i18n="keys.status">Status</th><th data-i18n="keys.totalQuota">Total quota / used</th><th data-i18n="keys.dailyQuota">Daily quota / used</th><th data-i18n="keys.expires">Expires</th><th data-i18n="common.actions">Actions</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="7" class="muted" data-i18n="keys.noKeys">No keys yet.</td></tr>`}</tbody>
          </table>
        </div>
        <div class="mobile-row-list">${mobileCards || `<p class="muted" data-i18n="keys.noKeys">No keys yet.</p>`}</div>
      </section>
      <form id="delete-key-form" method="post" class="hidden"></form>
      <div class="modal-shell" id="edit-key-modal" hidden>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-key-title">
          <div class="modal-head">
            <div>
              <p class="eyebrow mono" data-i18n="keys.keyId">Key ID</p>
              <h2 id="edit-key-title" data-i18n="keys.editTitle">Edit API key</h2>
              <p class="section-copy" data-i18n="keys.editSubtitle">Adjust label, state, quota, and expiry without reissuing the secret.</p>
              <p class="meta-line"><code id="edit-key-id"></code></p>
            </div>
            <button type="button" class="icon-btn" data-close-modal data-aria-label-i18n="common.close">${icon("close")}</button>
          </div>
          <form id="edit-key-form" method="post" class="modal-form">
            <label class="field"><span class="field-label" data-i18n="keys.label">Label</span><input id="edit-key-label" type="text" name="label" required /></label>
            <label class="field"><span class="field-label" data-i18n="keys.status">Status</span><select id="edit-key-status" name="status"><option value="active" data-i18n="status.active">active</option><option value="disabled" data-i18n="status.disabled">disabled</option></select></label>
            <label class="field"><span class="field-label" data-i18n="keys.totalQuotaInput">Total quota</span><input id="edit-key-total" type="number" min="0" name="quotaTotal" data-i18n-placeholder="keys.quotaTotalPlaceholder" placeholder="Leave blank or 0 for unlimited" /><span class="field-hint" data-i18n="keys.quotaHint">Leave blank or 0 for unlimited.</span></label>
            <label class="field"><span class="field-label" data-i18n="keys.dailyQuotaInput">Daily quota</span><input id="edit-key-daily" type="number" min="0" name="quotaDaily" data-i18n-placeholder="keys.quotaDailyPlaceholder" placeholder="Leave blank or 0 for unlimited" /><span class="field-hint" data-i18n="keys.quotaHint">Leave blank or 0 for unlimited.</span></label>
            <label class="field"><span class="field-label" data-i18n="keys.expires">Expires</span><input id="edit-key-expires" type="datetime-local" name="expiresAt" /><span class="field-hint" data-i18n="keys.expiresHint">Leave empty for no expiry.</span></label>
            <div class="modal-actions">
              <button type="button" class="ghost-btn" data-close-modal data-i18n="common.cancel">Cancel</button>
              <button type="submit" class="primary-btn" data-i18n="common.save">Save</button>
            </div>
          </form>
        </div>
      </div>
      <div class="modal-shell" id="create-key-modal" hidden>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-key-title">
          <div class="modal-head">
            <div>
              <p class="eyebrow mono" data-i18n="keys.createTitle">Create key</p>
              <h2 id="create-key-title" data-i18n="keys.createTitle">Create key</h2>
              <p class="section-copy" data-i18n="keys.createHint">Create quota-scoped keys for automation workflows. Zero means unlimited.</p>
            </div>
            <button type="button" class="icon-btn" data-close-create-modal data-aria-label-i18n="common.close">${icon("close")}</button>
          </div>
          <form method="post" action="/admin/keys" class="modal-form">
            <label class="field">
              <span class="field-label" data-i18n="keys.label">Label</span>
              <input type="text" name="label" required data-i18n-placeholder="keys.label" placeholder="Label" />
              <span class="field-hint" data-i18n="keys.formLabelHint">Human-readable owner or use case.</span>
            </label>
            <label class="field">
              <span class="field-label" data-i18n="keys.totalQuotaInput">Total quota</span>
              <input type="number" min="0" name="quotaTotal" data-i18n-placeholder="keys.quotaTotalPlaceholder" placeholder="Leave blank or 0 for unlimited" />
              <span class="field-hint" data-i18n="keys.quotaHint">Leave blank or 0 for unlimited.</span>
            </label>
            <label class="field">
              <span class="field-label" data-i18n="keys.dailyQuotaInput">Daily quota</span>
              <input type="number" min="0" name="quotaDaily" data-i18n-placeholder="keys.quotaDailyPlaceholder" placeholder="Leave blank or 0 for unlimited" />
              <span class="field-hint" data-i18n="keys.quotaHint">Leave blank or 0 for unlimited.</span>
            </label>
            <label class="field">
              <span class="field-label" data-i18n="keys.expires">Expires</span>
              <input type="datetime-local" name="expiresAt" />
              <span class="field-hint" data-i18n="keys.expiresHint">Leave empty for no expiry.</span>
            </label>
            <div class="modal-actions">
              <button type="button" class="ghost-btn" data-close-create-modal data-i18n="common.cancel">Cancel</button>
              <button type="submit" class="primary-btn">${icon("plus")}<span data-i18n="keys.createButton">Create key</span></button>
            </div>
          </form>
        </div>
      </div>`,
  });
}

function renderWarningList(warnings: string[]): string {
  if (!warnings.length) return "";
  return `<div class="warning-stack">
    ${warnings.map((warning) => `<div class="flash tone-warn" role="status">${icon("warning")}<div class="flash-copy">${escapeHtml(warning)}</div></div>`).join("")}
  </div>`;
}

function renderCodeBlock(
  title: string,
  code: string,
  id: string,
  titleKey?: string,
): string {
  return `<figure class="code-block">
    <figcaption><span ${titleKey ? `data-i18n="${escapeHtml(titleKey)}"` : ""}>${escapeHtml(title)}</span><button type="button" class="ghost-btn code-copy" data-copy-text-target="${escapeHtml(id)}">${icon("copy")}<span data-i18n="common.copy">Copy</span></button></figcaption>
    <pre id="${escapeHtml(id)}"><code>${escapeHtml(code)}</code></pre>
  </figure>`;
}

function renderDocsPage(rawModel: Record<string, unknown>): string {
  const model = normalizeDocsModel(rawModel);
  const providerSummary = model.providers.length
    ? model.providers.map((provider) => provider.isDefault ? `${provider.name} (default)` : provider.name).join(", ")
    : "(none configured)";
  const baseUrl = escapeHtml(model.baseUrl);
  const statsProvidersJson = JSON.stringify(model.providers, null, 2);
  const sections = [
    { id: "overview", key: "docs.overview" },
    { id: "generate", key: "docs.generateGet", method: "GET", tone: "get" },
    { id: "generate-post", key: "docs.generatePost", method: "POST", tone: "post" },
    { id: "list", key: "docs.list", method: "GET", tone: "get" },
    { id: "mail-fields", key: "docs.fields" },
    { id: "detail", key: "docs.detail", method: "GET", tone: "get" },
    { id: "delete", key: "docs.delete", method: "DELETE", tone: "delete" },
    { id: "clear", key: "docs.clear", method: "DELETE", tone: "delete" },
    { id: "stats", key: "docs.stats", method: "GET", tone: "get" },
    { id: "stats-fields", key: "docs.statsFields" },
  ];
  return renderDocument({
    title: "Temporary Mail API Docs",
    pageId: "docs",
    bodyClass: "docs-body",
    bodyHtml: `<a class="skip-link" href="#main-content" data-i18n="global.skipToContent">Skip to main content</a>
      <header class="topbar">
        <div class="topbar-brand">
          <button type="button" class="icon-btn drawer-toggle" data-drawer-toggle aria-controls="app-drawer" aria-expanded="false" data-aria-label-i18n="common.openMenu">${icon("menu")}</button>
          <a class="brand-lockup" href="/docs">
            <span class="eyebrow" data-i18n="global.docsEyebrow">Reference</span>
            <span class="brand-title" data-i18n="global.brand">Temporary Mail API</span>
          </a>
        </div>
        ${renderThemeLanguageControls()}
      </header>
      <div class="drawer-backdrop" data-drawer-backdrop></div>
      <div class="admin-layout">
        <aside class="admin-sidebar docs-sidebar" id="app-drawer">
          <div class="sidebar-main">
            <nav class="nav-stack docs-nav" aria-label="Documentation">
              ${sections.map((section) => `<a class="nav-item docs-nav-item" href="#${section.id}" data-doc-nav="${section.id}">${section.method ? `<span class="route-badge ${escapeHtml(section.tone ?? "get")} nav-route-badge">${escapeHtml(section.method)}</span>` : ""}<span data-i18n="${section.key}">${translateServer(section.key)}</span></a>`).join("")}
            </nav>
          </div>
        </aside>
        <main class="admin-main docs-main" id="main-content">
          <section class="docs-hero" id="overview">
            <div>
              <p class="eyebrow mono" data-i18n="global.docsEyebrow">Reference</p>
              <h1 data-i18n="docs.title">API Documentation</h1>
              <p class="page-subtitle" data-i18n="docs.subtitle">Public gateway endpoints for mailbox generation, polling, cleanup, and stats.</p>
              <p class="hero-note" data-i18n="docs.introSummary">Use the API to generate temporary inboxes, poll messages, read a specific mail, and clean up after verification flows.</p>
            </div>
          </section>
          ${renderWarningList(model.warnings)}
          <section class="docs-section docs-intro-section">
            <h2 data-i18n="docs.introTitle">Use cases and basics</h2>
            <div class="table-scroll">
              <table class="data-table docs-intro-table">
                <tbody>
                  <tr>
                    <th data-i18n="docs.baseUrl">Base URL</th>
                    <td><code>${baseUrl}</code></td>
                  </tr>
                  <tr>
                    <th data-i18n="docs.auth">Auth</th>
                    <td data-i18n="docs.introAuth">All endpoints use Authorization: Bearer &lt;api-key&gt;.</td>
                  </tr>
                  <tr>
                    <th data-i18n="docs.providerLabel">Provider</th>
                    <td data-i18n="docs.introRouting">Pass provider when you need deterministic routing across multiple upstream providers.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
          <section class="docs-section" id="generate" data-doc-section="generate"><h2><span class="route-badge get">GET</span> /api/generate-email</h2>${renderCodeBlock("Generate mailbox", `curl ${baseUrl}/api/generate-email \\
  -H 'Authorization: Bearer <api-key>'`, "generate-get-curl", "docs.generateMailboxTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "email": "demo123@mailto.plus"
  },
  "error": ""
}`, "generate-get-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="generate-post" data-doc-section="generate-post"><h2><span class="route-badge post">POST</span> /api/generate-email</h2><div class="table-scroll"><table class="data-table"><thead><tr><th data-i18n="docs.field">Field</th><th data-i18n="docs.type">Type</th><th data-i18n="docs.requiredLabel">Required</th><th data-i18n="docs.description">Description</th></tr></thead><tbody><tr><td><code>prefix</code></td><td>string</td><td data-i18n="docs.no">No</td><td data-i18n="docs.prefixDesc">Mailbox prefix.</td></tr><tr><td><code>domain</code></td><td>string</td><td data-i18n="docs.no">No</td><td data-i18n="docs.domainDesc">Requested domain.</td></tr><tr><td><code>provider</code></td><td>string</td><td data-i18n="docs.no">No</td><td data-i18n="docs.providerDesc">Explicit provider name.</td></tr></tbody></table></div>${renderCodeBlock("Generate mailbox with payload", `curl -X POST ${baseUrl}/api/generate-email \\
  -H 'Authorization: Bearer <api-key>' \\
  -H 'Content-Type: application/json' \\
  -d '{\"provider\":\"legacy\"}'`, "generate-post-curl", "docs.generatePayloadTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "email": "otp-bot@mailto.plus"
  },
  "error": ""
}`, "generate-post-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="list" data-doc-section="list"><h2><span class="route-badge get">GET</span> /api/emails</h2>${renderCodeBlock("List mailbox", `curl '${baseUrl}/api/emails?email=user@example.com' \\
  -H 'Authorization: Bearer <api-key>'`, "list-curl", "docs.listMailboxTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "emails": [
      {
        "id": "MAIL_ID",
        "email_address": "user@example.com",
        "from_address": "no-reply@example.com",
        "subject": "Your code",
        "content": "Code: 123456",
        "html_content": "<p>Code: <strong>123456</strong></p>"
      }
    ],
    "count": 1
  },
  "error": ""
}`, "list-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="mail-fields" data-doc-section="mail-fields"><h2 data-i18n="docs.fields">Fields</h2><div class="table-scroll"><table class="data-table"><thead><tr><th data-i18n="docs.field">Field</th><th data-i18n="docs.type">Type</th><th data-i18n="docs.description">Description</th></tr></thead><tbody><tr><td><code>id</code></td><td>string</td><td data-i18n="docs.mailId">Mail identifier.</td></tr><tr><td><code>email_address</code></td><td>string</td><td data-i18n="docs.emailAddress">Mailbox address.</td></tr><tr><td><code>from_address</code></td><td>string</td><td data-i18n="docs.fromAddress">Sender address.</td></tr><tr><td><code>subject</code></td><td>string</td><td data-i18n="docs.subjectDesc">Subject line.</td></tr><tr><td><code>content</code></td><td>string</td><td data-i18n="docs.contentDesc">Plain-text body.</td></tr><tr><td><code>html_content</code></td><td>string</td><td data-i18n="docs.htmlContentDesc">Rendered HTML body.</td></tr></tbody></table></div></section>
          <section class="docs-section" id="detail" data-doc-section="detail"><h2><span class="route-badge get">GET</span> /api/email/:id</h2><p class="section-copy" data-i18n="docs.detailNote">Providing email improves lookup reliability.</p>${renderCodeBlock("Get one mail", `curl '${baseUrl}/api/email/MAIL_ID?email=user@example.com' \\
  -H 'Authorization: Bearer <api-key>'`, "detail-curl", "docs.detailMailboxTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "id": "MAIL_ID",
    "email_address": "user@example.com",
    "from_address": "no-reply@example.com",
    "subject": "Your code",
    "content": "Code: 123456",
    "html_content": "<p>Code: <strong>123456</strong></p>"
  },
  "error": ""
}`, "detail-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="delete" data-doc-section="delete"><h2><span class="route-badge delete">DELETE</span> /api/email/:id</h2>${renderCodeBlock("Delete one mail", `curl -X DELETE '${baseUrl}/api/email/MAIL_ID?email=user@example.com' \\
  -H 'Authorization: Bearer <api-key>'`, "delete-curl", "docs.deleteMailTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "message": "Deleted email."
  },
  "error": ""
}`, "delete-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="clear" data-doc-section="clear"><h2><span class="route-badge delete">DELETE</span> /api/emails/clear</h2>${renderCodeBlock("Clear mailbox", `curl -X DELETE '${baseUrl}/api/emails/clear?email=user@example.com' \\
  -H 'Authorization: Bearer <api-key>'`, "clear-curl", "docs.clearMailboxTitle")}${renderCodeBlock("Response example", `{
  "success": true,
  "data": {
    "message": "Cleared emails.",
    "count": 1
  },
  "error": ""
}`, "clear-response", "docs.responseExampleTitle")}</section>
          <section class="docs-section" id="stats" data-doc-section="stats"><h2><span class="route-badge get">GET</span> /api/stats</h2>${renderCodeBlock("Read stats", `curl ${baseUrl}/api/stats \\
  -H 'Authorization: Bearer <api-key>'`, "stats-curl", "docs.readStatsTitle")}${renderCodeBlock("Stats envelope", `{
  "success": true,
  "data": {
    "proxy": {
      "totalUpstreamCalls": 1234,
      "todayUpstreamCalls": 56,
      "activeApiKeys": 3
    },
    "providers": ${statsProvidersJson}
  },
  "error": ""
}`, "stats-json", "docs.statsEnvelopeTitle")}</section>
          <section class="docs-section" id="stats-fields" data-doc-section="stats-fields"><h2 data-i18n="docs.statsFields">Stats Fields</h2><div class="table-scroll"><table class="data-table"><thead><tr><th data-i18n="docs.field">Field</th><th data-i18n="docs.type">Type</th><th data-i18n="docs.description">Description</th></tr></thead><tbody><tr><td><code>proxy.totalUpstreamCalls</code></td><td>number</td><td data-i18n="docs.statsTotalCalls">Total upstream calls recorded by the gateway.</td></tr><tr><td><code>proxy.todayUpstreamCalls</code></td><td>number</td><td data-i18n="docs.statsTodayCalls">Today's upstream calls in UTC.</td></tr><tr><td><code>proxy.activeApiKeys</code></td><td>number</td><td data-i18n="docs.statsActiveKeys">Currently active API key count.</td></tr><tr><td><code>providers</code></td><td>array</td><td data-i18n="docs.statsProvidersDesc">List of configured and enabled providers.</td></tr></tbody></table></div></section>
          <section class="docs-section" id="examples" data-doc-section="examples"><h2 data-i18n="docs.examples">Examples</h2>${renderCodeBlock("JavaScript", `fetch("${baseUrl}/api/generate-email", {
  headers: { Authorization: "Bearer <api-key>" }
}).then((response) => response.json())`, "js-example", "docs.javascriptLabel")}${renderCodeBlock("Python", `import requests

resp = requests.get(
    "${baseUrl}/api/emails",
    params={"email": "user@example.com"},
    headers={"Authorization": "Bearer <api-key>"},
    timeout=30,
)
print(resp.json())`, "py-example", "docs.pythonLabel")}</section>
          <section class="docs-section" id="tips" data-doc-section="tips"><h2 data-i18n="docs.tips">Practical Tips</h2><ol class="signal-list ordered"><li data-i18n="docs.tipPoll">Poll every 2-5 seconds for OTP workflows.</li><li data-i18n="docs.tipListFirst">List the mailbox first to build the mail-id mapping.</li><li data-i18n="docs.tipPreferHtml">Prefer html_content when rendered email fidelity matters.</li><li data-i18n="docs.tipPassEmail">Pass email explicitly for detail and delete operations.</li></ol></section>
        </main>
      </div>`,
  });
}

function renderSettingsPage(rawModel: Record<string, unknown>): string {
  const model = normalizeSettingsModel(rawModel);
  const flashHtml = renderFlash(model.flash);
  const warningHtml = renderWarningList(model.warnings);
  const providerRows = model.providers.map((provider) => {
    const canEdit = provider.source === "kv";
    const canDelete = provider.source === "kv";
    const disableSetDefault = model.defaultProvider.locked || provider.isDefault || provider.disabled;
    const disableDelete = provider.isDefault && model.defaultProvider.source === "env";
    const toggleAction = provider.disabled ? "enable" : "disable";
    const toggleLabel = provider.disabled ? "common.enable" : "common.disable";
    return `<article class="provider-row ${provider.disabled ? "is-disabled" : ""}">
      <div class="provider-topline"><div class="provider-title-stack"><h3><code>${escapeHtml(provider.name)}</code></h3><div class="provider-chips">${provider.isDefault ? `<span class="meta-chip accent" data-i18n="settings.defaultFlag">default</span>` : ""}<span class="status-chip ${provider.disabled ? "status-disabled" : "status-active"}" data-i18n="settings.${provider.disabled ? "disabled" : "enabled"}">${translateServer(`settings.${provider.disabled ? "disabled" : "enabled"}`)}</span></div></div></div>
      <p class="provider-url"><code>${escapeHtml(provider.url)}</code></p>
      <div class="provider-controls">
        <div class="provider-actions">
          <form method="post" action="/admin/settings/provider/${encodeURIComponent(provider.name)}/default" class="inline-form"><button type="submit" class="ghost-btn" ${disableSetDefault ? "disabled" : ""} data-i18n="settings.setDefault">Set default</button></form>
          <form method="post" action="/admin/settings/provider/${encodeURIComponent(provider.name)}/${toggleAction}" class="inline-form"><button type="submit" class="${provider.disabled ? "ghost-btn" : "warn-btn"}" ${provider.disableLocked ? "disabled" : ""} data-i18n="${toggleLabel}">${translateServer(toggleLabel)}</button></form>
          <button type="button" class="ghost-btn" data-test-provider="${escapeHtml(provider.name)}">${icon("zap")}<span data-i18n="settings.testConnection">Test connection</span></button>
          ${canEdit ? `<button type="button" class="primary-btn" data-open-provider-edit data-provider-name="${escapeHtml(provider.name)}" data-provider-url="${escapeHtml(provider.url)}">${icon("edit")}<span data-i18n="common.edit">Edit</span></button>` : ""}
          ${canDelete ? `<form method="post" action="/admin/settings/provider/${encodeURIComponent(provider.name)}/delete" class="inline-form"><button type="submit" class="danger-btn" ${disableDelete ? "disabled" : ""}>${icon("trash")}<span data-i18n="common.delete">Delete</span></button></form>` : ""}
        </div>
        <div class="provider-secondary">
          ${canEdit ? "" : `<p class="provider-readonly">${icon("lock", "inline-icon")}<span data-i18n="settings.readOnlyMeta">This value is inherited and cannot be edited here.</span></p>`}
          <p class="provider-test-note" data-test-status="${escapeHtml(provider.name)}" data-i18n="settings.testIdle">No test run yet.</p>
        </div>
      </div>
    </article>`;
  }).join("");
  const renderRuntimeRow = (resolved: ResolvedConfigValue, fallback: string, hintKey: string) => `<article class="runtime-row"><div class="runtime-summary"><div class="runtime-heading"><p class="runtime-key"><code>${escapeHtml(resolved.key)}</code></p></div><p class="meta-line">Default: <code>${escapeHtml(fallback)}</code></p><p class="field-hint" data-i18n="${escapeHtml(hintKey)}">${escapeHtml(translateServer(hintKey))}</p></div><div class="runtime-editor"><form method="post" action="/admin/settings/advanced" class="runtime-form"><input type="hidden" name="key" value="${escapeHtml(resolved.key)}" /><input type="number" min="1" name="value" value="${escapeHtml(resolved.value || fallback)}" ${resolved.locked ? "readonly" : ""} /><button type="submit" class="primary-btn" ${resolved.locked ? "disabled" : ""}>${icon("save")}<span data-i18n="common.save">Save</span></button>${resolved.source === "kv" ? `<button type="submit" class="danger-btn" name="intent" value="delete">${icon("trash")}<span data-i18n="common.delete">Delete</span></button>` : ""}</form></div></article>`;
  return renderAdminPage({
    active: "settings",
    title: translateServer("settings.title"),
    subtitle: translateServer("settings.subtitle"),
    titleKey: "settings.title",
    subtitleKey: "settings.subtitle",
    pageClass: "settings-page",
    flashHtml: `${flashHtml}${warningHtml}`,
    bodyHtml: `<section class="surface-block"><div class="section-head"><div><h2 data-i18n="settings.providerTitle">Provider routing</h2><p class="section-copy" data-i18n="settings.providerSubtitle">Each provider row is a route policy plus an operational control surface.</p></div><button type="button" class="primary-btn" data-open-provider-create>${icon("plus")}<span data-i18n="settings.createProvider">Add provider</span></button></div><div class="provider-stack">${providerRows || `<p class="muted" data-i18n="settings.noProviders">No providers configured.</p>`}</div></section>
      <section class="surface-block"><div class="section-head"><div><h2 data-i18n="settings.securityTitle">Shared secret</h2><p class="section-copy" data-i18n="settings.securitySubtitle">This token must match every mail provider deployment.</p></div></div><div class="secret-panel"><form method="post" action="/admin/settings/secret" class="secret-form"><input type="hidden" name="intent" value="save" /><label class="field secret-field"><span class="field-label" data-i18n="settings.providerSecret">Provider secret</span><input id="provider-secret-input" type="password" name="value" value="${escapeHtml(model.providerSecret.value)}" placeholder="${escapeHtml(translateServer("settings.providerSecret"))}" ${model.providerSecret.locked ? "readonly" : ""} /><span class="field-hint" data-i18n="settings.secretHint">${escapeHtml(translateServer("settings.secretHint"))}</span></label><button type="button" class="ghost-btn" data-secret-toggle="provider-secret-input">${icon("eye")}<span data-i18n="settings.reveal">Reveal</span></button><button type="submit" class="primary-btn" ${model.providerSecret.locked ? "disabled" : ""}>${icon("save")}<span data-i18n="settings.saveSecret">Save secret</span></button>${model.providerSecret.source === "kv" ? `<button type="submit" class="danger-btn" name="intent" value="delete">${icon("trash")}<span data-i18n="common.delete">Delete</span></button>` : ""}</form></div></section>
      <section class="surface-block"><div class="section-head"><div><h2 data-i18n="settings.advancedTitle">Runtime values</h2><p class="section-copy" data-i18n="settings.advancedSubtitle">Keep these settings boring, predictable, and auditable.</p></div></div><div class="runtime-stack">${renderRuntimeRow(model.mailIdTtl, "86400000", "settings.mailIdTtlHint")}${renderRuntimeRow(model.adminSessionTtl, "86400", "settings.adminSessionTtlHint")}</div></section>
      <div class="modal-shell" id="create-provider-modal" hidden><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-provider-title"><div class="modal-head"><div><p class="eyebrow mono" data-i18n="settings.createProvider">Add provider</p><h2 id="create-provider-title" data-i18n="settings.createProvider">Add provider</h2></div><button type="button" class="icon-btn" data-close-provider-create-modal data-aria-label-i18n="common.close">${icon("close")}</button></div><form method="post" action="/admin/settings/provider" class="modal-form"><label class="field"><span class="field-label" data-i18n="settings.providerName">Provider name</span><input type="text" name="name" required /></label><label class="field"><span class="field-label" data-i18n="settings.providerUrl">Provider URL</span><input type="url" name="url" required /></label><div class="modal-actions"><button type="button" class="ghost-btn" data-close-provider-create-modal data-i18n="common.cancel">Cancel</button><button type="submit" class="primary-btn">${icon("plus")}<span data-i18n="settings.saveProvider">Save provider</span></button></div></form></div></div>
      <div class="modal-shell" id="edit-provider-modal" hidden><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="edit-provider-title"><div class="modal-head"><div><p class="eyebrow mono" data-i18n="common.edit">Edit</p><h2 id="edit-provider-title" data-i18n="common.edit">Edit</h2></div><button type="button" class="icon-btn" data-close-provider-edit-modal data-aria-label-i18n="common.close">${icon("close")}</button></div><form id="edit-provider-form" method="post" action="/admin/settings/provider" class="modal-form"><input type="hidden" name="oldName" id="edit-provider-old-name" /><label class="field"><span class="field-label" data-i18n="settings.providerName">Provider name</span><input id="edit-provider-name" type="text" name="name" required /></label><label class="field"><span class="field-label" data-i18n="settings.providerUrl">Provider URL</span><input id="edit-provider-url" type="url" name="url" required /></label><div class="modal-actions"><button type="button" class="ghost-btn" data-close-provider-edit-modal data-i18n="common.cancel">Cancel</button><button type="submit" class="primary-btn">${icon("edit")}<span data-i18n="common.edit">Edit</span></button></div></form></div></div>`,
  });
}

function renderDocument(options: {
  title: string;
  pageId: string;
  bodyClass: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(options.title)}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231f9d55' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='4' width='20' height='16' rx='2'/%3E%3Cpath d='m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7'/%3E%3C/svg%3E" />
  <script>
    (() => {
      try {
        const themePref = localStorage.getItem("tmpmail_theme") || "system";
        const langPref = localStorage.getItem("tmpmail_lang") || "auto";
        const resolvedTheme = themePref === "system"
          ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : themePref;
        const resolvedLang = langPref === "auto"
          ? ((navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en")
          : langPref;
        document.documentElement.dataset.theme = resolvedTheme;
        document.documentElement.dataset.locale = resolvedLang;
        document.documentElement.style.colorScheme = resolvedTheme;
        document.documentElement.lang = resolvedLang === "zh" ? "zh-CN" : "en";
      } catch {
      }
    })();
  </script>
  <style>
    :root {
      --font-ui: "IBM Plex Sans", "Segoe UI Variable", "Aptos", ui-sans-serif, sans-serif;
      --font-display: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
      --font-code: "JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace;
      --bg-base: #f3f4f1;
      --bg-surface: rgba(255, 255, 255, 0.72);
      --bg-elevated: #e7ebe3;
      --bg-sidebar: rgba(248, 249, 246, 0.88);
      --text-primary: #162018;
      --text-secondary: #5e6a60;
      --border: rgba(22, 32, 24, 0.08);
      --border-strong: rgba(22, 32, 24, 0.16);
      --accent: #1f9d55;
      --accent-hover: #187a42;
      --accent-soft: rgba(31, 157, 85, 0.12);
      --accent-strong: #0f6a35;
      --link: #225ea8;
      --link-hover: #173f73;
      --success: #198754;
      --warning: #b7791f;
      --danger: #c4493d;
      --danger-hover: #a3362d;
      --danger-soft: rgba(196, 73, 61, 0.12);
      --code-bg: #101714;
      --code-text: #d6f5df;
      --code-border: rgba(22, 42, 28, 0.15);
      --code-header-bg: #e7ece7;
      --code-header-text: #1d2a21;
      --shadow-sm: 0 1px 2px rgba(22, 32, 24, 0.06);
      --shadow-md: 0 10px 28px rgba(22, 32, 24, 0.09);
      --blur-surface: blur(18px);
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --z-skip-link: 70;
      --z-topbar: 40;
      --z-sidebar: 35;
      --z-drawer-backdrop: 45;
      --z-drawer: 50;
      --z-modal: 60;
      --motion-fast: 120ms ease-out;
      --motion-base: 180ms ease-out;
    }
    html[data-theme="dark"] {
      --bg-base: #0f1720;
      --bg-surface: rgba(19, 27, 24, 0.72);
      --bg-elevated: #18211d;
      --bg-sidebar: rgba(16, 24, 22, 0.88);
      --text-primary: #edf5ef;
      --text-secondary: #a5b4a8;
      --border: rgba(237, 245, 239, 0.08);
      --border-strong: rgba(237, 245, 239, 0.16);
      --accent: #4fd18b;
      --accent-hover: #79e0a8;
      --accent-soft: rgba(79, 209, 139, 0.14);
      --accent-strong: #8ce8b7;
      --link: #7ab8ff;
      --link-hover: #abd1ff;
      --success: #4fd18b;
      --warning: #f2b95d;
      --danger: #f07f73;
      --danger-hover: #ff9a91;
      --danger-soft: rgba(240, 127, 115, 0.14);
      --code-bg: #0c1310;
      --code-text: #d7ffe3;
      --code-border: rgba(215, 255, 227, 0.12);
      --code-header-bg: rgba(255, 255, 255, 0.06);
      --code-header-text: #d7ffe3;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.28);
      --shadow-md: 0 18px 40px rgba(0, 0, 0, 0.34);
      --blur-surface: blur(20px);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: var(--font-ui);
      font-size: 15px;
      line-height: 1.68;
      background:
        radial-gradient(circle at top left, rgba(31, 157, 85, 0.08), transparent 32%),
        radial-gradient(circle at bottom right, rgba(34, 94, 168, 0.08), transparent 28%),
        var(--bg-base);
      color: var(--text-primary);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(rgba(22, 32, 24, 0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(22, 32, 24, 0.02) 1px, transparent 1px);
      background-size: 24px 24px;
      opacity: 0.45;
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { color: var(--link-hover); }
    h1, h2, h3, p { margin: 0; }
    h1 { font-family: var(--font-display); font-size: 28px; line-height: 1.2; letter-spacing: -0.02em; }
    h2 { font-size: 20px; line-height: 1.35; font-weight: 600; }
    h3 { font-size: 16px; line-height: 1.4; font-weight: 600; }
    button, input, select, textarea { font: inherit; }
    code, pre { font-family: var(--font-code); }
    code { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 2px 6px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; }
    pre code { background: none; padding: 0; border: 0; color: inherit; border-radius: 0; }
    svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .skip-link { position: absolute; left: 16px; top: -48px; z-index: var(--z-skip-link); background: var(--accent); color: #fff; padding: 10px 14px; border-radius: var(--radius-md); transition: top var(--motion-fast); }
    .skip-link:focus { top: 16px; }
    .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: var(--text-secondary); font-weight: 600; }
    .mono { font-family: var(--font-display); }
    .brand-lockup { display: grid; gap: 4px; color: inherit; }
    .brand-title { font-family: var(--font-display); font-size: 18px; color: var(--text-primary); }
    .field, .toolbar-group { display: grid; gap: 8px; }
    .field-label, .metric-label, .mini-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); font-weight: 600; }
    .field-hint, .section-copy, .page-subtitle, .sidebar-note, .login-copy, .login-helper, .metric-meta, .meta-line, .hero-note { color: var(--text-secondary); }
    .field-hint, .meta-line, .metric-meta, .sidebar-note { font-size: 13px; line-height: 1.6; }
    input, select, textarea { width: 100%; min-height: 40px; padding: 8px 12px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--bg-surface); color: var(--text-primary); backdrop-filter: var(--blur-surface); }
    .icon-btn, .ghost-btn, .primary-btn, .danger-btn, .warn-btn, .secondary-link { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-strong); transition: background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast); cursor: pointer; }
    .icon-btn { width: 40px; padding: 0; background: var(--bg-surface); color: var(--text-primary); }
    .primary-btn { background: var(--accent); color: white; border-color: var(--accent); }
    .primary-btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .ghost-btn, .secondary-link { background: transparent; color: var(--text-primary); }
    .ghost-btn:hover, .secondary-link:hover { background: var(--bg-elevated); }
    .danger-btn { background: transparent; color: var(--danger); border-color: rgba(196, 73, 61, 0.25); }
    .danger-btn:hover { background: var(--danger-soft); color: var(--danger-hover); }
    .warn-btn { background: rgba(183, 121, 31, 0.1); color: var(--warning); border-color: rgba(183, 121, 31, 0.24); }
    .cycle-btn { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; min-width: 40px; padding: 0; border-radius: var(--radius-md); border: 1px solid var(--border-strong); background: var(--bg-surface); color: var(--text-primary); box-shadow: var(--shadow-sm); }
    .cycle-icon { display: inline-flex; align-items: center; justify-content: center; }
    .cycle-btn:hover { background: var(--bg-elevated); }
    .cycle-btn[data-control-key="language"] { color: var(--link); }
    .cycle-btn[data-control-key="theme"] { color: var(--accent-strong); }
    .primary-btn:focus-visible, .ghost-btn:focus-visible, .danger-btn:focus-visible, .warn-btn:focus-visible, .icon-btn:focus-visible, .secondary-link:focus-visible, .nav-item:focus-visible, .cycle-btn:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 0; box-shadow: 0 0 0 3px var(--accent-soft); }
    .topbar { position: sticky; top: 0; z-index: var(--z-topbar); display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 56px; padding: 12px 24px; background: var(--bg-surface); backdrop-filter: var(--blur-surface); border-bottom: 1px solid var(--border); }
    .topbar-brand, .toolbar-cluster, .quick-actions, .table-actions, .row-card-actions, .provider-actions, .provider-secondary, .provider-meta, .provider-chips, .secret-panel, .runtime-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .toolbar-cluster { justify-content: flex-end; }
    .admin-layout { min-height: calc(100vh - 56px); }
    .admin-sidebar { position: fixed; top: 56px; left: 0; width: 232px; height: calc(100vh - 56px); padding: 28px 16px 16px; border-right: 1px solid var(--border); background: var(--bg-sidebar); backdrop-filter: var(--blur-surface); display: flex; flex-direction: column; gap: 24px; z-index: var(--z-sidebar); overflow-y: auto; overscroll-behavior: contain; }
    .sidebar-main { display: flex; flex: 1 1 auto; min-height: 0; }
    .nav-stack, .sidebar-utility, .docs-nav, .provider-stack, .runtime-stack { display: grid; gap: 8px; }
    .nav-stack { width: 100%; align-content: start; }
    .sidebar-utility { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--border); }
    .nav-item { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 8px 12px; border-radius: var(--radius-md); color: var(--text-primary); border: 1px solid transparent; background: transparent; width: 100%; text-align: left; }
    .nav-item:hover { background: var(--bg-elevated); }
    .nav-item.is-active { background: var(--accent-soft); border-color: rgba(31, 157, 85, 0.24); color: var(--accent-strong); }
    .nav-item-subtle { color: var(--text-secondary); }
    .nav-item-danger { color: var(--danger); background: transparent; }
    .nav-item-danger:hover { background: var(--danger-soft); }
    .admin-main, .docs-main { min-width: 0; padding: 32px 40px 48px; }
    .admin-main { margin-left: 232px; }
    .page-head { display: grid; gap: 8px; margin-bottom: 24px; }
    .surface-block, .metric-card, .meta-panel, .login-panel, .code-block, .provider-row, .runtime-row, .row-card, .modal-card { background: var(--bg-surface); backdrop-filter: var(--blur-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
    .surface-block { padding: 24px; margin-bottom: 24px; }
    .section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    .section-head .primary-btn { width: auto; }
    .metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .metric-card { padding: 20px; min-height: 132px; display: grid; gap: 12px; align-content: space-between; }
    .metric-value { font-family: var(--font-display); font-size: 40px; line-height: 1; letter-spacing: -0.04em; }
    .runtime-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 20px; }
    .docs-hero { display: block; }
    .signal-list { display: grid; gap: 12px; margin: 16px 0 0; padding: 0; list-style: none; }
    .signal-list li { display: flex; align-items: flex-start; gap: 10px; }
    .signal-list.ordered { list-style: decimal; padding-left: 20px; display: block; }
    .signal-list.ordered li { display: list-item; margin-bottom: 8px; }
    .flash, .warning-stack { margin-bottom: 16px; }
    .flash { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg-surface); box-shadow: var(--shadow-sm); }
    .flash-dismiss { margin-left: auto; flex: none; }
    .tone-success { border-color: rgba(25, 135, 84, 0.24); background: rgba(25, 135, 84, 0.08); }
    .tone-warn { border-color: rgba(183, 121, 31, 0.24); background: rgba(183, 121, 31, 0.09); }
    .tone-error { border-color: rgba(196, 73, 61, 0.28); background: rgba(196, 73, 61, 0.08); }
    .reveal-block { border-color: rgba(31, 157, 85, 0.28); background: linear-gradient(180deg, rgba(31, 157, 85, 0.1), rgba(31, 157, 85, 0.03)); }
    .reveal-meta { margin-top: 14px; display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; }
    .reveal-meta-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; color: var(--text-secondary); }
    .reveal-code { margin-top: 8px; padding: 18px; border-radius: var(--radius-lg); background: var(--code-bg); color: var(--code-text); border: 1px solid var(--code-border); font-family: var(--font-code); overflow-wrap: anywhere; }
    .key-form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; align-items: end; }
    .key-form-grid .field:first-child { grid-column: span 2; }
    .action-field { align-self: end; }
    .action-field .primary-btn { width: 100%; }
    .desktop-table { display: block; }
    .mobile-row-list { display: none; gap: 12px; }
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th, .data-table td { vertical-align: top; text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--border); }
    .data-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); font-weight: 600; }
    .quota-meter { display: grid; gap: 6px; min-width: 100px; }
    .quota-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .quota-label { font-weight: 600; font-size: 13px; }
    .quota-ratio { color: var(--text-secondary); font-size: 12px; }
    .quota-track { height: 8px; border-radius: 999px; background: var(--bg-elevated); overflow: hidden; border: 1px solid var(--border); }
    .quota-fill { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
    .is-warn .quota-fill { background: var(--warning); }
    .is-danger .quota-fill { background: var(--danger); }
    .is-unlimited .quota-fill { background: linear-gradient(90deg, var(--accent) 0%, rgba(31, 157, 85, 0.25) 100%); }
    .status-chip, .meta-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-primary); white-space: nowrap; }
    .status-active { color: var(--success); border-color: rgba(25, 135, 84, 0.24); }
    .status-disabled { color: var(--danger); border-color: rgba(196, 73, 61, 0.24); }
    .status-expired { color: var(--warning); border-color: rgba(183, 121, 31, 0.24); }
    .accent { color: var(--accent-strong); border-color: rgba(31, 157, 85, 0.24); }
    .modal-shell[hidden] { display: none; }
    .modal-shell { position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(15, 23, 32, 0.68); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .modal-card { width: min(640px, calc(100vw - 24px)); max-height: min(720px, calc(100vh - 32px)); padding: 20px; overflow: auto; }
    .modal-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 16px; }
    .modal-form, .row-card-grid { display: grid; gap: 14px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
    .row-card { padding: 16px; display: grid; gap: 14px; }
    .row-card-head, .provider-topline { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .row-card-title { font-weight: 600; }
    .provider-row, .runtime-row { padding: 18px; display: grid; gap: 12px; }
    .provider-url { font-family: var(--font-code); padding: 12px; border-radius: var(--radius-md); background: var(--bg-elevated); border: 1px solid var(--border); overflow-wrap: anywhere; }
    .provider-title-stack { display: grid; gap: 10px; }
    .provider-controls, .provider-actions, .provider-secondary { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; }
    .provider-edit-form { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; width: 100%; align-items: end; }
    .provider-readonly { display: flex; gap: 8px; align-items: center; color: var(--text-secondary); font-size: 12px; }
    .provider-test-note { min-height: 20px; color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; }
    .provider-test-note.is-success { color: var(--success); }
    .provider-test-note.is-error { color: var(--danger); }
    .provider-create-form { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(240px, 2fr) auto; gap: 12px; align-items: end; margin-top: 18px; }
    .settings-split { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .settings-summary-card { display: grid; gap: 10px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--bg-elevated); border: 1px solid var(--border); }
    .settings-summary-line { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .secret-panel { align-items: start; }
    .secret-field { min-width: 0; }
    .secret-form { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: start; width: 100%; }
    .secret-form > .ghost-btn, .secret-form > .primary-btn, .secret-form > .danger-btn { margin-top: 27px; }
    .runtime-row { grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); align-items: start; }
    .runtime-summary { display: grid; gap: 8px; }
    .runtime-heading { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .runtime-editor { display: grid; gap: 10px; width: 100%; }
    .runtime-form { justify-content: flex-start; }
    .runtime-form input { min-width: 180px; flex: 1 1 200px; }
    .inline-icon { width: 14px; height: 14px; }
    .docs-nav-item { justify-content: flex-start; gap: 12px; }
    .docs-main { max-width: 920px; line-height: 1.78; overflow-x: hidden; }
    .docs-hero { padding-bottom: 12px; }
    .docs-section { padding: 28px 0; border-top: 1px solid var(--border); }
    .docs-section h2 { margin-bottom: 12px; }
    .docs-kv { display: grid; gap: 10px; margin-top: 18px; }
    .docs-kv-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; padding: 8px 0; border-bottom: 1px dashed var(--border); }
    .docs-kv-row:last-child { border-bottom: 0; }
    .table-scroll { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .docs-main .data-table { width: 100%; table-layout: auto; }
    .docs-main .data-table th, .docs-main .data-table td { overflow-wrap: anywhere; word-break: break-word; }
    .docs-intro-table { table-layout: auto; }
    .docs-intro-table th { width: 120px; white-space: nowrap; }
    .code-block { margin: 16px 0; overflow: hidden; border-color: rgba(31, 157, 85, 0.18); }
    .code-block figcaption { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--code-border); background: var(--code-header-bg); color: var(--code-header-text); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .code-block figcaption > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .code-block pre { padding: 20px 24px; background: var(--code-bg); color: var(--code-text); overflow-x: auto; white-space: pre; }
    .code-copy { color: var(--code-header-text); border-color: var(--code-border); background: transparent; width: auto; min-width: 0; flex: none; }
    .route-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 46px; height: 24px; margin-right: 10px; padding: 0 10px; border-radius: 999px; font-size: 11px; color: white; vertical-align: middle; font-weight: 700; letter-spacing: 0.04em; }
    .route-badge.get { background: var(--success); }
    .route-badge.post { background: var(--link); }
    .route-badge.delete { background: var(--danger); }
    .nav-route-badge { margin-right: 0; min-width: 58px; }
    .drawer-backdrop { display: none; position: fixed; inset: 0; z-index: var(--z-drawer-backdrop); background: rgba(15, 23, 32, 0.45); }
    .drawer-toggle { display: none; }
    .login-body { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
    .login-main { width: 100%; display: grid; place-items: center; }
    .login-shell { width: min(480px, 100%); display: grid; grid-template-columns: 1fr; gap: 24px; }
    .login-brand { padding: 32px 24px; display: grid; align-content: center; gap: 12px; }
    .login-brand h1 { font-size: 34px; line-height: 1.15; letter-spacing: -0.03em; }
    .login-panel { padding: 24px; display: grid; gap: 18px; align-content: start; }
    .login-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .login-form { display: grid; gap: 14px; }
    .hidden { display: none !important; }
    @media (max-width: 1439px) {
      .admin-main,
      .docs-main {
        padding-left: 32px;
        padding-right: 32px;
      }
    }
    @media (max-width: 1023px) {
      .drawer-toggle {
        display: inline-flex;
      }
      .admin-layout,
      .metric-grid,
      .runtime-grid,
      .provider-create-form,
      .provider-edit-form,
      .runtime-row {
        grid-template-columns: 1fr;
      }
      .admin-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: min(320px, 86vw);
        height: auto;
        transform: translateX(-100%);
        transition: transform var(--motion-base);
        z-index: var(--z-drawer);
        padding-bottom: 24px;
      }
      .admin-sidebar.is-open {
        transform: translateX(0);
      }
      .drawer-backdrop.is-open {
        display: block;
      }
      .admin-main,
      .docs-main {
        padding: 24px;
      }
      .admin-main {
        margin-left: 0;
      }
      .settings-split,
      .secret-form {
        grid-template-columns: 1fr;
      }
      .secret-form > .ghost-btn, .secret-form > .primary-btn, .secret-form > .danger-btn { margin-top: 0; }
      .topbar {
        padding-left: 16px;
        padding-right: 16px;
      }
    }
    @media (max-width: 767px) {
      .toolbar-cluster,
      .table-actions,
      .row-card-actions,
      .modal-actions,
      .provider-actions,
      .provider-controls,
      .provider-secondary,
      .secret-form,
      .quick-actions {
        flex-direction: column;
        align-items: stretch;
      }
      .topbar {
        gap: 12px;
        align-items: center;
      }
      .topbar-brand { flex-wrap: nowrap; min-width: 0; }
      .topbar-brand .eyebrow { display: none; }
      .brand-lockup { min-width: 0; }
      .brand-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
      .toolbar-cluster {
        width: auto;
        gap: 8px;
        flex-direction: row;
        align-items: center;
      }
      .desktop-table {
        display: none;
      }
      .mobile-row-list {
        display: grid;
      }
      .admin-main,
      .docs-main {
        padding: 16px;
      }
      .section-head .primary-btn,
      .code-copy {
        width: auto;
      }
      .surface-block,
      .metric-card,
      .login-panel,
      .provider-row,
      .runtime-row,
      .row-card {
        padding: 16px;
      }
      .docs-section {
        padding: 22px 0;
      }
      .code-block pre {
        padding: 16px;
      }
      .ghost-btn,
      .primary-btn,
      .danger-btn,
      .warn-btn,
      .secondary-link {
        width: 100%;
      }
      .key-form-grid {
        grid-template-columns: 1fr;
      }
      .key-form-grid .field:first-child {
        grid-column: span 1;
      }
      .docs-main {
        padding-top: 24px;
      }
      .admin-sidebar {
        width: min(340px, 92vw);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }
    }
    .site-footer {
      text-align: center;
      padding: 18px 16px 14px;
      font-size: 13px;
      color: var(--text-secondary);
      border-top: 1px solid var(--border);
      margin-top: auto;
    }
    .site-footer a {
      color: var(--text-secondary);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color var(--motion-fast);
    }
    .site-footer a:hover { color: var(--text-primary); }
    .site-footer svg { vertical-align: middle; }
  </style>
</head>
<body class="${escapeHtml(options.bodyClass)}" data-page="${escapeHtml(options.pageId)}">
  ${options.bodyHtml}
  <script>
    (() => {
      const dict = ${JSON.stringify(uiDictionary)};
      const storageKeys = { theme: "tmpmail_theme", lang: "tmpmail_lang" };
      const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
      function readValue(locale, key) {
        let current = dict[locale] || dict.en;
        for (const part of key.split(".")) current = current && current[part];
        return typeof current === "string" ? current : key;
      }
      function interpolate(template, params) {
        let next = template;
        Object.entries(params || {}).forEach(([key, value]) => {
          next = next.replaceAll("{" + key + "}", value).replaceAll("#{" + key + "}", value);
        });
        return next;
      }
      function translate(locale, key, params) {
        return interpolate(readValue(locale, key), params || {});
      }
      function themePref() {
        return localStorage.getItem(storageKeys.theme) || "system";
      }
      function langPref() {
        return localStorage.getItem(storageKeys.lang) || "auto";
      }
      function resolveTheme(pref) {
        return pref === "system" ? (themeMedia.matches ? "dark" : "light") : pref;
      }
      function resolveLocale(pref) {
        if (pref === "zh" || pref === "en") return pref;
        return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
      }
      function currentLocale() {
        return resolveLocale(langPref());
      }
      const cycleMeta = {
        theme: {
          system: { labelKey: "cycle.themeSystem", icon: ${JSON.stringify(icon("monitor"))} },
          light: { labelKey: "cycle.themeLight", icon: ${JSON.stringify(icon("sun"))} },
          dark: { labelKey: "cycle.themeDark", icon: ${JSON.stringify(icon("moon"))} },
        },
        lang: {
          auto: { labelKey: "cycle.langAuto", icon: ${JSON.stringify(icon("globe"))} },
          zh: { labelKey: "cycle.langZh", icon: ${JSON.stringify(icon("globe"))} },
          en: { labelKey: "cycle.langEn", icon: ${JSON.stringify(icon("globe"))} },
        }
      };
      function syncCycleButtons() {
        const themeState = cycleMeta.theme[themePref()] || cycleMeta.theme.system;
        const themeButton = document.querySelector("[data-theme-cycle]");
        if (themeButton) {
          const iconNode = themeButton.querySelector("[data-theme-cycle-icon]");
          if (iconNode) iconNode.innerHTML = themeState.icon;
          const themeLabel = translate(currentLocale(), themeState.labelKey, {});
          themeButton.setAttribute("title", translate(currentLocale(), "global.theme", {}) + ": " + themeLabel);
          themeButton.setAttribute("aria-label", translate(currentLocale(), "global.theme", {}) + ": " + themeLabel);
        }
        const langState = cycleMeta.lang[langPref()] || cycleMeta.lang.auto;
        const langButton = document.querySelector("[data-lang-cycle]");
        if (langButton) {
          const iconNode = langButton.querySelector("[data-lang-cycle-icon]");
          if (iconNode) iconNode.innerHTML = langState.icon;
          const langLabel = translate(currentLocale(), langState.labelKey, {});
          langButton.setAttribute("title", translate(currentLocale(), "global.language", {}) + ": " + langLabel);
          langButton.setAttribute("aria-label", translate(currentLocale(), "global.language", {}) + ": " + langLabel);
        }
      }
      function applyTheme() {
        const preference = themePref();
        const resolved = resolveTheme(preference);
        document.documentElement.dataset.theme = resolved;
        document.documentElement.style.colorScheme = resolved;
        syncCycleButtons();
      }
      function applyLocale() {
        const locale = currentLocale();
        document.documentElement.dataset.locale = locale;
        document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
        document.querySelectorAll("[data-i18n]").forEach((node) => {
          let params = {};
          if (node.dataset.i18nParams) {
            try {
              params = JSON.parse(node.dataset.i18nParams);
            } catch {
              params = {};
            }
          }
          node.textContent = translate(locale, node.dataset.i18n, params);
        });
        document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
          node.setAttribute("placeholder", translate(locale, node.getAttribute("data-i18n-placeholder"), {}));
        });
        document.querySelectorAll("[data-label-i18n]").forEach((node) => {
          node.setAttribute("data-label", translate(locale, node.getAttribute("data-label-i18n"), {}));
        });
        document.querySelectorAll("[data-aria-label-i18n]").forEach((node) => {
          node.setAttribute("aria-label", translate(locale, node.getAttribute("data-aria-label-i18n"), {}));
        });
        document.querySelectorAll("[data-status-value]").forEach((node) => {
          node.textContent = translate(locale, "status." + node.getAttribute("data-status-value"), {});
        });
        syncCycleButtons();
      }
      function setupCycleControls() {
        const themeOrder = ["system", "light", "dark"];
        const langOrder = ["auto", "zh", "en"];
        const themeButton = document.querySelector("[data-theme-cycle]");
        if (themeButton) {
          themeButton.addEventListener("click", () => {
            const current = themePref();
            const index = themeOrder.indexOf(current);
            const next = themeOrder[(index + 1 + themeOrder.length) % themeOrder.length];
            localStorage.setItem(storageKeys.theme, next);
            applyTheme();
            applyLocale();
          });
        }
        const langButton = document.querySelector("[data-lang-cycle]");
        if (langButton) {
          langButton.addEventListener("click", () => {
            const current = langPref();
            const index = langOrder.indexOf(current);
            const next = langOrder[(index + 1 + langOrder.length) % langOrder.length];
            localStorage.setItem(storageKeys.lang, next);
            applyLocale();
          });
        }
      }
      function setupCopy() {
        document.querySelectorAll("[data-copy-text-target]").forEach((button) => {
          button.addEventListener("click", async () => {
            const targetId = button.getAttribute("data-copy-text-target");
            const target = targetId ? document.getElementById(targetId) : null;
            if (!target) return;
            const labelNode = button.querySelector("span:last-child");
            const original = labelNode ? labelNode.textContent : "";
            try {
              await navigator.clipboard.writeText(target.textContent || "");
              if (labelNode) labelNode.textContent = translate(currentLocale(), "common.copied", {});
            } catch {
            }
            setTimeout(() => {
              if (labelNode) labelNode.textContent = original || translate(currentLocale(), "common.copy", {});
            }, 1200);
          });
        });
      }
      function setupDismiss() {
        document.querySelectorAll("[data-flash-dismiss]").forEach((button) => {
          button.addEventListener("click", () => {
            const flash = button.closest(".flash");
            if (flash) flash.remove();
          });
        });
      }
      function setupDrawer() {
        const drawer = document.getElementById("app-drawer");
        const backdrop = document.querySelector("[data-drawer-backdrop]");
        const toggles = document.querySelectorAll("[data-drawer-toggle]");
        const setOpen = (nextOpen) => {
          if (!drawer || !backdrop) return;
          drawer.classList.toggle("is-open", nextOpen);
          backdrop.classList.toggle("is-open", nextOpen);
          toggles.forEach((button) => button.setAttribute("aria-expanded", nextOpen ? "true" : "false"));
        };
        toggles.forEach((button) => button.addEventListener("click", () => setOpen(!(drawer && drawer.classList.contains("is-open")))));
        if (backdrop) backdrop.addEventListener("click", () => setOpen(false));
        document.querySelectorAll("#app-drawer a, #app-drawer button[type='submit']").forEach((node) => {
          node.addEventListener("click", () => {
            if (window.innerWidth <= 1023) setOpen(false);
          });
        });
      }
      function setupKeysPage() {
        const createModal = document.getElementById("create-key-modal");
        const modal = document.getElementById("edit-key-modal");
        const form = document.getElementById("edit-key-form");
        const keyId = document.getElementById("edit-key-id");
        const label = document.getElementById("edit-key-label");
        const status = document.getElementById("edit-key-status");
        const total = document.getElementById("edit-key-total");
        const daily = document.getElementById("edit-key-daily");
        const expires = document.getElementById("edit-key-expires");
        document.querySelectorAll("[data-open-edit]").forEach((button) => {
          button.addEventListener("click", () => {
            if (!modal || !form || !keyId || !label || !status || !total || !daily || !expires) return;
            form.setAttribute("action", button.getAttribute("data-edit-action") || "/admin/keys");
            keyId.textContent = button.getAttribute("data-key-id") || "";
            label.value = button.getAttribute("data-key-label") || "";
            status.value = button.getAttribute("data-key-status") || "active";
            total.value = button.getAttribute("data-key-total") || "";
            daily.value = button.getAttribute("data-key-daily") || "";
            expires.value = button.getAttribute("data-key-expires") || "";
            modal.hidden = false;
          });
        });
        document.querySelectorAll("[data-open-create]").forEach((button) => {
          button.addEventListener("click", () => {
            if (createModal) createModal.hidden = false;
          });
        });
        document.querySelectorAll("[data-close-modal]").forEach((button) => {
          button.addEventListener("click", () => {
            if (modal) modal.hidden = true;
          });
        });
        document.querySelectorAll("[data-close-create-modal]").forEach((button) => {
          button.addEventListener("click", () => {
            if (createModal) createModal.hidden = true;
          });
        });
        if (modal) {
          modal.addEventListener("click", (event) => {
            if (event.target === modal) modal.hidden = true;
          });
        }
        if (createModal) {
          createModal.addEventListener("click", (event) => {
            if (event.target === createModal) createModal.hidden = true;
          });
        }
        const deleteForm = document.getElementById("delete-key-form");
        document.querySelectorAll("[data-delete-key]").forEach((button) => {
          button.addEventListener("click", () => {
            if (!deleteForm) return;
            const key = button.getAttribute("data-key-id") || "";
            const labelValue = button.getAttribute("data-key-label") || "";
            const template = translate(currentLocale(), "keys.deleteConfirm", { id: key, label: labelValue });
            if (!window.confirm(template)) return;
            deleteForm.setAttribute("action", button.getAttribute("data-delete-action") || "/admin/keys");
            deleteForm.submit();
          });
        });
      }
      function setupLocalTimes() {
        document.querySelectorAll("[data-local-time]").forEach((node) => {
          const raw = Number(node.getAttribute("data-local-time"));
          if (!raw) return;
          try {
            node.textContent = new Date(raw).toLocaleString();
          } catch {
          }
        });
      }
      function setupDocsNav() {
        const sections = Array.from(document.querySelectorAll("[data-doc-section]"));
        const links = Array.from(document.querySelectorAll("[data-doc-nav]"));
        if (!sections.length || !links.length || !("IntersectionObserver" in window)) return;
        const observer = new IntersectionObserver((entries) => {
          const visible = entries.find((entry) => entry.isIntersecting);
          if (!visible) return;
          const id = visible.target.getAttribute("id");
          links.forEach((link) => {
            const active = link.getAttribute("data-doc-nav") === id;
            link.classList.toggle("is-active", active);
            if (active) link.setAttribute("aria-current", "true");
            else link.removeAttribute("aria-current");
          });
        }, { rootMargin: "-25% 0px -60% 0px", threshold: 0.1 });
        sections.forEach((section) => observer.observe(section));
      }
      function setupSettings() {
        const providerCreateModal = document.getElementById("create-provider-modal");
        const providerEditModal = document.getElementById("edit-provider-modal");
        const providerEditOldName = document.getElementById("edit-provider-old-name");
        const providerEditName = document.getElementById("edit-provider-name");
        const providerEditUrl = document.getElementById("edit-provider-url");
        document.querySelectorAll("[data-secret-toggle]").forEach((button) => {
          button.addEventListener("click", () => {
            const target = document.getElementById(button.getAttribute("data-secret-toggle") || "");
            if (!target) return;
            const isPassword = target.getAttribute("type") === "password";
            target.setAttribute("type", isPassword ? "text" : "password");
            const labelNode = button.querySelector("span:last-child");
            if (labelNode) labelNode.textContent = translate(currentLocale(), isPassword ? "settings.hide" : "settings.reveal", {});
          });
        });
        document.querySelectorAll("[data-open-provider-create]").forEach((button) => {
          button.addEventListener("click", () => {
            if (providerCreateModal) providerCreateModal.hidden = false;
          });
        });
        document.querySelectorAll("[data-close-provider-create-modal]").forEach((button) => {
          button.addEventListener("click", () => {
            if (providerCreateModal) providerCreateModal.hidden = true;
          });
        });
        if (providerCreateModal) {
          providerCreateModal.addEventListener("click", (event) => {
            if (event.target === providerCreateModal) providerCreateModal.hidden = true;
          });
        }
        document.querySelectorAll("[data-open-provider-edit]").forEach((button) => {
          button.addEventListener("click", () => {
            if (!providerEditModal || !providerEditOldName || !providerEditName || !providerEditUrl) return;
            providerEditOldName.value = button.getAttribute("data-provider-name") || "";
            providerEditName.value = button.getAttribute("data-provider-name") || "";
            providerEditUrl.value = button.getAttribute("data-provider-url") || "";
            providerEditModal.hidden = false;
          });
        });
        document.querySelectorAll("[data-close-provider-edit-modal]").forEach((button) => {
          button.addEventListener("click", () => {
            if (providerEditModal) providerEditModal.hidden = true;
          });
        });
        if (providerEditModal) {
          providerEditModal.addEventListener("click", (event) => {
            if (event.target === providerEditModal) providerEditModal.hidden = true;
          });
        }
        document.querySelectorAll("[data-test-provider]").forEach((button) => {
          button.addEventListener("click", async () => {
            const name = button.getAttribute("data-test-provider") || "";
            const statusNode = document.querySelector('[data-test-status="' + CSS.escape(name) + '"]');
            if (!statusNode || !name) return;
            statusNode.textContent = translate(currentLocale(), "common.testing", {});
            statusNode.classList.remove("is-error", "is-success");
            try {
              const response = await fetch("/admin/settings/test-provider", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: new URLSearchParams({ name }).toString(),
                credentials: "same-origin"
              });
              const payload = await response.json();
              if (!response.ok || !payload.success) {
                statusNode.textContent = payload.error || translate(currentLocale(), "settings.unreachable", {});
                statusNode.classList.add("is-error");
                return;
              }
              const result = payload.data || {};
              const text = result.ok ? "✓ " + (result.email || "OK") + " • " + result.latencyMs + "ms" : String(result.status || 0) + " • " + (result.error || translate(currentLocale(), "settings.unreachable", {}));
              statusNode.textContent = text;
              statusNode.classList.add(result.ok ? "is-success" : "is-error");
            } catch {
              statusNode.textContent = translate(currentLocale(), "settings.unreachable", {});
              statusNode.classList.add("is-error");
            }
          });
        });
      }
      themeMedia.addEventListener("change", () => {
        if (themePref() === "system") applyTheme();
      });
      applyTheme();
      applyLocale();
      setupCopy();
      setupDismiss();
      setupDrawer();
      setupCycleControls();
      setupKeysPage();
      setupLocalTimes();
      setupDocsNav();
      setupSettings();
    })();
  </script>
  <footer class="site-footer">
    <a href="https://github.com/k0baya/tmp-mail-api" target="_blank" rel="noopener noreferrer">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      k0baya/tmp-mail-api
    </a>
  </footer>
</body>
</html>`;
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve(Number.isInteger(port) && port > 0 ? { port } : {}, async (request) => {
    try {
      authenticateGateway(request);
      const url = new URL(request.url);
      if (request.method === "POST") {
        const rawModel = await request.json() as Record<string, unknown>;
        if (url.pathname === "/render/login") return htmlResponse(renderLoginPage(rawModel));
        if (url.pathname === "/render/dashboard") return htmlResponse(renderDashboardPage(rawModel));
        if (url.pathname === "/render/keys") return htmlResponse(renderKeysPage(rawModel));
        if (url.pathname === "/render/docs" || url.pathname === "/render/docs-page") return htmlResponse(renderDocsPage(rawModel));
        if (url.pathname === "/render/settings" || url.pathname === "/render/settings-page") return htmlResponse(renderSettingsPage(rawModel));
      }
      return new Response("Front-End Provider", { status: 200 });
    } catch (error) {
      if (error instanceof Response) return error;
      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 500 });
    }
  });
}
