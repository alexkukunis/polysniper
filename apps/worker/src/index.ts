import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(__dirname, '../../../.env') })

import { ChainlinkListener } from './chainlink'
import { PolymarketClient } from './polymarket'
import { StrategyEngine } from './strategy'
import { Executor } from './executor'
import { Monitor } from './monitor'
import { Scanner } from './scanner'
import { RiskManager } from './risk'
import { db } from '@repo/db'
import { sendAlert } from './alerts'
import http from 'http'

// Configuration from environment
const bankroll = parseFloat(process.env.BANKROLL_USDC || '1000')
const paperMode = process.env.PAPER_MODE !== 'false' // default to true

async function main() {
  console.log('🚀 Starting PolyMarket Oracle Lag Bot...')
  console.log(`   Bankroll: $${bankroll}`)
  console.log(`   Mode: ${paperMode ? 'PAPER' : 'LIVE'}`)

  // Initialize bot state in DB
  await db.botState.upsert({
    where: { id: 'singleton' },
    create: { 
      id: 'singleton', 
      bankroll, 
      running: true, 
      paperMode,
      dailyPnl: 0,
      totalPnl: 0,
    },
    update: { 
      running: true, 
      pausedReason: null, 
      lastHeartbeat: new Date(), 
      paperMode,
    },
  })

  const risk = new RiskManager(bankroll)
  const executor = new Executor(paperMode)
  const chainlink = new ChainlinkListener()
  const polymarket = new PolymarketClient()
  const scanner = new Scanner(polymarket)
  const monitor = new Monitor(executor, polymarket, risk)
  const strategy = new StrategyEngine(risk, executor, chainlink)

  // Wire executor <-> polymarket client
  executor.setPolymarketClient(polymarket)

  // Heartbeat every 30s
  setInterval(async () => {
    try {
      await db.botState.update({
        where: { id: 'singleton' },
        data: { lastHeartbeat: new Date() },
      })
    } catch {}
  }, 30_000)

  // Reset daily stats at midnight
  const msUntilMidnight = () => {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setHours(24, 0, 0, 0)
    return midnight.getTime() - now.getTime()
  }
  setTimeout(function resetDaily() {
    risk.resetDaily()
    setTimeout(resetDaily, 86_400_000)
  }, msUntilMidnight())

  // Health check endpoint for Railway
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', paperMode, bankroll }))
  }).listen(process.env.PORT || 3001)

  // Wire Chainlink → Strategy
  chainlink.on('price', (update: any) => {
    strategy.onChainlinkUpdate(update)
  })

  // Wire Polymarket book → Strategy
  polymarket.on('book', (update: any) => {
    strategy.onPolymarketUpdate(update)
  })

  // Start all services
  await scanner.start()        // discover active windows
  await chainlink.start()      // subscribe to BTC/ETH/SOL oracles
  await polymarket.start()     // subscribe to market orderbooks
  monitor.start()              // poll open trades every 10s

  await sendAlert(`✅ Bot live | Paper: ${paperMode} | Bankroll: $${bankroll}`)
  console.log(`✅ All systems live | Paper mode: ${paperMode}`)
}

main().catch(async err => {
  console.error('Fatal:', err)
  await sendAlert(`🚨 Bot crashed: ${err.message}`)
  process.exit(1)
})
