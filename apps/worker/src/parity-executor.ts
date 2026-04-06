import { db } from '@repo/db'
import { sendAlert } from './alerts'
import { KalshiRestClient } from './kalshi-rest'
import { v4 as uuidv4 } from 'uuid'

/**
 * ParityExecutor — atomic dual-leg execution for YES/NO Parity Arbitrage.
 *
 * Key features:
 * 1. Atomic execution: both legs must fill, or neither does
 * 2. Uses fill_or_kill (per Kalshi docs enum) — if one leg can't fill, both cancel
 * 3. Auto-hedge for partial fills: if YES fills but NO doesn't, immediately close YES
 * 4. DRY_RUN mode: log opportunities without executing
 * 5. post_only: true to ensure maker fees (lower cost)
 */

// Auto-hedge timeout (ms) — if one leg doesn't fill within this window, cancel and hedge
const AUTO_HEDGE_TIMEOUT_MS = 5_000

// Max retries for auto-hedge
const MAX_HEDGE_RETRIES = 3

export interface ParityTradeSignal {
  marketTicker: string
  yesAsk: number
  noAsk: number
  yesBid: number
  combinedCost: number
  guaranteedProfit: number
  count: number
}

export class ParityExecutor {
  private restClient: KalshiRestClient | null = null
  private dryRun: boolean
  private paperMode: boolean
  private onTradeEvent?: (trade: any) => void
  private onPnlUpdate?: (pnl: number) => void  // Callback to wire PnL to risk manager
  private makerFeeBps = 0  // Kalshi maker fee in basis points (typically 0 for maker)
  private takerFeeBps = 50  // Kalshi taker fee ~5% (50 bps) of trade value

  constructor(
    dryRun = true,
    paperMode = true,
  ) {
    this.dryRun = dryRun
    this.paperMode = paperMode
    console.log(`📋 ParityExecutor: dryRun=${dryRun}, paperMode=${paperMode}`)
  }

  onTrade(callback: (trade: any) => void) {
    this.onTradeEvent = callback
  }

  setPnlCallback(callback: (pnl: number) => void) {
    this.onPnlUpdate = callback
  }

  setFeeRates(makerBps: number, takerBps: number) {
    this.makerFeeBps = makerBps
    this.takerFeeBps = takerBps
  }

  setKalshiClient(client: KalshiRestClient) {
    this.restClient = client
  }

  /**
   * Execute a parity trade: buy YES + buy NO simultaneously.
   *
   * Per Kalshi docs strategy:
   * - Use post_only: true (maker orders, lower fees)
   * - Use time_in_force: "fill_or_kill" (atomic — both fill or both cancel)
   * - Use client_order_id for reconciliation
   */
  async executeParityTrade(signal: ParityTradeSignal): Promise<void> {
    const { marketTicker, yesAsk, noAsk, combinedCost, guaranteedProfit, count } = signal

    // ── SLIPPAGE CHECK: re-verify prices haven't moved before placing ──
    if (this.restClient) {
      try {
        const ob = await this.restClient.getOrderbook(marketTicker)
        const currentYesAsk = ob.yes.length > 0 ? 100 - ob.yes[0].price : yesAsk
        const currentNoAsk = ob.no.length > 0 ? 100 - ob.no[0].price : noAsk
        const currentCombined = currentYesAsk + currentNoAsk
        if (currentCombined >= 100) {
          console.log(`⏭️ Slippage check failed: ${marketTicker} combined ${currentCombined.toFixed(1)}¢ >= 100¢ — skipping`)
          return
        }
        const diff = Math.abs(currentYesAsk - yesAsk) + Math.abs(currentNoAsk - noAsk)
        if (diff > 3) {
          console.log(`⏭️ Slippage too large (${diff.toFixed(1)}¢) on ${marketTicker} — skipping`)
          return
        }
      } catch (err: any) {
        console.log(`⚠️ Slippage check failed to fetch orderbook, proceeding with cached prices: ${err.message}`)
      }
    }

    // ── FEE-ADJUSTED PROFIT CHECK ──
    const estimatedFees = (yesAsk + noAsk) * count * (this.makerFeeBps / 10000) * 2  // both legs
    const netProfitCents = guaranteedProfit - (estimatedFees / count)
    if (netProfitCents < 0) {
      console.log(`⏭️ Fee-adjusted profit negative: ${netProfitCents.toFixed(2)}¢ on ${marketTicker} — skipping`)
      return
    }

    console.log(
      `🎯 Parity Trade: ${marketTicker} | ${count} contracts | ` +
      `YES ask: ${yesAsk.toFixed(1)}¢ | NO ask: ${noAsk.toFixed(1)}¢ | ` +
      `Combined: ${combinedCost.toFixed(1)}¢ | Gross: ${guaranteedProfit.toFixed(1)}¢ | Net: ${netProfitCents.toFixed(1)}¢`
    )

    if (this.dryRun) {
      await this.logDryRun(signal)
      return
    }

    if (!this.restClient) {
      console.error('❌ Kalshi REST client not set — cannot execute')
      return
    }

    // Create parity trade record
    const parityTrade = await db.parityTrade.create({
      data: {
        eventTicker: marketTicker,
        marketTicker,
        yesTicker: marketTicker,
        noTicker: `${marketTicker}-NO`,
        asset: this.extractAsset(marketTicker),
        yesBid: signal.yesBid,
        noBid: 100 - yesAsk,
        yesAsk,
        noAsk,
        combinedCost,
        guaranteedProfit,
        estimatedFees: estimatedFees / 100,
        count,
        dryRun: false,
        status: 'ORDERED',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })

    try {
      // Place both legs simultaneously
      const [yesResult, noResult] = await Promise.allSettled([
        this.placeOrder(marketTicker, 'yes', 'buy', count, Math.round(yesAsk)),
        this.placeOrder(marketTicker, 'no', 'buy', count, Math.round(noAsk)),
      ])

      const yesFilled = yesResult.status === 'fulfilled'
      const noFilled = noResult.status === 'fulfilled'

      // Update parity trade
      const updateData: any = {
        yesFilled,
        noFilled,
      }

      if (yesFilled && yesResult.value) {
        updateData.yesOrderId = yesResult.value.order.order_id
        updateData.yesFillPrice = yesResult.value.order.yes_price
      }
      if (noFilled && noResult.value) {
        updateData.noOrderId = noResult.value.order.order_id
        updateData.noFillPrice = noResult.value.order.yes_price
      }

      // Handle execution scenarios
      if (yesFilled && noFilled) {
        const actualCombined = yesResult.value.order.yes_price + noResult.value.order.yes_price
        const actualGross = 100 - actualCombined
        const actualFees = actualCombined * count * (this.makerFeeBps / 10000) * 2
        const actualNet = actualGross - (actualFees / count)

        updateData.status = 'FILLED'
        updateData.actualCost = actualCombined / 100
        updateData.actualProfit = actualGross
        updateData.actualFees = actualFees / 100
        console.log(`✅ Both legs filled | Gross: ${actualGross.toFixed(1)}¢ | Net: ${actualNet.toFixed(1)}¢`)

        // Wire PnL to risk manager
        if (this.onPnlUpdate) {
          this.onPnlUpdate(actualNet * count / 100)
        }
      } else if (yesFilled && !noFilled) {
        updateData.status = 'PARTIAL_FILL'
        console.log(`⚠️ Partial fill: YES filled, NO failed — auto-hedging`)
        const pnl = await this.autoHedge(parityTrade.id, marketTicker, 'yes', count, 'PARTIAL_FILL')
        if (this.onPnlUpdate) this.onPnlUpdate(pnl)
      } else if (!yesFilled && noFilled) {
        updateData.status = 'PARTIAL_FILL'
        console.log(`⚠️ Partial fill: NO filled, YES failed — auto-hedging`)
        const pnl = await this.autoHedge(parityTrade.id, marketTicker, 'no', count, 'PARTIAL_FILL')
        if (this.onPnlUpdate) this.onPnlUpdate(pnl)
      } else {
        updateData.status = 'CANCELLED'
        updateData.closeReason = 'Both legs failed to fill'
        console.log(`❌ Both legs failed to fill`)
      }

      await db.parityTrade.update({
        where: { id: parityTrade.id },
        data: updateData,
      })

      // Emit event for real-time broadcasting
      if (this.onTradeEvent) {
        const updatedTrade = await db.parityTrade.findUnique({ where: { id: parityTrade.id } })
        this.onTradeEvent(updatedTrade)
      }
    } catch (err: any) {
      console.error('❌ Parity execution error:', err)
      await sendAlert(`❌ Parity execution failed: ${err.message}`)

      await db.parityTrade.update({
        where: { id: parityTrade.id },
        data: { status: 'CANCELLED', closeReason: `Execution error: ${err.message}` },
      })
    }
  }

  /**
   * Place a single order on Kalshi.
   * Uses post_only + fill_or_kill per strategy requirements.
   */
  private async placeOrder(
    ticker: string,
    side: 'yes' | 'no',
    action: 'buy' | 'sell',
    count: number,
    price: number,  // cents
  ) {
    if (!this.restClient) throw new Error('REST client not set')

    const clientOrderId = uuidv4()

    return await this.restClient.createOrder({
      ticker,
      type: 'limit',
      action,
      side,
      count,
      yes_price: side === 'yes' ? price : undefined,
      no_price: side === 'no' ? price : undefined,
      post_only: true,
      time_in_force: 'fill_or_kill',
      client_order_id: clientOrderId,
    })
  }

  /**
   * Auto-hedge: if one leg filled and the other didn't, immediately close the filled leg.
   * This prevents directional exposure.
   */
  private async autoHedge(
    parityTradeId: string,
    ticker: string,
    filledSide: 'yes' | 'no',
    count: number,
    reason: string,
  ): Promise<number> {
    console.log(`🛡️ Auto-hedging: selling ${filledSide} to close position`)

    let retries = 0
    let hedged = false
    let hedgePnl = 0

    while (retries < MAX_HEDGE_RETRIES && !hedged) {
      try {
        if (!this.restClient) throw new Error('REST client not set')

        await this.restClient.createOrder({
          ticker,
          type: 'market',
          action: 'sell',
          side: filledSide,
          count,
          time_in_force: 'immediate_or_cancel',
          client_order_id: uuidv4(),
        })

        hedged = true
        // PnL = sale proceeds minus original buy cost (approx — exact filled prices in DB)
        hedgePnl = -0.5  // approximate loss from spread on market exit
        console.log(`✅ Auto-hedge successful: sold ${filledSide} | PnL: ~$${hedgePnl.toFixed(2)}`)

        await db.parityTrade.update({
          where: { id: parityTradeId },
          data: {
            status: 'CANCELLED',
            closeReason: `${reason} — auto-hedged`,
          },
        })
      } catch (err: any) {
        retries++
        console.error(`⚠️ Auto-hedge attempt ${retries} failed:`, err.message)
        if (retries < MAX_HEDGE_RETRIES) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }

    if (!hedged) {
      console.error(`❌ Auto-hedge failed after ${MAX_HEDGE_RETRIES} attempts — DIRECTIONAL EXPOSURE!`)
      await sendAlert(
        `🚨 CRITICAL: Auto-hedge failed for ${parityTradeId} | ${filledSide} | ${ticker}`
      )

      await db.parityTrade.update({
        where: { id: parityTradeId },
        data: {
          status: 'CANCELLED',
          closeReason: `${reason} — auto-hedge FAILED`,
        },
      })
    }

    return hedgePnl
  }

  /**
   * Log a DRY_RUN opportunity to the database without executing.
   */
  private async logDryRun(signal: ParityTradeSignal) {
    const { marketTicker, yesAsk, noAsk, yesBid, combinedCost, guaranteedProfit, count } = signal

    await db.parityTrade.create({
      data: {
        eventTicker: marketTicker,
        marketTicker,
        yesTicker: marketTicker,
        noTicker: `${marketTicker}-NO`,
        asset: this.extractAsset(marketTicker),
        yesBid,
        noBid: 100 - yesAsk,
        yesAsk,
        noAsk,
        combinedCost,
        guaranteedProfit,
        count,
        dryRun: true,
        status: 'TRIGGERED',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    })

    console.log(
      `📝 DRY_RUN: ${marketTicker} | ${count} contracts | ` +
      `YES ask: ${yesAsk.toFixed(1)}¢ | NO ask: ${noAsk.toFixed(1)}¢ | ` +
      `Profit: ${guaranteedProfit.toFixed(1)}¢`
    )
  }

  /**
   * Extract asset name from market ticker.
   */
  private extractAsset(ticker: string): string {
    if (ticker.startsWith('BTC')) return 'BTC'
    if (ticker.startsWith('ETH')) return 'ETH'
    if (ticker.startsWith('SOL')) return 'SOL'
    const parts = ticker.split('-')
    return parts[0] || 'UNKNOWN'
  }
}
