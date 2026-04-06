# Deployment

## Railway Setup

This project uses **Railpack** (not Nixpacks — deprecated).

### Config File

Only `railway.toml` at the repo root. Nixpacks files have been removed.

---

## Services

You need **2 services** in Railway. Both connect to the same GitHub repo.

### Service 1: `web` (Next.js + WebSocket Dashboard)

| Setting | Value |
|---------|-------|
| **Builder** | `RAILPACK` |
| **Build Command** | `pnpm install --frozen-lockfile && pnpm --filter @repo/db db:generate && pnpm --filter @repo/web build` |
| **Start Command** | `pnpm --filter @repo/web start` |
| **Healthcheck Path** | `/` |

The custom `server.ts` runs Next.js and a WebSocket server (`/ws`) on the same port — both HTTP and WS in one process.

### Service 2: `worker` (Trading Bot)

| Setting | Value |
|---------|-------|
| **Builder** | `RAILPACK` |
| **Build Command** | `pnpm install --frozen-lockfile && pnpm --filter @repo/db db:generate` |
| **Start Command** | `pnpm --filter @repo/worker start` |
| **Healthcheck Path** | `/` |

Worker exposes a health endpoint on port 3001.

---

## Environment Variables

Set on both services:
- `DATABASE_URL` — from Railway PostgreSQL
- `BANKROLL_USDC` — starting bankroll (default: `1000`)
- `PAPER_MODE` — `true` for paper trading (default: `true`)
- Any API keys / wallet secrets your bot needs

---

## Directory Structure

```
polysniper/
├── apps/
│   ├── web/          ← Next.js + WebSocket (server.ts)
│   └── worker/       ← Trading bot (src/index.ts)
├── packages/
│   └── db/           ← Shared Prisma client
├── railway.toml      ← Railpack config (web service)
└── package.json      ← pnpm workspace root
```

---

## How WebSockets Work with Next.js

We use a custom `server.ts` instead of the default Next.js server:

1. Creates an HTTP server
2. Mounts Next.js request handler on it
3. Attaches a `WebSocketServer` to the same HTTP server on `/ws`
4. Both share the same port (`PORT` env var)

This means **one Railway service** handles both the web UI and real-time WebSocket updates — no separate WebSocket server needed.
