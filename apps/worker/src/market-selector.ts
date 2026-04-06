import { KalshiRestClient, MarketInfo } from './kalshi-rest'
import { EventEmitter } from 'events'

export interface MarketFilterConfig {
  minVolume24h: number          // minimum 24h volume (contracts)
  maxSpread: number             // max bid-ask spread in cents
  minTteHours: number           // minimum time to expiration (hours)
  maxTteDays: number            // maximum time to expiration (days)
  minParticipants: number       // minimum unique participants
  excludeCategories: string[]   // categories to skip entirely
  scanIntervalMs: number        // how often to refresh whitelist
}

export interface WhitelistedMarket {
  ticker: string
  eventTicker: string
  title: string
  category: string
  volume24h: number
  yesBid: number
  yesAsk: number
  spread: number
  midPrice: number
  expirationTime: string
  tteHours: number
  liquidity: number
  yesBids: Array<{ price: number; count: number }>
  noBids: Array<{ price: number; count: number }>
}

const DEFAULT_CONFIG: MarketFilterConfig = {
  minVolume24h: 15_000,         // 15k contracts minimum
  maxSpread: 4,                 // max 4¢ spread
  minTteHours: 12,              // at least 12h until settlement
  maxTteDays: 7,                // no more than 7 days out
  minParticipants: 5,           // at least 5 participants (from orderbook depth)
  excludeCategories: [],        // user-configurable
  scanIntervalMs: 60_000,       // scan every 60s
}

/**
 * MarketSelector — scans Kalshi markets and filters to a whitelist
 * suitable for market making.
 *
 * Filtering criteria:
 * - volume_24h > threshold (liquidity)
 * - spread ≤ maxSpread (tight enough for profitable quoting)
 * - TTE between minTteHours and maxTteDays (not settling soon, not too far out)
 * - orderbook depth ≥ minParticipants (real liquidity, not spoof)
 * - excluded categories skipped
 */
export class MarketSelector extends EventEmitter {
  private config: MarketFilterConfig
  private restClient: KalshiRestClient
  private running = false
  private whitelist: Map<string, WhitelistedMarket> = new Map()
  private scanTimer: ReturnType<typeof setInterval> | null = null

  constructor(restClient: KalshiRestClient, config?: Partial<MarketFilterConfig>) {
    super()
    this.restClient = restClient
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start periodic market scanning.
   * Runs the filter loop every `scanIntervalMs`.
   */
  async start() {
    if (this.running) return
    this.running = true
    console.log('🔍 MarketSelector starting...')

    // Run immediately, then on interval
    await this.scanAndFilter()
    this.scanTimer = setInterval(() => this.scanAndFilter(), this.config.scanIntervalMs)
  }

  /**
   * Stop the periodic scanner.
   */
  stop() {
    this.running = false
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    console.log('🛑 MarketSelector stopped')
  }

  /**
   * Get current whitelist of qualified markets.
   */
  getWhitelist(): Map<string, WhitelistedMarket> {
    return new Map(this.whitelist)
  }

  /**
   * Get array of whitelisted tickers.
   */
  getTickers(): string[] {
    return Array.from(this.whitelist.keys())
  }

  /**
   * Main filter loop — fetches all active markets, applies filters,
   * emits changes if whitelist updated.
   */
  private async scanAndFilter() {
    if (!this.running) return

    try {
      const oldWhitelist = new Set(this.whitelist.keys())
      this.whitelist.clear()

      const markets = await this.fetchAllActiveMarkets()
      console.log(`📊 Scanned ${markets.length} active markets`)

      const qualified: WhitelistedMarket[] = []

      for (const market of markets) {
        if (this.shouldExclude(market)) continue
        if (!this.passesVolumeFilter(market)) continue
        if (!this.passesSpreadFilter(market)) continue
        if (!this.passesTteFilter(market)) continue

        const orderbook = await this.fetchOrderbookSafely(market.ticker)
        if (!orderbook) continue

        const yesBids = orderbook.yes || []
        const noBids = orderbook.no || []

        // Derive spread from orderbook
        const bestYesBid = yesBids.length > 0 ? yesBids[0].price : 0
        const bestNoBid = noBids.length > 0 ? noBids[0].price : 0

        // Per Kalshi docs: NO price = 100 - YES price
        // YES ask is implied from NO bid: yesAsk = 100 - noBid
        const yesAsk = noBids.length > 0 ? 100 - noBids[0].price : 100
        const spread = yesAsk - bestYesBid
        const midPrice = (bestYesBid + yesAsk) / 2

        // Check spread filter again with real orderbook data
        if (spread > this.config.maxSpread || spread <= 0) continue

        // Check participant count (from orderbook depth)
        const uniqueYesPrices = new Set(yesBids.map(b => b.price)).size
        const uniqueNoPrices = new Set(noBids.map(b => b.price)).size
        if (uniqueYesPrices + uniqueNoPrices < this.config.minParticipants) continue

        const tteMs = new Date(market.expiration_time).getTime() - Date.now()
        const tteHours = tteMs / (1000 * 60 * 60)

        const whitelisted: WhitelistedMarket = {
          ticker: market.ticker,
          eventTicker: market.event_ticker,
          title: market.title,
          category: market.category,
          volume24h: market.volume_24h,
          yesBid: bestYesBid,
          yesAsk,
          spread,
          midPrice,
          expirationTime: market.expiration_time,
          tteHours,
          liquidity: market.liquidity,
          yesBids,
          noBids,
        }

        this.whitelist.set(market.ticker, whitelisted)
        qualified.push(whitelisted)
      }

      // Diff to find additions/removals
      const newTickers = qualified.filter(m => !oldWhitelist.has(m.ticker))
      const removedTickers = [...oldWhitelist].filter(t => !this.whitelist.has(t))

      if (newTickers.length > 0 || removedTickers.length > 0) {
        console.log(
          `📋 Whitelist updated: ${qualified.length} markets ` +
          `(+${newTickers.length} / -${removedTickers.length})`
        )
        if (newTickers.length > 0) {
          this.emit('marketsAdded', newTickers.map(m => m.ticker))
        }
        if (removedTickers.length > 0) {
          this.emit('marketsRemoved', removedTickers)
        }
      } else {
        console.log(`📋 Whitelist unchanged: ${qualified.length} markets`)
      }

      this.emit('scanComplete', { count: qualified.length, markets: qualified })
    } catch (err) {
      console.error('❌ MarketSelector scan error:', err)
      this.emit('scanError', err)
    }
  }

  /**
   * Fetch all active markets using cursor pagination.
   * Per Kalshi docs: paginated with cursor, default limit 100.
   */
  private async fetchAllActiveMarkets(): Promise<MarketInfo[]> {
    const allMarkets: MarketInfo[] = []
    let cursor: string | undefined

    do {
      const response = await this.restClient.getMarkets({
        status: 'open',
        limit: 100,
        cursor,
      })

      allMarkets.push(...(response.markets || []))
      cursor = response.cursor
    } while (cursor)

    return allMarkets
  }

  /**
   * Fetch orderbook for a single market, with error handling.
   */
  private async fetchOrderbookSafely(ticker: string) {
    try {
      return await this.restClient.getOrderbook(ticker)
    } catch (err) {
      console.warn(`⚠️ Failed to fetch orderbook for ${ticker}:`, (err as Error).message)
      return null
    }
  }

  /**
   * Check if market should be excluded by category.
   */
  private shouldExclude(market: MarketInfo): boolean {
    if (this.config.excludeCategories.includes(market.category)) {
      console.log(`⏭️ Excluded by category: ${market.ticker} (${market.category})`)
      return true
    }
    return false
  }

  /**
   * Check minimum 24h volume.
   */
  private passesVolumeFilter(market: MarketInfo): boolean {
    const passes = market.volume_24h >= this.config.minVolume24h
    if (!passes) {
      console.log(`⏭️ Low volume: ${market.ticker} (24h vol: ${market.volume_24h})`)
    }
    return passes
  }

  /**
   * Check spread from market data (preliminary, refined later with orderbook).
   */
  private passesSpreadFilter(market: MarketInfo): boolean {
    const bid = market.previous_yes_bid
    const ask = market.previous_yes_ask
    if (bid == null || ask == null) return false

    const spread = ask - bid
    const passes = spread <= this.config.maxSpread && spread > 0
    if (!passes) {
      console.log(`⏭️ Spread too wide: ${market.ticker} (spread: ${spread}¢)`)
    }
    return passes
  }

  /**
   * Check time-to-expiration is within bounds.
   */
  private passesTteFilter(market: MarketInfo): boolean {
    const tteMs = new Date(market.expiration_time).getTime() - Date.now()
    const tteHours = tteMs / (1000 * 60 * 60)
    const tteDays = tteHours / 24

    const passes = tteHours >= this.config.minTteHours && tteDays <= this.config.maxTteDays
    if (!passes) {
      console.log(
        `⏭️ TTE out of range: ${market.ticker} (${tteHours.toFixed(1)}h)`
      )
    }
    return passes
  }
}
