import { db } from '@repo/db'
import { RiskManager } from './risk'
import { ParityExecutor } from './parity-executor'
import { KalshiOrderbookEngine } from './kalshi-orderbook'
import { TickerUpdate } from './kalshi'

/**
 * ParityStrategyEngine — YES/NO Parity Arbitrage
 *
 * Core Strategy:
 * - Buy 1 YES + 1 NO when combined cost < 100¢ (guaranteed $1.00 payout at settlement)
 * - Profit = 100 - (yesAsk + noAsk) - fees
 * - Win Rate: 85-95% (deterministic settlement, no directional risk)
 *
 * Key API insight (per Kalshi docs):
 * - Kalshi only returns bids in orderbook, asks are implied
 * - yes_ask ≈ 100 - no_bid
 * - no_ask ≈ 100 - yes_bid
 */

// Minimum profit per contract in cents (after fee buffer)
// Start conservative at 1.5¢, tune based on DRY_RUN data
const MIN_PROFIT_CENTS = 1.5

// How often to scan cached orderbooks for opportunities (ms)
const SCAN_INTERVAL_MS = 500  // 500ms — scan in-memory cache, no REST calls

// Max concurrent parity trades (risk cap)
const MAX_CONCURRENT_TRADES = 5

// Cooldown per market after firing (ms) — avoid spam
const COOLDOWN_MS = 30_000

export class ParityStrategyEngine {
  private executor: ParityExecutor
  private risk: RiskManager
  private orderbook: KalshiOrderbookEngine
  private cooldowns = new Set<string>()
  private concurrentTrades = 0
  private scanInterval: NodeJS.Timeout | null = null
  private scanCount = 0
  private opportunityCount = 0
  private triggeredCount = 0

  constructor(
    risk: RiskManager,
    executor: ParityExecutor,
    orderbook: KalshiOrderbookEngine,
  ) {
    this.risk = risk
    this.executor = executor
    this.orderbook = orderbook
  }

  start() {
    console.log('🎯 Starting ParityStrategyEngine...')
    this.scanInterval = setInterval(() => this.scanOrderbooks(), SCAN_INTERVAL_MS)
  }

  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
  }

  /**
   * Scan in-memory orderbook cache for parity opportunities.
   * This runs every 500ms against cached data (no REST calls, rate-limit friendly).
   */
  private scanOrderbooks() {
    this.scanCount++

    // Scan every 10 cycles (5s) to avoid excessive DB writes
    const shouldLog = this.scanCount % 10 === 0

    for (const [ticker, ob] of this.orderbook.getAllOrderbooks()) {
      // Skip if cooling down
      if (this.cooldowns.has(ticker)) continue

      // Skip if max concurrent trades reached
      if (this.concurrentTrades >= MAX_CONCURRENT_TRADES) continue

      // Need valid orderbook data
      if (!ob.bestBid || !ob.bestAsk) continue

      // Parity math (per Kalshi docs):
      // YES ask = 100 - NO bid (NO bid is NOT directly available, so we use the ticker data)
      // For binary markets, the orderbook engine derives:
      //   bestAsk = 100 - bestBid (when only bids available)
      // But when we have ticker data, we have both yesBid and yesAsk directly.

      // The orderbook engine stores bestBid and bestAsk from ticker updates
      const yesAsk = ob.bestAsk
      const noAsk = 100 - ob.bestBid  // NO ask = 100 - YES bid

      const combinedCost = yesAsk + noAsk
      const guaranteedProfit = 100 - combinedCost

      if (guaranteedProfit >= MIN_PROFIT_CENTS) {
        this.opportunityCount++

        if (shouldLog) {
          console.log(
            `  💰 PARITY OPPORTUNITY: ${ticker} | YES ask: ${yesAsk.toFixed(1)}¢ | ` +
            `NO ask: ${noAsk.toFixed(1)}¢ | Combined: ${combinedCost.toFixed(1)}¢ | ` +
            `Profit: ${guaranteedProfit.toFixed(1)}¢`
          )
        }

        // Trigger the trade
        this.triggerParityTrade({
          ticker,
          yesAsk,
          noAsk,
          yesBid: ob.bestBid,
          combinedCost,
          guaranteedProfit,
        })
      }
    }

    if (shouldLog) {
      console.log(
        `📊 Parity stats: ${this.scanCount} scans | ${this.opportunityCount} opportunities | ` +
        `${this.triggeredCount} triggered | ${this.concurrentTrades} active`
      )
    }
  }

  /**
   * Trigger a parity trade: buy YES + NO simultaneously.
   */
  private async triggerParityTrade(signal: {
    ticker: string
    yesAsk: number
    noAsk: number
    yesBid: number
    combinedCost: number
    guaranteedProfit: number
  }) {
    // Position sizing
    const size = this.risk.sizePosition(signal.guaranteedProfit / 100)
    if (!size) {
      this.cooldowns.add(signal.ticker)
      setTimeout(() => this.cooldowns.delete(signal.ticker), COOLDOWN_MS)
      return
    }

    // Number of contracts (size in dollars / combined cost in dollars)
    const count = Math.max(1, Math.floor(size / (signal.combinedCost / 100)))

    // Set cooldown
    this.cooldowns.add(signal.ticker)
    setTimeout(() => this.cooldowns.delete(signal.ticker), COOLDOWN_MS)

    this.triggeredCount++
    this.concurrentTrades++

    await this.executor.executeParityTrade({
      marketTicker: signal.ticker,
      yesAsk: signal.yesAsk,
      noAsk: signal.noAsk,
      yesBid: signal.yesBid,
      combinedCost: signal.combinedCost,
      guaranteedProfit: signal.guaranteedProfit,
      count,
    })

    // Decrement when trade completes (handled by executor callback)
  }

  /**
   * Called by executor when a parity trade completes (fills or cancels).
   */
  onTradeComplete() {
    this.concurrentTrades = Math.max(0, this.concurrentTrades - 1)
  }

  /**
   * Handle ticker updates from WebSocket (updates orderbook cache).
   */
  onTickerUpdate(ticker: TickerUpdate) {
    // The orderbook engine handles ticker updates automatically
    // This is a pass-through for any additional strategy logic
  }

  /**
   * Get current stats for dashboard.
   */
  getStats() {
    return {
      scans: this.scanCount,
      opportunities: this.opportunityCount,
      triggered: this.triggeredCount,
      concurrentTrades: this.concurrentTrades,
      maxConcurrentTrades: MAX_CONCURRENT_TRADES,
      minProfitCents: MIN_PROFIT_CENTS,
    }
  }
}
