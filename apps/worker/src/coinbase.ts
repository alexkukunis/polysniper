/**
 * Binance Futures Oracle — Live BTC/USDT Price Feed
 *
 * Connects to Binance USDⓈ-M Futures WebSocket (public, no API keys).
 * Binance Futures leads Coinbase Spot in price discovery — lower latency signal.
 *
 * Stream: wss://fstream.binance.com/ws/btcusdt@aggTrade
 * Payload: { "e": "aggTrade", "p": "68400.50", "T": 1690000000000, ... }
 *
 * Event-driven: fires spike callback directly from WS message handler.
 * Rolling window buffer with reset-after-fire to prevent spam.
 */

import { WebSocket } from 'ws'

export interface PriceEvent {
  price: number
  change: number       // $ change over window
  pctChange: number    // % change over window
  direction: 'spike' | 'drop'
  timestamp: number
}

export class BinanceOracle {
  private ws: WebSocket | null = null
  private priceBuffer: { price: number; timestamp: number }[] = []
  readonly windowMs: number
  readonly thresholdUsd: number
  private onSpike: (event: PriceEvent) => void
  private onPriceUpdate: (price: number) => void  // fires on EVERY trade
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private currentPrice = 0
  private url = 'wss://fstream.binance.com/ws/btcusdt@aggTrade'

  // ── Heartbeat ──
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastMessageTime = 0
  private readonly HEARTBEAT_INTERVAL_MS = 15000
  private readonly STALE_CONNECTION_MS = 45000

  // Rolling price history for momentum context (last 60 seconds)
  private priceHistory: { price: number; timestamp: number }[] = []
  private readonly historyMs = 60000

  constructor(opts: {
    windowMs?: number        // default 2000ms
    thresholdUsd?: number    // default $25
    onSpike: (event: PriceEvent) => void  // EVENT-DRIVEN: fired on spike detection
    onPriceUpdate?: (price: number) => void  // fires on every trade
  }) {
    this.windowMs = opts.windowMs || 2000
    this.thresholdUsd = opts.thresholdUsd || 25
    this.onSpike = opts.onSpike
    this.onPriceUpdate = opts.onPriceUpdate || (() => {})
  }

  // Replace the spike callback (used after oracle starts with no-op)
  setSpikeCallback(cb: (event: PriceEvent) => void) {
    this.onSpike = cb
  }

  // Register a callback that fires on EVERY trade (not just spikes)
  setPriceUpdateCallback(cb: (price: number) => void) {
    this.onPriceUpdate = cb
  }

  start() {
    this.connect()
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    if (this.ws) { this.ws.close(); this.ws = null }
  }

  getCurrentPrice(): number {
    return this.currentPrice
  }

  /**
   * Get BTC price change over the last N milliseconds.
   * Returns null if not enough data.
   */
  getRollingChange(windowMs: number): number | null {
    const now = Date.now()
    const cutoff = now - windowMs
    // Find oldest price still within window
    const entry = this.priceHistory.find(p => p.timestamp >= cutoff)
    if (!entry || this.priceHistory.length < 2) return null
    return this.currentPrice - entry.price
  }

  /**
   * Get full momentum context: changes over 2s, 5s, 30s windows.
   */
  getMomentumContext(): {
    change2s: number | null
    change5s: number | null
    change30s: number | null
  } {
    return {
      change2s: this.getRollingChange(2000),
      change5s: this.getRollingChange(5000),
      change30s: this.getRollingChange(30000),
    }
  }

  /**
   * Get recent price history for sparkline chart (last N data points).
   */
  getRecentPriceHistory(points = 60): { price: number; timestamp: number }[] {
    const now = Date.now()
    const cutoff = now - this.historyMs
    const recent = this.priceHistory.filter(p => p.timestamp >= cutoff)
    // Downsample to requested points
    if (recent.length <= points) return recent
    const step = Math.floor(recent.length / points)
    return recent.filter((_, i) => i % step === 0).slice(-points)
  }

  private connect() {
    console.log(`🔗 Connecting to Binance Futures WebSocket (btcusdt@aggTrade)...`)

    this.ws = new WebSocket(this.url, {
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 6,
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024,
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        threshold: 256,
      },
    })

    this.ws.on('open', () => {
      console.log('✅ Binance Futures WebSocket connected')
      this.lastMessageTime = Date.now()
      this.reconnectAttempts = 0
      this.startHeartbeat()
    })

    // EVENT-DRIVEN: parse aggTrade messages and fire spike check
    this.ws.on('message', (data: Buffer) => {
      try {
        this.lastMessageTime = Date.now()
        const msg = JSON.parse(data.toString())

        // Binance aggTrade format:
        // { "e": "aggTrade", "p": "68400.50", "T": 1690000000000, ... }
        if (msg.e === 'aggTrade' && msg.p && msg.T) {
          const price = parseFloat(msg.p)
          const time = msg.T  // Binance provides millisecond timestamp directly
          this.onTrade(price, time)
        }
      } catch {}
    })

    this.ws.on('ping', () => this.ws?.pong())

    this.ws.on('close', () => {
      this.stopHeartbeat()
      const delay = this.getReconnectDelay()
      console.log(`⚠️ Binance Futures disconnected — reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})...`)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })

    this.ws.on('error', (err) => {
      console.error('❌ Binance Futures WS error:', err.message)
    })
  }

  private getReconnectDelay(): number {
    // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    return delay
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.checkConnectionHealth(), this.HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private checkConnectionHealth() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const timeSinceLastMessage = Date.now() - this.lastMessageTime

    if (timeSinceLastMessage > this.STALE_CONNECTION_MS) {
      console.warn(`⚠️ Stale Binance WS connection (${timeSinceLastMessage}ms since last message) — forcing reconnect`)
      this.ws.close()
      return
    }

    this.ws.ping()
  }

  private onTrade(price: number, time: number) {
    this.currentPrice = price

    // Track price history for momentum context
    this.priceHistory.push({ price, timestamp: time })

    // Trim price history older than historyMs
    const historyCutoff = time - this.historyMs
    while (this.priceHistory.length > 0 && this.priceHistory[0].timestamp < historyCutoff) {
      this.priceHistory.shift()
    }

    // Fire price update callback on EVERY trade (for boot sequence + dashboard)
    this.onPriceUpdate(price)

    // Add to rolling buffer
    this.priceBuffer.push({ price, timestamp: time })

    // Trim old prices outside window
    const cutoff = time - this.windowMs
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].timestamp < cutoff) {
      this.priceBuffer.shift()
    }

    // Need at least 2 data points in window
    if (this.priceBuffer.length < 2) return

    // Compare current price to oldest in window
    const oldest = this.priceBuffer[0].price
    const delta = price - oldest
    const pctChange = (delta / oldest) * 100

    // Check threshold
    if (Math.abs(delta) >= this.thresholdUsd) {
      const event: PriceEvent = {
        price,
        change: delta,
        pctChange,
        direction: delta > 0 ? 'spike' : 'drop',
        timestamp: time,
      }

      // CRITICAL: Reset buffer using rolling window filter — keep last price
      // so we don't blind ourselves to continuation spikes
      this.priceBuffer = this.priceBuffer.filter(t => time - t.timestamp <= this.windowMs)

      // FIRE CALLBACK IMMEDIATELY — zero polling delay
      this.onSpike(event)
    }
  }
}
