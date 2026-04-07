/**
 * WebSocket Bridge — connects to Kalshi WS, manages local orderbook state,
 * enriches messages, broadcasts to dashboard clients.
 *
 * CRITICAL: Orderbook deltas use count_fp = "0.00" to indicate a price level
 * has been completely removed. We must DELETE these levels, not set to zero.
 */
import { WebSocketServer, WebSocket } from 'ws'
import * as crypto from 'crypto'
import * as http from 'http'

const DEMO_WS = 'wss://demo-api.kalshi.co/trade-api/ws/v2'
const PROD_WS = 'wss://api.elections.kalshi.com/trade-api/ws/v2'

// Map-based orderbook: price_dollars (string key) → count_fp (string)
// This properly handles Kalshi's count_fp = "0.00" removal signals
export type OrderbookMap = Map<string, string>  // price → count

export interface OrderbookState {
  ticker: string
  title: string
  closeTime: string
  yesBook: OrderbookMap  // YES bids: price → count
  noBook: OrderbookMap   // NO bids: price → count
  snapshotTime: number
}

export interface MarketMeta {
  ticker: string
  title: string
  event_ticker: string
  close_time: string
  category: string
}

interface KalshiWSConfig {
  key: string
  secret: string
  demo: boolean
  onMarketSettled?: (ticker: string, status: string) => void
}

export class WebSocketBridge {
  private kalshiWs: WebSocket | null = null
  private server: http.Server
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private cfg: KalshiWSConfig
  private running = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private marketMeta = new Map<string, MarketMeta>()

  // Local orderbook for the sniper's target market
  private orderbook: OrderbookState | null = null
  private orderbookReady = false
  private pendingOrderbookSubscription: any = null

  // Pending messages for new clients
  private pendingMessages: any[] = []

  constructor(port: number, path: string, cfg: KalshiWSConfig) {
    this.cfg = cfg
    this.server = http.createServer()
    this.wss = new WebSocketServer({ server: this.server, path })
  }

  async start() {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws)
      console.log(`📺 Dashboard client connected (${this.clients.size} total)`)

      for (const msg of this.pendingMessages) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
      }

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(`📺 Dashboard client disconnected (${this.clients.size} total)`)
      })
    })

    await new Promise<void>((resolve) => {
      this.server.listen(3002, () => {
        console.log('🔌 WebSocket bridge listening on :3002')
        resolve()
      })
    })

    this.connectKalshi()
  }

  stop() {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.kalshiWs) this.kalshiWs.close()
    this.clients.forEach((c) => c.close())
    this.server.close()
  }

  // ── Orderbook API ──

  /**
   * Reset orderbook state (called when switching to a new market).
   */
  resetOrderbook() {
    this.orderbook = null
    this.orderbookReady = false
    console.log('🔄 Orderbook state cleared')
  }

  registerMarket(meta: MarketMeta) {
    this.marketMeta.set(meta.ticker, meta)
  }

  subscribeOrderbook(ticker: string) {
    // Subscribe to orderbook_delta for a specific market
    // Kalshi requires channels INSIDE params, plus market_ticker
    const payload = {
      id: 2,
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta'],
        market_ticker: ticker,
      },
    }
    
    // If connection is ready, send immediately
    if (this.kalshiWs?.readyState === WebSocket.OPEN && this.running) {
      this.send(payload)
      console.log(`📖 Subscribed to orderbook_delta for ${ticker}`)
    } else {
      // Store for later when connection is established
      this.pendingOrderbookSubscription = payload
      console.log(`📖 Queued orderbook_delta subscription for ${ticker}`)
    }
  }

  getOrderbook(): OrderbookState | null {
    return this.orderbook
  }

  isOrderbookReady(): boolean {
    return this.orderbookReady
  }

  // Derive best YES ask from NO book
  // Binary math: YES Ask = $1.00 - (highest NO bid price)
  getYesAskCents(): number | null {
    if (!this.orderbook || this.orderbook.noBook.size === 0) return null
    const prices = Array.from(this.orderbook.noBook.keys()).map(Number)
    const highestNoBid = Math.max(...prices)
    return Math.round((1.00 - highestNoBid) * 100)
  }

  // Derive best YES bid from YES book
  getYesBidCents(): number | null {
    if (!this.orderbook || this.orderbook.yesBook.size === 0) return null
    const prices = Array.from(this.orderbook.yesBook.keys()).map(Number)
    return Math.round(Math.max(...prices) * 100)
  }

  // ── Internal: Kalshi WS connection ──

  private connectKalshi() {
    const url = this.cfg.demo ? DEMO_WS : PROD_WS
    const { ts, sig } = this.sign()

    console.log(`🔗 Connecting to Kalshi WebSocket (${this.cfg.demo ? 'demo' : 'live'})...`)

    this.kalshiWs = new WebSocket(url, {
      headers: {
        'KALSHI-ACCESS-KEY': this.cfg.key,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': sig,
      },
    })

    this.kalshiWs.on('open', () => {
      console.log('✅ Connected to Kalshi WebSocket')
      this.running = true
      // Subscribe to public channels first
      this.subscribe()
      // Wait a bit before subscribing to orderbook_delta to avoid race conditions
      setTimeout(() => {
        if (this.pendingOrderbookSubscription) {
          this.send(this.pendingOrderbookSubscription)
          console.log(`📖 Subscribed to orderbook_delta for ${this.pendingOrderbookSubscription.params?.market_ticker}`)
          this.pendingOrderbookSubscription = null
        }
      }, 500)
    })

    this.kalshiWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        // All logging handled in handleMessage()
        this.handleMessage(msg)
      } catch (err) {
        console.error('❌ Failed to parse Kalshi message:', err)
      }
    })

    this.kalshiWs.on('close', () => {
      console.log('⚠️ Kalshi WS disconnected — reconnecting in 3s...')
      this.running = false
      this.orderbookReady = false
      this.reconnectTimer = setTimeout(() => this.connectKalshi(), 3000)
    })

    this.kalshiWs.on('error', (err) => {
      console.error('❌ Kalshi WS error:', err.message)
    })

    this.kalshiWs.on('ping', () => this.kalshiWs?.pong())
  }

  private subscribe() {
    // Subscribe to public channels — channels go INSIDE params
    const payload = {
      id: 1,
      cmd: 'subscribe',
      params: {
        channels: ['ticker', 'trade', 'market_lifecycle_v2'],
      },
    }
    this.send(payload)
    console.log('📡 Subscribed to ticker, trade, market_lifecycle_v2')
  }

  private send(msg: any) {
    if (this.kalshiWs?.readyState === WebSocket.OPEN) {
      console.log('📤 Sending:', JSON.stringify(msg))
      this.kalshiWs.send(JSON.stringify(msg))
    }
  }

  broadcast(msg: any) {
    const data = JSON.stringify(msg)
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(data)
    })

    this.pendingMessages.push(msg)
    if (this.pendingMessages.length > 100) this.pendingMessages.shift()
  }

  // ── Message handling + orderbook state ──

  private handleMessage(msg: any) {
    const msgType = msg.type || msg.channel || 'unknown'

    // Always log errors
    if (msgType === 'error') {
      console.error(`📨 Kalshi ERROR: ${JSON.stringify(msg, null, 2)}`)
      return
    }

    // Handle orderbook_snapshot message (first message after subscribing)
    if (msg.type === 'orderbook_snapshot') {
      console.log('📖 Received orderbook_snapshot message')
      this.handleOrderbookSnapshot(msg)
      return
    }

    // Handle orderbook_delta messages (subsequent updates)
    if (msg.type === 'orderbook_delta' || (msg.channel === 'orderbook_delta' && msg.data)) {
      const data = msg.data || msg.msg
      if (data) {
        // Only log the first few deltas for debugging
        if (!this.orderbookReady || !this.orderbook || this.orderbook.yesBook.size === 0) {
          console.log('📖 Orderbook delta (debug):', JSON.stringify(data).substring(0, 300))
        }
        this.updateOrderbook(data)
        const enriched = this.enrichOrderbookMessage(data)
        if (enriched) this.broadcast(enriched)
      }
      return
    }

    // Handle market lifecycle events
    if (msg.channel === 'market_lifecycle_v2' && msg.data) {
      const status = msg.data.status
      const ticker = msg.data.ticker
      if (status === 'settled' || status === 'closed') {
        console.log(`🏁 Market ${ticker} ${status} — triggering auto-rotation`)
        if (this.cfg.onMarketSettled) {
          this.cfg.onMarketSettled(ticker, status)
        }
      }
      return
    }

    // Skip logging ticker and trade messages entirely (too noisy)
    if (msg.type === 'ticker' || msg.channel === 'ticker') return
    if (msg.type === 'trade' || msg.channel === 'trade') return

    const enriched = this.enrichMessage(msg)
    if (enriched) this.broadcast(enriched)
  }

  // Handle orderbook_snapshot message
  private handleOrderbookSnapshot(msg: any) {
    const snapshotData = msg.msg || msg.data
    if (!snapshotData) {
      console.warn('⚠️ Received orderbook_snapshot but no data')
      console.warn('   Full message:', JSON.stringify(msg, null, 2))
      return
    }

    console.log('📖 Processing orderbook snapshot...')
    console.log('   Snapshot data keys:', Object.keys(snapshotData).join(','))
    
    const ticker = snapshotData.market_ticker || ''
    console.log(`   Market: ${ticker}`)

    // Clear existing orderbook
    this.orderbook = {
      ticker,
      title: this.marketMeta.get(ticker)?.title || ticker,
      closeTime: this.marketMeta.get(ticker)?.close_time || '',
      yesBook: new Map<string, string>(),
      noBook: new Map<string, string>(),
      snapshotTime: Date.now(),
    }

    // Kalshi official format: yes_dollars_fp = [["price", "count"], ...]
    // Priority 1: Official Kalshi format (array of [price, count] tuples)
    if (snapshotData.yes_dollars_fp && Array.isArray(snapshotData.yes_dollars_fp)) {
      console.log(`   Using yes_dollars_fp format - YES levels: ${snapshotData.yes_dollars_fp.length}`)
      for (const [price, count] of snapshotData.yes_dollars_fp) {
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.yesBook.set(price.toString(), count.toString())
        }
      }
    }
    // Fallback 1: { yes: [[price, count], ...] }
    else if (snapshotData.yes && Array.isArray(snapshotData.yes)) {
      console.log(`   Using yes array format - YES levels: ${snapshotData.yes.length}`)
      for (const [price, count] of snapshotData.yes) {
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.yesBook.set(price.toString(), count.toString())
        }
      }
    }
    // Fallback 2: { yes_dollars: { bids: [...] } }
    else if (snapshotData.yes_dollars?.bids) {
      console.log(`   Using yes_dollars.bids format - YES levels: ${snapshotData.yes_dollars.bids.length}`)
      for (const level of snapshotData.yes_dollars.bids) {
        const price = level.price_dollars || level.price
        const count = level.count_fp || level.count
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.yesBook.set(price.toString(), count.toString())
        }
      }
    }

    // Kalshi official format: no_dollars_fp = [["price", "count"], ...]
    // Priority 1: Official Kalshi format
    if (snapshotData.no_dollars_fp && Array.isArray(snapshotData.no_dollars_fp)) {
      console.log(`   Using no_dollars_fp format - NO levels: ${snapshotData.no_dollars_fp.length}`)
      for (const [price, count] of snapshotData.no_dollars_fp) {
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.noBook.set(price.toString(), count.toString())
        }
      }
    }
    // Fallback 1: { no: [[price, count], ...] }
    else if (snapshotData.no && Array.isArray(snapshotData.no)) {
      console.log(`   Using no array format - NO levels: ${snapshotData.no.length}`)
      for (const [price, count] of snapshotData.no) {
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.noBook.set(price.toString(), count.toString())
        }
      }
    }
    // Fallback 2: { no_dollars: { bids: [...] } }
    else if (snapshotData.no_dollars?.bids) {
      console.log(`   Using no_dollars.bids format - NO levels: ${snapshotData.no_dollars.bids.length}`)
      for (const level of snapshotData.no_dollars.bids) {
        const price = level.price_dollars || level.price
        const count = level.count_fp || level.count
        if (price && count !== '0.00' && parseFloat(count) > 0) {
          this.orderbook.noBook.set(price.toString(), count.toString())
        }
      }
    }

    this.orderbookReady = true

    const yesAsk = this.getYesAskCents()
    const yesBid = this.getYesBidCents()
    console.log(`✅ Orderbook snapshot loaded: YES bid=${yesBid}¢ ask=${yesAsk}¢ | YES levels: ${this.orderbook.yesBook.size} | NO levels: ${this.orderbook.noBook.size}`)

    // Broadcast the snapshot to dashboard
    const enriched = this.enrichOrderbookMessage(snapshotData)
    if (enriched) {
      enriched.isSnapshot = true
      this.broadcast(enriched)
    }
  }

  // Apply snapshot or delta to local orderbook state
  private updateOrderbook(data: any) {
    const ticker = data.market_ticker || ''

    // Detect message type based on structure
    const hasBatchStructure = data.yes_dollars || data.no_dollars || data.is_snapshot
    const hasIndividualDelta = data.price_dollars !== undefined && data.side !== undefined

    // Snapshot — initialize the book with full state
    if (hasBatchStructure && (data.is_snapshot || !this.orderbook)) {
      console.log('📖 Initializing orderbook from snapshot...')
      console.log('   Snapshot keys:', Object.keys(data).join(', '))
      
      this.orderbook = {
        ticker,
        title: this.marketMeta.get(ticker)?.title || ticker,
        closeTime: this.marketMeta.get(ticker)?.close_time || '',
        yesBook: new Map<string, string>(),
        noBook: new Map<string, string>(),
        snapshotTime: Date.now(),
      }

      // Apply YES side levels
      if (data.yes_dollars?.bids) {
        console.log(`   YES bids from snapshot: ${data.yes_dollars.bids.length} levels`)
        for (const level of data.yes_dollars.bids) {
          const price = level.price_dollars || level.price
          const count = level.count_fp || level.count
          if (price && count !== '0.00') {
            this.orderbook.yesBook.set(price, count)
          }
        }
      }

      // Apply NO side levels  
      if (data.no_dollars?.bids) {
        console.log(`   NO bids from snapshot: ${data.no_dollars.bids.length} levels`)
        for (const level of data.no_dollars.bids) {
          const price = level.price_dollars || level.price
          const count = level.count_fp || level.count
          if (price && count !== '0.00') {
            this.orderbook.noBook.set(price, count)
          }
        }
      }

      this.orderbookReady = true

      const yesAsk = this.getYesAskCents()
      const yesBid = this.getYesBidCents()
      console.log(`✅ Orderbook ready (snapshot): YES bid=${yesBid}¢ ask=${yesAsk}¢ | YES levels: ${this.orderbook.yesBook.size} | NO levels: ${this.orderbook.noBook.size}`)
    } else if (hasIndividualDelta) {
      // Individual delta format: { market_ticker, price_dollars, count_fp, side, ... }
      if (!this.orderbook) {
        console.log(`📖 Initializing orderbook from first delta (no snapshot): ${ticker}`)
        this.orderbook = {
          ticker,
          title: this.marketMeta.get(ticker)?.title || ticker,
          closeTime: this.marketMeta.get(ticker)?.close_time || '',
          yesBook: new Map<string, string>(),
          noBook: new Map<string, string>(),
          snapshotTime: Date.now(),
        }
      }

      if (this.orderbook.ticker !== ticker) {
        console.warn(`⚠️ Delta ticker mismatch: expected ${this.orderbook.ticker}, got ${ticker}`)
        return
      }

      // Apply individual delta to the correct book
      // Kalshi format: { price_dollars, delta_fp, side, ... }
      const side = data.side // 'yes' or 'no'
      const price = data.price_dollars || data.price
      const delta = data.delta_fp || data.count_fp || data.count

      if (price) {
        const book = side === 'yes' ? this.orderbook.yesBook : this.orderbook.noBook
        const deltaValue = parseFloat(delta)
        
        if (deltaValue === 0) {
          // Level removed
          book.delete(price)
        } else if (deltaValue > 0) {
          // Add/update level
          book.set(price, delta.toString())
        } else {
          // Negative delta - reduce existing level
          const existing = parseFloat(book.get(price) || '0')
          const newCount = existing + deltaValue
          if (newCount <= 0) {
            book.delete(price)
          } else {
            book.set(price, newCount.toFixed(2))
          }
        }
      }

      // Mark as ready after first delta
      if (!this.orderbookReady) {
        this.orderbookReady = true
        console.log(`✅ Orderbook ready (from individual deltas): YES levels=${this.orderbook.yesBook.size}, NO levels=${this.orderbook.noBook.size}`)
      }
    } else if (hasBatchStructure) {
      // Batch delta format with yes_dollars/no_dollars arrays
      if (!this.orderbook) {
        console.log(`📖 Initializing orderbook from batch delta: ${ticker}`)
        this.orderbook = {
          ticker,
          title: this.marketMeta.get(ticker)?.title || ticker,
          closeTime: this.marketMeta.get(ticker)?.close_time || '',
          yesBook: new Map<string, string>(),
          noBook: new Map<string, string>(),
          snapshotTime: Date.now(),
        }
      }

      if (this.orderbook.ticker !== ticker) {
        console.warn(`⚠️ Delta ticker mismatch: expected ${this.orderbook.ticker}, got ${ticker}`)
        return
      }

      // YES deltas
      const yesDeltas = data.yes_dollars?.deltas || data.yes_dollars || []
      for (const d of yesDeltas) {
        this.applyDeltaToBook(this.orderbook.yesBook, d)
      }

      // NO deltas
      const noDeltas = data.no_dollars?.deltas || data.no_dollars || []
      for (const d of noDeltas) {
        this.applyDeltaToBook(this.orderbook.noBook, d)
      }

      // Mark as ready after first delta
      if (!this.orderbookReady) {
        this.orderbookReady = true
        console.log(`✅ Orderbook ready (from batch deltas): YES levels=${this.orderbook.yesBook.size}, NO levels=${this.orderbook.noBook.size}`)
      }
    }
  }

  // Apply a single delta to an orderbook Map
  // CRITICAL: count_fp = "0.00" means DELETE the price level
  private applyDeltaToBook(book: OrderbookMap, delta: any) {
    const price = delta.price_dollars || delta.price
    const count = delta.count_fp || delta.count

    if (!price) return

    if (parseFloat(count) === 0) {
      // Level removed — DELETE from book (not set to zero!)
      book.delete(price)
    } else {
      // Level added or updated — SET in book
      book.set(price, count)
    }
  }

  private enrichOrderbookMessage(data: any): any {
    const ticker = data.market_ticker || ''
    const info = this.marketMeta.get(ticker)
    return {
      type: 'orderbook',
      ticker,
      title: info?.title || ticker,
      yesBid: this.getYesBidCents(),
      yesAsk: this.getYesAskCents(),
      yesLevels: this.orderbook?.yesBook.size || 0,
      noLevels: this.orderbook?.noBook.size || 0,
      isSnapshot: data.is_snapshot,
      time: new Date().toISOString(),
    }
  }

  private enrichMessage(msg: any): any {
    const ticker = msg.data?.ticker || msg.data?.market_ticker || msg.market_ticker || ''
    const info = this.marketMeta.get(ticker)

    if (msg.channel === 'order' && msg.data) {
      return {
        type: 'order',
        orderId: msg.data.order_id,
        clientOrderId: msg.data.client_order_id,
        ticker,
        title: info?.title || ticker,
        closeTime: info?.close_time || '',
        side: msg.data.side,
        action: msg.data.action,
        price: msg.data.yes_price || msg.data.no_price,
        count: msg.data.count,
        remainingCount: msg.data.remaining_count,
        status: msg.data.status,
        createdTime: msg.data.created_time,
        time: new Date().toISOString(),
      }
    }

    if (msg.channel === 'fill' && msg.data) {
      const price = msg.data.yes_price || msg.data.no_price
      const count = msg.data.count
      const cost = price * count / 100

      return {
        type: 'fill',
        tradeId: msg.data.trade_id,
        orderId: msg.data.order_id,
        ticker,
        title: info?.title || ticker,
        side: msg.data.side,
        action: msg.data.action,
        price,
        count,
        cost,
        status: 'filled',
        createdTime: msg.data.created_time,
        time: new Date().toISOString(),
      }
    }

    if (msg.channel === 'ticker' && msg.data) {
      return {
        type: 'ticker',
        ticker,
        title: info?.title || ticker,
        lastPrice: msg.data.last_price,
        yesBid: msg.data.yes_bid,
        yesAsk: msg.data.yes_ask,
        volume: msg.data.volume,
        time: new Date().toISOString(),
      }
    }

    if (msg.channel === 'market_positions' && msg.data) {
      return {
        type: 'position',
        ticker,
        title: info?.title || ticker,
        position: msg.data.position,
        totalTraded: msg.data.total_traded,
        marketExposure: msg.data.market_exposure,
        realizedPnl: msg.data.realized_pnl,
        time: new Date().toISOString(),
      }
    }

    return { type: msg.channel || 'unknown', time: new Date().toISOString(), raw: msg }
  }

  private sign() {
    const ts = Date.now().toString()
    const full = '/trade-api/ws/v2'
    const sig = crypto.sign('RSA-SHA256', Buffer.from(ts + 'GET' + full), {
      key: this.cfg.secret,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64')
    return { ts, sig }
  }
}
