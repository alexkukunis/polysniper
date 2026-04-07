/**
 * Latency Arbitrage Sniper — v2
 *
 * Event-driven: Binance Futures fires spikes directly via callback.
 * Zero delay between WS message and order execution.
 *
 * DRY_RUN mode: when enabled, logs the exact payload but skips real execution.
 *
 * SAFETY RAILS (hardcoded):
 * - 1 contract per order (micro-lot)
 * - Max 5 contracts inventory per side
 * - 100ms throttle between orders
 * - IOC orders with buy_max_cost cap
 * - isTrading mutex prevents double-fire
 * - Event-driven exit checks on every tick (no setInterval)
 */

import { KalshiAPI } from './kalshi-api'
import { WebSocketBridge } from './ws-bridge'
import { BinanceOracle, PriceEvent } from './coinbase'

// Kalshi fee: ~1% of contract value per leg (maker), ~3% (taker).
// For a 50¢ contract, taker fee ≈ 1.5¢ per leg → ~3¢ round-trip.
// We use 2¢ as a conservative estimate.
const KALSHI_FEE_CENTS_PER_LEG = 2
const ROUND_TRIP_FEE_CENTS = KALSHI_FEE_CENTS_PER_LEG * 2

// When crossing spread for stop-loss exits, how many cents to concede
const STOP_LOSS_SPREAD_CONCESSION_CENTS = 1

export interface SnipeAuditEntry {
  time: string
  btcPrice: number
  trigger: string             // e.g. "BTC Spike +$35"
  action: string              // e.g. "Fired IOC Buy YES @ 55¢"
  status: 'filled' | 'canceled' | 'dry_run' | 'error'
  orderId?: string
  edge: number                // ¢ edge captured
  skipReason?: SkipReason     // Why the trade was skipped (if applicable)
  latencyMs?: number          // ms from spike → order submission
  momentumContext?: {         // BTC price context at time of decision
    change2s: number | null
    change5s: number | null
    change30s: number | null
  }
  edgeExplanation?: string    // Human-readable why this trade had edge
  yesAskAtDecision: number    // YES ask at time of decision
  yesBidAtDecision: number    // YES bid at time of decision
  dynamicMinEdge: number      // The computed minimum edge required
  depthCheck?: string         // Orderbook depth at entry price
}

export type SkipReason =
  | 'ask_too_expensive'
  | 'bid_too_cheap'
  | 'max_inventory_yes'
  | 'max_inventory_no'
  | 'no_edge'
  | 'orderbook_not_ready'
  | 'rate_limited'
  | 'order_failed'
  | 'momentum_divergence'    // 30s trend contradicts 2s spike
  | 'insufficient_depth'     // Not enough liquidity at target price
  | 'mutex_locked'           // Already processing a spike
  | 'edge_below_fees'        // Edge doesn't cover round-trip fees

export interface PositionEntry {
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  entryPriceCents: number
  count: number
  orderId: string
  timestamp: string
  btcPriceAtEntry: number
}

export interface PnLSnapshot {
  realizedPnLCents: number     // Total realized P&L
  unrealizedPnLCents: number   // Current inventory mark-to-market
  totalPnLCents: number        // realized + unrealized
  winRate: number              // % of filled trades that were profitable
  totalTrades: number          // Number of completed round-trip trades
  avgLatencyMs: number         // Average latency across all snipe attempts
  bestTradeCents: number       // Best single trade P&L
  worstTradeCents: number      // Worst single trade P&L
  exitOrdersPlaced: number     // Total exit orders fired
  stopLossesTriggered: number  // How many stop-losses hit
  takeProfitsTriggered: number // How many take-profits hit
  timeExitsTriggered: number   // How many time-based exits
  totalFeesPaidCents: number   // Estimated fees paid
}

export interface TradeRecord {
  id: string
  entryTime: string
  exitTime?: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'  // The entry action (buy to open, or sell to open)
  entryPriceCents: number
  exitPriceCents?: number
  count: number
  entryOrderId: string
  exitOrderId?: string
  realizedPnLCents: number     // 0 until exited
  btcPriceAtEntry: number
  btcPriceAtExit?: number
  status: 'open' | 'closed'
}

interface SniperConfig {
  key: string
  secret: string
  demo: boolean
  dryRun: boolean       // If true, skip real execution
  btcMarketTicker: string
  strikePrice: number   // The BTC strike price in dollars (e.g. 70000)
  minEdgeCents: number  // Base minimum edge (before fee adjustment)
  oracle: BinanceOracle    // Reference to Binance price feed
  onMarketSettled?: () => void  // Called when current market settles

  // ── Exit Strategy Config ──
  maxHoldSeconds?: number       // Auto-exit after N seconds (default: 30)
  stopLossBtcUsd?: number       // Exit if BTC reverses by this much against us (default: $30)
  takeProfitCents?: number      // Exit when position reaches this profit (default: 10¢)
}

export class LatencySniper {
  private api: KalshiAPI
  private bridge: WebSocketBridge
  private cfg: SniperConfig

  // State
  private running = false
  private ordersPlaced = 0
  private fillsReceived = 0
  private lastOrderTime = 0
  private spikeTimestamp = 0  // When the last spike was detected

  // ── MUTEX: Prevent double-fire on spike events ──
  private isTrading = false

  // Audit log
  private auditLog: SnipeAuditEntry[] = []

  // Inventory tracking
  private inventoryYes = 0
  private inventoryNo = 0
  private readonly MAX_INVENTORY = 5

  // Rate limiting
  private readonly ORDER_THROTTLE_MS = 100

  // P&L tracking
  private trades: TradeRecord[] = []
  private realizedPnLCents = 0
  private bestTradeCents = 0
  private worstTradeCents = 0
  private latencyMeasurements: number[] = []
  private totalFeesPaidCents = 0

  // Exit strategy config (with defaults)
  private readonly maxHoldMs: number
  private readonly stopLossBtcUsd: number
  private readonly takeProfitCents: number

  // Exit tracking: prevent double-exit on same trade
  private exitingTradeIds = new Set<string>()

  constructor(cfg: SniperConfig, bridge: WebSocketBridge) {
    this.cfg = cfg
    this.api = new KalshiAPI(cfg.key, cfg.secret, cfg.demo)
    this.bridge = bridge

    // Exit strategy defaults
    this.maxHoldMs = (cfg.maxHoldSeconds ?? 30) * 1000
    this.stopLossBtcUsd = cfg.stopLossBtcUsd ?? 30
    this.takeProfitCents = cfg.takeProfitCents ?? 10

    this.bridge.registerMarket({
      ticker: cfg.btcMarketTicker,
      title: cfg.btcMarketTicker,
      event_ticker: '',
      close_time: '',
      category: '💰 BTC',
    })

    this.setupFillListener()
  }

  private setupFillListener() {
    const originalBroadcast = this.bridge.broadcast.bind(this.bridge)
    this.bridge.broadcast = (msg: any) => {
      originalBroadcast(msg)

      if (msg.type === 'fill' && msg.status === 'filled') {
        if (msg.side === 'yes' && msg.action === 'buy') this.inventoryYes += msg.count
        if (msg.side === 'yes' && msg.action === 'sell') this.inventoryYes -= msg.count
        if (msg.side === 'no' && msg.action === 'buy') this.inventoryNo += msg.count
        if (msg.side === 'no' && msg.action === 'sell') this.inventoryNo -= msg.count
        this.fillsReceived++
        console.log(`   📊 Inventory (WS fill): YES=${this.inventoryYes} NO=${this.inventoryNo}`)

        // Track fee on entry
        if (msg.action === 'buy') {
          this.totalFeesPaidCents += ROUND_TRIP_FEE_CENTS
        }

        // Track trade for P&L
        this.onFill(msg)
      }
    }
  }

  /**
   * Track fills and compute P&L per trade.
   */
  private onFill(fill: any) {
    const side: 'yes' | 'no' = fill.side
    const action: 'buy' | 'sell' = fill.action
    const priceCents = fill.price
    const count = fill.count
    const orderId = fill.orderId

    if (action === 'buy') {
      // Opening a position
      const trade: TradeRecord = {
        id: `trade-${this.trades.length + 1}`,
        entryTime: new Date().toISOString(),
        side,
        action,
        entryPriceCents: priceCents,
        count,
        entryOrderId: orderId,
        realizedPnLCents: 0,
        btcPriceAtEntry: this.cfg.oracle.getCurrentPrice(),
        status: 'open',
      }
      this.trades.push(trade)
      console.log(`   📈 Opened ${trade.id}: ${side} ${action} @ ${priceCents}¢`)
    } else {
      // Closing a position — match with most recent open trade on this side
      const openTrade = [...this.trades].reverse().find(t => t.side === side && t.status === 'open')
      if (openTrade) {
        openTrade.exitTime = new Date().toISOString()
        openTrade.exitPriceCents = priceCents
        openTrade.exitOrderId = orderId
        openTrade.btcPriceAtExit = this.cfg.oracle.getCurrentPrice()
        openTrade.status = 'closed'

        // Calculate P&L
        if (side === 'yes') {
          openTrade.realizedPnLCents = (priceCents - openTrade.entryPriceCents) * count
        } else {
          openTrade.realizedPnLCents = (priceCents - openTrade.entryPriceCents) * count
        }

        this.realizedPnLCents += openTrade.realizedPnLCents

        if (openTrade.realizedPnLCents > this.bestTradeCents) {
          this.bestTradeCents = openTrade.realizedPnLCents
        }
        if (openTrade.realizedPnLCents < this.worstTradeCents) {
          this.worstTradeCents = openTrade.realizedPnLCents
        }

        const pnlStr = openTrade.realizedPnLCents >= 0
          ? `+$${(openTrade.realizedPnLCents / 100).toFixed(2)}`
          : `-$${Math.abs(openTrade.realizedPnLCents / 100).toFixed(2)}`

        console.log(`   📉 Closed ${openTrade.id}: ${side} sell @ ${priceCents}¢ | P&L: ${pnlStr}`)

        // Broadcast trade update
        this.bridge.broadcast({
          type: 'trade_update',
          trade: openTrade,
          pnl: this.getPnLSnapshot(),
        })
      }
    }
  }

  async start() {
    console.log('\n' + '🎯'.repeat(25))
    console.log('Latency Arbitrage Sniper v2 Starting')
    console.log('='.repeat(60))
    console.log(`  Environment:    ${this.cfg.demo ? 'DEMO' : 'LIVE ⚠️'}`)
    console.log(`  Dry Run:        ${this.cfg.dryRun ? 'YES (no real orders)' : 'NO (live execution)'}`)
    console.log(`  Target Market:  ${this.cfg.btcMarketTicker}`)
    console.log(`  Price Feed:     Binance Futures BTC/USDT (aggTrade)`)
    console.log(`  Trigger:        $25 in 2000ms`)
    console.log(`  Min Edge:       ${this.cfg.minEdgeCents}¢ + fees`)
    console.log(`  Round-trip fee: ~${ROUND_TRIP_FEE_CENTS}¢ (estimated)`)
    console.log(`  Order Size:     1 contract (hardcoded)`)
    console.log(`  Max Inventory:  ${this.MAX_INVENTORY} per side`)
    console.log(`  Exits:          Event-driven (every tick)`)
    console.log('='.repeat(60) + '\n')

    const bal = await this.api.getBalance()
    console.log(`✅ Connected to Kalshi | Balance: $${(bal.balance / 100).toFixed(2)}`)

    this.running = true
    await this.waitForOrderbook()

    console.log('🔫 Sniper armed. Event-driven — waiting for BTC spike...')
    console.log(`   Exit Strategy: maxHold=${this.maxHoldMs/1000}s | stopLoss=$${this.stopLossBtcUsd} | takeProfit=${this.takeProfitCents}¢\n`)

    setInterval(() => this.broadcastState(), 5000)
  }

  stop() {
    this.running = false
    console.log('\n⏹️  Sniper stopped')
    console.log(`   Exit stats: ${this.exitOrdersPlaced} exits | ${this.stopLossesTriggered} stop-losses | ${this.takeProfitsTriggered} take-profits | ${this.timeExitsTriggered} time exits`)
  }

  /**
   * Called when the current market settles. Stops the sniper and signals
   * that a new market needs to be selected.
   */
  onMarketSettled() {
    if (!this.running) return
    console.log(`\n🏁 Current market settled — stopping sniper, awaiting new market...`)
    this.running = false

    // Clear inventory (contracts are settled)
    const oldYes = this.inventoryYes
    const oldNo = this.inventoryNo
    this.inventoryYes = 0
    this.inventoryNo = 0

    console.log(`   Cleared settled inventory: YES=${oldYes} NO=${oldNo}`)

    if (this.cfg.onMarketSettled) {
      this.cfg.onMarketSettled()
    }
  }

  /**
   * Restart the sniper with a newly selected market.
   */
  async restartWithNewMarket(
    newTicker: string,
    newStrikePrice: number,
  ) {
    console.log(`\n🔄 Restarting sniper with new market: ${newTicker} (strike: $${newStrikePrice.toLocaleString()})`)

    this.cfg.btcMarketTicker = newTicker
    this.cfg.strikePrice = newStrikePrice
    this.running = false

    // Reset orderbook state in bridge
    this.bridge.resetOrderbook()

    // Resubscribe to the new market's orderbook
    this.bridge.registerMarket({
      ticker: newTicker,
      title: newTicker,
      event_ticker: '',
      close_time: '',
      category: '💰 BTC',
    })
    this.bridge.subscribeOrderbook(newTicker)

    // Wait for new orderbook
    await this.waitForOrderbook()

    // Restart
    this.running = true
    const bal = await this.api.getBalance()
    console.log(`✅ Connected to Kalshi | Balance: $${(bal.balance / 100).toFixed(2)}`)
    console.log(`🔫 Sniper re-armed. Event-driven — waiting for BTC spike...\n`)

    this.broadcastState()
  }

  // Get recent audit entries
  getAuditLog(): SnipeAuditEntry[] {
    return [...this.auditLog].reverse()
  }

  // Get reference to Binance oracle (for market rotation price access)
  getCoinbase(): BinanceOracle {
    return this.cfg.oracle
  }

  /**
   * Calculate current P&L snapshot for dashboard display.
   */
  getPnLSnapshot(): PnLSnapshot {
    const closedTrades = this.trades.filter(t => t.status === 'closed')
    const winningTrades = closedTrades.filter(t => t.realizedPnLCents > 0)

    const yesAsk = this.bridge.getYesAskCents() || 0
    const yesBid = this.bridge.getYesBidCents() || 0

    const yesMid = yesAsk && yesBid ? Math.round((yesAsk + yesBid) / 2) : 0
    const noMid = yesMid ? 100 - yesMid : 0

    const openYesTrades = this.trades.filter(t => t.side === 'yes' && t.status === 'open')
    const openNoTrades = this.trades.filter(t => t.side === 'no' && t.status === 'open')

    let unrealizedPnLCents = 0
    if (openYesTrades.length > 0 && yesMid > 0) {
      const yesEntryAvg = openYesTrades.reduce((s, t) => s + t.entryPriceCents * t.count, 0) /
                          openYesTrades.reduce((s, t) => s + t.count, 0)
      unrealizedPnLCents += Math.round((yesMid - yesEntryAvg) * this.inventoryYes)
    }
    if (openNoTrades.length > 0 && noMid > 0) {
      const noEntryAvg = openNoTrades.reduce((s, t) => s + t.entryPriceCents * t.count, 0) /
                         openNoTrades.reduce((s, t) => s + t.count, 0)
      unrealizedPnLCents += Math.round((noMid - noEntryAvg) * this.inventoryNo)
    }

    const avgLatency = this.latencyMeasurements.length > 0
      ? Math.round(this.latencyMeasurements.reduce((a, b) => a + b, 0) / this.latencyMeasurements.length)
      : 0

    return {
      realizedPnLCents: this.realizedPnLCents,
      unrealizedPnLCents,
      totalPnLCents: this.realizedPnLCents + unrealizedPnLCents,
      winRate: closedTrades.length > 0
        ? Math.round((winningTrades.length / closedTrades.length) * 100)
        : 0,
      totalTrades: closedTrades.length,
      avgLatencyMs: avgLatency,
      bestTradeCents: this.bestTradeCents,
      worstTradeCents: this.worstTradeCents,
      exitOrdersPlaced: this.exitOrdersPlaced,
      stopLossesTriggered: this.stopLossesTriggered,
      takeProfitsTriggered: this.takeProfitsTriggered,
      timeExitsTriggered: this.timeExitsTriggered,
      totalFeesPaidCents: this.totalFeesPaidCents,
    }
  }

  /**
   * Get recent trades for dashboard display.
   */
  getRecentTrades(limit = 20): TradeRecord[] {
    return [...this.trades].reverse().slice(0, limit)
  }

  /**
   * Get rolling BTC momentum context from the price buffer.
   */
  getMomentumContext(): {
    change2s: number | null
    change5s: number | null
    change30s: number | null
  } {
    return this.cfg.oracle.getMomentumContext()
  }

  /**
   * Build a human-readable edge explanation.
   */
  buildEdgeExplanation(
    direction: 'spike' | 'drop',
    btcChange: number,
    yesAsk: number,
    yesBid: number,
    maxBuyPrice: number,
    mid: number,
    dynamicMinEdge: number,
  ): string {
    const btcMove = direction === 'spike' ? 'up' : 'down'
    const directionLabel = direction === 'spike' ? '↑' : '↓'

    if (direction === 'spike') {
      return `${directionLabel} BTC +$${Math.abs(btcChange).toFixed(0)} → YES should be ~${mid}¢ but ask still ${yesAsk}¢ (min edge: ${dynamicMinEdge}¢, fees: ${ROUND_TRIP_FEE_CENTS}¢)`
    } else {
      return `${directionLabel} BTC -$${Math.abs(btcChange).toFixed(0)} → YES should be ~${mid}¢ but bid still ${yesBid}¢ (min edge: ${dynamicMinEdge}¢, fees: ${ROUND_TRIP_FEE_CENTS}¢)`
    }
  }

  /**
   * Compute dynamic minimum edge required based on current spread + fees.
   * We need: edge >= roundTripFee + 1¢ profit minimum.
   * Also accounts for spread: wider spread = more slippage risk.
   */
  computeDynamicMinEdge(spreadCents: number): number {
    // Base: round-trip fees
    const minEdge = ROUND_TRIP_FEE_CENTS + 1  // At least 1¢ profit after fees
    // If spread is wide (>3¢), require extra edge for slippage risk
    if (spreadCents > 3) {
      return minEdge + Math.ceil((spreadCents - 3) / 2)
    }
    return minEdge
  }

  // ── EVENT-DRIVEN: Called directly by Binance on spike ──
  async onSpike(event: PriceEvent) {
    if (!this.running) return

    // ── MUTEX: Prevent double-fire ──
    if (this.isTrading) {
      console.log('   ⏳ Mutex locked — already processing a spike, skipping')
      return
    }
    this.isTrading = true

    try {
      await this._onSpike(event)
    } finally {
      this.isTrading = false
    }
  }

  /**
   * Internal spike handler. Called under mutex protection.
   * Also triggers event-driven exit checks on every tick.
   */
  private async _onSpike(event: PriceEvent) {
    // Record spike timestamp for latency measurement
    this.spikeTimestamp = Date.now()

    const direction = event.direction
    const priceStr = event.price.toFixed(2)

    console.log(`🚨 BTC: ${direction.toUpperCase()} | $${priceStr} (${event.change > 0 ? '+' : ''}${event.change.toFixed(2)} in 2s)`)

    if (!this.bridge.isOrderbookReady()) {
      console.log('   ⏳ Orderbook not ready, skipping')
      return
    }

    const yesAsk = this.bridge.getYesAskCents()
    const yesBid = this.bridge.getYesBidCents()

    if (yesAsk === null || yesBid === null) {
      console.log('   ⏳ No orderbook data, skipping')
      return
    }

    const spread = yesAsk - yesBid
    console.log(`   📖 Kalshi: YES bid=${yesBid}¢ ask=${yesAsk}¢ spread=${spread}¢`)

    // ── Event-driven exit check on every tick ──
    await this.checkOpenPositions()

    // ── Momentum filter: 30s trend must confirm 2s spike direction ──
    const momentum = this.getMomentumContext()
    if (momentum.change30s !== null) {
      if (direction === 'spike' && momentum.change30s < 0) {
        console.log(`   ⏭️ Momentum divergence: 2s spike +$${event.change.toFixed(0)} but 30s change $${momentum.change30s.toFixed(0)} — dead cat bounce, skipping`)
        this.addAudit({
          btcPrice: event.price,
          trigger: `BTC Spike +$${event.change.toFixed(0)}`,
          action: 'Skipped (momentum divergence)',
          status: 'canceled',
          edge: 0,
          skipReason: 'momentum_divergence',
          latencyMs: 0,
          momentumContext: momentum,
          edgeExplanation: `2s ↑$${event.change.toFixed(0)} but 30s ↓$${Math.abs(momentum.change30s).toFixed(0)}`,
          yesAskAtDecision: yesAsk,
          yesBidAtDecision: yesBid,
          dynamicMinEdge: this.computeDynamicMinEdge(spread),
        })
        return
      }
      if (direction === 'drop' && momentum.change30s > 0) {
        console.log(`   ⏭️ Momentum divergence: 2s drop -$${Math.abs(event.change).toFixed(0)} but 30s change +$${momentum.change30s.toFixed(0)} — reversal spike, skipping`)
        this.addAudit({
          btcPrice: event.price,
          trigger: `BTC Drop -$${Math.abs(event.change).toFixed(0)}`,
          action: 'Skipped (momentum divergence)',
          status: 'canceled',
          edge: 0,
          skipReason: 'momentum_divergence',
          latencyMs: 0,
          momentumContext: momentum,
          edgeExplanation: `2s ↓$${Math.abs(event.change).toFixed(0)} but 30s ↑$${momentum.change30s.toFixed(0)}`,
          yesAskAtDecision: yesAsk,
          yesBidAtDecision: yesBid,
          dynamicMinEdge: this.computeDynamicMinEdge(spread),
        })
        return
      }
    }

    if (direction === 'spike') {
      await this.trySnipeBuyYes(yesAsk, yesBid, event.price, event.change)
    } else {
      await this.trySnipeSellYes(yesAsk, yesBid, event.price, event.change)
    }
  }

  private addAudit(entry: Omit<SnipeAuditEntry, 'time'>) {
    const auditEntry: SnipeAuditEntry = {
      ...entry,
      time: new Date().toISOString(),
    }
    this.auditLog.push(auditEntry)
    if (this.auditLog.length > 100) this.auditLog.shift()

    // Broadcast to dashboard
    this.bridge.broadcast({
      type: 'audit',
      ...auditEntry,
    })

    console.log(`   📋 AUDIT: ${entry.trigger} → ${entry.action} → ${entry.status}`)
  }

  private async trySnipeBuyYes(currentAsk: number, currentBid: number, btcPrice: number, btcChange: number) {
    const mid = Math.round((currentAsk + currentBid) / 2)
    const spread = currentAsk - currentBid

    // Dynamic edge: must cover fees + slippage
    const dynamicMinEdge = this.computeDynamicMinEdge(spread)
    const maxBuyPrice = mid - dynamicMinEdge
    const trigger = `BTC Spike +$${btcChange.toFixed(0)}`
    const latencyMs = this.spikeTimestamp ? Date.now() - this.spikeTimestamp : 0

    // Track latency measurement
    if (latencyMs > 0) {
      this.latencyMeasurements.push(latencyMs)
      if (this.latencyMeasurements.length > 100) this.latencyMeasurements.shift()
    }

    const momentumContext = this.getMomentumContext()
    const edgeExplanation = this.buildEdgeExplanation('spike', btcChange, currentAsk, currentBid, maxBuyPrice, mid, dynamicMinEdge)

    console.log(`   🎯 Spike: mid=${mid}¢ maxBuy=${maxBuyPrice}¢ ask=${currentAsk}¢ (dynamic minEdge: ${dynamicMinEdge}¢)`)

    // ── Edge check: ask must be cheap enough ──
    if (currentAsk > maxBuyPrice) {
      const reason = (currentAsk - mid) < dynamicMinEdge ? 'edge_below_fees' : 'ask_too_expensive'
      console.log(`   ⏭️ No edge — ask too expensive (need ≤${maxBuyPrice}¢, got ${currentAsk}¢)`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (ask ${currentAsk}¢ > maxBuy ${maxBuyPrice}¢)`,
        status: 'canceled',
        edge: 0,
        skipReason: reason,
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
      })
      return
    }

    // ── Depth check: need ≥1 contract at ask ──
    const askSize = this.bridge.getYesAskBestSize()
    if (askSize === null || askSize < 1) {
      console.log(`   ⏭️ Insufficient depth at ask: ${askSize ?? 'unknown'} contracts (need ≥1)`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (ask depth: ${askSize ?? 'unknown'}, need ≥1)`,
        status: 'canceled',
        edge: 0,
        skipReason: 'insufficient_depth',
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
        depthCheck: `ask=${askSize ?? 'unknown'} < 1`,
      })
      return
    }

    // ── Inventory check ──
    if (this.inventoryYes >= this.MAX_INVENTORY) {
      console.log(`   ⏭️ Max YES inventory (${this.MAX_INVENTORY}), skipping`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (max YES inventory: ${this.MAX_INVENTORY})`,
        status: 'canceled',
        edge: 0,
        skipReason: 'max_inventory_yes',
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
        depthCheck: `ask=${askSize.toFixed(2)}`,
      })
      return
    }

    const snipePrice = Math.min(currentAsk, maxBuyPrice)
    const edge = maxBuyPrice - currentAsk

    if (this.cfg.dryRun) {
      console.log(`   🔫 DRY RUN: Would BUY YES @ ${snipePrice}¢ | 1 contract (IOC)`)
      console.log(`       Payload: { ticker: "${this.cfg.btcMarketTicker}", side: "yes", action: "buy", count_fp: "1.00", yes_price_dollars: "${(snipePrice / 100).toFixed(4)}", time_in_force: "immediate_or_cancel", buy_max_cost: ${snipePrice} }`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Fired IOC Buy YES @ ${snipePrice}¢`,
        status: 'dry_run',
        edge,
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
        depthCheck: `ask=${askSize.toFixed(2)} ≥ 1 ✓`,
      })
      return
    }

    console.log(`   🔫 SNIPING: BUY YES @ ${snipePrice}¢ | 1 contract (IOC)`)
    await this.fireOrder(this.cfg.btcMarketTicker, 'yes', 'buy', 1, snipePrice, trigger, btcPrice, edge, latencyMs, momentumContext, edgeExplanation, currentAsk, currentBid, dynamicMinEdge, `ask=${askSize.toFixed(2)} ≥ 1 ✓`)
  }

  private async trySnipeSellYes(currentAsk: number, currentBid: number, btcPrice: number, btcChange: number) {
    const mid = Math.round((currentAsk + currentBid) / 2)
    const spread = currentAsk - currentBid

    // Dynamic edge
    const dynamicMinEdge = this.computeDynamicMinEdge(spread)
    const minSellPrice = mid + dynamicMinEdge
    const trigger = `BTC Drop -$${Math.abs(btcChange).toFixed(0)}`
    const latencyMs = this.spikeTimestamp ? Date.now() - this.spikeTimestamp : 0

    if (latencyMs > 0) {
      this.latencyMeasurements.push(latencyMs)
      if (this.latencyMeasurements.length > 100) this.latencyMeasurements.shift()
    }

    const momentumContext = this.getMomentumContext()
    const edgeExplanation = this.buildEdgeExplanation('drop', btcChange, currentAsk, currentBid, minSellPrice, mid, dynamicMinEdge)

    console.log(`   🎯 Drop: mid=${mid}¢ minSell=${minSellPrice}¢ bid=${currentBid}¢ (dynamic minEdge: ${dynamicMinEdge}¢)`)

    if (this.inventoryYes > 0) {
      // ── Depth check: need ≥1 contract at bid ──
      const bidSize = this.bridge.getYesBidBestSize()
      if (bidSize === null || bidSize < 1) {
        console.log(`   ⏭️ Insufficient depth at bid: ${bidSize ?? 'unknown'} contracts (need ≥1)`)
        this.addAudit({
          btcPrice,
          trigger,
          action: `Skipped (bid depth: ${bidSize ?? 'unknown'}, need ≥1)`,
          status: 'canceled',
          edge: 0,
          skipReason: 'insufficient_depth',
          latencyMs,
          momentumContext,
          edgeExplanation,
          yesAskAtDecision: currentAsk,
          yesBidAtDecision: currentBid,
          dynamicMinEdge,
          depthCheck: `bid=${bidSize ?? 'unknown'} < 1`,
        })
        return
      }

      if (currentBid < minSellPrice) {
        console.log(`   ⏭️ No edge — bid too cheap`)
        this.addAudit({
          btcPrice,
          trigger,
          action: `Skipped (bid ${currentBid}¢ < minSell ${minSellPrice}¢)`,
          status: 'canceled',
          edge: 0,
          skipReason: 'bid_too_cheap',
          latencyMs,
          momentumContext,
          edgeExplanation,
          yesAskAtDecision: currentAsk,
          yesBidAtDecision: currentBid,
          dynamicMinEdge,
          depthCheck: `bid=${bidSize.toFixed(2)}`,
        })
        return
      }
      const snipePrice = Math.max(currentBid, minSellPrice)
      if (this.cfg.dryRun) {
        console.log(`   🔫 DRY RUN: Would SELL YES @ ${snipePrice}¢`)
        this.addAudit({
          btcPrice,
          trigger,
          action: `Fired IOC Sell YES @ ${snipePrice}¢`,
          status: 'dry_run',
          edge: snipePrice - mid,
          latencyMs,
          momentumContext,
          edgeExplanation,
          yesAskAtDecision: currentAsk,
          yesBidAtDecision: currentBid,
          dynamicMinEdge,
          depthCheck: `bid=${bidSize.toFixed(2)} ≥ 1 ✓`,
        })
        return
      }
      console.log(`   🔫 SNIPING: SELL YES @ ${snipePrice}¢`)
      await this.fireOrder(this.cfg.btcMarketTicker, 'yes', 'sell', 1, snipePrice, trigger, btcPrice, snipePrice - mid, latencyMs, momentumContext, edgeExplanation, currentAsk, currentBid, dynamicMinEdge, `bid=${bidSize.toFixed(2)} ≥ 1 ✓`)
      return
    }

    // No YES → buy NO
    const noAsk = 100 - currentBid
    const noMaxBuy = 100 - minSellPrice

    console.log(`   🔄 No YES → buying NO: ask=${noAsk}¢ maxBuy=${noMaxBuy}¢`)

    if (noAsk > noMaxBuy) {
      console.log(`   ⏭️ No edge on NO side`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (NO ask ${noAsk}¢ > maxBuy ${noMaxBuy}¢)`,
        status: 'canceled',
        edge: 0,
        skipReason: 'no_edge',
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
      })
      return
    }

    if (this.inventoryNo >= this.MAX_INVENTORY) {
      console.log(`   ⏭️ Max NO inventory (${this.MAX_INVENTORY}), skipping`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (max NO inventory: ${this.MAX_INVENTORY})`,
        status: 'canceled',
        edge: 0,
        skipReason: 'max_inventory_no',
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
      })
      return
    }

    const snipePrice = Math.min(noAsk, noMaxBuy)

    if (this.cfg.dryRun) {
      console.log(`   🔫 DRY RUN: Would BUY NO @ ${snipePrice}¢`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Fired IOC Buy NO @ ${snipePrice}¢`,
        status: 'dry_run',
        edge: noMaxBuy - noAsk,
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision: currentAsk,
        yesBidAtDecision: currentBid,
        dynamicMinEdge,
      })
      return
    }

    console.log(`   🔫 SNIPING: BUY NO @ ${snipePrice}¢`)
    await this.fireOrder(this.cfg.btcMarketTicker, 'no', 'buy', 1, snipePrice, trigger, btcPrice, noMaxBuy - noAsk, latencyMs, momentumContext, edgeExplanation, currentAsk, currentBid, dynamicMinEdge)
  }

  private async fireOrder(
    ticker: string,
    side: 'yes' | 'no',
    action: 'buy' | 'sell',
    count: number,
    priceCents: number,
    trigger: string,
    btcPrice: number,
    edge: number,
    latencyMs: number,
    momentumContext: { change2s: number | null; change5s: number | null; change30s: number | null },
    edgeExplanation: string,
    yesAskAtDecision: number,
    yesBidAtDecision: number,
    dynamicMinEdge: number,
    depthCheck?: string,
  ) {
    const now = Date.now()
    const elapsed = now - this.lastOrderTime
    if (elapsed < this.ORDER_THROTTLE_MS) {
      await new Promise((r) => setTimeout(r, this.ORDER_THROTTLE_MS - elapsed))
    }

    try {
      const result = await this.api.createOrder(
        ticker, side, action, count, priceCents,
        'immediate_or_cancel', false,
      )

      this.lastOrderTime = Date.now()
      this.ordersPlaced++

      const order = result.order
      const status = order?.status || 'unknown'
      const orderId = order?.order_id || 'unknown'

      console.log(`   ✅ Order ${status} | ID: ${orderId} | ${side} ${action} @ ${priceCents}¢ × ${count}`)

      this.addAudit({
        btcPrice,
        trigger,
        action: `${action} ${side} @ ${priceCents}¢`,
        status: status === 'executed' || status === 'filling' ? 'filled' : 'canceled',
        edge,
        orderId,
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision,
        yesBidAtDecision,
        dynamicMinEdge,
        depthCheck,
      })

      if (status === 'executed' || status === 'filling') {
        if (action === 'buy' && side === 'yes') this.inventoryYes += count
        if (action === 'sell' && side === 'yes') this.inventoryYes -= count
        if (action === 'buy' && side === 'no') this.inventoryNo += count
        if (action === 'sell' && side === 'no') this.inventoryNo -= count
      }

      return result
    } catch (e: any) {
      this.addAudit({
        btcPrice,
        trigger,
        action: `${action} ${side} @ ${priceCents}¢`,
        status: 'error',
        edge,
        skipReason: 'order_failed',
        latencyMs,
        momentumContext,
        edgeExplanation,
        yesAskAtDecision,
        yesBidAtDecision,
        dynamicMinEdge,
        depthCheck,
      })

      if (e.message.includes('429')) {
        console.log(`   ⚠️ Rate limited — backing off 1s`)
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        console.log(`   ❌ Order failed: ${e.message}`)
      }
      return null
    }
  }

  // ── EVENT-DRIVEN EXIT CHECKS ──
  // Called on every tick from onSpike(), not on a setInterval.

  /**
   * Check all open positions for exit conditions.
   * Called on every new Binance tick — instant reaction to price moves.
   *
   * Exit conditions (any one triggers):
   * 1. Max hold time exceeded → market exit at current bid/ask
   * 2. BTC reversed against position by stopLossBtcUsd → stop-loss
   * 3. Position reached take-profit target → take-profit
   */
  private async checkOpenPositions() {
    const openTrades = this.trades.filter(t => t.status === 'open')
    if (openTrades.length === 0) return

    const currentBtcPrice = this.cfg.oracle.getCurrentPrice()
    const yesBid = this.bridge.getYesBidCents()
    const yesAsk = this.bridge.getYesAskCents()

    if (yesBid === null || yesAsk === null) return
    if (!this.bridge.isOrderbookReady()) return

    const now = Date.now()

    for (const trade of openTrades) {
      // Skip if already exiting (prevent double-exit)
      if (this.exitingTradeIds.has(trade.id)) continue

      const ageMs = now - new Date(trade.entryTime).getTime()
      const ageSec = Math.round(ageMs / 1000)

      // ── Condition 1: Max hold time exceeded ──
      if (ageMs >= this.maxHoldMs) {
        this.timeExitsTriggered++
        console.log(`⏰ TIME EXIT: ${trade.id} held ${ageSec}s (max: ${this.maxHoldMs/1000}s) → exiting at market`)
        await this.exitPosition(trade, 'max_hold_time', yesBid, yesAsk, currentBtcPrice)
        continue
      }

      // ── Condition 2: BTC reversal (stop-loss) ──
      const btcDelta = currentBtcPrice - trade.btcPriceAtEntry
      const sideLabel = trade.side === 'yes' ? 'YES' : 'NO'

      if (trade.side === 'yes' && trade.action === 'buy') {
        // Bought YES expecting BTC to go up → stop if BTC dropped
        if (btcDelta <= -this.stopLossBtcUsd) {
          this.stopLossesTriggered++
          console.log(`🛑 STOP-LOSS: ${trade.id} | ${sideLabel} | BTC dropped $${Math.abs(btcDelta).toFixed(0)} from entry (threshold: $${this.stopLossBtcUsd})`)
          await this.exitPosition(trade, 'stop_loss', yesBid, yesAsk, currentBtcPrice)
          continue
        }
      } else if (trade.side === 'no' && trade.action === 'buy') {
        // Bought NO expecting BTC to go down → stop if BTC rose
        if (btcDelta >= this.stopLossBtcUsd) {
          this.stopLossesTriggered++
          console.log(`🛑 STOP-LOSS: ${trade.id} | ${sideLabel} | BTC rose $${btcDelta.toFixed(0)} from entry (threshold: $${this.stopLossBtcUsd})`)
          await this.exitPosition(trade, 'stop_loss', yesBid, yesAsk, currentBtcPrice)
          continue
        }
      }

      // ── Condition 3: Take-profit reached ──
      let currentPnLCents = 0
      if (trade.side === 'yes' && trade.action === 'buy') {
        currentPnLCents = yesBid - trade.entryPriceCents
      } else if (trade.side === 'no' && trade.action === 'buy') {
        const currentNoBid = 100 - yesAsk
        currentPnLCents = currentNoBid - trade.entryPriceCents
      }

      if (currentPnLCents >= this.takeProfitCents) {
        this.takeProfitsTriggered++
        console.log(`💰 TAKE-PROFIT: ${trade.id} | ${sideLabel} | +${currentPnLCents}¢ (target: ${this.takeProfitCents}¢)`)
        await this.exitPosition(trade, 'take_profit', yesBid, yesAsk, currentBtcPrice)
        continue
      }

      // Log position status every 10 seconds
      if (ageMs > 0 && ageMs % 10000 < 1000) {
        const pnlStr = currentPnLCents >= 0 ? `+${currentPnLCents}¢` : `${currentPnLCents}¢`
        console.log(`   👁️  Position ${trade.id}: ${sideLabel} @ ${trade.entryPriceCents}¢ | Age: ${ageSec}s | P&L: ${pnlStr} | BTC: ${btcDelta >= 0 ? '+' : ''}$${btcDelta.toFixed(0)} from entry`)
      }
    }
  }

  /**
   * Exit an open position at market price.
   * For stop-loss exits: cross the spread by 1¢ to guarantee fill.
   */
  private async exitPosition(
    trade: TradeRecord,
    reason: 'stop_loss' | 'take_profit' | 'max_hold_time',
    yesBid: number,
    yesAsk: number,
    currentBtcPrice: number,
  ) {
    if (trade.status !== 'open') return
    if (this.exitingTradeIds.has(trade.id)) return  // Double-exit guard

    this.exitingTradeIds.add(trade.id)

    const exitSide: 'yes' | 'no' = trade.side
    const exitAction: 'buy' | 'sell' = 'sell'  // Always sell to exit

    // Determine exit price
    let exitPriceCents: number
    if (trade.side === 'yes') {
      exitPriceCents = yesBid  // Sell YES at current bid
    } else {
      exitPriceCents = 100 - yesAsk  // Sell NO: NO bid = 100 - YES ask
    }

    // ── Cross the spread for stop-loss exits ──
    // Concede 1-2¢ to guarantee the matching engine fills us
    if (reason === 'stop_loss') {
      exitPriceCents -= STOP_LOSS_SPREAD_CONCESSION_CENTS
      console.log(`   ⚡ Stop-loss: crossing spread by ${STOP_LOSS_SPREAD_CONCESSION_CENTS}¢ (exit: ${exitPriceCents}¢)`)
    }

    if (exitPriceCents <= 0) {
      console.log(`   ⚠️ Exit price invalid (${exitPriceCents}¢), skipping exit for ${trade.id}`)
      this.exitingTradeIds.delete(trade.id)
      return
    }

    const estimatedPnL = (exitPriceCents - trade.entryPriceCents) * trade.count

    if (this.cfg.dryRun) {
      console.log(`   🔫 DRY RUN EXIT: Would ${exitAction} ${exitSide} @ ${exitPriceCents}¢ | Est P&L: ${estimatedPnL >= 0 ? '+' : ''}${estimatedPnL}¢`)
      this.addAudit({
        btcPrice: currentBtcPrice,
        trigger: `EXIT: ${reason}`,
        action: `${exitAction} ${exitSide} @ ${exitPriceCents}¢ (est P&L: ${estimatedPnL >= 0 ? '+' : ''}${estimatedPnL}¢)`,
        status: 'dry_run',
        edge: estimatedPnL,
        yesAskAtDecision: yesAsk,
        yesBidAtDecision: yesBid,
        dynamicMinEdge: 0,
      })
      this.exitingTradeIds.delete(trade.id)
      return
    }

    console.log(`   🔫 EXITING: ${exitAction} ${exitSide} @ ${exitPriceCents}¢ | Est P&L: ${estimatedPnL >= 0 ? '+' : ''}${estimatedPnL}¢`)

    this.exitOrdersPlaced++

    try {
      const result = await this.api.createOrder(
        this.cfg.btcMarketTicker,
        exitSide,
        exitAction,
        trade.count,
        exitPriceCents,
        'immediate_or_cancel',
        false,
      )

      const order = result.order
      const status = order?.status || 'unknown'
      console.log(`   ✅ Exit order ${status} | ${exitSide} ${exitAction} @ ${exitPriceCents}¢`)

      // Update trade status
      trade.exitTime = new Date().toISOString()
      trade.exitOrderId = order?.order_id
      trade.btcPriceAtExit = currentBtcPrice

      if (status === 'executed' || status === 'filling') {
        trade.exitPriceCents = exitPriceCents
        trade.realizedPnLCents = (exitPriceCents - trade.entryPriceCents) * trade.count
        trade.status = 'closed'
        this.realizedPnLCents += trade.realizedPnLCents

        // Update inventory
        if (trade.side === 'yes') this.inventoryYes -= trade.count
        if (trade.side === 'no') this.inventoryNo -= trade.count

        const pnlStr = trade.realizedPnLCents >= 0
          ? `+$${(trade.realizedPnLCents / 100).toFixed(2)}`
          : `-$${Math.abs(trade.realizedPnLCents / 100).toFixed(2)}`

        console.log(`   📉 Closed ${trade.id}: ${pnlStr} (exit reason: ${reason})`)

        if (trade.realizedPnLCents > this.bestTradeCents) this.bestTradeCents = trade.realizedPnLCents
        if (trade.realizedPnLCents < this.worstTradeCents) this.worstTradeCents = trade.realizedPnLCents
      }

      // Broadcast trade update
      this.bridge.broadcast({
        type: 'trade_update',
        trade,
        pnl: this.getPnLSnapshot(),
        exitReason: reason,
      })

      this.addAudit({
        btcPrice: currentBtcPrice,
        trigger: `EXIT: ${reason}`,
        action: `${exitAction} ${exitSide} @ ${exitPriceCents}¢`,
        status: status === 'executed' || status === 'filling' ? 'filled' : 'canceled',
        edge: trade.realizedPnLCents || 0,
        orderId: order?.order_id,
        yesAskAtDecision: yesAsk,
        yesBidAtDecision: yesBid,
        dynamicMinEdge: 0,
      })

    } catch (e: any) {
      console.log(`   ❌ Exit order failed: ${e.message}`)
      this.addAudit({
        btcPrice: currentBtcPrice,
        trigger: `EXIT: ${reason}`,
        action: `${exitAction} ${exitSide} FAILED: ${e.message}`,
        status: 'error',
        edge: 0,
        skipReason: 'order_failed',
        yesAskAtDecision: yesAsk,
        yesBidAtDecision: yesBid,
        dynamicMinEdge: 0,
      })
    } finally {
      this.exitingTradeIds.delete(trade.id)
    }
  }

  private async waitForOrderbook(): Promise<void> {
    const maxWait = 15000
    const interval = 500
    let waited = 0
    while (!this.bridge.isOrderbookReady() && waited < maxWait) {
      await new Promise((r) => setTimeout(r, interval))
      waited += interval
      if (waited % 3000 === 0) console.log(`   ⏳ Waiting for orderbook... (${waited / 1000}s)`)
    }
    if (!this.bridge.isOrderbookReady()) console.log('   ⚠️ Orderbook not ready after 15s')
  }

  private broadcastState() {
    const pnl = this.getPnLSnapshot()
    const momentum = this.cfg.oracle.getMomentumContext()

    this.bridge.broadcast({
      type: 'bot_state',
      running: this.running,
      ordersPlaced: this.ordersPlaced,
      fillsReceived: this.fillsReceived,
      inventoryYes: this.inventoryYes,
      inventoryNo: this.inventoryNo,
      isDemo: this.cfg.demo,
      dryRun: this.cfg.dryRun,
      orderbookReady: this.bridge.isOrderbookReady(),
      yesBid: this.bridge.getYesBidCents(),
      yesAsk: this.bridge.getYesAskCents(),
      btcPrice: this.cfg.oracle.getCurrentPrice(),
      strikePrice: this.cfg.strikePrice,
      time: new Date().toISOString(),
      // P&L data
      realizedPnLCents: pnl.realizedPnLCents,
      unrealizedPnLCents: pnl.unrealizedPnLCents,
      totalPnLCents: pnl.totalPnLCents,
      winRate: pnl.winRate,
      totalTrades: pnl.totalTrades,
      avgLatencyMs: pnl.avgLatencyMs,
      bestTradeCents: pnl.bestTradeCents,
      worstTradeCents: pnl.worstTradeCents,
      totalFeesPaidCents: pnl.totalFeesPaidCents,
      // Exit strategy stats
      exitOrdersPlaced: this.exitOrdersPlaced,
      stopLossesTriggered: this.stopLossesTriggered,
      takeProfitsTriggered: this.takeProfitsTriggered,
      timeExitsTriggered: this.timeExitsTriggered,
      maxHoldSeconds: this.maxHoldMs / 1000,
      stopLossBtcUsd: this.stopLossBtcUsd,
      takeProfitCents: this.takeProfitCents,
      openPositions: this.trades.filter(t => t.status === 'open').map(t => ({
        id: t.id,
        side: t.side,
        action: t.action,
        entryPriceCents: t.entryPriceCents,
        count: t.count,
        btcPriceAtEntry: t.btcPriceAtEntry,
        ageSeconds: Math.round((Date.now() - new Date(t.entryTime).getTime()) / 1000),
        estimatedPnLCents: t.side === 'yes'
          ? (this.bridge.getYesBidCents() ?? 0) - t.entryPriceCents
          : (100 - (this.bridge.getYesAskCents() ?? 100)) - t.entryPriceCents,
      })),
      // BTC momentum
      btcChange2s: momentum.change2s,
      btcChange5s: momentum.change5s,
      btcChange30s: momentum.change30s,
      // BTC price history for sparkline (last 60 points)
      btcPriceHistory: this.cfg.oracle.getRecentPriceHistory(60),
    })
  }

  // Exit strategy counters (used by checkOpenPositions and broadcastState)
  private exitOrdersPlaced = 0
  private stopLossesTriggered = 0
  private takeProfitsTriggered = 0
  private timeExitsTriggered = 0
}
