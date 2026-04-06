import { EventEmitter } from 'events'
import { KalshiClient } from './kalshi'
import { KalshiRestClient } from './kalshi-rest'
import { MarketSelector } from './market-selector'
import { FairValueEngine, WsOrderbookSnapshot, WsOrderbookDelta, WsTicker } from './fair-value'
import { MarketMaker, FillEvent } from './market-maker'
import { HybridRiskManager } from './hybrid-risk'

// ── Configuration ──────────────────────────────────────────────────────────

export interface HybridBotConfig {
  bankroll: number
  paperMode: boolean
  dryRun: boolean
  isDemo: boolean
  kalshiAccessKey: string
  kalshiPrivateKey: string
  minVolume24h?: number
  maxSpread?: number
  baseSpreadCents?: number
  orderSize?: number
  maxConcurrentMarkets?: number
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/**
 * HybridBot — Market Making Orchestrator
 *
 * Wires together:
 *   MarketSelector → FairValueEngine → MarketMaker → HybridRiskManager
 *
 * Flow:
 *   1. MarketSelector scans REST /markets every 60s → whitelist
 *   2. WebSocket subscribes to whitelisted markets → orderbook deltas
 *   3. FairValueEngine merges deltas → fair value (midprice)
 *   4. MarketMaker quotes bid/ask around fair value → captures spread
 *   5. HybridRiskManager enforces limits → circuit breaker
 *
 * 24/7 operation with:
 *   - Exponential backoff on WS disconnect
 *   - Auto-resnapshot orderbooks on reconnect
 *   - Persist state to DB every 30s
 *   - Daily PnL reset at midnight
 */
export class HybridBot extends EventEmitter {
  private config: HybridBotConfig

  // Core components
  private wsClient: KalshiClient
  private restClient: KalshiRestClient
  private selector: MarketSelector
  private fairValue: FairValueEngine
  private marketMaker: MarketMaker
  private riskManager: HybridRiskManager

  // State
  private running = false
  private persistTimer: ReturnType<typeof setInterval> | null = null
  private wsConnected = false

  constructor(config: HybridBotConfig) {
    super()
    this.config = config

    // Initialize clients
    this.restClient = new KalshiRestClient(config.kalshiAccessKey, config.kalshiPrivateKey, config.isDemo)
    this.wsClient = new KalshiClient(config.kalshiAccessKey, config.kalshiPrivateKey, config.isDemo)

    // Initialize components
    this.selector = new MarketSelector(this.restClient, {
      minVolume24h: config.minVolume24h || 15_000,
      maxSpread: config.maxSpread || 4,
      scanIntervalMs: 60_000,
    })

    this.fairValue = new FairValueEngine()

    this.marketMaker = new MarketMaker(this.restClient, this.fairValue, {
      baseSpreadCents: config.baseSpreadCents || 2,
      orderSize: config.orderSize || 20,
      maxConcurrentMarkets: config.maxConcurrentMarkets || 3,
    })

    this.riskManager = new HybridRiskManager(config.bankroll, {})
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Start the hybrid bot.
   * Full sequence: REST scan → WS connect → subscribe → start market making.
   */
  async start() {
    if (this.running) return
    this.running = true

    console.log('🚀 HybridBot starting...')
    console.log(`   Bankroll: $${this.config.bankroll}`)
    console.log(`   Mode: ${this.config.paperMode ? 'PAPER' : 'LIVE'}`)
    console.log(`   Environment: ${this.config.isDemo ? 'DEMO' : 'PRODUCTION'}`)
    console.log(`   DRY_RUN: ${this.config.dryRun ? 'YES' : 'NO'}`)

    // Sync risk state from DB
    await this.riskManager.syncFromDb()

    // Wire up all event handlers
    this.wireEvents()

    // Start market selector (scans REST, emits whitelist)
    await this.selector.start()

    // Connect WebSocket (will auto-subscribe when whitelist arrives)
    await this.wsClient.start()

    // Start market maker (will begin quoting once orderbooks are fresh)
    this.marketMaker.start()

    // Start fair value integrity checks
    this.fairValue.startIntegrityChecks()

    // Persist state to DB every 30s
    this.persistTimer = setInterval(() => this.persistState(), 30_000)

    this.emit('started')
    console.log('✅ HybridBot all systems live')
  }

  /**
   * Gracefully stop everything.
   */
  async stop() {
    if (!this.running) return
    this.running = false

    console.log('🛑 HybridBot shutting down...')

    this.marketMaker.pause('Bot shutting down')
    await this.marketMaker.stop()
    this.fairValue.stopIntegrityChecks()
    this.selector.stop()
    this.wsClient.stop()

    if (this.persistTimer) {
      clearInterval(this.persistTimer)
      this.persistTimer = null
    }

    // Final state persist
    await this.persistState()

    this.emit('stopped')
  }

  // ── Event Wiring ───────────────────────────────────────────────────────

  private wireEvents() {
    // ── WebSocket events ───────────────────────────────────────────────
    this.wsClient.on('ticker', (ticker: any) => {
      this.fairValue.updateFromTicker({
        marketTicker: ticker.marketTicker,
        yesBid: ticker.yesBid,
        yesAsk: ticker.yesAsk,
        lastPrice: ticker.lastPrice,
        volume: ticker.volume,
        ts: ticker.ts,
      })
    })

    this.wsClient.on('orderbook_snapshot', (snapshot: any) => {
      this.fairValue.initFromSnapshot({
        market_ticker: snapshot.marketTicker,
        yes_bids: snapshot.bids?.filter((b: any) => b.side === 'yes') || [],
        no_bids: snapshot.bids?.filter((b: any) => b.side === 'no') || [],
        ts: snapshot.ts,
      })
    })

    this.wsClient.on('orderbook_delta', (delta: any) => {
      this.fairValue.applyDelta({
        market_ticker: delta.marketTicker,
        yes_bids: delta.deltas?.filter((d: any) => d.side === 'yes') || [],
        no_bids: delta.deltas?.filter((d: any) => d.side === 'no') || [],
        ts: delta.ts,
      })
    })

    this.wsClient.on('fill', (fill: any) => {
      const fillEvent: FillEvent = {
        orderId: fill.order_id,
        ticker: fill.ticker,
        side: fill.side,
        action: fill.action,
        price: fill.yes_price,
        count: fill.count,
        fees: fill.taker_fees || 0,
        ts: fill.ts,
      }
      this.marketMaker.onFill(fillEvent)
      this.riskManager.recordFill(fill.ticker, fill.side, fill.action, fill.yes_price, fill.count, fill.taker_fees || 0)
    })

    // ── Selector events ────────────────────────────────────────────────
    this.selector.on('marketsAdded', (tickers: string[]) => {
      console.log(`📡 New markets discovered: ${tickers.length}`)
      this.wsClient.subscribe(tickers)
    })

    this.selector.on('marketsRemoved', (tickers: string[]) => {
      console.log(`📡 Markets removed from whitelist: ${tickers.length}`)
      // Request resnapshot for these markets
      for (const ticker of tickers) {
        this.fairValue.requestResnapshot(ticker)
        this.marketMaker.cancelAllOrders()
      }
    })

    this.selector.on('scanComplete', ({ count }: { count: number }) => {
      console.log(`📋 MarketSelector: ${count} markets qualified`)
    })

    // ── Market Maker events ────────────────────────────────────────────
    this.marketMaker.on('ordersPlaced', ({ ticker, bidPrice, askPrice }: any) => {
      this.riskManager.recordOrder(ticker)
    })

    this.marketMaker.on('orderCanceled', ({ ticker }: any) => {
      this.riskManager.recordCancel(ticker)
    })

    this.marketMaker.on('fill', ({ ticker, price, count, fees }: any) => {
      this.riskManager.recordFill(ticker, 'yes', 'buy', price, count, fees)
    })

    this.marketMaker.on('paused', (reason: string) => {
      console.log(`⏸️ MarketMaker paused: ${reason}`)
    })

    this.marketMaker.on('orderError', ({ ticker, error }: any) => {
      console.error(`❌ Order error for ${ticker}:`, error)
    })

    // ── Risk Manager events ────────────────────────────────────────────
    this.riskManager.on('halted', (reason: string) => {
      console.log(`🚨 Risk halt: ${reason}`)
      this.marketMaker.pause(reason)
      this.emit('circuitBreaker', reason)
    })

    // ── Fair Value events ──────────────────────────────────────────────
    this.fairValue.on('staleBook', (ticker: string) => {
      console.warn(`⚠️ Stale orderbook for ${ticker}, requesting resnapshot`)
      this.fairValue.requestResnapshot(ticker)
    })

    this.fairValue.on('integrityCheck', (stats: any) => {
      console.log(`🔍 FairValue integrity: ${stats.totalBooks} books, ${stats.stale} stale`)
    })
  }

  // ── State Persistence ──────────────────────────────────────────────────

  private async persistState() {
    try {
      await this.riskManager.persistState()
    } catch (err) {
      console.error('Failed to persist hybrid bot state:', err)
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  /**
   * Get current bot status for monitoring.
   */
  getStatus() {
    return {
      running: this.running,
      wsConnected: this.wsClient.isConnected(),
      paperMode: this.config.paperMode,
      dryRun: this.config.dryRun,
      bankroll: this.config.bankroll,
      dailyPnl: this.riskManager.getDailyPnl(),
      dailyStats: this.riskManager.getDailyStats(),
      exposures: this.riskManager.getExposures(),
      quotingMarkets: [...this.marketMaker.getQuotingMarkets()],
      whitelistedMarkets: this.selector.getTickers().length,
      orderToTradeRatio: this.riskManager.getOrderToTradeRatio(),
      cancelRate: this.riskManager.getCancelRate(),
      totalDeployed: this.riskManager.getTotalDeployed(),
      riskHalted: this.riskManager.isHalted(),
      riskHaltReason: this.riskManager.getHaltReason(),
    }
  }
}
