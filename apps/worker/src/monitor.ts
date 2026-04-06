import { db } from '@repo/db'
import { Executor } from './executor'
import { PolymarketClient } from './polymarket'
import { RiskManager } from './risk'

// Take profit: sell when market reprices this much in our favor
const TAKE_PROFIT_CENTS = 0.10   // exit if price moves 10¢ our way
// Time stop: 45s before window ends — check oracle vs priceToBeat
const TIME_STOP_SECS = 45

export class Monitor {
  private interval: NodeJS.Timeout | null = null

  constructor(
    private executor: Executor,
    private polymarket: PolymarketClient,
    private risk: RiskManager,
  ) {}

  start() {
    // Run every 5 seconds
    this.interval = setInterval(() => this.checkOpenTrades(), 5_000)
    console.log('👁️ Monitor started')
  }

  private async checkOpenTrades() {
    const openIds = this.executor.getOpenPositionIds()
    if (!openIds.length) return

    try {
      const trades = await db.trade.findMany({
        where: { id: { in: openIds }, status: 'OPEN' },
      })

      for (const trade of trades) {
        const now = Date.now()
        const windowEndsAt = new Date(trade.windowEndsAt).getTime()
        const secsLeft = (windowEndsAt - now) / 1000

        // Window has ended — resolve
        if (secsLeft <= 0) {
          await this.executor.closeTrade(trade.id, 1.0, 'RESOLUTION')
          this.risk.onPositionClose()
          continue
        }

        // Get current market for this token
        const book = this.polymarket.getBook(trade.assetId)
        if (!book) continue

        const currentBid = book.bid // what we'd get if we sell now

        // Take profit if market has repriced 10¢ in our favor
        if (currentBid >= trade.entryPrice + TAKE_PROFIT_CENTS) {
          await this.executor.closeTrade(trade.id, currentBid, 'TARGET')
          this.risk.onPositionClose()
          continue
        }

        // Time stop — 45 seconds before window ends
        if (secsLeft < TIME_STOP_SECS) {
          // Check if oracle confirms our side is winning
          const chainlinkPrice = trade.chainlinkAt
          const winning = trade.direction === 'UP'
            ? chainlinkPrice >= trade.priceToBeat
            : chainlinkPrice <= trade.priceToBeat

          if (winning) {
            // Hold to resolution — collect $1.00
            console.log(
              `⏳ ${trade.asset} ${trade.direction} — holding to resolution`
            )
          } else {
            // Oracle says we're on wrong side — sell what we can
            await this.executor.closeTrade(trade.id, currentBid, 'EXPIRY')
            this.risk.onPositionClose()
          }
          continue
        }
      }
    } catch (err) {
      console.error('Monitor check failed:', err)
    }
  }

  stop() {
    if (this.interval) clearInterval(this.interval)
  }
}
