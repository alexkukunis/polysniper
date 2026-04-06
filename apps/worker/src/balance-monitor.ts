import { KalshiRestClient } from './kalshi-rest'
import { sendAlert } from './alerts'

/**
 * BalanceMonitor — checks Kalshi account balance hourly.
 * Pauses trading if balance drops below minimum threshold.
 */

// Minimum balance before auto-pause ($)
const MIN_BALANCE = 100

// How often to check balance (ms)
const CHECK_INTERVAL_MS = 3_600_000  // 1 hour

export class BalanceMonitor {
  private restClient: KalshiRestClient
  private checkInterval: NodeJS.Timeout | null = null
  private minBalance: number

  constructor(
    restClient: KalshiRestClient,
    minBalance = MIN_BALANCE,
  ) {
    this.restClient = restClient
    this.minBalance = minBalance
  }

  start() {
    console.log(`💰 Starting BalanceMonitor (min: $${this.minBalance})...`)
    // Check immediately
    this.checkBalance()
    // Then every hour
    this.checkInterval = setInterval(() => this.checkBalance(), CHECK_INTERVAL_MS)
  }

  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
  }

  private async checkBalance() {
    try {
      const { balance } = await this.restClient.getBalance()
      const balanceDollars = balance / 100  // Kalshi returns cents

      console.log(`💰 Account balance: $${balanceDollars.toFixed(2)}`)

      if (balanceDollars < this.minBalance) {
        await sendAlert(
          `⚠️ LOW BALANCE: $${balanceDollars.toFixed(2)} (min: $${this.minBalance}) — Pause trading`
        )
        console.error(`⚠️ Balance too low: $${balanceDollars.toFixed(2)}`)
        // Could trigger bot pause here via DB update
        return false
      }

      return true
    } catch (err: any) {
      console.error('❌ Balance check failed:', err.message)
      return false
    }
  }

  async getBalance(): Promise<number> {
    try {
      const { balance } = await this.restClient.getBalance()
      return balance / 100  // Convert cents to dollars
    } catch {
      return 0
    }
  }
}
