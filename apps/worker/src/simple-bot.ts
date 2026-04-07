/**
 * Latency Arbitrage Sniper
 *
 * Event-driven: Coinbase fires spikes directly via callback.
 * Zero delay between WS message and order execution.
 *
 * DRY_RUN mode: when enabled, logs the exact payload but skips real execution.
 *
 * SAFETY RAILS (hardcoded):
 * - 1 contract per order (micro-lot)
 * - Max 5 contracts inventory per side
 * - 100ms throttle between orders
 * - IOC orders with buy_max_cost cap
 */

import { KalshiAPI } from './kalshi-api'
import { WebSocketBridge } from './ws-bridge'
import { Coinbase, PriceEvent } from './coinbase'

export interface SnipeAuditEntry {
  time: string
  btcPrice: number
  trigger: string       // e.g. "BTC Spike +$35"
  action: string        // e.g. "Fired IOC Buy YES @ 55¢"
  status: 'filled' | 'canceled' | 'dry_run' | 'error'
  orderId?: string
  edge: number          // ¢ edge captured
}

interface SniperConfig {
  key: string
  secret: string
  demo: boolean
  dryRun: boolean       // If true, skip real execution
  btcMarketTicker: string
  strikePrice: number   // The BTC strike price in dollars (e.g. 70000)
  minEdgeCents: number
  coinbase: Coinbase    // Reference to Coinbase price feed
  onMarketSettled?: () => void  // Called when current market settles
}

export class LatencySniper {
  private api: KalshiAPI
  private bridge: WebSocketBridge
  private cfg: SniperConfig

  // State
  private running = false
  private ordersPlaced = 0
  private fillsReceived = 0
  private lastOrderTime = 0

  // Audit log
  private auditLog: SnipeAuditEntry[] = []

  // Inventory tracking
  private inventoryYes = 0
  private inventoryNo = 0
  private readonly MAX_INVENTORY = 5

  // Rate limiting
  private readonly ORDER_THROTTLE_MS = 100

  constructor(cfg: SniperConfig, bridge: WebSocketBridge) {
    this.cfg = cfg
    this.api = new KalshiAPI(cfg.key, cfg.secret, cfg.demo)
    this.bridge = bridge

    this.bridge.registerMarket({
      ticker: cfg.btcMarketTicker,
      title: cfg.btcMarketTicker,
      event_ticker: '',
      close_time: '',
      category: '💰 BTC',
    })
    // subscribeOrderbook already called in index.ts — skip here to avoid duplicate
    // this.bridge.subscribeOrderbook(cfg.btcMarketTicker)

    this.setupFillListener()
  }

  private setupFillListener() {
    const originalBroadcast = this.bridge.broadcast.bind(this.bridge)
    this.bridge.broadcast = (msg: any) => {
      originalBroadcast(msg)

      if (msg.type === 'fill' && msg.status === 'filled') {
        if (msg.side === 'yes' && msg.action === 'buy') this.inventoryYes += msg.count
        if (msg.side === 'yes' && msg.action === 'sell') this.inventoryYes -= msg.count
        if (msg.side === 'no' && msg.action === 'buy') this.inventoryNo += msg.count
        if (msg.side === 'no' && msg.action === 'sell') this.inventoryNo -= msg.count
        this.fillsReceived++
        console.log(`   📊 Inventory (WS fill): YES=${this.inventoryYes} NO=${this.inventoryNo}`)
      }
    }
  }

  async start() {
    console.log('\n' + '🎯'.repeat(25))
    console.log('Latency Arbitrage Sniper Starting')
    console.log('='.repeat(60))
    console.log(`  Environment:    ${this.cfg.demo ? 'DEMO' : 'LIVE ⚠️'}`)
    console.log(`  Dry Run:        ${this.cfg.dryRun ? 'YES (no real orders)' : 'NO (live execution)'}`)
    console.log(`  Target Market:  ${this.cfg.btcMarketTicker}`)
    console.log(`  Price Feed:     Coinbase BTC/USD (event-driven)`)
    console.log(`  Trigger:        $25 in 2000ms`)
    console.log(`  Min Edge:       ${this.cfg.minEdgeCents}¢`)
    console.log(`  Order Size:     1 contract (hardcoded)`)
    console.log(`  Max Inventory:  ${this.MAX_INVENTORY} per side`)
    console.log('='.repeat(60) + '\n')

    const bal = await this.api.getBalance()
    console.log(`✅ Connected to Kalshi | Balance: $${(bal.balance / 100).toFixed(2)}`)

    this.running = true
    await this.waitForOrderbook()

    console.log('🔫 Sniper armed. Event-driven — waiting for BTC spike...\n')

    setInterval(() => this.broadcastState(), 5000)
  }

  stop() {
    this.running = false
    console.log('\n⏹️  Sniper stopped')
  }

  /**
   * Called when the current market settles. Stops the sniper and signals
   * that a new market needs to be selected.
   */
  onMarketSettled() {
    if (!this.running) return
    console.log(`\n🏁 Current market settled — stopping sniper, awaiting new market...`)
    this.running = false

    // Clear inventory (contracts are settled)
    const oldYes = this.inventoryYes
    const oldNo = this.inventoryNo
    this.inventoryYes = 0
    this.inventoryNo = 0

    console.log(`   Cleared settled inventory: YES=${oldYes} NO=${oldNo}`)

    if (this.cfg.onMarketSettled) {
      this.cfg.onMarketSettled()
    }
  }

  /**
   * Restart the sniper with a newly selected market.
   */
  async restartWithNewMarket(
    newTicker: string,
    newStrikePrice: number,
  ) {
    console.log(`\n🔄 Restarting sniper with new market: ${newTicker} (strike: $${newStrikePrice.toLocaleString()})`)

    this.cfg.btcMarketTicker = newTicker
    this.cfg.strikePrice = newStrikePrice
    this.running = false

    // Reset orderbook state in bridge
    this.bridge.resetOrderbook()

    // Resubscribe to the new market's orderbook
    this.bridge.registerMarket({
      ticker: newTicker,
      title: newTicker,
      event_ticker: '',
      close_time: '',
      category: '💰 BTC',
    })
    this.bridge.subscribeOrderbook(newTicker)

    // Wait for new orderbook
    await this.waitForOrderbook()

    // Restart
    this.running = true
    const bal = await this.api.getBalance()
    console.log(`✅ Connected to Kalshi | Balance: $${(bal.balance / 100).toFixed(2)}`)
    console.log(`🔫 Sniper re-armed. Event-driven — waiting for BTC spike...\n`)

    this.broadcastState()
  }

  // Get recent audit entries
  getAuditLog(): SnipeAuditEntry[] {
    return [...this.auditLog].reverse()
  }

  // Get reference to Coinbase oracle (for market rotation price access)
  getCoinbase(): Coinbase {
    return this.cfg.coinbase
  }

  // ── EVENT-DRIVEN: Called directly by Coinbase on spike ──
  // This method is PUBLIC so index.ts can register it as the callback

  async onSpike(event: PriceEvent) {
    if (!this.running) return

    const direction = event.direction
    const priceStr = event.price.toFixed(2)

    console.log(`🚨 BTC: ${direction.toUpperCase()} | $${priceStr} (${event.change > 0 ? '+' : ''}${event.change.toFixed(2)} in 2s)`)

    if (!this.bridge.isOrderbookReady()) {
      console.log('   ⏳ Orderbook not ready, skipping')
      return
    }

    const yesAsk = this.bridge.getYesAskCents()
    const yesBid = this.bridge.getYesBidCents()

    if (yesAsk === null || yesBid === null) {
      console.log('   ⏳ No orderbook data, skipping')
      return
    }

    const spread = yesAsk - yesBid
    console.log(`   📖 Kalshi: YES bid=${yesBid}¢ ask=${yesAsk}¢ spread=${spread}¢`)

    if (direction === 'spike') {
      await this.trySnipeBuyYes(yesAsk, yesBid, event.price, event.change)
    } else {
      await this.trySnipeSellYes(yesAsk, yesBid, event.price, event.change)
    }
  }

  private addAudit(entry: Omit<SnipeAuditEntry, 'time'>) {
    const auditEntry: SnipeAuditEntry = {
      ...entry,
      time: new Date().toISOString(),
    }
    this.auditLog.push(auditEntry)
    if (this.auditLog.length > 100) this.auditLog.shift()

    // Broadcast to dashboard
    this.bridge.broadcast({
      type: 'audit',
      ...auditEntry,
    })

    console.log(`   📋 AUDIT: ${entry.trigger} → ${entry.action} → ${entry.status}`)
  }

  private async trySnipeBuyYes(currentAsk: number, currentBid: number, btcPrice: number, btcChange: number) {
    const mid = Math.round((currentAsk + currentBid) / 2)
    const maxBuyPrice = mid - this.cfg.minEdgeCents
    const trigger = `BTC Spike +$${btcChange.toFixed(0)}`

    console.log(`   🎯 Spike: mid=${mid}¢ maxBuy=${maxBuyPrice}¢ ask=${currentAsk}¢`)

    if (currentAsk > maxBuyPrice) {
      console.log(`   ⏭️ No edge — ask too expensive`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Skipped (ask ${currentAsk}¢ > maxBuy ${maxBuyPrice}¢)`,
        status: 'canceled',
        edge: 0,
      })
      return
    }

    if (this.inventoryYes >= this.MAX_INVENTORY) {
      console.log(`   ⏭️ Max YES inventory (${this.MAX_INVENTORY}), skipping`)
      return
    }

    const snipePrice = Math.min(currentAsk, maxBuyPrice)
    const edge = maxBuyPrice - currentAsk

    if (this.cfg.dryRun) {
      console.log(`   🔫 DRY RUN: Would BUY YES @ ${snipePrice}¢ | 1 contract (IOC)`)
      console.log(`       Payload: { ticker: "${this.cfg.btcMarketTicker}", side: "yes", action: "buy", count_fp: "1.00", yes_price_dollars: "${(snipePrice / 100).toFixed(4)}", time_in_force: "immediate_or_cancel", buy_max_cost: ${snipePrice} }`)
      this.addAudit({
        btcPrice,
        trigger,
        action: `Fired IOC Buy YES @ ${snipePrice}¢`,
        status: 'dry_run',
        edge,
      })
      return
    }

    console.log(`   🔫 SNIPING: BUY YES @ ${snipePrice}¢ | 1 contract (IOC)`)
    await this.fireOrder(this.cfg.btcMarketTicker, 'yes', 'buy', 1, snipePrice, trigger, btcPrice, edge)
  }

  private async trySnipeSellYes(currentAsk: number, currentBid: number, btcPrice: number, btcChange: number) {
    const mid = Math.round((currentAsk + currentBid) / 2)
    const minSellPrice = mid + this.cfg.minEdgeCents
    const trigger = `BTC Drop -$${Math.abs(btcChange).toFixed(0)}`

    console.log(`   🎯 Drop: mid=${mid}¢ minSell=${minSellPrice}¢ bid=${currentBid}¢`)

    if (this.inventoryYes > 0) {
      if (currentBid < minSellPrice) {
        console.log(`   ⏭️ No edge — bid too cheap`)
        return
      }
      const snipePrice = Math.max(currentBid, minSellPrice)
      if (this.cfg.dryRun) {
        console.log(`   🔫 DRY RUN: Would SELL YES @ ${snipePrice}¢`)
        this.addAudit({ btcPrice, trigger, action: `Fired IOC Sell YES @ ${snipePrice}¢`, status: 'dry_run', edge: snipePrice - mid })
        return
      }
      console.log(`   🔫 SNIPING: SELL YES @ ${snipePrice}¢`)
      await this.fireOrder(this.cfg.btcMarketTicker, 'yes', 'sell', 1, snipePrice, trigger, btcPrice, snipePrice - mid)
      return
    }

    // No YES → buy NO
    const noAsk = 100 - currentBid
    const noMaxBuy = 100 - minSellPrice

    console.log(`   🔄 No YES → buying NO: ask=${noAsk}¢ maxBuy=${noMaxBuy}¢`)

    if (noAsk > noMaxBuy) {
      console.log(`   ⏭️ No edge on NO side`)
      return
    }

    if (this.inventoryNo >= this.MAX_INVENTORY) {
      console.log(`   ⏭️ Max NO inventory (${this.MAX_INVENTORY}), skipping`)
      return
    }

    const snipePrice = Math.min(noAsk, noMaxBuy)

    if (this.cfg.dryRun) {
      console.log(`   🔫 DRY RUN: Would BUY NO @ ${snipePrice}¢`)
      this.addAudit({ btcPrice, trigger, action: `Fired IOC Buy NO @ ${snipePrice}¢`, status: 'dry_run', edge: noMaxBuy - noAsk })
      return
    }

    console.log(`   🔫 SNIPING: BUY NO @ ${snipePrice}¢`)
    await this.fireOrder(this.cfg.btcMarketTicker, 'no', 'buy', 1, snipePrice, trigger, btcPrice, noMaxBuy - noAsk)
  }

  private async fireOrder(
    ticker: string,
    side: 'yes' | 'no',
    action: 'buy' | 'sell',
    count: number,
    priceCents: number,
    trigger: string,
    btcPrice: number,
    edge: number,
  ) {
    const now = Date.now()
    const elapsed = now - this.lastOrderTime
    if (elapsed < this.ORDER_THROTTLE_MS) {
      await new Promise((r) => setTimeout(r, this.ORDER_THROTTLE_MS - elapsed))
    }

    try {
      const result = await this.api.createOrder(
        ticker, side, action, count, priceCents,
        'immediate_or_cancel', false,
      )

      this.lastOrderTime = Date.now()
      this.ordersPlaced++

      const order = result.order
      const status = order?.status || 'unknown'
      const orderId = order?.order_id || 'unknown'

      console.log(`   ✅ Order ${status} | ID: ${orderId} | ${side} ${action} @ ${priceCents}¢ × ${count}`)

      this.addAudit({
        btcPrice,
        trigger,
        action: `${action} ${side} @ ${priceCents}¢`,
        status: status === 'executed' || status === 'filling' ? 'filled' : 'canceled',
        edge,
        orderId,
      })

      if (status === 'executed' || status === 'filling') {
        if (action === 'buy' && side === 'yes') this.inventoryYes += count
        if (action === 'sell' && side === 'yes') this.inventoryYes -= count
        if (action === 'buy' && side === 'no') this.inventoryNo += count
        if (action === 'sell' && side === 'no') this.inventoryNo -= count
      }

      return result
    } catch (e: any) {
      this.addAudit({
        btcPrice,
        trigger,
        action: `${action} ${side} @ ${priceCents}¢`,
        status: 'error',
        edge,
      })

      if (e.message.includes('429')) {
        console.log(`   ⚠️ Rate limited — backing off 1s`)
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        console.log(`   ❌ Order failed: ${e.message}`)
      }
      return null
    }
  }

  private async waitForOrderbook(): Promise<void> {
    const maxWait = 15000
    const interval = 500
    let waited = 0
    while (!this.bridge.isOrderbookReady() && waited < maxWait) {
      await new Promise((r) => setTimeout(r, interval))
      waited += interval
      if (waited % 3000 === 0) console.log(`   ⏳ Waiting for orderbook... (${waited / 1000}s)`)
    }
    if (!this.bridge.isOrderbookReady()) console.log('   ⚠️ Orderbook not ready after 15s')
  }

  private broadcastState() {
    this.bridge.broadcast({
      type: 'bot_state',
      running: this.running,
      ordersPlaced: this.ordersPlaced,
      fillsReceived: this.fillsReceived,
      inventoryYes: this.inventoryYes,
      inventoryNo: this.inventoryNo,
      isDemo: this.cfg.demo,
      dryRun: this.cfg.dryRun,
      orderbookReady: this.bridge.isOrderbookReady(),
      yesBid: this.bridge.getYesBidCents(),
      yesAsk: this.bridge.getYesAskCents(),
      btcPrice: this.cfg.coinbase.getCurrentPrice(),
      strikePrice: this.cfg.strikePrice,
      time: new Date().toISOString(),
    })
  }
}
