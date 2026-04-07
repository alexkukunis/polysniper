import { loadEnv, getKalshiPrivateKey, validateKalshiCredentials } from './env'

// Load environment variables (local .env file or Railway-injected)
loadEnv()

import { WebSocketBridge, DataProvider } from './ws-bridge'
import { LatencySniper } from './simple-bot'
import { BinanceOracle } from './coinbase'
import { KalshiAPI } from './kalshi-api'
import { selectAtmMarket, waitForBtcPrice } from './market-selector'

// ── Configuration ──

const key = process.env.KALSHI_ACCESS_KEY || ''
const secret = getKalshiPrivateKey()
const demo = process.env.KALSHI_DEMO !== 'false'
const dryRun = process.env.DRY_RUN !== 'false'  // Default: dry run for safety

// Validate credentials on startup
const validation = validateKalshiCredentials()
if (!validation.valid) {
  console.error('\n❌ Credential validation failed:')
  validation.errors.forEach(err => console.error(`   • ${err}`))
  process.exit(1)
}
console.log('')  // Add spacing after validation output
const spikeThreshold = parseInt(process.env.SPIKE_THRESHOLD || '50')
const spikeWindowMs = parseInt(process.env.SPIKE_WINDOW_MS || '2000')
const minEdgeCents = parseInt(process.env.MIN_EDGE_CENTS || '1')  // Loose: 1¢ edge minimum

// Exit strategy config (tweak these before going live!)
const maxHoldSeconds = parseInt(process.env.MAX_HOLD_SECONDS || '30')
const stopLossBtcUsd = parseInt(process.env.STOP_LOSS_BTC_USD || '30')
const takeProfitCents = parseInt(process.env.TAKE_PROFIT_CENTS || '10')

if (!key || !secret) {
  console.error('❌ Missing API credentials!')
  process.exit(1)
}

// ── Shared state for market rotation ──
let sniper: LatencySniper | null = null
let kalshi: KalshiAPI | null = null

/**
 * Select a new ATM market and restart the sniper.
 * Called on boot AND whenever the current market settles.
 */
async function selectAndRestart(btcPrice: number) {
  if (!kalshi || !sniper) return

  console.log('\n🎯 Market Selector — Finding next ATM BTC market...')
  const selected = await selectAtmMarket(kalshi, btcPrice)
  if (!selected) {
    console.error('❌ Failed to find next ATM market. Will retry in 30s...')
    setTimeout(() => selectAndRestart(btcPrice), 30000)
    return
  }

  console.log(`\n✅ Next target: ${selected.ticker} | Strike: $${selected.strikePrice.toLocaleString()}`)

  await sniper.restartWithNewMarket(selected.ticker, selected.strikePrice)
}

async function main() {
  console.log('\n' + '🚀'.repeat(25))
  console.log('KalshiSniper — Latency Arbitrage Bot v2')
  console.log('='.repeat(60))
  console.log(`Environment:     ${demo ? 'DEMO' : 'LIVE'}`)
  console.log(`Dry Run:         ${dryRun ? 'YES (simulated only)' : 'NO (live execution)'}`)
  console.log('─'.repeat(60))
  console.log(`Entry Config:`)
  console.log(`  Price Feed:      Binance Futures (btcusdt@aggTrade)`)
  console.log(`  Spike Thresh:    $${spikeThreshold} (2s window)`)
  console.log(`  Min Edge:        ${minEdgeCents}¢ + dynamic fee adj`)
  console.log(`  Momentum Filter: 30s trend must confirm 2s spike`)
  console.log(`  Depth Check:     Require ≥1 contract at target`)
  console.log(`Exit Strategy:`)
  console.log(`  Max Hold:        ${maxHoldSeconds}s`)
  console.log(`  Stop-Loss:       $${stopLossBtcUsd} BTC reversal`)
  console.log(`  Take-Profit:     ${takeProfitCents}¢`)
  console.log(`  Exit Mode:       Event-driven (every tick)`)
  console.log(`  SL Spread Cross: 1¢ concession for guaranteed fill`)
  console.log('='.repeat(60) + '\n')

  // Initialize Kalshi API once (reused across market rotations)
  kalshi = new KalshiAPI(key, secret, demo)

  // Step 1: Start WebSocket bridge (port configurable via WS_PORT env var)
  const wsPort = parseInt(process.env.WS_PORT || '3002', 10)
  const bridge = new WebSocketBridge(wsPort, '/ws', {
    key, secret, demo,
    onMarketSettled: (ticker: string, status: string) => {
      console.log(`\n🔄 Auto-rotation triggered: ${ticker} ${status}`)
      if (sniper) {
        sniper.onMarketSettled()
        // After sniper stops, select next market and restart
        const btcPrice = sniper.getCoinbase().getCurrentPrice()
        if (btcPrice > 0) {
          selectAndRestart(btcPrice)
        } else {
          console.error('❌ No BTC price available, cannot select next market')
        }
      }
    },
  })
  await bridge.start()

  // Step 2: Connect to Binance Futures
  console.log('📡 Step 1: Connecting to Binance Futures...')

  let btcPrice = 0
  const oracle = new BinanceOracle({
    windowMs: spikeWindowMs,
    thresholdUsd: spikeThreshold,
    onSpike: () => {},  // Temp no-op — replaced below
  })
  oracle.start()

  btcPrice = await waitForBtcPrice(oracle)
  console.log(`✅ BTC Price: $${btcPrice.toLocaleString()}\n`)

  // Step 3: Auto-select ATM market
  let btcMarketTicker = process.env.KALSHI_BTC_TICKER || ''
  let strikePrice = 0

  if (!demo && !btcMarketTicker) {
    console.log('📡 Step 2: Auto-selecting ATM BTC market...')
    const selected = await selectAtmMarket(kalshi, btcPrice)
    if (!selected) {
      console.error('❌ Failed to select ATM market.')
      process.exit(1)
    }
    btcMarketTicker = selected.ticker
    strikePrice = selected.strikePrice
    console.log(`\n✅ Target: ${btcMarketTicker} | Strike: $${strikePrice.toLocaleString()}`)
  } else if (demo) {
    btcMarketTicker = 'KXBTC-DEMO'
    strikePrice = 70000  // Default demo strike (will be updated on first bot_state)
  } else {
    console.log(`📡 Step 2: Using configured ticker: ${btcMarketTicker}`)
  }

  bridge.registerMarket({
    ticker: btcMarketTicker,
    title: `BTC Daily ${btcMarketTicker}`,
    event_ticker: '',
    close_time: '',
    category: '💰 BTC',
  })
  bridge.subscribeOrderbook(btcMarketTicker)

  // Step 4: Create sniper
  console.log('\n📡 Step 3: Initializing sniper...')
  sniper = new LatencySniper({
    key, secret, demo, dryRun,
    btcMarketTicker,
    strikePrice,
    minEdgeCents: minEdgeCents,
    oracle,
    maxHoldSeconds,
    stopLossBtcUsd,
    takeProfitCents,
  }, bridge)

  // Register sniper as data provider for HTTP API
  bridge.registerDataProvider(sniper)
  console.log('✅ HTTP API registered (audit, trades, pnl, state)')

  // Wire event-driven callback
  oracle.setSpikeCallback((event) => sniper!.onSpike(event))
  console.log('✅ Binance callback registered → sniper\n')

  await sniper.start()

  const shutdown = () => {
    console.log('\n⏹️  Shutting down...')
    sniper?.stop()
    bridge.stop()
    oracle.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('💥 Fatal:', err)
  process.exit(1)
})
