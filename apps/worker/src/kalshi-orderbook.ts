import { EventEmitter } from 'events'
import { TickerUpdate, OrderbookSnapshot, OrderbookDelta } from './kalshi'

interface OrderbookEntry {
  price: number
  count: number
}

interface MarketOrderbook {
  bids: OrderbookEntry[]  // YES bids (only side shown in Kalshi)
  bestBid: number
  bestAsk: number  // Derived: 100 - best YES bid price
  midPrice: number
  lastUpdate: number
}

/**
 * KalshiOrderbookEngine
 * 
 * Manages orderbook state for Kalshi binary markets.
 * 
 * KEY INSIGHT: Kalshi only shows bids in the orderbook.
 * The ask side is implied because:
 * - YES price = p
 * - NO price = 100 - p
 * 
 * For binary markets:
 * - If YES bid is 45¢, the ask is implied at 100 - 45 = 55¢
 * - This represents the NO side of the market
 */
export class KalshiOrderbookEngine extends EventEmitter {
  private orderbooks: Map<string, MarketOrderbook> = new Map()
  private initialized: Set<string> = new Set()

  /**
   * Process an orderbook snapshot (full refresh)
   * Should be called when first connecting or on reset
   */
  handleSnapshot(snapshot: OrderbookSnapshot) {
    const { marketTicker, bids } = snapshot

    // Sort bids descending by price (highest first)
    const sortedBids = bids.sort((a, b) => b.price - a.price)

    const bestBid = sortedBids.length > 0 ? sortedBids[0].price : 0
    // In binary markets, ask = 100 - bestBid (NO side)
    const bestAsk = bestBid > 0 ? 100 - bestBid : 100
    const midPrice = bestBid > 0 ? (bestBid + bestAsk) / 2 : 50

    this.orderbooks.set(marketTicker, {
      bids: sortedBids,
      bestBid,
      bestAsk,
      midPrice,
      lastUpdate: Date.now(),
    })

    this.initialized.add(marketTicker)
    this.emit('orderbook_updated', {
      marketTicker,
      bestBid,
      bestAsk,
      midPrice,
      depth: sortedBids.length,
    })
  }

  /**
   * Process orderbook deltas (incremental updates)
   * Must be applied AFTER snapshot initialization
   */
  handleDelta(delta: OrderbookDelta) {
    const { marketTicker, deltas } = delta

    if (!this.initialized.has(marketTicker)) {
      console.warn(`⚠️ Received delta for uninitialized market: ${marketTicker}`)
      return
    }

    const ob = this.orderbooks.get(marketTicker)
    if (!ob) return

    // Apply each delta
    for (const d of deltas) {
      if (d.action === 'delete') {
        // Remove entry at this price
        ob.bids = ob.bids.filter(entry => entry.price !== d.price)
      } else {
        // Find existing entry or create new one
        const existing = ob.bids.find(entry => entry.price === d.price)
        if (existing) {
          if (d.count === 0) {
            // Remove if count is zero
            ob.bids = ob.bids.filter(entry => entry.price !== d.price)
          } else {
            // Update count
            existing.count = d.count
          }
        } else if (d.count > 0) {
          // Add new entry
          ob.bids.push({ price: d.price, count: d.count })
        }
      }
    }

    // Re-sort bids
    ob.bids.sort((a, b) => b.price - a.price)

    // Update best bid/ask/mid
    ob.bestBid = ob.bids.length > 0 ? ob.bids[0].price : 0
    ob.bestAsk = ob.bestBid > 0 ? 100 - ob.bestBid : 100
    ob.midPrice = ob.bestBid > 0 ? (ob.bestBid + ob.bestAsk) / 2 : 50
    ob.lastUpdate = Date.now()

    this.emit('orderbook_updated', {
      marketTicker,
      bestBid: ob.bestBid,
      bestAsk: ob.bestAsk,
      midPrice: ob.midPrice,
      depth: ob.bids.length,
    })
  }

  /**
   * Update from ticker message (simplified view)
   */
  handleTicker(ticker: TickerUpdate) {
    const { marketTicker, yesBid, yesAsk } = ticker

    const existing = this.orderbooks.get(marketTicker)
    if (existing) {
      existing.bestBid = yesBid
      existing.bestAsk = yesAsk
      existing.midPrice = (yesBid + yesAsk) / 2
      existing.lastUpdate = Date.now()
    } else {
      // Create minimal orderbook from ticker
      this.orderbooks.set(marketTicker, {
        bids: [{ price: yesBid, count: 0 }],
        bestBid: yesBid,
        bestAsk: yesAsk,
        midPrice: (yesBid + yesAsk) / 2,
        lastUpdate: Date.now(),
      })
      this.initialized.add(marketTicker)
    }

    this.emit('orderbook_updated', {
      marketTicker,
      bestBid: yesBid,
      bestAsk: yesAsk,
      midPrice: (yesBid + yesAsk) / 2,
      depth: 1,
    })
  }

  /**
   * Get current orderbook for a market
   */
  getOrderbook(marketTicker: string): MarketOrderbook | null {
    return this.orderbooks.get(marketTicker) || null
  }

  /**
   * Get best bid for a market
   */
  getBestBid(marketTicker: string): number | null {
    const ob = this.orderbooks.get(marketTicker)
    return ob ? ob.bestBid : null
  }

  /**
   * Get best ask for a market (derived from NO side)
   */
  getBestAsk(marketTicker: string): number | null {
    const ob = this.orderbooks.get(marketTicker)
    return ob ? ob.bestAsk : null
  }

  /**
   * Get mid price for a market
   */
  getMidPrice(marketTicker: string): number | null {
    const ob = this.orderbooks.get(marketTicker)
    return ob ? ob.midPrice : null
  }

  /**
   * Check if orderbook is initialized for a market
   */
  isInitialized(marketTicker: string): boolean {
    return this.initialized.has(marketTicker)
  }

  /**
   * Clear orderbook for a market (e.g., on reconnect)
   */
  clear(marketTicker: string) {
    this.orderbooks.delete(marketTicker)
    this.initialized.delete(marketTicker)
  }

  /**
   * Clear all orderbooks
   */
  clearAll() {
    this.orderbooks.clear()
    this.initialized.clear()
  }

  /**
   * Get all orderbooks for parity scanning.
   */
  getAllOrderbooks(): Map<string, MarketOrderbook> {
    return this.orderbooks
  }
}
