import { EventEmitter } from 'events'
import { ethers } from 'ethers'

// Chainlink oracle addresses on Polygon
const FEEDS: Record<string, string> = {
  BTC: '0xc907E116054Ad103354f2D350FD2514433D57F6f',
  ETH: '0xF9680D99D6C9589e2a93a78A04A279e509205945',
  SOL: '0x10C8264C0935b3B9870013e057f330Ff3e9C56dC',
}

const ABI = [
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]

export class ChainlinkListener extends EventEmitter {
  private provider: ethers.WebSocketProvider | null = null
  private prices: Record<string, number> = {}
  private prevPrices: Record<string, number> = {}

  constructor() {
    super()
  }

  async start() {
    if (!process.env.POLYGON_WSS_RPC) {
      console.warn('POLYGON_WSS_RPC not set, using HTTP fallback')
      // Fallback to polling via HTTP
      const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com')
      this.provider = provider as unknown as ethers.WebSocketProvider
      
      // Seed initial prices
      for (const [asset, address] of Object.entries(FEEDS)) {
        const contract = new ethers.Contract(address, ABI, provider)
        try {
          const [, answer] = await contract.latestRoundData()
          const price = Number(answer) / 1e8
          this.prices[asset] = price
          this.prevPrices[asset] = price
          console.log(`📡 ${asset} initial price: $${price}`)
        } catch (err) {
          console.error(`Failed to fetch ${asset} price:`, err)
        }
      }
      
      // Poll for updates every 30s (HTTP fallback)
      setInterval(async () => {
        for (const [asset, address] of Object.entries(FEEDS)) {
          try {
            const contract = new ethers.Contract(address, ABI, provider)
            const [, answer] = await contract.latestRoundData()
            const price = Number(answer) / 1e8
            const prev = this.prices[asset] ?? price
            this.prevPrices[asset] = prev
            this.prices[asset] = price
            const delta = ((price - prev) / prev) * 100
            this.emit('price', { asset, price, delta, prev, ts: Date.now() })
          } catch (err) {
            console.error(`Error fetching ${asset}:`, err)
          }
        }
      }, 30_000)
      return
    }

    // WebSocket mode
    this.provider = new ethers.WebSocketProvider(process.env.POLYGON_WSS_RPC!)
    
    for (const [asset, address] of Object.entries(FEEDS)) {
      const contract = new ethers.Contract(address, ABI, this.provider)

      // Seed initial price
      const [, answer] = await contract.latestRoundData()
      const price = Number(answer) / 1e8
      this.prices[asset] = price
      this.prevPrices[asset] = price
      console.log(`📡 ${asset} initial price: $${price}`)

      // Listen for updates
      contract.on('AnswerUpdated', (current: bigint) => {
        const price = Number(current) / 1e8
        const prev = this.prices[asset] ?? price
        const delta = ((price - prev) / prev) * 100

        this.prevPrices[asset] = prev
        this.prices[asset] = price

        this.emit('price', { asset, price, delta, prev, ts: Date.now() })
      })
    }

    // Reconnect on drop
    this.provider.on('error', () => {
      console.log('🔄 Chainlink WS dropped, reconnecting...')
      setTimeout(() => this.start(), 3000)
    })
  }

  getPrice(asset: string): number { 
    return this.prices[asset] ?? 0 
  }
}
