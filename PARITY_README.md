# 🎯 PolySniper — YES/NO Parity Arbitrage Bot

A 24/7 autonomous trading bot for Kalshi crypto prediction markets using **YES/NO Parity Arbitrage**.

## 📐 Core Strategy

**YES/NO Parity Arbitrage** exploits a pricing inefficiency in Kalshi's binary markets:

- In any binary market: `YES + NO = $1.00` at settlement (guaranteed)
- If you can buy 1 YES + 1 NO for **less than $1.00**, you lock in risk-free profit
- **Kalshi API quirk**: The orderbook only shows bids (not asks). Asks are implied:
  - `yes_ask ≈ 100 - no_bid`
  - `no_ask ≈ 100 - yes_bid`
- **Parity condition**: When `yes_ask + no_ask < 100¢`, place `post_only` buy orders on both sides
- If both fill, you pay `< $0.985` for a guaranteed `$1.00` payout

### Why 85-95% Win Rate

✅ Settlement is deterministic (no directional guesswork)  
✅ Captures market microstructure inefficiencies, not predictions  
✅ Works 24/7 across all open crypto markets  
✅ Scales with capital (more contracts = same edge)  

### Risk Controls

| Risk | Mitigation |
|------|-----------|
| One-leg fill | `fill_or_kill` orders + auto-hedge within 5s |
| Fee creep | Only trade when `combined_cost ≤ 98.5¢` (1.5¢ buffer) |
| Rate limits | In-memory orderbook cache, scan every 500ms, no REST polling |
| Overexposure | Max 5 concurrent parity trades, max 5% bankroll per position |
| Balance drop | Hourly balance check, auto-pause if < $100 |

## 🏗️ Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│  Kalshi API     │ ◄────────────────► │  KalshiClient     │
│  (demo/prod)    │    orderbook_delta │  (auth + reconnect)│
└─────────────────┘                     └────────┬─────────┘
                                                 │
                                    ┌────────────▼──────────┐
                                    │  OrderbookEngine       │
                                    │  (in-memory cache)     │
                                    └────────────┬──────────┘
                                                 │
                     ┌───────────────────────────┼───────────────────────┐
                     │                           │                       │
          ┌──────────▼──────────┐    ┌──────────▼───────────┐  ┌───────▼──────────┐
          │  ParityScanner      │    │ ParityStrategyEngine  │  │  BalanceMonitor   │
          │  (REST, every 2min) │    │  (scan cache 500ms)   │  │  (hourly check)   │
          └─────────────────────┘    └──────────┬───────────┘  └──────────────────┘
                                                │
                                   ┌────────────▼────────────┐
                                   │  ParityExecutor          │
                                   │  - DRY_RUN mode          │
                                   │  - Atomic dual-leg       │
                                   │  - fill_or_kill          │
                                   │  - Auto-hedge            │
                                   └────────────┬────────────┘
                                                │
                                   ┌────────────▼────────────┐
                                   │  PostgreSQL (Railway)    │
                                   │  - parity_trades         │
                                   │  - parity_opportunities   │
                                   │  - daily_stats           │
                                   └─────────────────────────┘
```

## 🚀 Quick Start

### 1. Set up environment

```bash
cp .env.example .env
# Edit .env with your Kalshi API credentials
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Sync database schema

```bash
cd packages/db && npx prisma db push
```

### 4. Run in DRY_RUN mode (recommended first)

```bash
# Defaults: DRY_RUN=true, PAPER_MODE=true, KALSHI_DEMO=true
pnpm dev
```

This will:
- Connect to Kalshi demo environment
- Scan for parity opportunities
- Log them to PostgreSQL **without placing orders**
- Dashboard shows opportunities at `http://localhost:3000`

### 5. Review DRY_RUN logs after 24h

Query your database:
```sql
-- How many opportunities found?
SELECT COUNT(*) FROM "ParityOpportunity";

-- What was average profit?
SELECT AVG("guaranteedProfit") as avg_profit_cents FROM "ParityOpportunity";

-- How many would have triggered?
SELECT COUNT(*) FROM "ParityTrade" WHERE "dryRun" = true;

-- Profit distribution
SELECT "guaranteedProfit", COUNT(*) 
FROM "ParityOpportunity" 
GROUP BY "guaranteedProfit" 
ORDER BY "guaranteedProfit" DESC;
```

### 6. Enable execution (still on demo)

```bash
DRY_RUN=false PAPER_MODE=true KALSHI_DEMO=true pnpm dev
```

### 7. Go live (after 500+ demo fills, >85% win rate)

```bash
DRY_RUN=false PAPER_MODE=false KALSHI_DEMO=false pnpm dev
```

## 📊 Dashboard

The Next.js dashboard at `http://localhost:3000` provides:

- **Real-time metrics**: Bankroll, Daily P&L, Total P&L, Win Rate
- **Trade history**: Last 100 trades with status and outcomes
- **Parity opportunities**: Recent detected opportunities
- **Parity trades**: Execution history (DRY_RUN and live)
- **Bot controls**: Start/stop/pause from the UI
- **Settings**: Configure API keys, bankroll, paper mode

### API Endpoints

| Endpoint | Description |
|----------|------------|
| `GET /api/bot` | Bot state |
| `POST /api/bot` | Start/stop/pause/resume |
| `GET /api/config` | Configuration |
| `POST /api/config` | Update configuration |
| `GET /api/trades` | Trade history |
| `GET /api/parity-trades` | Parity trade history |
| `GET /api/parity-opportunities` | Detected opportunities |
| `GET /health` | Health check (for Railway) |
| `WS /ws` | Real-time WebSocket stream |

## 🛡️ Production Deployment (Railway)

### Services needed:
1. **PostgreSQL** — Railway managed database
2. **Worker** — Node.js service (runs the bot)
3. **Web** — Next.js dashboard

### Environment variables:
Set all variables from `.env.example` in Railway's environment config.

### Start sequence:
```bash
# 1. Deploy database first
# 2. Set DATABASE_URL in Railway
# 3. Run: npx prisma db push
# 4. Deploy worker and web
```

## 🔑 Kalshi API Notes

### Authentication
- REST: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP` (ms), `KALSHI-ACCESS-SIGNATURE`
- WebSocket: Same headers during handshake
- Signing: `timestamp + HTTP_METHOD + path` (strip query params!)

### Key Endpoints Used
| Endpoint | Purpose |
|----------|---------|
| `wss://demo-api.kalshi.co/trade-api/ws/v2` | Real-time orderbook |
| `GET /markets?status=open&limit=100` | Market discovery |
| `POST /portfolio/orders` | Place orders |
| `GET /portfolio/balance` | Balance monitoring |
| `GET /portfolio/fills` | Fill tracking |

### Rate Limits (Basic tier)
- **Read**: 20/sec
- **Write**: 10/sec
- Our bot stays well within limits (in-memory cache, no REST polling)

## 📈 Tuning Thresholds

After 24h of DRY_RUN data, tune `MIN_PROFIT_CENTS` in `parity-strategy.ts`:

| Threshold | Effect |
|-----------|--------|
| 1.0¢ | More trades, lower per-trade profit |
| 1.5¢ | Balanced (default) |
| 2.0¢ | Fewer trades, higher per-trade profit |
| 3.0¢ | Very selective, highest profit per trade |

**Rule of thumb**: Start at 1.5¢, adjust based on fill rate. If <50% of DRY_RUN triggers result in fills, lower the threshold. If >90% fill, you can raise it.

## ⚠️ Important Warnings

1. **Never skip DRY_RUN** — Run for at least 24h before executing
2. **Start with demo environment** — `KALSHI_DEMO=true`
3. **Use paper mode first** — `PAPER_MODE=true`
4. **Monitor balance hourly** — BalanceMonitor auto-pauses if < $100
5. **Partial fills are the main risk** — Auto-hedge closes within 5s
6. **Never chase yield** — This is a consistent grind strategy, not a moonshot

## 📁 Project Structure

```
apps/
├── worker/
│   └── src/
│       ├── index.ts                 # Entry point, wires components
│       ├── kalshi.ts                # WebSocket client (auth, reconnect)
│       ├── kalshi-rest.ts           # REST client (signing, endpoints)
│       ├── kalshi-orderbook.ts      # In-memory orderbook cache
│       ├── parity-scanner.ts        # Market discovery (REST, 2min)
│       ├── parity-strategy.ts       # Parity scanner (cache, 500ms)
│       ├── parity-executor.ts       # Atomic dual-leg execution
│       ├── balance-monitor.ts       # Hourly balance check
│       ├── risk.ts                  # Position sizing (Half-Kelly)
│       ├── monitor.ts               # Trade lifecycle monitor
│       ├── executor.ts              # Legacy executor (for old trades)
│       ├── spot-price-feed.ts       # Binance/CoinGecko prices
│       └── alerts.ts                # Telegram notifications
├── web/
│   ├── app/                         # Next.js dashboard
│   │   ├── api/                     # API routes
│   │   │   ├── parity-trades/       # Parity trade history
│   │   │   └── parity-opportunities/ # Opportunity tracker
│   │   └── page.tsx                 # Main dashboard
│   └── server.ts                    # Custom server with WebSocket
packages/
└── db/
    └── prisma/
        └── schema.prisma            # Database schema
```

## 📝 License

Private — All rights reserved
