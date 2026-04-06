import { createSign } from 'crypto'

const DEMO_API_URL = 'https://demo-api.kalshi.co/trade-api/v2'
const PROD_API_URL = 'https://api.kalshi.com/trade-api/v2'

export interface OrderRequest {
  ticker: string
  type: 'market' | 'limit'
  action: 'buy' | 'sell'
  side: 'yes' | 'no'
  count: number
  yes_price?: number  // required for limit orders (0-100 cents)
  no_price?: number   // alternative pricing
  post_only?: boolean
  expiration_ts?: number
  time_in_force?: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel'
  client_order_id?: string
}

export interface OrderResponse {
  order: {
    order_id: string
    user_id: string
    ticker: string
    status: 'resting' | 'executing' | 'done' | 'canceled'
    yes_price: number
    count: number
    remaining_count: number
    action: 'buy' | 'sell'
    side: 'yes' | 'no'
    type: 'market' | 'limit'
    created_time: string
    expiration_time: string
    close_cancel_count: number
    queue_position: number
    place_count: number
    taker_fill_count: number
    taker_fees: number
  }
}

export interface Position {
  ticker: string
  market_ticker: string
  position: number  // positive = long, negative = short
  total_traded: number
  rest_orders_count: number
  sell_position_capped: boolean
  realized_pnl: number
  fees_paid: number
}

export interface MarketInfo {
  ticker: string
  event_ticker: string
  market_type: 'binary' | 'multiple_choice' | 'range'
  title: string
  subtitle: string
  yes_sub_title: string
  no_sub_title: string
  status: 'active' | 'closed' | 'settled'
  can_close_early: boolean
  expiration_time: string
  settlement_timer_seconds: number
  category: string
  strike_type?: string
  floor_strike?: number
  cap_strike?: number
  last_price: number
  previous_yes_ask: number
  previous_yes_bid: number
  volume: number
  volume_24h: number
  liquidity: number
  open_interest: number
  result: 'yes' | 'no' | null
  latest_trade_price: number
  latest_trade_ts: number
}

export class KalshiRestClient {
  private accessKey: string
  private privateKey: string
  private baseUrl: string

  constructor(accessKey: string, privateKey: string, isDemo = true) {
    this.accessKey = accessKey
    this.privateKey = privateKey
    this.baseUrl = isDemo ? DEMO_API_URL : PROD_API_URL
  }

  private signRequest(method: string, path: string): {
    timestamp: string
    signature: string
  } {
    // Per Kalshi docs: timestamp in MILLISECONDS
    const timestamp = Date.now().toString()
    // Strip query parameters before signing (per Kalshi docs warning)
    const cleanPath = path.split('?')[0]
    // Sign: timestamp + HTTP_METHOD + path (NO body)
    const payload = timestamp + method.toUpperCase() + cleanPath
    const sign = createSign('SHA256')
    sign.update(payload)
    const signature = sign.sign(this.privateKey, 'base64')
    return { timestamp, signature }
  }

  private getHeaders(method: string, path: string): Record<string, string> {
    const { timestamp, signature } = this.signRequest(method, path)

    return {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': this.accessKey,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
    }
  }

  private buildPath(endpoint: string): string {
    return `${this.baseUrl}${endpoint}`
  }

  async createOrder(order: OrderRequest): Promise<OrderResponse> {
    const endpoint = '/portfolio/orders'
    const body = {
      ticker: order.ticker,
      type: order.type,
      action: order.action,
      side: order.side,
      count: order.count,
      ...(order.yes_price && { yes_price: order.yes_price }),
      ...(order.no_price && { no_price: order.no_price }),
      ...(order.post_only && { post_only: order.post_only }),
      ...(order.expiration_ts && { expiration_ts: order.expiration_ts }),
      ...(order.time_in_force && { time_in_force: order.time_in_force }),
      ...(order.client_order_id && { client_order_id: order.client_order_id }),
    }

    const headers = this.getHeaders('POST', endpoint)
    const response = await fetch(this.buildPath(endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to create order: ${response.status} ${error}`)
    }

    return response.json()
  }

  async cancelOrder(orderId: string): Promise<void> {
    const endpoint = `/portfolio/orders/${orderId}`
    const headers = this.getHeaders('DELETE', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'DELETE',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to cancel order: ${response.status} ${error}`)
    }
  }

  async getPositions(): Promise<{ positions: Position[] }> {
    const endpoint = '/portfolio/positions'
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get positions: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getPosition(ticker: string): Promise<{ position: Position }> {
    const endpoint = `/portfolio/positions/${ticker}`
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get position: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getFills(orderId?: string): Promise<{ fills: any[] }> {
    const endpoint = orderId
      ? `/portfolio/fills?order_id=${orderId}`
      : '/portfolio/fills'
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get fills: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getMarket(ticker: string): Promise<{ market: MarketInfo }> {
    const endpoint = `/markets/${ticker}`
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get market: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getMarkets(params?: {
    event_ticker?: string
    status?: string
    limit?: number
    cursor?: string
  }): Promise<{ markets: MarketInfo[]; cursor?: string }> {
    const queryParams = new URLSearchParams()
    if (params?.event_ticker) queryParams.set('event_ticker', params.event_ticker)
    if (params?.status) queryParams.set('status', params.status)
    if (params?.limit) queryParams.set('limit', params.limit.toString())
    if (params?.cursor) queryParams.set('cursor', params.cursor)

    const endpoint = `/markets?${queryParams.toString()}`
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get markets: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getEvents(category?: string): Promise<{ events: any[] }> {
    const queryParams = category ? `?category=${category}` : ''
    const endpoint = `/events${queryParams}`
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get events: ${response.status} ${error}`)
    }

    return response.json()
  }

  /**
   * Get orderbook for a market.
   * Per Kalshi docs: only bids are returned (not asks),
   * because asks are implied via the YES/NO reciprocal relationship.
   */
  async getOrderbook(ticker: string): Promise<{
    market_ticker: string
    yes: Array<{ price: number; count: number }>
    no: Array<{ price: number; count: number }>
  }> {
    const endpoint = `/markets/${encodeURIComponent(ticker)}/orderbook`
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get orderbook: ${response.status} ${error}`)
    }

    return response.json()
  }

  async getBalance(): Promise<{ balance: number }> {
    const endpoint = '/portfolio/balance'
    const headers = this.getHeaders('GET', endpoint)

    const response = await fetch(this.buildPath(endpoint), {
      method: 'GET',
      headers,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Failed to get balance: ${response.status} ${error}`)
    }

    return response.json()
  }
}
