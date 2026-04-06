import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { createSign } from 'crypto'

const DEMO_WS_URL = 'wss://demo-api.kalshi.co/trade-api/ws/v2'
const PROD_WS_URL = 'wss://api.kalshi.com/trade-api/ws/v2'

export interface TickerUpdate {
  marketTicker: string
  yesBid: number
  yesAsk: number
  lastPrice?: number
  volume?: number
  ts: number
}

export interface OrderbookSnapshot {
  marketTicker: string
  bids: Array<{ price: number; count: number }>
  ts: number
}

export interface OrderbookDelta {
  marketTicker: string
  deltas: Array<{ side: 'yes' | 'no'; price: number; count: number; action: 'new' | 'update' | 'delete' }>
  ts: number
}

export interface FillMessage {
  order_id: string
  trade_id: string
  ticker: string
  yes_price: number
  count: number
  action: 'buy' | 'sell'
  side: 'yes' | 'no'
  ts: number
}

export interface ErrorMessage {
  code: string
  msg: string
}

export type KalshiMessage = {
  type: string
  msg: any
  id?: number
}

export class KalshiClient extends EventEmitter {
  private ws: WebSocket | null = null
  private accessKey: string
  private privateKey: string
  private wsUrl: string
  private connected = false
  private reconnectAttempts = 0
  private maxReconnectDelay = 30000
  private baseReconnectDelay = 1000
  private subscribedMarkets: string[] = []
  private msgId = 0

  constructor(accessKey: string, privateKey: string, isDemo = true) {
    super()
    this.accessKey = accessKey
    this.privateKey = privateKey
    this.wsUrl = isDemo ? DEMO_WS_URL : PROD_WS_URL
  }

  async start() {
    this.connect()
  }

  private generateSignature(): string {
    const timestamp = Date.now().toString()
    const payload = timestamp + 'GET' + '/trade-api/ws/v2'
    const sign = createSign('SHA256')
    sign.update(payload)
    return sign.sign(this.privateKey, 'base64')
  }

  private connect() {
    const headers = {
      'KALSHI-ACCESS-KEY': this.accessKey,
      'KALSHI-ACCESS-SIGNATURE': this.generateSignature(),
      'KALSHI-ACCESS-TIMESTAMP': Date.now().toString(),
    }

    console.log(`🔌 Connecting to Kalshi WebSocket: ${this.wsUrl}`)

    this.ws = new WebSocket(this.wsUrl, {
      headers,
    })

    this.ws.on('open', () => {
      console.log('✅ Kalshi WebSocket connected')
      this.connected = true
      this.reconnectAttempts = 0
      this.resubscribe()
      // Ping every 25 seconds
      setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping()
        }
      }, 25_000)
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const messages = JSON.parse(data.toString())
        const msgArray = Array.isArray(messages) ? messages : [messages]
        for (const msg of msgArray) {
          this.handleMessage(msg)
        }
      } catch (err) {
        console.error('Failed to parse Kalshi message:', err)
      }
    })

    this.ws.on('close', () => {
      console.log('⚠️ Kalshi WebSocket closed — reconnecting...')
      this.connected = false
      this.scheduleReconnect()
    })

    this.ws.on('error', (err) => {
      console.error('❌ Kalshi WebSocket error:', err.message)
      this.connected = false
    })
  }

  private handleMessage(raw: KalshiMessage) {
    switch (raw.type) {
      case 'ticker':
        this.emit('ticker', {
          marketTicker: raw.msg.market_ticker,
          yesBid: raw.msg.yes_bid,
          yesAsk: raw.msg.yes_ask,
          lastPrice: raw.msg.last_price,
          volume: raw.msg.volume,
          ts: Date.now(),
        } as TickerUpdate)
        break

      case 'orderbook_snapshot':
        this.emit('orderbook_snapshot', {
          marketTicker: raw.msg.market_ticker,
          bids: (raw.msg.bids || []).map((b: any) => ({
            price: b.price,
            count: b.count,
          })),
          ts: Date.now(),
        } as OrderbookSnapshot)
        break

      case 'orderbook_delta':
        this.emit('orderbook_delta', {
          marketTicker: raw.msg.market_ticker,
          deltas: (raw.msg.deltas || []).map((d: any) => ({
            side: d.side,
            price: d.price,
            count: d.count,
            action: d.action,
          })),
          ts: Date.now(),
        } as OrderbookDelta)
        break

      case 'fill':
        this.emit('fill', {
          order_id: raw.msg.order_id,
          trade_id: raw.msg.trade_id,
          ticker: raw.msg.ticker,
          yes_price: raw.msg.yes_price,
          count: raw.msg.count,
          action: raw.msg.action,
          side: raw.msg.side,
          ts: Date.now(),
        } as FillMessage)
        break

      case 'error':
        console.error('❌ Kalshi WS Error:', raw.msg)
        this.emit('error', raw.msg as ErrorMessage)
        break

      case 'subscription_confirmation':
        console.log('✅ Subscription confirmed for:', raw.msg?.channels)
        this.emit('subscribed', raw.msg)
        break

      default:
        // Ignore unknown message types
        break
    }
  }

  subscribe(tickers: string[]) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('⚠️ Cannot subscribe: WebSocket not connected')
      return
    }

    this.subscribedMarkets = [...new Set([...this.subscribedMarkets, ...tickers])]

    const id = ++this.msgId
    const msg = {
      id,
      cmd: 'subscribe',
      params: {
        channels: ['ticker', 'orderbook_snapshot', 'orderbook_delta'],
        market_tickers: tickers,
      },
    }

    this.ws.send(JSON.stringify(msg))
    console.log(`📋 Subscribed to ${tickers.length} Kalshi markets`)
  }

  private resubscribe() {
    if (this.subscribedMarkets.length > 0) {
      console.log(`🔄 Resubscribing to ${this.subscribedMarkets.length} markets...`)
      this.subscribe(this.subscribedMarkets)
    }
  }

  private scheduleReconnect() {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    )
    this.reconnectAttempts++

    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    setTimeout(() => {
      if (!this.connected) {
        this.connect()
      }
    }, delay)
  }

  isConnected(): boolean {
    return this.connected
  }

  getSubscribedMarkets(): string[] {
    return [...this.subscribedMarkets]
  }

  stop() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }
}
