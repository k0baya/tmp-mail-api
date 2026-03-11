# Mailer

一次性邮箱网关，将多个上游邮件服务聚合在一套统一的 REST API 之后。内置管理后台和自动生成的 API 文档。

## 架构

```
                ┌─────────────────────┐
   客户端 ──▶   │   Gateway (app.ts)   │
                │  鉴权 · 路由 · KV    │
                └──┬──────┬──────┬────┘
                   │      │      │        PROVIDER_SECRET
          ┌────────┘      │      └──────────┐
          ▼               ▼                 ▼
   ┌────────────┐  ┌────────────┐    ┌────────────┐
   │ provider-  │  │ provider-  │    │ provider-  │  ...
   │ foo.ts     │  │ bar.ts     │    │ baz.ts     │
   └────────────┘  └────────────┘    └────────────┘
          │               │                 │
          ▼               ▼                 ▼
      上游服务 A       上游服务 B        上游服务 C
```

| 组件 | 路径 | 用途 |
|---|---|---|
| 网关 | `src/gateway/app.ts` | 中心 API——API Key 鉴权、Provider 路由、管理后台、KV 存储 |
| 前端 Provider | `src/frontend/provider-front_end.ts` | 为网关渲染 HTML 页面（管理 UI、API 文档、登录页） |
| 邮件 Provider | `src/providers/provider-*.ts` | 每个文件封装一个上游邮件服务，对外暴露统一的 5 路由接口 |
| 示例 Provider | `src/providers/provider-example.ts` | 带详细注释的开发模板 |
| 冒烟测试 | `scripts/smoke_test.mjs` | 端到端测试：生成 → 列表 → 详情 → 删除 |

所有组件都是**独立的单文件 Deno TypeScript 程序**，各自独立运行，通过 HTTP 通信。

## 前置条件

- [Deno](https://deno.com/) ≥ 2.0（使用 `Deno.openKv()`、`Deno.serve()`）

无需 `npm install` 或 `package.json`。

## 配置

所有配置通过**环境变量**完成。每个文件内部也有一个 `CONFIG` 块定义默认值——环境变量优先级更高。

### 网关（`app.ts`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口（默认 `8000`） |
| `ADMIN_PASSWORD` | **是** | 管理后台登录密码 |
| `ADMIN_COOKIE_SECRET` | **是** | 管理会话 Cookie 的 HMAC 签名密钥 |
| `PROVIDER_SECRET` | 否 | 网关发给 Provider 的共享密钥（通过 `Authorization: Bearer` 传递） |
| `FRONTEND_PROVIDER_URL` | 否 | 前端 Provider 的地址（如 `http://127.0.0.1:8001`） |
| `PROVIDER_URL_<NAME>` | 否 | 注册邮件 Provider，`<NAME>` 自动转小写作为 Provider 名称（如 `PROVIDER_URL_LEGACY=http://127.0.0.1:8010`） |
| `DEFAULT_PROVIDER` | 否 | 客户端未指定时使用的默认 Provider（默认 `legacy`） |

Provider 也可以在运行时通过管理后台添加（存储在 Deno KV 中）。

### 邮件 Provider

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口（默认 `8000`） |
| `PROVIDER_SECRET` | 须与网关的 `PROVIDER_SECRET` 一致 |
| `UPSTREAM_BASE` / `UPSTREAM_BASE_URL` | 上游邮件服务的基础 URL |

各 Provider 的专属设置见其文件内的 `CONFIG` 块。

### 前端 Provider

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口（默认 `8000`） |
| `PROVIDER_SECRET` | 须与网关的 `PROVIDER_SECRET` 一致 |

## 部署

### 1. 启动邮件 Provider

每个 Provider 独立启动，各分配一个端口。

```bash
# 每个上游服务启动一个 Provider
PORT=<端口> PROVIDER_SECRET=<密钥> \
  deno run --allow-net --allow-env --unstable-kv \
  src/providers/provider-<名称>.ts
```

为你要使用的每个 Provider 重复此步骤，各用不同端口。

### 2. 启动前端 Provider

```bash
PORT=8001 PROVIDER_SECRET=<密钥> \
  deno run --allow-net --allow-env --unstable-kv \
  src/frontend/provider-front_end.ts
```

### 3. 启动网关

传入所有 Provider URL 和必要的凭据：

```bash
PORT=8787 \
  ADMIN_PASSWORD=<管理员密码> \
  ADMIN_COOKIE_SECRET=<Cookie密钥> \
  PROVIDER_SECRET=<密钥> \
  FRONTEND_PROVIDER_URL=http://127.0.0.1:8001 \
  PROVIDER_URL_FOO=http://127.0.0.1:8010 \
  PROVIDER_URL_BAR=http://127.0.0.1:8011 \
  deno run --allow-net --allow-env --unstable-kv \
  src/gateway/app.ts
```

第 1 步中启动的每个 Provider 都需要对应添加一条 `PROVIDER_URL_<NAME>`。

### 启动顺序

1. 邮件 Provider（彼此之间无顺序要求）
2. 前端 Provider
3. 网关（最后启动——它会在启动时验证 Provider 连通性）

通过环境变量注册的 Provider 会被锁定，无法在管理后台中删除。通过管理 UI 添加的 Provider 存储在 KV 中，可自由修改。

### Deno Deploy

每个 `.ts` 文件都可以作为独立的 Deno Deploy 项目部署。在项目面板中设置环境变量，入口文件指向对应文件即可。

## 使用方法

部署完成后，访问 `http://<网关地址>:<端口>/docs` 查看完整的交互式 API 文档，包含 curl 示例和代码片段。

## 开发新 Provider

1. 复制 `src/providers/provider-example.ts` 并重命名。
2. 实现文件中标注 TODO 的部分——文件内有详细的行内指导。
3. 使用独立的 `PORT` 和相同的 `PROVIDER_SECRET` 启动。
4. 通过 `PROVIDER_URL_<NAME>` 环境变量或管理后台注册到网关。

## 项目结构

```
mailer/
├── src/
│   ├── gateway/
│   │   └── app.ts                  # 中心 API 网关
│   ├── frontend/
│   │   └── provider-front_end.ts   # HTML/CSS/JS 渲染器
│   └── providers/
│       ├── provider-example.ts     # 开发模板
│       └── provider-<name>.ts      # 每个上游服务一个文件
├── scripts/
│   └── smoke_test.mjs              # 端到端冒烟测试
└── README.md
```
