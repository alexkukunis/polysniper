import { db } from '@repo/db'
import { KalshiRestClient } from './kalshi-rest'

/**
 * ParityScanner — scans all open binary Kalshi markets for YES/NO parity arbitrage.
 *
 * Core logic (per Kalshi API docs):
 * - Kalshi only returns bids (not asks) because asks are implied via YES/NO reciprocity
 * - yes_ask ≈ 100 - no_bid
 * - no_ask ≈ 100 - yes_bid
 *
 * Parity condition:
 *   combinedCost = yes_ask + no_ask
 *   profit = 100 - combinedCost
 *
 * If profit > minProfitThreshold (default 1.5¢ after fee buffer), it's a valid opportunity.
 */

// How often to scan for new markets (ms)
const SCAN_INTERVAL_MS = 120_000  // 2 minutes

// Minimum profit per contract in cents (1.5¢ buffer after fees)
const DEFAULT_MIN_PROFIT = 1.5

export interface ParitySignal {
  eventTicker: string
  marketTicker: string    // YES market ticker
  yesTicker: string
  noTicker: string
  asset: string
  yesBid: number          // YES best bid (cents)
  noBid: number           // NO best bid = 100 - YES ask
  yesAsk: number          // YES best ask = 100 - NO bid
  noAsk: number           // NO best ask = 100 - YES bid
  combinedCost: number    // yesAsk + noAsk
  guaranteedProfit: number // 100 - combinedCost
  expiresAt: Date
}

export class ParityScanner {
  private restClient: KalshiRestClient
  private scanInterval: NodeJS.Timeout | null = null
  private isDemo: boolean
  private minProfit: number
  private activeMarkets = new Map<string, any>()  // ticker → market info
  private onNewMarkets?: (tickers: string[]) => void  // Callback for auto-subscription
  private onOpportunity?: (opportunity: any) => void  // Callback for real-time broadcasting

  constructor(
    restClient: KalshiRestClient,
    isDemo = true,
    minProfit = DEFAULT_MIN_PROFIT,
  ) {
    this.restClient = restClient
    this.isDemo = isDemo
    this.minProfit = minProfit
  }

  /**
   * Register callback for when new markets are discovered.
   * Used to auto-subscribe to WebSocket feeds.
   */
  onNewMarketsDiscovered(callback: (tickers: string[]) => void) {
    this.onNewMarkets = callback
  }

  /**
   * Register callback for opportunity events (real-time broadcasting).
   */
  onOpportunityFound(callback: (opportunity: any) => void) {
    this.onOpportunity = callback
  }

  async start() {
    console.log('🔍 Starting ParityScanner...')
    await this.scan()
    this.scanInterval = setInterval(() => this.scan(), SCAN_INTERVAL_MS)
  }

  stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval)
      this.scanInterval = null
    }
  }

  /**
   * Scan all open binary markets and identify parity opportunities.
   * Uses cursor pagination as per Kalshi docs.
   */
  private async scan() {
    console.log('🔍 Scanning for parity opportunities...')
    try {
      const markets = await this.fetchAllOpenBinaryMarkets()
      console.log(`  Found ${markets.length} open binary markets`)

      let opportunityCount = 0
      let newMarkets: string[] = []

      for (const market of markets) {
        // Only process binary markets
        if (market.market_type !== 'binary') continue
        // Skip settled/closed
        if (market.status !== 'active' && market.status !== 'open') continue

        const ticker = market.ticker
        
        // Track newly discovered markets
        if (!this.activeMarkets.has(ticker)) {
          newMarkets.push(ticker)
        }
        this.activeMarkets.set(ticker, market)

        // Derive bid/ask from market data
        // Per Kalshi docs: yes_ask is derived from NO bid side
        const yesBid = market.last_price || market.yes_bid || 0
        const yesAsk = market.previous_yes_ask || market.yes_ask || (100 - (market.no_bid || 0))
        const noBid = market.no_bid || (100 - yesAsk)
        const noAsk = 100 - yesBid

        // combinedCost = what we pay to buy 1 YES + 1 NO
        const combinedCost = yesAsk + noAsk
        const guaranteedProfit = 100 - combinedCost

        if (guaranteedProfit >= this.minProfit) {
          opportunityCount++

          const opportunityData = {
            eventTicker: market.event_ticker || ticker,
            marketTicker: ticker,
            asset: this.extractAsset(ticker),
            yesBid,
            noBid,
            yesAsk,
            noAsk,
            combinedCost,
            guaranteedProfit,
            triggered: false,
          }

          console.log(
            `  💰 PARITY: ${ticker} | YES ask: ${yesAsk.toFixed(1)}¢ | NO ask: ${noAsk.toFixed(1)}¢ | ` +
            `Combined: ${combinedCost.toFixed(1)}¢ | Profit: ${guaranteedProfit.toFixed(1)}¢`
          )

          // Log to DB for DRY_RUN tracking
          await db.parityOpportunity.create({
            data: opportunityData,
          })

          // Emit event for real-time broadcasting
          if (this.onOpportunity) {
            this.onOpportunity(opportunityData)
          }
        }
      }

      console.log(`✅ Parity scan complete: ${opportunityCount} opportunities found`)

      // Notify about new markets for auto-subscription
      if (newMarkets.length > 0 && this.onNewMarkets) {
        console.log(`📡 Discovered ${newMarkets.length} new markets — auto-subscribing to WebSocket`)
        this.onNewMarkets(newMarkets)
      }
    } catch (err) {
      console.error('❌ ParityScanner error:', err)
    }
  }

  /**
   * Fetch ALL open binary markets using cursor pagination.
   * Per Kalshi docs: use ?limit=100&cursor=... until cursor is null.
   */
  private async fetchAllOpenBinaryMarkets(): Promise<any[]> {
    const allMarkets: any[] = []
    let cursor: string | undefined

    do {
      const result = await this.restClient.getMarkets({
        status: 'open',
        limit: 100,
        cursor,
      })

      if (result.markets) {
        allMarkets.push(...result.markets)
      }

      cursor = (result as any).cursor
    } while (cursor)

    return allMarkets
  }

  /**
   * Extract asset name from market ticker.
   * Supports all Kalshi market categories:
   * - Crypto: BTC-24DEC31-69K-T → BTC
   * - Politics: PRES-2026 → PRES
   * - Economics: FED-RATE-DEC24 → FED-RATE
   * - Weather: NYC-TEMP-JUL4 → NYC-TEMP
   * - Sports: NBA-LAL-GSW → NBA
   */
  private extractAsset(ticker: string): string {
    // Crypto assets
    if (ticker.startsWith('BTC')) return 'BTC'
    if (ticker.startsWith('ETH')) return 'ETH'
    if (ticker.startsWith('SOL')) return 'SOL'
    if (ticker.startsWith('XRP')) return 'XRP'
    if (ticker.startsWith('DOGE')) return 'DOGE'

    // Politics
    if (ticker.startsWith('PRES')) return 'Presidency'
    if (ticker.startsWith('SENATE')) return 'Senate'
    if (ticker.startsWith('HOUSE')) return 'House'
    if (ticker.startsWith('GOV')) return 'Governor'

    // Economics / Fed
    if (ticker.startsWith('FED')) return 'Federal Reserve'
    if (ticker.startsWith('CPI')) return 'Inflation (CPI)'
    if (ticker.startsWith('UNEMP')) return 'Unemployment'
    if (ticker.startsWith('GDP')) return 'GDP'

    // Weather
    if (ticker.startsWith('NYC')) return 'NYC Weather'
    if (ticker.startsWith('LA')) return 'LA Weather'
    if (ticker.startsWith('CHI')) return 'Chicago Weather'

    // Sports
    if (ticker.startsWith('NBA')) return 'NBA'
    if (ticker.startsWith('NFL')) return 'NFL'
    if (ticker.startsWith('MLB')) return 'MLB'
    if (ticker.startsWith('NHL')) return 'NHL'
    if (ticker.startsWith('EPL')) return 'EPL Soccer'

    // Generic fallback: first segment before dash
    const parts = ticker.split('-')
    return parts[0] || 'UNKNOWN'
  }

  /**
   * Get cached active markets for parity evaluation.
   */
  getActiveMarkets(): Map<string, any> {
    return this.activeMarkets
  }

  /**
   * Get a specific market by ticker.
   */
  getMarket(ticker: string): any | undefined {
    return this.activeMarkets.get(ticker)
  }
}
