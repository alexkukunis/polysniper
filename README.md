# 🎯 PolyMarket Oracle Lag Bot

A sophisticated trading bot that exploits oracle price lag between Chainlink oracles and Polymarket CLOB prices for BTC, ETH, and SOL Up/Down markets.

## How It Works

1. **Chainlink Listener**: Monitors real-time oracle price updates on Polygon for BTC, ETH, SOL
2. **Polymarket Client**: Subscribes to CLOB WebSocket for live orderbook data
3. **Strategy Engine**: Detects when oracle moves exceed thresholds but Polymarket hasn't repriced yet
4. **Risk Manager**: Uses Half-Kelly formula for optimal position sizing with daily loss limits
5. **Monitor**: Watches open trades, takes profit at 10¢ gain, exits 45s before window close
6. **Scanner**: Auto-discovers active 5min/15min/1hour Up/Down market windows

## Architecture

```
polysniper/
├── apps/
│   ├── worker/           # Railway persistent service (bot)
│   │   └── src/
│   │       ├── index.ts        # Entry point + wiring
│   │       ├── chainlink.ts    # Multi-asset oracle listener
│   │       ├── polymarket.ts   # CLOB WebSocket client
│   │       ├── strategy.ts     # Signal detection + kill switch
│   │       ├── executor.ts     # Order placement + trade management
│   │       ├── monitor.ts      # Open trade management
│   │       ├── scanner.ts      # Market discovery
│   │       ├── risk.ts         # Position sizing + limits
│   │       └── alerts.ts       # Telegram notifications
│   └── web/              # Next.js 14 dashboard
│       └── app/
│           ├── page.tsx        # Dashboard UI
│           └── api/
│               ├── stream/     # SSE real-time updates
│               └── trades/     # Trade history API
└── packages/
    └── db/               # Prisma + PostgreSQL
        └── prisma/
            └── schema.prisma
```

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Next.js 14 (App Router)
- **Database**: PostgreSQL (Railway addon)
- **ORM**: Prisma 5
- **Blockchain**: ethers.js v6 (Polygon)
- **Polymarket**: @polymarket/clob-client v4
- **Deployment**: Railway
- **Package Manager**: pnpm
- **Monorepo**: Turborepo

## Quick Start

### Prerequisites
- Node.js 18+
- pnpm 9+
- PostgreSQL database (or Railway account)
- Polymarket API credentials
- Polygon RPC endpoint

### Local Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Generate Prisma client
cd packages/db && pnpm db:generate

# Push schema to database
pnpm db:push

# Start development mode (worker + web)
pnpm dev
```

The dashboard will be at http://localhost:3000

### Building

```bash
pnpm build
```

## Configuration

All configuration is via environment variables. See `.env.example` for template.

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
| `POLY_API_KEY` | Polymarket API key | `your_key` |
| `POLY_API_SECRET` | Polymarket API secret | `your_secret` |
| `POLY_PASSPHRASE` | Polymarket passphrase | `your_passphrase` |
| `WALLET_PRIVATE_KEY` | Ethereum wallet private key | `0x...` |
| `POLYGON_RPC` | Polygon HTTP RPC | `https://polygon-rpc.com` |
| `POLYGON_WSS_RPC` | Polygon WebSocket RPC | `wss://...` |
| `BANKROLL_USDC` | Starting bankroll | `1000` |
| `PAPER_MODE` | Paper trading (true/false) | `true` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot for alerts | Disabled |
| `TELEGRAM_CHAT_ID` | Telegram chat ID | Disabled |

## Strategy Details

### Oracle Lag Exploit

Chainlink oracles update prices on-chain with a slight delay vs actual market movements. When the oracle price moves significantly, Polymarket's Up/Down markets (which resolve based on the oracle price at window close) become mispriced.

**Example:**
- BTC oracle updates: +0.40% in last 30s
- Polymarket BTC Up still priced at 45¢
- True probability should be ~60¢
- Bot buys BTC Up at 45¢ → profit when market reprices

### Thresholds

Minimum oracle price change to trigger signal:

| Asset | 5min | 15min | 1hour |
|-------|------|-------|-------|
| BTC | 0.25% | 0.35% | 0.70% |
| ETH | 0.30% | 0.40% | 0.80% |
| SOL | 0.40% | 0.55% | 1.00% |

### Risk Management

- **Position Sizing**: Half-Kelly formula, max 5% of bankroll per trade
- **Daily Loss Limit**: 3% of bankroll → auto-pause
- **Max Open Positions**: 10 concurrent trades
- **Minimum Trade Size**: $10 USDC
- **Cooldown**: 120s between signals per asset

### Trade Management

- **Take Profit**: Exit when price moves 10¢ in our favor
- **Time Stop**: 45s before window end, check oracle confirmation
- **No Stop Loss**: Edge doesn't disappear — hold to resolution if oracle confirms

## Deployment to Railway

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment guide.

Quick steps:
```bash
railway init
railway add -d postgresql
railway variables set PAPER_MODE=true BANKROLL_USDC=1000 ...
railway up
```

## Dashboard

The web dashboard provides:
- Real-time bot status (Paper/Live mode, bankroll, P&L)
- Daily statistics (trades, wins, losses, win rate)
- Trade history with entry/exit prices and P&L
- Server-Sent Events for live updates every 3 seconds

Access at your Railway-provided URL or http://localhost:3000 locally.

## Safety

⚠️ **IMPORTANT SAFETY NOTES:**

1. **ALWAYS start in PAPER_MODE=true** to test without real money
2. Never commit your `.env` file to git
3. Use a separate wallet with minimal funds for testing
4. Monitor logs regularly: `railway logs`
5. Set Telegram alerts for trade notifications
6. The bot has automatic kill switches (daily loss limit, max positions)

## Monitoring

```bash
# View logs
railway logs

# Check bot status
railway variables get RUNNING

# Open dashboard
railway open

# SSH into container (debug only)
railway shell
```

## License

MIT

## Support

For issues:
1. Check logs: `railway logs`
2. Verify environment variables
3. Test in paper mode first
4. Review DEPLOYMENT.md
