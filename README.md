# Mailer

Disposable email gateway that aggregates multiple upstream mail services behind a single, uniform REST API. Comes with a built-in admin console and auto-generated API documentation.

## Architecture

```
                ┌─────────────────────┐
   Clients ──▶  │   Gateway (app.ts)   │
                │  auth · routing · KV │
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
     Upstream A       Upstream B       Upstream C
```

| Component | Path | Purpose |
|---|---|---|
| Gateway | `src/gateway/app.ts` | Central API, API-key auth, provider routing, admin console, KV storage |
| Front-End Provider | `src/frontend/provider-front_end.ts` | Renders HTML pages (admin UI, API docs, login) served by the gateway |
| Mail Providers | `src/providers/provider-*.ts` | Each wraps one upstream mail service behind a standard 5-route interface |
| Example Provider | `src/providers/provider-example.ts` | Annotated template for developing new providers |
| Smoke Test | `scripts/smoke_test.mjs` | End-to-end test exercising generate → list → detail → delete |

Every component is a **standalone, single-file Deno TypeScript program** that runs independently. Components communicate over HTTP.

## Prerequisites

- [Deno](https://deno.com/) ≥ 2.0 (uses `Deno.openKv()`, `Deno.serve()`)

No `npm install` or `package.json` required.

## Configuration

All configuration is done via **environment variables**. Each file also contains a `CONFIG` block with default values — environment variables take priority.

### Gateway (`app.ts`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Listen port (default `8000`) |
| `ADMIN_PASSWORD` | **Yes** | Password for the admin console login |
| `ADMIN_COOKIE_SECRET` | **Yes** | HMAC secret for signing admin session cookies |
| `PROVIDER_SECRET` | No | Shared secret that the gateway sends to providers via `Authorization: Bearer` |
| `FRONTEND_PROVIDER_URL` | No | URL of the front-end provider (e.g. `http://127.0.0.1:8001`) |
| `PROVIDER_URL_<NAME>` | No | Register a mail provider. `<NAME>` becomes the provider name in lowercase (e.g. `PROVIDER_URL_LEGACY=http://127.0.0.1:8010`) |
| `DEFAULT_PROVIDER` | No | Which provider to use when the client doesn't specify one (default `legacy`) |

Providers can also be managed at runtime through the admin console (stored in Deno KV).

### Mail Providers

| Variable | Description |
|---|---|
| `PORT` | Listen port (default `8000`) |
| `PROVIDER_SECRET` | Must match the gateway's `PROVIDER_SECRET` |
| `UPSTREAM_BASE` / `UPSTREAM_BASE_URL` | Base URL of the upstream mail service |

See each provider's `CONFIG` block for provider-specific settings.

### Front-End Provider

| Variable | Description |
|---|---|
| `PORT` | Listen port (default `8000`) |
| `PROVIDER_SECRET` | Must match the gateway's `PROVIDER_SECRET` |

## Deployment

### 1. Start mail providers

Each provider is started independently. Assign a unique port to each.

```bash
# Start one provider per upstream service
PORT=<port> PROVIDER_SECRET=<secret> \
  deno run --allow-net --allow-env --unstable-kv \
  src/providers/provider-<name>.ts
```

Repeat for every provider you want to run, each on a different port.

### 2. Start the front-end provider

```bash
PORT=8001 PROVIDER_SECRET=<secret> \
  deno run --allow-net --allow-env --unstable-kv \
  src/frontend/provider-front_end.ts
```

### 3. Start the gateway

Pass all provider URLs and required credentials:

```bash
PORT=8787 \
  ADMIN_PASSWORD=<admin-password> \
  ADMIN_COOKIE_SECRET=<cookie-secret> \
  PROVIDER_SECRET=<secret> \
  FRONTEND_PROVIDER_URL=http://127.0.0.1:8001 \
  PROVIDER_URL_FOO=http://127.0.0.1:8010 \
  PROVIDER_URL_BAR=http://127.0.0.1:8011 \
  deno run --allow-net --allow-env --unstable-kv \
  src/gateway/app.ts
```

Add one `PROVIDER_URL_<NAME>` for each provider you started in step 1.

### Start order

1. Mail providers (any order among themselves)
2. Front-end provider
3. Gateway (last — it validates provider connectivity on startup)

Providers registered via environment variables are locked and cannot be removed from the admin console. Providers added through the admin UI are stored in KV and can be modified freely.

### Deno Deploy

Each `.ts` file can be deployed as a standalone Deno Deploy project. Set the environment variables in the project dashboard, then point the entrypoint to the desired file.

## Usage

Once deployed, open `http://<gateway-host>:<port>/docs` for the full interactive API documentation, including curl examples and code snippets.

## Developing a New Provider

1. Copy `src/providers/provider-example.ts` and rename it.
2. Implement the TODO sections — the file contains detailed inline guidance.
3. Start it with a unique `PORT` and the same `PROVIDER_SECRET`.
4. Register it in the gateway via `PROVIDER_URL_<NAME>` env var or through the admin console.

## Project Layout

```
mailer/
├── src/
│   ├── gateway/
│   │   └── app.ts                  # Central API gateway
│   ├── frontend/
│   │   └── provider-front_end.ts   # HTML/CSS/JS renderer
│   └── providers/
│       ├── provider-example.ts     # Development template
│       └── provider-<name>.ts      # One file per upstream service
├── scripts/
│   └── smoke_test.mjs              # End-to-end smoke test
└── README.md
```
