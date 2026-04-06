import { db } from '@repo/db'
import { RiskManager } from './risk'
import { Executor } from './executor'
import { ChainlinkListener } from './chainlink'

// Thresholds: minimum % BTC/ETH/SOL move to consider signal valid
const THRESHOLDS: Record<string, Record<string, number>> = {
  BTC: { '5min': 0.25, '15min': 0.35, '1hour': 0.70 },
  ETH: { '5min': 0.30, '15min': 0.40, '1hour': 0.80 },
  SOL: { '5min': 0.40, '15min': 0.55, '1hour': 1.00 },
}

// Minimum edge after ~2% Polymarket fee per side
const MIN_EDGE = 0.08

// Cooldown per asset ID after firing (ms)
const COOLDOWN_MS = 120_000

export class StrategyEngine {
  private oraclePrices: Record<string, { price: number; delta: number }> = {}
  private cooldowns = new Set<string>()
  private marketCache: Record<string, any> = {}

  constructor(
    private risk: RiskManager,
    private executor: Executor,
    private chainlink: ChainlinkListener,
  ) {
    // Refresh market cache every 5 min
    setInterval(() => this.refreshMarketCache(), 5 * 60 * 1000)
    this.refreshMarketCache()
  }

  private async refreshMarketCache() {
    try {
      const markets = await db.market.findMany({ where: { active: true } })
      for (const m of markets) {
        this.marketCache[m.upTokenId] = { ...m, direction: 'UP' }
        this.marketCache[m.downTokenId] = { ...m, direction: 'DOWN' }
      }
      console.log(`🔄 Market cache refreshed: ${markets.length * 2} tokens`)
    } catch (err) {
      console.error('Failed to refresh market cache:', err)
    }
  }

  onChainlinkUpdate({ asset, price, delta }: { asset: string; price: number; delta: number }) {
    this.oraclePrices[asset] = { price, delta }
  }

  async onPolymarketUpdate({ assetId, bid, ask }: { assetId: string; bid: number; ask: number }) {
    const market = this.marketCache[assetId]
    if (!market) return
    if (this.cooldowns.has(assetId)) return

    const oracle = this.oraclePrices[market.asset]
    if (!oracle) return

    const threshold = THRESHOLDS[market.asset]?.[market.window] ?? 0.40
    if (Math.abs(oracle.delta) < threshold) return

    // Is the move in the same direction as this token?
    const moveUp = oracle.delta > 0
    const isUpToken = market.direction === 'UP'
    const aligned = moveUp === isUpToken

    if (!aligned) return // only trade in direction of move

    // Calculate implied true probability
    const absDelta = Math.abs(oracle.delta)
    const trueProb = this.calcTrueProb(absDelta, market.window, market.asset)

    // Entry price is the ask (cost to buy this token)
    const entryPrice = ask
    const edge = trueProb - entryPrice

    if (edge < MIN_EDGE) return

    // Check window isn't about to expire (need at least 90 seconds)
    const windowEndsAt = new Date(market.windowEndsAt)
    const secRemaining = (windowEndsAt.getTime() - Date.now()) / 1000
    if (secRemaining < 90) return

    const size = this.risk.sizePosition(edge)
    if (!size) return

    console.log(
      `🎯 ${market.asset} ${market.direction} | Edge: ${(edge * 100).toFixed(1)}¢ | ΔOracle: ${oracle.delta.toFixed(2)}% | Size: $${size}`
    )

    // Cooldown this token
    this.cooldowns.add(assetId)
    setTimeout(() => this.cooldowns.delete(assetId), COOLDOWN_MS)

    await this.executor.placeOrder({
      asset: market.asset,
      marketId: market.id,
      assetId,
      window: market.window,
      direction: market.direction,
      entryPrice,
      size,
      edge,
      trueProb,
      chainlinkPrice: oracle.price,
      priceToBeat: market.priceToBeat ?? oracle.price,
      windowEndsAt,
    })
  }

  // Calibrated probability model based on delta magnitude
  private calcTrueProb(deltaPct: number, window: string, asset: string): number {
    const scales: Record<string, Record<string, number>> = {
      BTC: { '5min': 6, '15min': 4, '1hour': 2.5 },
      ETH: { '5min': 7, '15min': 5, '1hour': 3 },
      SOL: { '5min': 8, '15min': 6, '1hour': 4 },
    }
    const scale = scales[asset]?.[window] ?? 5
    // Sigmoid: maps delta% to probability 0.5 → 1.0
    const raw = 0.5 + (deltaPct / scale) * 0.45
    return Math.min(Math.max(raw, 0.5), 0.95)
  }
}
