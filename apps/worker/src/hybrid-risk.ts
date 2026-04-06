import { db } from '@repo/db'
import { EventEmitter } from 'events'

// ── Configuration ──────────────────────────────────────────────────────────

export interface HybridRiskConfig {
  bankroll: number
  dailyLossLimitPct: number    // halt if daily PnL drops below this %
  maxDeployedPct: number       // max % of bankroll deployed as open orders
  maxConcurrentMarkets: number // max markets to have exposure in
  perMarketExposurePct: number // max % of bankroll at risk per market
  orderToTradeRatioLimit: number // Kalshi compliance: keep O/T ratio below this
  maxCancelRate: number        // max cancel rate (compliance)
}

const DEFAULT_CONFIG: Omit<HybridRiskConfig, 'bankroll'> = {
  dailyLossLimitPct: 0.015,       // 1.5% daily loss → circuit breaker
  maxDeployedPct: 0.30,           // max 30% of bankroll in open orders
  maxConcurrentMarkets: 3,
  perMarketExposurePct: 0.01,     // 1% of bankroll per market
  orderToTradeRatioLimit: 10,     // Kalshi compliance
  maxCancelRate: 0.70,            // 70% max cancel rate
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ExposureRecord {
  ticker: string
  contracts: number
  avgEntryPrice: number
  currentPnl: number
  realizedPnl: number
  feesPaid: number
  tradesCount: number
  ordersCount: number
  cancelsCount: number
  lastUpdated: number
}

export interface DailyStats {
  date: string
  startingBalance: number
  currentPnl: number
  tradesCount: number
  ordersPlaced: number
  ordersCanceled: number
  feesPaid: number
  maxDrawdown: number
  peakPnl: number
}

// ── Hybrid Risk Manager ───────────────────────────────────────────────────

/**
 * HybridRiskManager — risk controls for the market making + mean reversion bot.
 *
 * Responsibilities:
 *   - Track per-market exposure and total deployed capital
 *   - Enforce daily circuit breaker (-1.5% → halt)
 *   - Monitor order-to-trade ratio (Kalshi compliance)
 *   - Track fills, fees, PnL in real-time
 *   - Emit alerts when thresholds are approached
 *
 * Non-negotiable:
 *   - Daily loss limit is absolute — no override
 *   - Per-market exposure caps prevent catastrophic single-market loss
 *   - Order-to-trade ratio monitored to avoid Kalshi account review
 */
export class HybridRiskManager extends EventEmitter {
  private config: HybridRiskConfig
  private dailyStats: DailyStats
  private exposures: Map<string, ExposureRecord> = new Map()
  private halted = false
  private haltReason: string | null = null
  private totalOrdersPlaced = 0
  private totalOrdersCanceled = 0
  private totalFills = 0

  constructor(bankroll: number, config?: Partial<Omit<HybridRiskConfig, 'bankroll'>>) {
    super()
    this.config = { bankroll, ...DEFAULT_CONFIG, ...config }
    this.dailyStats = this.createDailyStats()
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Check if a new order is allowed under risk limits.
   * Returns { allowed: true } or { allowed: false, reason: string }
   */
  canPlaceOrder(ticker: string, orderValueCents: number): { allowed: boolean; reason?: string } {
    if (this.halted) {
      return { allowed: false, reason: `Bot halted: ${this.haltReason}` }
    }

    // Daily loss limit check
    const dailyLossLimit = this.config.bankroll * this.config.dailyLossLimitPct
    if (this.dailyStats.currentPnl < -dailyLossLimit) {
      this.triggerHalt(`Daily loss limit breached: PnL=${this.dailyStats.currentPnl.toFixed(0)}¢ < -${dailyLossLimit.toFixed(0)}¢`)
      return { allowed: false, reason: 'Daily circuit breaker triggered' }
    }

    // Max deployed capital check
    const totalDeployed = this.getTotalDeployed()
    const maxDeployed = this.config.bankroll * this.config.maxDeployedPct
    if (totalDeployed + orderValueCents > maxDeployed) {
      return {
        allowed: false,
        reason: `Max deployed capital reached: ${(totalDeployed / 100).toFixed(0)}$ / ${(maxDeployed / 100).toFixed(0)}$`,
      }
    }

    // Per-market exposure check
    const marketExposure = this.exposures.get(ticker)
    const maxPerMarket = this.config.bankroll * this.config.perMarketExposurePct
    if (marketExposure) {
      const marketValue = Math.abs(marketExposure.contracts) * marketExposure.avgEntryPrice
      if (marketValue + orderValueCents > maxPerMarket) {
        return {
          allowed: false,
          reason: `Per-market exposure limit: ${ticker} at ${(marketValue / 100).toFixed(0)}$`,
        }
      }
    }

    // Max concurrent markets check
    if (this.exposures.size >= this.config.maxConcurrentMarkets && !marketExposure) {
      return {
        allowed: false,
        reason: `Max concurrent markets: ${this.config.maxConcurrentMarkets}`,
      }
    }

    // Order-to-trade ratio check (Kalshi compliance)
    if (this.totalFills > 0) {
      const otRatio = this.totalOrdersPlaced / this.totalFills
      if (otRatio > this.config.orderToTradeRatioLimit) {
        return {
          allowed: false,
          reason: `Order-to-trade ratio too high: ${otRatio.toFixed(1)} (limit: ${this.config.orderToTradeRatioLimit})`,
        }
      }
    }

    return { allowed: true }
  }

  /**
   * Record an order placement.
   */
  recordOrder(ticker: string) {
    this.totalOrdersPlaced++
    this.dailyStats.ordersPlaced++

    if (!this.exposures.has(ticker)) {
      this.exposures.set(ticker, this.createExposure(ticker))
    }
    this.exposures.get(ticker)!.ordersCount++
    this.emit('orderRecorded', { ticker, totalOrders: this.totalOrdersPlaced })
  }

  /**
   * Record an order cancellation.
   */
  recordCancel(ticker: string) {
    this.totalOrdersCanceled++
    this.dailyStats.ordersCanceled++

    const exp = this.exposures.get(ticker)
    if (exp) exp.cancelsCount++

    this.emit('cancelRecorded', { ticker, totalCancels: this.totalOrdersCanceled })
  }

  /**
   * Record a fill. Updates exposure and PnL.
   */
  recordFill(ticker: string, side: 'yes' | 'no', action: 'buy' | 'sell', price: number, count: number, fees: number) {
    this.totalFills++
    this.dailyStats.tradesCount++
    this.dailyStats.feesPaid += fees

    let exp = this.exposures.get(ticker)
    if (!exp) {
      exp = this.createExposure(ticker)
      this.exposures.set(ticker, exp)
    }

    // Update exposure
    const direction = action === 'buy' ? 1 : -1
    const totalContracts = exp.contracts + (direction * count)

    // Recalculate average entry if adding to position
    if (action === 'buy' && exp.contracts >= 0) {
      const totalCost = (exp.contracts * exp.avgEntryPrice) + (count * price)
      exp.avgEntryPrice = totalContracts > 0 ? totalCost / totalContracts : price
    }

    exp.contracts = totalContracts
    exp.tradesCount++
    exp.feesPaid += fees
    exp.lastUpdated = Date.now()

    // Update daily PnL
    this.dailyStats.currentPnl -= fees  // fees are negative PnL

    // Track peak PnL and max drawdown
    if (this.dailyStats.currentPnl > this.dailyStats.peakPnl) {
      this.dailyStats.peakPnl = this.dailyStats.currentPnl
    }
    const drawdown = this.dailyStats.peakPnl - this.dailyStats.currentPnl
    if (drawdown > this.dailyStats.maxDrawdown) {
      this.dailyStats.maxDrawdown = drawdown
    }

    this.emit('fillRecorded', { ticker, side, action, price, count, fees, inventory: exp.contracts })
    console.log(
      `📊 ${ticker} | ${action} ${count} ${side} @ ${price}¢ | fees: ${fees}¢ | inv: ${exp.contracts} | daily PnL: ${this.dailyStats.currentPnl.toFixed(0)}¢`
    )
  }

  /**
   * Update PnL from a realized trade (settlement or closed position).
   */
  updatePnl(delta: number) {
    this.dailyStats.currentPnl += delta

    // Check circuit breaker
    const dailyLossLimit = this.config.bankroll * this.config.dailyLossLimitPct
    if (this.dailyStats.currentPnl < -dailyLossLimit && !this.halted) {
      this.triggerHalt(`Daily loss limit: PnL=${this.dailyStats.currentPnl.toFixed(0)}¢ < -${dailyLossLimit.toFixed(0)}¢`)
    }

    this.emit('pnlUpdated', { dailyPnl: this.dailyStats.currentPnl, halted: this.halted })
  }

  /**
   * Reset daily stats at midnight UTC.
   */
  resetDaily() {
    const oldStats = { ...this.dailyStats }
    this.dailyStats = this.createDailyStats()
    this.emit('dailyReset', oldStats)
    console.log('🔄 Daily stats reset')
  }

  /**
   * Sync state from database (on startup).
   */
  async syncFromDb() {
    try {
      const state = await db.botState.findUnique({ where: { id: 'singleton' } })
      if (state) {
        this.config.bankroll = state.bankroll
        if (state.dailyPnl !== 0) {
          this.dailyStats.currentPnl = state.dailyPnl
        }
      }

      // Load today's stats if available
      const today = new Date().toISOString().split('T')[0]
      const todayStats = await db.dailyStats.findFirst({
        where: { date: new Date(today) },
        orderBy: { date: 'desc' },
      })
      if (todayStats) {
        this.dailyStats = {
          date: todayStats.date.toISOString().split('T')[0],
          startingBalance: todayStats.startingBalance,
          currentPnl: todayStats.currentPnl,
          tradesCount: todayStats.tradesCount,
          ordersPlaced: todayStats.ordersPlaced,
          ordersCanceled: todayStats.ordersCanceled,
          feesPaid: todayStats.feesPaid,
          maxDrawdown: todayStats.maxDrawdown,
          peakPnl: todayStats.peakPnl,
        }
      }
    } catch (err) {
      console.error('Failed to sync risk state from DB:', err)
    }
  }

  /**
   * Persist state to database.
   */
  async persistState() {
    try {
      await db.botState.update({
        where: { id: 'singleton' },
        data: {
          dailyPnl: this.dailyStats.currentPnl,
          lastHeartbeat: new Date(),
        },
      })

      // Upsert daily stats
      const today = new Date(this.dailyStats.date)
      await db.dailyStats.upsert({
        where: { date: today },
        create: {
          date: today,
          startingBalance: this.dailyStats.startingBalance,
          currentPnl: this.dailyStats.currentPnl,
          tradesCount: this.dailyStats.tradesCount,
          ordersPlaced: this.dailyStats.ordersPlaced,
          ordersCanceled: this.dailyStats.ordersCanceled,
          feesPaid: this.dailyStats.feesPaid,
          maxDrawdown: this.dailyStats.maxDrawdown,
          peakPnl: this.dailyStats.peakPnl,
        },
        update: {
          currentPnl: this.dailyStats.currentPnl,
          tradesCount: this.dailyStats.tradesCount,
          ordersPlaced: this.dailyStats.ordersPlaced,
          ordersCanceled: this.dailyStats.ordersCanceled,
          feesPaid: this.dailyStats.feesPaid,
          maxDrawdown: this.dailyStats.maxDrawdown,
          peakPnl: this.dailyStats.peakPnl,
        },
      })
    } catch (err) {
      console.error('Failed to persist risk state:', err)
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────

  isHalted(): boolean { return this.halted }
  getHaltReason(): string | null { return this.haltReason }
  getDailyPnl(): number { return this.dailyStats.currentPnl }
  getDailyStats(): DailyStats { return { ...this.dailyStats } }
  getExposures(): Map<string, ExposureRecord> { return new Map(this.exposures) }
  getExposure(ticker: string): ExposureRecord | null {
    return this.exposures.get(ticker) || null
  }
  getOrderToTradeRatio(): number {
    return this.totalFills > 0 ? this.totalOrdersPlaced / this.totalFills : 0
  }
  getCancelRate(): number {
    const total = this.totalOrdersPlaced
    return total > 0 ? this.totalOrdersCanceled / total : 0
  }
  getTotalDeployed(): number {
    let total = 0
    for (const exp of this.exposures.values()) {
      total += Math.abs(exp.contracts) * exp.avgEntryPrice
    }
    return total
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private createDailyStats(): DailyStats {
    const today = new Date().toISOString().split('T')[0]
    return {
      date: today,
      startingBalance: this.config.bankroll,
      currentPnl: 0,
      tradesCount: 0,
      ordersPlaced: 0,
      ordersCanceled: 0,
      feesPaid: 0,
      maxDrawdown: 0,
      peakPnl: 0,
    }
  }

  private createExposure(ticker: string): ExposureRecord {
    return {
      ticker,
      contracts: 0,
      avgEntryPrice: 0,
      currentPnl: 0,
      realizedPnl: 0,
      feesPaid: 0,
      tradesCount: 0,
      ordersCount: 0,
      cancelsCount: 0,
      lastUpdated: Date.now(),
    }
  }

  private triggerHalt(reason: string) {
    this.halted = true
    this.haltReason = reason
    console.log(`🚨 CIRCUIT BREAKER: ${reason}`)
    this.emit('halted', reason)
  }
}
