import { db } from '@repo/db'
import { sendAlert } from './alerts'

const DAILY_LOSS_LIMIT_PCT = 0.03  // pause if down 3% in a day
const MAX_POSITION_PCT = 0.05      // max 5% of bankroll per position
const MAX_OPEN_POSITIONS = 10
const MIN_TRADE_SIZE = 10          // minimum $10 per trade

export class RiskManager {
  private openCount = 0
  private dailyPnl = 0
  private paused = false

  constructor(private bankroll: number) {
    this.syncFromDb()
  }

  private async syncFromDb() {
    try {
      const s = await db.botState.findUnique({ where: { id: 'singleton' } })
      if (s) { 
        this.dailyPnl = s.dailyPnl
        this.bankroll = s.bankroll 
      }
    } catch (err) {
      console.error('Failed to sync risk state from DB:', err)
    }
  }

  sizePosition(edge: number): number | null {
    if (this.paused) {
      console.log('⛔ Risk: bot is paused')
      return null
    }
    if (this.openCount >= MAX_OPEN_POSITIONS) {
      console.log(`⛔ Risk: max positions reached (${MAX_OPEN_POSITIONS})`)
      return null
    }

    const lossLimit = this.bankroll * DAILY_LOSS_LIMIT_PCT
    if (this.dailyPnl < -lossLimit) {
      this.pause('Daily loss limit reached')
      return null
    }

    // Half-Kelly formula for position sizing
    // Kelly % = (bp - q) / b where b = odds, p = true prob, q = 1-p
    // Simplified: edge / (1 - edge) ≈ edge for small edges
    const kelly = edge / (1 - edge)
    const halfKelly = kelly * 0.5
    const maxSize = this.bankroll * MAX_POSITION_PCT
    const size = Math.min(this.bankroll * halfKelly, maxSize)
    const rounded = Math.round(size * 100) / 100

    if (rounded < MIN_TRADE_SIZE) {
      console.log(`⛔ Risk: size ${rounded} below minimum ${MIN_TRADE_SIZE}`)
      return null
    }

    this.openCount++
    return rounded
  }

  onPositionClose() { 
    this.openCount = Math.max(0, this.openCount - 1) 
  }

  onPnlUpdate(delta: number) { 
    this.dailyPnl += delta 
  }

  resetDaily() {
    this.dailyPnl = 0
    this.paused = false
    console.log('🔄 Daily stats reset')
  }

  private async pause(reason: string) {
    this.paused = true
    await sendAlert(`⛔ Bot paused: ${reason}`)
    try {
      await db.botState.update({
        where: { id: 'singleton' },
        data: { running: false, pausedReason: reason },
      })
    } catch (err) {
      console.error('Failed to update bot state:', err)
    }
  }

  isPaused() { return this.paused }
  getOpenCount() { return this.openCount }
}
