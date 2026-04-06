import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { ethers } from 'ethers'
import { ClobClient, Side as ClobSide } from '@polymarket/clob-client'

const CLOB_API = 'https://clob.polymarket.com'

export interface BookUpdate {
  assetId: string
  bid: number
  ask: number
  ts: number
}

export class PolymarketClient extends EventEmitter {
  private ws: WebSocket | null = null
  private assetIds: string[] = []
  private books: Record<string, { bid: number; ask: number; ts: number }> = {}
  public clob: ClobClient

  constructor() {
    super()
    const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY!)
    this.clob = new ClobClient(
      CLOB_API,
      137,
      wallet as any,
      {
        key: process.env.POLY_API_KEY!,
        secret: process.env.POLY_API_SECRET!,
        passphrase: process.env.POLY_PASSPHRASE!,
      }
    ) as any
  }

  async start() {
    this.connect()
  }

  updateSubscriptions(ids: string[]) {
    this.assetIds = [...new Set([...this.assetIds, ...ids])]
    console.log(`📋 Updated subscriptions: ${this.assetIds.length} assets`)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe()
    }
  }

  private connect() {
    const url = `wss://ws-subscriptions-clob.polymarket.com/ws/market`
    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      console.log('🔌 Polymarket WS connected')
      this.subscribe()
      setInterval(() => this.ws?.ping(), 25_000)
    })

    this.ws.on('message', (raw: Buffer) => {
      try {
        const events = JSON.parse(raw.toString())
        for (const e of Array.isArray(events) ? events : [events]) {
          this.handleEvent(e)
        }
      } catch {
        // Ignore malformed messages
      }
    })

    this.ws.on('close', () => {
      console.log('⚠️ Polymarket WS closed — reconnecting in 2s')
      setTimeout(() => this.connect(), 2000)
    })

    this.ws.on('error', err => console.error('Polymarket WS error:', err.message))
  }

  private subscribe() {
    if (!this.assetIds.length) return
    // Polymarket supports ~500 per connection
    const chunks = this.chunk(this.assetIds, 490)
    for (const c of chunks) {
      this.ws?.send(JSON.stringify({ type: 'market', asset_ids: c }))
    }
    console.log(`📋 Subscribed to ${this.assetIds.length} assets`)
  }

  private handleEvent(e: any) {
    if (!e.asset_id) return
    if (e.event_type === 'book' || e.event_type === 'price_change') {
      const bid = parseFloat(e.bids?.[0]?.price ?? e.bid ?? 0)
      const ask = parseFloat(e.asks?.[0]?.price ?? e.ask ?? 1)
      if (!bid || !ask || bid >= ask) return
      this.books[e.asset_id] = { bid, ask, ts: Date.now() }
      this.emit('book', { assetId: e.asset_id, bid, ask, ts: Date.now() })
    }
  }

  getBook(assetId: string) { 
    return this.books[assetId] 
  }

  getMid(assetId: string): number | null {
    const b = this.books[assetId]
    return b ? (b.bid + b.ask) / 2 : null
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }
}
