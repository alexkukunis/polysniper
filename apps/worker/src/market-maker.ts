import { EventEmitter } from 'events'
import { KalshiRestClient } from './kalshi-rest'
import { FairValueEngine, LocalOrderbook } from './fair-value'

// ── Types ──────────────────────────────────────────────────────────────────

export interface MakerOrder {
  orderId: string
  ticker: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  price: number       // in cents
  count: number
  placedAt: number    // timestamp
  clientOrderId: string
}

export interface FillEvent {
  orderId: string
  ticker: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  price: number
  count: number
  fees: number
  ts: number
}

export interface MarketMakerConfig {
  baseSpreadCents: number         // target spread in cents (e.g., 2 = 2¢)
  wideSpreadCents: number         // spread during inventory imbalance
  orderSize: number               // contracts per side
  orderTtlMs: number              // auto-cancel + reprice interval
  maxInventoryPerMarket: number   // max directional contracts before widening
  minSpreadForQuote: number       // minimum spread to quote (cents)
  feeMultiplier: number           // only quote if spread >= feeMultiplier * totalFees
  makerFeeBps: number             // maker fee in basis points (e.g., 5 = 0.05¢ per $1)
  repriceIntervalMs: number       // how often to check and reprice
  maxConcurrentMarkets: number    // max markets to quote simultaneously
}

const DEFAULT_CONFIG: MarketMakerConfig = {
  baseSpreadCents: 2,
  wideSpreadCents: 4,
  orderSize: 20,
  orderTtlMs: 12_000,           // 12s TTL
  maxInventoryPerMarket: 30,     // widen if >30 contracts directional
  minSpreadForQuote: 2,          // don't quote if spread < 2¢
  feeMultiplier: 2.5,            // spread must be ≥ 2.5× fees
  makerFeeBps: 5,                // 0.05% maker fee
  repriceIntervalMs: 3_000,      // check every 3s
  maxConcurrentMarkets: 3,
}

// ── Audit Log ──────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: number
  type: 'quote' | 'cancel' | 'fill' | 'reprice' | 'pause' | 'resume' | 'error'
  ticker: string
  details: string
  pnl?: number
}

// ── Market Maker ───────────────────────────────────────────────────────────

/**
 * MarketMaker — passive market making engine for Kalshi binary markets.
 *
 * Strategy:
 *   1. Calculate fair value (midprice) from local orderbook
 *   2. Place post_only bid @ midprice - spread/2, ask @ midprice + spread/2
 *   3. Auto-cancel and reprice every `orderTtlMs` seconds
 *   4. Track inventory — widen spread if one-sided fills accumulate
 *   5. Only quote when spread ≥ feeMultiplier × totalFees (positive expectancy)
 *
 * Non-negotiable rules:
 *   - Always post_only (maker fee, never taker)
 *   - Auto-cancel stale orders
 *   - Widen or pause if inventory exceeds threshold
 *   - Never quote during settlement or paused state
 */
export class MarketMaker extends EventEmitter {
  private config: MarketMakerConfig
  private restClient: KalshiRestClient
  private fairValue: FairValueEngine
  private activeOrders: Map<string, MakerOrder> = new Map()  // orderId -> order
  private inventory: Map<string, number> = new Map()          // ticker -> net contracts (+ = yes, - = no)
  private auditLog: AuditEntry[] = []
  private paused = false
  private pauseReason: string | null = null
  private repriceTimer: ReturnType<typeof setInterval> | null = null
  private quotingMarkets: Set<string> = new Set()

  constructor(
    restClient: KalshiRestClient,
    fairValue: FairValueEngine,
    config?: Partial<MarketMakerConfig>
  ) {
    super()
    this.restClient = restClient
    this.fairValue = fairValue
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Start the market making loop.
   * Checks all whitelisted markets and places/updates quotes.
   */
  start() {
    if (this.repriceTimer) return
    console.log('🏪 MarketMaker starting...')
    this.repriceTimer = setInterval(() => this.repriceLoop(), this.config.repriceIntervalMs)
    this.emit('started')
  }

  /**
   * Stop the market making loop and cancel all orders.
   */
  async stop() {
    if (this.repriceTimer) {
      clearInterval(this.repriceTimer)
      this.repriceTimer = null
    }
    await this.cancelAllOrders()
    this.quotingMarkets.clear()
    this.emit('stopped')
    console.log('🛑 MarketMaker stopped')
  }

  /**
   * Pause quoting (e.g., circuit breaker triggered).
   */
  pause(reason: string) {
    this.paused = true
    this.pauseReason = reason
    this.audit('pause', '', `Paused: ${reason}`)
    console.log(`⏸️ MarketMaker paused: ${reason}`)
    this.emit('paused', reason)
  }

  /**
   * Resume quoting.
   */
  resume() {
    this.paused = false
    this.pauseReason = null
    this.audit('resume', '', 'Resumed')
    console.log('▶️ MarketMaker resumed')
    this.emit('resumed')
  }

  /**
   * Manually set inventory for a market (called after fills).
   */
  setInventory(ticker: string, contracts: number) {
    this.inventory.set(ticker, contracts)
  }

  /**
   * Get current inventory for a market.
   */
  getInventory(ticker: string): number {
    return this.inventory.get(ticker) || 0
  }

  /**
   * Get all active orders.
   */
  getActiveOrders(): Map<string, MakerOrder> {
    return new Map(this.activeOrders)
  }

  /**
   * Get audit log.
   */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog]
  }

  /**
   * Check if currently paused.
   */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Get current quoting markets.
   */
  getQuotingMarkets(): Set<string> {
    return new Set(this.quotingMarkets)
  }

  // ── Core Loop ──────────────────────────────────────────────────────────

  /**
   * Main reprice loop — runs every `repriceIntervalMs`.
   * For each whitelisted market:
   *   1. Check if we should quote (spread, inventory, paused)
   *   2. Cancel stale orders (older than orderTtlMs)
   *   3. Place new orders if needed
   */
  private async repriceLoop() {
    if (this.paused) return

    try {
      const freshTickers = this.fairValue.getFreshTickers()

      // Cancel stale orders first
      this.cancelStaleOrders()

      // Check which markets we can quote (respect maxConcurrentMarkets)
      const eligibleTickers = freshTickers.filter(t => this.shouldQuote(t))

      // Limit to max concurrent markets
      const toQuote = eligibleTickers.slice(0, this.config.maxConcurrentMarkets)

      // Remove markets we're no longer quoting
      for (const ticker of this.quotingMarkets) {
        if (!toQuote.includes(ticker)) {
          this.cancelMarketOrders(ticker)
          this.quotingMarkets.delete(ticker)
        }
      }

      // Place/update quotes for eligible markets
      for (const ticker of toQuote) {
        await this.quoteMarket(ticker)
      }
    } catch (err) {
      console.error('❌ MarketMaker reprice loop error:', err)
      this.audit('error', '', `Reprice loop error: ${(err as Error).message}`)
    }
  }

  // ── Quoting Logic ──────────────────────────────────────────────────────

  /**
   * Check if we should quote a market.
   */
  private shouldQuote(ticker: string): boolean {
    const book = this.fairValue.getOrderbook(ticker)
    if (!book) return false

    // Spread check
    if (book.spread < this.config.minSpreadForQuote) {
      return false
    }

    // Fee check — spread must be wide enough to cover fees profitably
    const expectedFeePerSide = this.calcMakerFee(book.midPrice)
    const totalFees = expectedFeePerSide * 2
    const minRequiredSpread = totalFees * this.config.feeMultiplier
    if (book.spread < minRequiredSpread) {
      return false
    }

    // Inventory check — widen or pause if too directional
    const inv = Math.abs(this.getInventory(ticker))
    if (inv >= this.config.maxInventoryPerMarket * 1.5) {
      return false  // hard pause quoting for this market
    }

    // Freshness check
    if (!this.fairValue.isFresh(ticker)) return false

    return true
  }

  /**
   * Place bid and ask orders for a market.
   */
  private async quoteMarket(ticker: string) {
    const book = this.fairValue.getOrderbook(ticker)
    if (!book) return

    // Determine spread to use (base or wide based on inventory)
    const inv = Math.abs(this.getInventory(ticker))
    const spreadCents = inv >= this.config.maxInventoryPerMarket
      ? this.config.wideSpreadCents
      : this.config.baseSpreadCents

    // Calculate prices
    const halfSpread = Math.round(spreadCents / 2)
    let bidPrice = book.bestYesBid + halfSpread  // bid inside the spread
    let askPrice = book.bestYesAsk - halfSpread  // ask inside the spread

    // Sanity: prices must be 1-99
    bidPrice = Math.max(1, Math.min(99, bidPrice))
    askPrice = Math.max(1, Math.min(99, askPrice))

    // Don't quote if bid >= ask (crossed book)
    if (bidPrice >= askPrice) return

    // Check if we already have valid orders for this market
    const existingOrders = this.getOrdersForMarket(ticker)
    if (existingOrders.length >= 2) {
      // Check if prices changed significantly
      const bidOrder = existingOrders.find(o => o.action === 'buy')
      const askOrder = existingOrders.find(o => o.action === 'sell')

      if (bidOrder && askOrder) {
        const bidDiff = Math.abs(bidOrder.price - bidPrice)
        const askDiff = Math.abs(askOrder.price - askPrice)
        if (bidDiff <= 1 && askDiff <= 1) return  // prices close enough, skip
      }
    }

    // Cancel existing orders for this market
    if (existingOrders.length > 0) {
      this.cancelMarketOrders(ticker)
    }

    // Place bid (buy YES at bidPrice)
    const bidClientOrderId = `${ticker}_bid_${Date.now()}`
    const askClientOrderId = `${ticker}_ask_${Date.now()}`

    // DRY_RUN mode check
    if (process.env.DRY_RUN === 'true') {
      console.log(
        `[DRY_RUN] Would place: ${ticker} bid=${bidPrice}¢ ask=${askPrice}¢ spread=${spreadCents}¢ inv=${this.getInventory(ticker)}`
      )
      this.audit('quote', ticker, `bid=${bidPrice} ask=${askPrice} spread=${spreadCents}`)
      this.quotingMarkets.add(ticker)
      return
    }

    try {
      // Place bid
      const bidResult = await this.restClient.createOrder({
        ticker,
        type: 'limit',
        action: 'buy',
        side: 'yes',
        count: this.config.orderSize,
        yes_price: bidPrice,
        post_only: true,
        time_in_force: 'good_till_canceled',
        client_order_id: bidClientOrderId,
      })

      this.activeOrders.set(bidResult.order.order_id, {
        orderId: bidResult.order.order_id,
        ticker,
        side: 'yes',
        action: 'buy',
        price: bidPrice,
        count: this.config.orderSize,
        placedAt: Date.now(),
        clientOrderId: bidClientOrderId,
      })

      // Place ask (sell YES at askPrice = buy NO at 100-askPrice)
      const askResult = await this.restClient.createOrder({
        ticker,
        type: 'limit',
        action: 'sell',
        side: 'yes',
        count: this.config.orderSize,
        yes_price: askPrice,
        post_only: true,
        time_in_force: 'good_till_canceled',
        client_order_id: askClientOrderId,
      })

      this.activeOrders.set(askResult.order.order_id, {
        orderId: askResult.order.order_id,
        ticker,
        side: 'yes',
        action: 'sell',
        price: askPrice,
        count: this.config.orderSize,
        placedAt: Date.now(),
        clientOrderId: askClientOrderId,
      })

      this.quotingMarkets.add(ticker)
      this.audit('quote', ticker, `bid=${bidPrice} ask=${askPrice} spread=${spreadCents}`)
      this.emit('ordersPlaced', { ticker, bidPrice, askPrice, spreadCents })

      console.log(
        `📊 ${ticker} | bid=${bidPrice}¢ ask=${askPrice}¢ spread=${spreadCents}¢ | inv=${this.getInventory(ticker)}`
      )
    } catch (err) {
      console.error(`❌ Failed to place orders for ${ticker}:`, err)
      this.audit('error', ticker, `Order placement failed: ${(err as Error).message}`)
      this.emit('orderError', { ticker, error: err })
    }
  }

  // ── Order Management ───────────────────────────────────────────────────

  /**
   * Cancel all orders older than orderTtlMs.
   */
  private cancelStaleOrders() {
    const now = Date.now()
    const stale: string[] = []

    for (const [orderId, order] of this.activeOrders) {
      if (now - order.placedAt > this.config.orderTtlMs) {
        stale.push(orderId)
      }
    }

    for (const orderId of stale) {
      this.cancelOrder(orderId)
    }
  }

  /**
   * Cancel all orders for a specific market.
   */
  private cancelMarketOrders(ticker: string) {
    const toCancel: string[] = []
    for (const [orderId, order] of this.activeOrders) {
      if (order.ticker === ticker) {
        toCancel.push(orderId)
      }
    }
    for (const orderId of toCancel) {
      this.cancelOrder(orderId)
    }
  }

  /**
   * Cancel a single order.
   */
  private async cancelOrder(orderId: string) {
    const order = this.activeOrders.get(orderId)
    if (!order) return

    if (process.env.DRY_RUN === 'true') {
      this.activeOrders.delete(orderId)
      this.audit('cancel', order.ticker, `Canceled order ${orderId}`)
      return
    }

    try {
      await this.restClient.cancelOrder(orderId)
      this.activeOrders.delete(orderId)
      this.audit('cancel', order.ticker, `Canceled order ${orderId}`)
      this.emit('orderCanceled', { orderId, ticker: order.ticker })
    } catch (err) {
      // Order may already be filled/canceled — remove from tracking
      this.activeOrders.delete(orderId)
      console.warn(`⚠️ Failed to cancel order ${orderId}:`, (err as Error).message)
    }
  }

  /**
   * Cancel all active orders.
   */
  async cancelAllOrders() {
    const orderIds = [...this.activeOrders.keys()]
    for (const orderId of orderIds) {
      await this.cancelOrder(orderId)
    }
  }

  /**
   * Get orders for a specific market.
   */
  private getOrdersForMarket(ticker: string): MakerOrder[] {
    return [...this.activeOrders.values()].filter(o => o.ticker === ticker)
  }

  // ── Fill Handling ──────────────────────────────────────────────────────

  /**
   * Called when a fill is received. Updates inventory and may trigger reprice.
   */
  onFill(fill: FillEvent) {
    const currentInv = this.getInventory(fill.ticker)

    // Update inventory: + for buy, - for sell
    if (fill.action === 'buy') {
      this.inventory.set(fill.ticker, currentInv + fill.count)
    } else {
      this.inventory.set(fill.ticker, currentInv - fill.count)
    }

    const newInv = this.getInventory(fill.ticker)
    this.audit('fill', fill.ticker, `${fill.side} ${fill.action} ${fill.count} @ ${fill.price}¢ (inv: ${newInv})`, fill.fees)
    this.emit('fill', { ...fill, inventory: newInv })

    console.log(
      `💥 Fill: ${fill.ticker} ${fill.side} ${fill.action} ${fill.count} @ ${fill.price}¢ | inv → ${newInv}`
    )

    // Reprice immediately after fill
    this.cancelMarketOrders(fill.ticker)
  }

  // ── Fee Calculation ────────────────────────────────────────────────────

  /**
   * Calculate maker fee for a single contract at given price.
   * Kalshi fees are in basis points of the contract value.
   * Contract value = price_cents / 100 dollars
   * Fee = contract_value * (feeBps / 10000) in dollars → convert to cents
   */
  private calcMakerFee(priceCents: number): number {
    const contractValueDollars = priceCents / 100
    const feeDollars = contractValueDollars * (this.config.makerFeeBps / 10000)
    return feeDollars * 100 // return in cents
  }

  // ── Audit Logging ──────────────────────────────────────────────────────

  private audit(type: AuditEntry['type'], ticker: string, details: string, pnl?: number) {
    this.auditLog.push({
      ts: Date.now(),
      type,
      ticker,
      details,
      pnl,
    })

    // Keep log bounded (last 1000 entries)
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000)
    }
  }
}
