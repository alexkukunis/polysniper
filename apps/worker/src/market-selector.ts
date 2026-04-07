/**
 * Market Selector — Auto-find the At-The-Money (ATM) BTC market
 *
 * Kalshi lists dozens of BTC strike prices. We want the one closest
 * to the current spot price — highest volatility and liquidity.
 *
 * Active BTC series:
 * - KXBTC15M: 15-minute expiries (best for latency sniping)
 * - KXBTCD: Daily expiries
 *
 * Boot sequence:
 * 1. Get current BTC spot price from Coinbase
 * 2. Query Kalshi with series_ticker=KXBTC15M (fast-paced, best edge)
 * 3. Extract strike price from ticker/subtitle
 * 4. Select market with smallest |strike - spot| difference
 */

import { KalshiAPI } from './kalshi-api'

export interface SelectedMarket {
  ticker: string
  title: string
  strikePrice: number   // the strike in dollars (e.g. 70000)
  currentPrice: number  // how it's priced on Kalshi (cents, ~50 = ATM)
  distanceFromSpot: number  // $ difference from Binance spot
  series: string        // KXBTC15M, KXBTCD, etc.
}

// Series to try, in priority order (fastest expiry first for sniping)
const BTC_SERIES = ['KXBTC15M', 'KXBTCD', 'KXBTC']

/**
 * Find the ATM BTC market.
 *
 * @param kalshi Kalshi API instance (must be authenticated)
 * @param btcSpotPrice Current BTC/USDT spot price from Coinbase
 * @returns The best market to target, or null if none found
 */
export async function selectAtmMarket(
  kalshi: KalshiAPI,
  btcSpotPrice: number,
): Promise<SelectedMarket | null> {
  console.log(`\n🎯 Market Selector — Finding ATM BTC market (spot: $${btcSpotPrice.toLocaleString()})`)

  // Try each BTC series in priority order
  for (const series of BTC_SERIES) {
    console.log(`   Trying series: ${series}...`)
    const markets = await kalshi.getMarkets('open', 100, 3, series)
    console.log(`   Fetched ${markets.length} open markets from ${series}`)

    if (markets.length === 0) continue

    // Log close times for debugging
    if (markets.length > 0 && markets[0].close_time) {
      const sample = markets[0]
      const closeTime = typeof sample.close_time === 'string' 
        ? sample.close_time 
        : new Date(sample.close_time * 1000).toISOString()
      console.log(`   Sample close time: ${closeTime}`)
    }

    // Parse strikes and find closest to spot
    const candidates = parseBtcMarkets(markets, series, btcSpotPrice)
    console.log(`   ${candidates.length} active candidates after close_time filter`)

    if (candidates.length > 0) {
      // Sort by distance from spot price (closest first)
      candidates.sort((a, b) => a.distanceFromSpot - b.distanceFromSpot)
      const selected = candidates[0]

      console.log(`\n   ✅ Selected ATM Market:`)
      console.log(`      Ticker:  ${selected.ticker}`)
      console.log(`      Series:  ${selected.series}`)
      console.log(`      Strike:  $${selected.strikePrice.toLocaleString()}`)
      console.log(`      Spot:    $${btcSpotPrice.toLocaleString()}`)
      console.log(`      Distance: $${selected.distanceFromSpot.toLocaleString()}`)
      console.log(`      Kalshi Price: ${selected.currentPrice}¢`)

      // Show nearby markets for context
      if (candidates.length > 1) {
        console.log(`\n   ── Nearby markets ──`)
        candidates.slice(1, 4).forEach((c, i) => {
          console.log(`      ${i + 2}. ${c.ticker} | Strike: $${c.strikePrice.toLocaleString()} | Distance: $${c.distanceFromSpot.toLocaleString()} | Price: ${c.currentPrice}¢`)
        })
      }

      return selected
    }
  }

  // If we get here, no BTC markets found in any series
  console.log('   ⚠️ No open BTC markets found in any series: ' + BTC_SERIES.join(', '))
  return null
}

/**
 * Parse BTC market tickers and extract strike prices.
 *
 * KXBTC15M ticker format: KXBTC15M-26APR062030-30
 *   (last segment is NOT a dollar strike — it's an internal ID)
 *
 * Strike prices are in the API response fields:
 *   floor_strike: 68965.34  (the actual BTC price level)
 *   strike_type: "greater_or_equal"
 */
function parseBtcMarkets(
  markets: any[],
  series: string,
  btcSpotPrice: number,
): SelectedMarket[] {
  const candidates: SelectedMarket[] = []
  const now = Date.now()
  const MIN_TIME_TO_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes minimum

  for (const m of markets) {
    const ticker = m.ticker || ''

    // CRITICAL: Filter out markets that have already closed or are about to close
    // Kalshi may still return them as "open" even after close_time has passed
    if (m.close_time) {
      const closeTimeMs = typeof m.close_time === 'string'
        ? new Date(m.close_time).getTime()
        : m.close_time * 1000 // Convert seconds to ms if needed
      const timeUntilClose = closeTimeMs - now

      // Skip if market closed or closes within minimum time window
      if (timeUntilClose < MIN_TIME_TO_EXPIRY_MS) {
        const closeDate = new Date(closeTimeMs)
        const minsLeft = Math.max(0, Math.round(timeUntilClose / 60000))
        console.log(`   ⏭️ Skipping ${ticker} — closes in ${minsLeft}m (min: 5m)`)
        continue
      }
    }

    let strike = 0

    // Priority 1: Use floor_strike from API response (most reliable)
    if (m.floor_strike && typeof m.floor_strike === 'number' && m.floor_strike > 1000) {
      strike = Math.round(m.floor_strike)
    }
    // Priority 2: Use cap_strike
    else if (m.cap_strike && typeof m.cap_strike === 'number' && m.cap_strike > 1000) {
      strike = Math.round(m.cap_strike)
    }
    // Priority 3: Try parsing last segment of ticker (fallback for daily markets)
    else {
      const parts = ticker.split('-')
      const lastPart = parts[parts.length - 1]
      strike = parseInt(lastPart)
      if (isNaN(strike) || strike < 1000) {
        // Check subtitle as last resort
        const subtitle = m.subtitle || ''
        const dollarMatch = subtitle.match(/\$?(\d{4,})/)
        if (dollarMatch) {
          strike = parseInt(dollarMatch[1])
        } else {
          continue  // Can't determine strike
        }
      }
    }

    const distance = Math.abs(btcSpotPrice - strike)

    // Get current Kalshi price
    const kalshiPrice = parseFloat(m.yes_bid_dollars || m.previous_yes_bid_dollars || '0') * 100

    candidates.push({
      ticker,
      title: m.title || ticker,
      series,
      strikePrice: strike,
      currentPrice: Math.round(kalshiPrice),
      distanceFromSpot: distance,
    })
  }

  return candidates
}

/**
 * Wait for Coinbase price feed to have a valid price.
 * Event-driven: resolves the moment the first trade event arrives.
 */
export async function waitForBtcPrice(
  oracle: { setPriceUpdateCallback: (cb: any) => void; getCurrentPrice: () => number },
  maxWaitMs = 15000,
): Promise<number> {
  console.log(`   ⏳ Waiting for first BTC price from Coinbase...`)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Failed to get BTC price from Coinbase after ${maxWaitMs / 1000}s`))
    }, maxWaitMs)

    // Resolve the moment the first trade event arrives
    oracle.setPriceUpdateCallback((price: number) => {
      clearTimeout(timeout)
      resolve(price)
    })
  })
}
