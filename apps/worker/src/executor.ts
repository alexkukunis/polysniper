import { db } from '@repo/db'
import { sendAlert } from './alerts'
import { PolymarketClient } from './polymarket'
import { Side as ClobSide } from '@polymarket/clob-client'

function todayDate() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

interface OrderParams {
  asset: string
  marketId: string
  assetId: string
  window: string
  direction: string
  entryPrice: number
  size: number
  edge: number
  trueProb: number
  chainlinkPrice: number
  priceToBeat: number
  windowEndsAt: Date
}

export class Executor {
  private client: PolymarketClient | null = null
  private openPositions = new Map<string, string>()

  constructor(private paperMode: boolean) {
    console.log(`📋 Executor mode: ${paperMode ? 'PAPER' : 'LIVE'}`)
  }

  setPolymarketClient(client: PolymarketClient) {
    this.client = client
  }

  async placeOrder(p: OrderParams) {
    const shares = parseFloat((p.size / p.entryPrice).toFixed(2))

    let orderId: string | null = null

    if (!this.paperMode && this.client) {
      try {
        const order = await this.client.clob.createOrder({
          tokenID: p.assetId,
          price: p.entryPrice,
          side: ClobSide.BUY,
          size: shares,
        } as any)
        orderId = String(order?.orderID ?? null)
      } catch (err: any) {
        console.error('Order placement failed:', err.message)
        await sendAlert(`⚠️ Order failed: ${err.message}`)
        return
      }
    }

    const trade = await db.trade.create({
      data: {
        asset: p.asset,
        marketId: p.marketId,
        assetId: p.assetId,
        window: p.window,
        direction: p.direction,
        entryPrice: p.entryPrice,
        size: p.size,
        shares,
        chainlinkAt: p.chainlinkPrice,
        polymarketAt: p.entryPrice,
        priceToBeat: p.priceToBeat,
        edge: p.edge,
        status: 'OPEN',
        windowEndsAt: p.windowEndsAt,
        orderId,
        paperTrade: this.paperMode,
      },
    })

    this.openPositions.set(trade.id, p.assetId)

    try {
      await db.dailyStats.upsert({
        where: { date: todayDate() },
        create: { date: todayDate(), trades: 1 },
        update: { trades: { increment: 1 } },
      })
    } catch {}

    console.log(
      `${this.paperMode ? '📝' : '✅'} Trade ${trade.id.slice(0, 8)} | ${p.asset} ${p.direction} | ${shares} shares @ ${p.entryPrice.toFixed(2)} | $${p.size}`
    )
    return trade
  }

  async closeTrade(tradeId: string, exitPrice: number, reason: string) {
    const trade = await db.trade.findUnique({ where: { id: tradeId } })
    if (!trade || trade.status !== 'OPEN') return

    const isWin = reason === 'RESOLUTION'
      ? exitPrice >= 0.95
      : exitPrice > trade.entryPrice

    const pnl = isWin
      ? (exitPrice - trade.entryPrice) * trade.shares
      : -(trade.entryPrice * trade.shares)

    const outcome = isWin ? 'WIN' : 'LOSS'

    await db.trade.update({
      where: { id: tradeId },
      data: {
        exitPrice,
        status: reason === 'RESOLUTION' ? 'RESOLVED' : 'CLOSED',
        closeReason: reason,
        pnl,
        outcome,
        resolvedAt: new Date(),
      },
    })

    try {
      await db.dailyStats.upsert({
        where: { date: todayDate() },
        create: { date: todayDate(), [isWin ? 'wins' : 'losses']: 1, pnl },
        update: {
          [isWin ? 'wins' : 'losses']: { increment: 1 },
          pnl: { increment: pnl },
        },
      })
    } catch {}

    try {
      await db.botState.update({
        where: { id: 'singleton' },
        data: {
          dailyPnl: { increment: pnl },
          totalPnl: { increment: pnl },
          bankroll: { increment: pnl },
        },
      })
    } catch {}

    this.openPositions.delete(tradeId)

    console.log(
      `${isWin ? '🟢' : '🔴'} Trade closed | ${outcome} | PnL: $${pnl.toFixed(2)} | Reason: ${reason}`
    )

    if (Math.abs(pnl) > 50) {
      await sendAlert(
        `${isWin ? '🟢' : '🔴'} ${outcome} $${pnl.toFixed(2)} | ${trade.asset} ${trade.direction} | ${reason}`
      )
    }

    return { pnl, outcome }
  }

  getOpenPositionIds() { 
    return [...this.openPositions.keys()] 
  }
}
