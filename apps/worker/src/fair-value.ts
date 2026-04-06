import { EventEmitter } from 'events'

// ── Types ──────────────────────────────────────────────────────────────────

export interface OrderbookLevel {
  price: number   // price in cents (1-99)
  count: number   // contracts at this level
}

export interface LocalOrderbook {
  marketTicker: string
  yesBids: OrderbookLevel[]   // YES bid side (descending by price)
  noBids: OrderbookLevel[]    // NO bid side (descending by price)
  bestYesBid: number          // highest YES bid
  bestYesAsk: number          // implied: 100 - bestNoBid
  bestNoBid: number           // highest NO bid
  bestNoAsk: number           // implied: 100 - bestYesBid
  midPrice: number            // (bestYesBid + bestYesAsk) / 2
  spread: number              // bestYesAsk - bestYesBid
  lastUpdateTs: number        // timestamp of last update
  snapshotTs: number          // timestamp of last full snapshot
  sequence: number            // delta sequence counter for integrity
}

export interface WsOrderbookSnapshot {
  market_ticker: string
  yes_bids: Array<{ price: number; count: number }>
  no_bids: Array<{ price: number; count: number }>
  ts: number
}

export interface WsOrderbookDelta {
  market_ticker: string
  yes_bids: Array<{ price: number; count: number; action: 'new' | 'update' | 'delete' }>
  no_bids: Array<{ price: number; count: number; action: 'new' | 'update' | 'delete' }>
  ts: number
}

export interface WsTicker {
  marketTicker: string
  yesBid: number
  yesAsk: number
  lastPrice?: number
  volume?: number
  ts: number
}

// ── Configuration ──────────────────────────────────────────────────────────

export interface FairValueConfig {
  checksumIntervalMs: number   // how often to validate against REST snapshot
  staleBookMs: number          // mark book stale if no update in this time
  maxDeltaLag: number          // max acceptable delta lag before requesting resnapshot
}

const DEFAULT_CONFIG: FairValueConfig = {
  checksumIntervalMs: 30_000,  // validate every 30s
  staleBookMs: 15_000,         // stale after 15s without update
  maxDeltaLag: 5_000,          // 5s max delta lag
}

// ── Engine ─────────────────────────────────────────────────────────────────

/**
 * FairValueEngine — maintains local orderbooks from WebSocket deltas,
 * calculates fair value (midprice), and validates integrity.
 *
 * Key insight from Kalshi docs:
 *   - API returns yes_bids AND no_bids (both sides shown in REST orderbook)
 *   - WebSocket deltas also include both yes_bids and no_bids
 *   - YES ask is implied from NO bid: yesAsk = 100 - noBid
 *   - NO ask is implied from YES bid: noAsk = 100 - yesBid
 *   - Midprice = (bestYesBid + bestYesAsk) / 2
 *              = (bestYesBid + (100 - bestNoBid)) / 2
 */
export class FairValueEngine extends EventEmitter {
  private config: FairValueConfig
  private books: Map<string, LocalOrderbook> = new Map()
  private initialized: Set<string> = new Set()
  private staleMarkets: Set<string> = new Set()
  private checksumTimer: ReturnType<typeof setInterval> | null = null
  private staleTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<FairValueConfig>) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Initialize a market from a full REST snapshot.
   * Must be called before applying deltas for a market.
   */
  initFromSnapshot(snapshot: WsOrderbookSnapshot) {
    const yesBids = this.sortAndFilter(snapshot.yes_bids || [])
    const noBids = this.sortAndFilter(snapshot.no_bids || [])

    const bestYesBid = yesBids.length > 0 ? yesBids[0].price : 0
    const bestNoBid = noBids.length > 0 ? noBids[0].price : 0
    const bestYesAsk = noBids.length > 0 ? 100 - noBids[0].price : 100
    const bestNoAsk = yesBids.length > 0 ? 100 - yesBids[0].price : 100
    const midPrice = (bestYesBid + bestYesAsk) / 2
    const spread = bestYesAsk - bestYesBid

    const book: LocalOrderbook = {
      marketTicker: snapshot.market_ticker,
      yesBids,
      noBids,
      bestYesBid,
      bestYesAsk,
      bestNoBid,
      bestNoAsk,
      midPrice,
      spread,
      lastUpdateTs: Date.now(),
      snapshotTs: Date.now(),
      sequence: 0,
    }

    this.books.set(snapshot.market_ticker, book)
    this.initialized.add(snapshot.market_ticker)
    this.staleMarkets.delete(snapshot.market_ticker)

    this.emit('bookInitialized', book)
    this.emit('bookUpdated', book)
  }

  /**
   * Apply WebSocket delta updates to an existing orderbook.
   * Deltas are incremental — they modify the book state.
   */
  applyDelta(delta: WsOrderbookDelta) {
    const ticker = delta.market_ticker
    const book = this.books.get(ticker)

    if (!book) {
      console.warn(`⚠️ Delta for uninitialized market: ${ticker}, skipping`)
      return
    }

    if (!this.initialized.has(ticker)) {
      console.warn(`⚠️ Delta before snapshot: ${ticker}, skipping`)
      return
    }

    // Apply YES bid deltas
    for (const d of delta.yes_bids || []) {
      this.applySideDelta(book.yesBids, d)
    }

    // Apply NO bid deltas
    for (const d of delta.no_bids || []) {
      this.applySideDelta(book.noBids, d)
    }

    // Re-sort and recalculate
    book.yesBids = this.sortAndFilter(book.yesBids)
    book.noBids = this.sortAndFilter(book.noBids)

    book.bestYesBid = book.yesBids.length > 0 ? book.yesBids[0].price : 0
    book.bestNoBid = book.noBids.length > 0 ? book.noBids[0].price : 0
    book.bestYesAsk = book.noBids.length > 0 ? 100 - book.noBids[0].price : 100
    book.bestNoAsk = book.yesBids.length > 0 ? 100 - book.yesBids[0].price : 100
    book.midPrice = (book.bestYesBid + book.bestYesAsk) / 2
    book.spread = book.bestYesAsk - book.bestYesBid
    book.lastUpdateTs = Date.now()
    book.sequence++

    this.staleMarkets.delete(ticker)

    this.emit('bookUpdated', book)
  }

  /**
   * Update book from ticker message (lightweight, less precise).
   * Used as fallback when deltas are lagging.
   */
  updateFromTicker(ticker: WsTicker) {
    const book = this.books.get(ticker.marketTicker)

    if (!book) {
      // Create minimal book from ticker if not initialized
      this.initFromTicker(ticker)
      return
    }

    // Update best bid/ask from ticker
    book.bestYesBid = ticker.yesBid
    book.bestYesAsk = ticker.yesAsk
    book.midPrice = (ticker.yesBid + ticker.yesAsk) / 2
    book.spread = ticker.yesAsk - ticker.yesBid
    book.lastUpdateTs = ticker.ts

    // Note: ticker doesn't give full book depth, so we don't update yesBids/noBids arrays
    this.staleMarkets.delete(ticker.marketTicker)
    this.emit('bookUpdated', book)
  }

  /**
   * Get the current fair value (midprice) for a market.
   */
  getMidPrice(ticker: string): number | null {
    const book = this.books.get(ticker)
    return book ? book.midPrice : null
  }

  /**
   * Get the current spread for a market.
   */
  getSpread(ticker: string): number | null {
    const book = this.books.get(ticker)
    return book ? book.spread : null
  }

  /**
   * Get the full local orderbook for a market.
   */
  getOrderbook(ticker: string): LocalOrderbook | null {
    return this.books.get(ticker) || null
  }

  /**
   * Check if a market's book is initialized and fresh.
   */
  isFresh(ticker: string): boolean {
    const book = this.books.get(ticker)
    if (!book || !this.initialized.has(ticker)) return false
    const age = Date.now() - book.lastUpdateTs
    return age < this.config.staleBookMs
  }

  /**
   * Check if orderbook has sufficient depth (top N levels volume).
   * Returns total contracts on each side for the top N levels.
   */
  getTopDepth(ticker: string, levels = 3): { yesSideVolume: number; noSideVolume: number } {
    const book = this.books.get(ticker)
    if (!book) return { yesSideVolume: 0, noSideVolume: 0 }

    const yesSideVolume = book.yesBids.slice(0, levels).reduce((sum, l) => sum + l.count, 0)
    const noSideVolume = book.noBids.slice(0, levels).reduce((sum, l) => sum + l.count, 0)

    return { yesSideVolume, noSideVolume }
  }

  /**
   * Get all tickers that have fresh books.
   */
  getFreshTickers(): string[] {
    return Array.from(this.initialized).filter(t => this.isFresh(t))
  }

  /**
   * Mark a market for resnapshot (e.g., after reconnect).
   */
  requestResnapshot(ticker: string) {
    this.initialized.delete(ticker)
    this.books.delete(ticker)
    this.staleMarkets.delete(ticker)
    this.emit('resnapshotRequested', ticker)
  }

  /**
   * Start periodic integrity checks.
   */
  startIntegrityChecks() {
    // Stale detection
    this.staleTimer = setInterval(() => this.detectStaleBooks(), 5_000)

    // Checksum / validation interval
    this.checksumTimer = setInterval(() => {
      this.emit('integrityCheck', {
        totalBooks: this.books.size,
        initialized: this.initialized.size,
        stale: this.staleMarkets.size,
      })
    }, this.config.checksumIntervalMs)
  }

  /**
   * Stop integrity checks.
   */
  stopIntegrityChecks() {
    if (this.checksumTimer) {
      clearInterval(this.checksumTimer)
      this.checksumTimer = null
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer)
      this.staleTimer = null
    }
  }

  /**
   * Clear all books (e.g., on major reconnect).
   */
  clearAll() {
    this.books.clear()
    this.initialized.clear()
    this.staleMarkets.clear()
    this.emit('allBooksCleared')
  }

  // ── Internal ───────────────────────────────────────────────────────────

  /**
   * Apply a single delta to a side's orderbook levels.
   */
  private applySideDelta(levels: OrderbookLevel[], delta: { price: number; count: number; action: string }) {
    const idx = levels.findIndex(l => l.price === delta.price)

    switch (delta.action) {
      case 'delete':
        if (idx !== -1) levels.splice(idx, 1)
        break

      case 'new':
      case 'update':
        if (delta.count === 0) {
          // Treat as delete
          if (idx !== -1) levels.splice(idx, 1)
        } else if (idx !== -1) {
          levels[idx].count = delta.count
        } else {
          levels.push({ price: delta.price, count: delta.count })
        }
        break
    }
  }

  /**
   * Sort levels descending by price and filter zero-count entries.
   */
  private sortAndFilter(levels: OrderbookLevel[]): OrderbookLevel[] {
    return levels
      .filter(l => l.count > 0 && l.price > 0 && l.price < 100)
      .sort((a, b) => b.price - a.price)
  }

  /**
   * Create minimal book from ticker data (fallback).
   */
  private initFromTicker(ticker: WsTicker) {
    // yesAsk = 100 - noBid → noBid = 100 - yesAsk
    const impliedNoBid = 100 - ticker.yesAsk

    const book: LocalOrderbook = {
      marketTicker: ticker.marketTicker,
      yesBids: [{ price: ticker.yesBid, count: 0 }],
      noBids: [{ price: impliedNoBid, count: 0 }],
      bestYesBid: ticker.yesBid,
      bestYesAsk: ticker.yesAsk,
      bestNoBid: impliedNoBid,
      bestNoAsk: 100 - ticker.yesBid,
      midPrice: ticker.yesBid + (ticker.yesAsk - ticker.yesBid) / 2,
      spread: ticker.yesAsk - ticker.yesBid,
      lastUpdateTs: ticker.ts,
      snapshotTs: ticker.ts,
      sequence: 0,
    }

    this.books.set(ticker.marketTicker, book)
    this.initialized.add(ticker.marketTicker)
    this.emit('bookInitialized', book)
  }

  /**
   * Detect stale books and emit warning.
   */
  private detectStaleBooks() {
    const now = Date.now()
    for (const [ticker, book] of this.books) {
      const age = now - book.lastUpdateTs
      if (age > this.config.staleBookMs && !this.staleMarkets.has(ticker)) {
        this.staleMarkets.add(ticker)
        console.warn(`⚠️ Stale orderbook: ${ticker} (${(age / 1000).toFixed(0)}s old)`)
        this.emit('staleBook', ticker)
      }
    }
  }
}
