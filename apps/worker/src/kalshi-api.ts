import * as crypto from 'crypto'

const DEMO_API = 'https://demo-api.kalshi.co/trade-api/v2'
const PROD_API = 'https://api.elections.kalshi.com/trade-api/v2'

export class KalshiAPI {
  private key: string
  private secret: string
  private base: string

  constructor(key: string, secret: string, demo = true) {
    this.key = key
    this.secret = secret
    this.base = demo ? DEMO_API : PROD_API
  }

  private sign(method: string, path: string) {
    const ts = Date.now().toString()
    const clean = path.split('?')[0]
    const full = `/trade-api/v2${clean}`
    const sig = crypto.sign('RSA-SHA256', Buffer.from(ts + method.toUpperCase() + full), {
      key: this.secret,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64')
    return { ts, sig }
  }

  private headers(method: string, path: string) {
    const { ts, sig } = this.sign(method, path)
    return {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': this.key,
      'KALSHI-ACCESS-SIGNATURE': sig,
      'KALSHI-ACCESS-TIMESTAMP': ts,
    }
  }

  async get(path: string) {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers('GET', path) })
    if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async post(path: string, body: any) {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers('POST', path),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`)
    return res.json()
  }

  // Public endpoints
  async getMarkets(
    status = 'open',
    limit = 100,
    maxPages = 3,
    seriesTicker?: string,  // Filter by series (e.g. KXBTC15M, KXBTCD)
  ) {
    const all: any[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const seriesFilter = seriesTicker ? `&series_ticker=${seriesTicker}` : ''
      const url = `/markets?status=${status}&limit=${limit}${seriesFilter}${cursor ? `&cursor=${cursor}` : ''}`
      const data = await this.get(url)
      all.push(...(data.markets || []))
      cursor = data.cursor
      pages++
    } while (cursor && pages < maxPages)
    return all
  }

  // Authenticated endpoints
  async getBalance() {
    return this.get('/portfolio/balance')
  }

  async getOrders() {
    return this.get('/portfolio/orders')
  }

  /**
   * Place an order with fixed-point formatting (required by Kalshi API).
   *
   * @param ticker Market ticker
   * @param side 'yes' or 'no'
   * @param action 'buy' or 'sell'
   * @param count Number of contracts (integer)
   * @param priceCents Price in cents (integer)
   * @param tif Time in force: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel'
   * @param postOnly If true, order must rest on book (maker). If false, can take liquidity.
   */
  async createOrder(
    ticker: string,
    side: 'yes' | 'no',
    action: 'buy' | 'sell',
    count: number,
    priceCents: number,
    tif: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel' = 'fill_or_kill',
    postOnly = true,
  ) {
    const priceDollars = (priceCents / 100).toFixed(4)  // "0.5500"
    const countFp = count.toFixed(2)                     // "1.00"

    const body: any = {
      ticker,
      side,
      action,
      count_fp: countFp,
      yes_price_dollars: side === 'yes' ? priceDollars : undefined,
      no_price_dollars: side === 'no' ? priceDollars : undefined,
      time_in_force: tif,
    }

    // For IOC/snipe orders: add buy_max_cost safety cap
    // This prevents spending more than expected even if slippage occurs
    if (tif === 'immediate_or_cancel' && action === 'buy') {
      body.buy_max_cost = Math.round(priceCents * count)  // Integer cents, explicit round
    }

    // Only set post_only for maker orders (resting orders)
    if (postOnly) {
      body.post_only = true
    }

    return this.post('/portfolio/orders', body)
  }

  async cancelOrder(orderId: string) {
    return this.post(`/portfolio/orders/${orderId}/cancel`, {})
  }
}
