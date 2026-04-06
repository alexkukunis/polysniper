import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(__dirname, '../../../.env') })

import { KalshiClient } from './kalshi'
import { KalshiRestClient } from './kalshi-rest'
import { ParityScanner } from './parity-scanner'
import { KalshiOrderbookEngine } from './kalshi-orderbook'
import { ParityStrategyEngine } from './parity-strategy'
import { ParityExecutor } from './parity-executor'
import { BalanceMonitor } from './balance-monitor'
import { RiskManager } from './risk'
import { RealTimeBridge } from './realtime-bridge'
import { HybridBot } from './hybrid-bot'
import { db } from '@repo/db'
import { sendAlert } from './alerts'
import http from 'http'

// Configuration from environment
const bankroll = parseFloat(process.env.BANKROLL_USDC || '1000')
const paperMode = process.env.PAPER_MODE !== 'false' // default to true
const isDemo = process.env.KALSHI_DEMO !== 'false' // default to demo
const dryRun = process.env.DRY_RUN !== 'false' // DRY_RUN by default

// Kalshi API credentials
const kalshiAccessKey = process.env.KALSHI_ACCESS_KEY || ''
const kalshiPrivateKey = process.env.KALSHI_PRIVATE_KEY || ''

// Bot mode: 'parity' (legacy YES/NO arbitrage) or 'hybrid' (market making)
const botMode = (process.env.BOT_MODE || 'hybrid') as 'parity' | 'hybrid'

async function main() {
  const strategyLabel = botMode === 'hybrid' ? 'Hybrid Market Making' : 'YES/NO Parity Arbitrage'

  console.log(`🚀 Starting Kalshi Bot — ${strategyLabel}...`)
  console.log(`   Bankroll: $${bankroll}`)
  console.log(`   Mode: ${paperMode ? 'PAPER' : 'LIVE'}`)
  console.log(`   Environment: ${isDemo ? 'DEMO' : 'PRODUCTION'}`)
  console.log(`   DRY_RUN: ${dryRun ? 'YES (logging only)' : 'NO (executing trades)'}`)
  console.log(`   BOT_MODE: ${botMode}`)

  // Initialize bot state in DB
  await db.botState.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      bankroll,
      running: true,
      paperMode,
      dailyPnl: 0,
      totalPnl: 0,
    },
    update: {
      running: true,
      pausedReason: null,
      lastHeartbeat: new Date(),
      paperMode,
    },
  })

  // Initialize Kalshi clients
  const kalshiWsClient = new KalshiClient(kalshiAccessKey, kalshiPrivateKey, isDemo)
  const kalshiRestClient = new KalshiRestClient(kalshiAccessKey, kalshiPrivateKey, isDemo)

  // Start real-time bridge for event-driven dashboard updates
  const realtimeBridge = new RealTimeBridge(3002, '/ws-realtime')
  await realtimeBridge.start()

  // Heartbeat every 30s
  setInterval(async () => {
    try {
      await db.botState.update({
        where: { id: 'singleton' },
        data: { lastHeartbeat: new Date() },
      })
    } catch {}
  }, 30_000)

  // Health check endpoint for Railway
  http.createServer((_, res) => {
    const status = botMode === 'hybrid' && hybridBot
      ? hybridBot.getStatus()
      : { status: 'ok', paperMode, bankroll, dryRun, exchange: 'kalshi', strategy: strategyLabel }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status))
  }).listen(process.env.PORT || 3001)

  // ── Route to the correct strategy ──────────────────────────────────

  let hybridBot: HybridBot | null = null

  if (botMode === 'hybrid') {
    // ── HYBRID MARKET MAKING MODE ────────────────────────────────────
    hybridBot = new HybridBot({
      bankroll,
      paperMode,
      dryRun,
      isDemo,
      kalshiAccessKey,
      kalshiPrivateKey,
      minVolume24h: parseInt(process.env.MM_MIN_VOLUME_24H || '15000'),
      maxSpread: parseInt(process.env.MM_MAX_SPREAD || '4'),
      baseSpreadCents: parseInt(process.env.MM_BASE_SPREAD_CENTS || '2'),
      orderSize: parseInt(process.env.MM_ORDER_SIZE || '20'),
      maxConcurrentMarkets: parseInt(process.env.MM_MAX_MARKETS || '3'),
    })

    // Wire hybrid events to real-time bridge
    hybridBot.on('started', async () => {
      await sendAlert(
        `✅ Hybrid Market Maker live | Paper: ${paperMode} | DRY_RUN: ${dryRun} | Bankroll: $${bankroll} | ${isDemo ? 'DEMO' : 'LIVE'}`
      )
    })

    hybridBot.on('circuitBreaker', async (reason: string) => {
      await sendAlert(`🚨 Circuit breaker triggered: ${reason}`)
    })

    await hybridBot.start()

    console.log(
      `✅ Hybrid Market Maker live | Paper: ${paperMode} | DRY_RUN: ${dryRun} | Exchange: Kalshi`
    )
  } else {
    // ── LEGACY PARITY ARBITRAGE MODE ─────────────────────────────────
    const risk = new RiskManager(bankroll)
    const executor = new ParityExecutor(dryRun, paperMode)
    const orderbook = new KalshiOrderbookEngine()
    const strategy = new ParityStrategyEngine(risk, executor, orderbook)
    const scanner = new ParityScanner(kalshiRestClient, isDemo)
    const balanceMonitor = new BalanceMonitor(kalshiRestClient)

    // Wire executor <-> Kalshi REST client
    executor.setKalshiClient(kalshiRestClient)

    // Wire executor -> real-time bridge for event-driven dashboard updates
    executor.onTrade(async (trade) => {
      await realtimeBridge.broadcastTrade(trade)
      await realtimeBridge.broadcastStateUpdate()
    })

    // Wire executor PnL updates -> risk manager (daily loss limit tracking)
    executor.setPnlCallback((pnl: number) => {
      risk.updatePnl(pnl)
    })

    // Wire scanner -> real-time bridge for opportunity events
    scanner.onOpportunityFound(async (opportunity) => {
      await realtimeBridge.broadcastOpportunity(opportunity)
    })

    // Reset daily stats at midnight
    const msUntilMidnight = () => {
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      return midnight.getTime() - now.getTime()
    }
    setTimeout(function resetDaily() {
      risk.resetDaily()
      setTimeout(resetDaily, 86_400_000)
    }, msUntilMidnight())

    // ── Wire Kalshi WebSocket → Orderbook Engine ──
    kalshiWsClient.on('ticker', (ticker: any) => {
      orderbook.handleTicker(ticker)
      strategy.onTickerUpdate(ticker)
    })

    kalshiWsClient.on('orderbook_snapshot', (snapshot: any) => {
      orderbook.handleSnapshot(snapshot)
    })

    kalshiWsClient.on('orderbook_delta', (delta: any) => {
      orderbook.handleDelta(delta)
    })

    kalshiWsClient.on('fill', (fill: any) => {
      console.log('📋 Fill received:', fill)
      strategy.onTradeComplete()
    })

    // ── Start all services ──
    await scanner.start()
    await kalshiWsClient.start()

    scanner.onNewMarketsDiscovered((tickers: string[]) => {
      kalshiWsClient.subscribe(tickers)
      console.log(`📡 Auto-subscribed to ${tickers.length} new markets via WebSocket`)
    })

    setTimeout(async () => {
      const tickers = [...orderbook.getAllOrderbooks().keys()]
      if (tickers.length > 0) {
        kalshiWsClient.subscribe(tickers)
        console.log(`📋 Subscribed to ${tickers.length} markets via WebSocket`)
      }
    }, 5000)

    strategy.start()
    balanceMonitor.start()

    await sendAlert(
      `✅ Kalshi Parity Bot live | Paper: ${paperMode} | DRY_RUN: ${dryRun} | Bankroll: $${bankroll} | ${isDemo ? 'DEMO' : 'LIVE'}`
    )
    console.log(
      `✅ All systems live | Paper: ${paperMode} | DRY_RUN: ${dryRun} | Exchange: Kalshi | Strategy: YES/NO Parity Arbitrage`
    )
  }
}

main().catch(async err => {
  console.error('Fatal:', err)
  await sendAlert(`🚨 Kalshi Bot crashed: ${err.message}`)
  process.exit(1)
})
