'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import Link from 'next/link'

interface SnipeAuditEntry {
  time: string
  btcPrice: number
  trigger: string
  action: string
  status: 'filled' | 'canceled' | 'dry_run' | 'error'
  orderId?: string
  edge: number
  skipReason?: string
  latencyMs?: number
  momentumContext?: { change2s: number | null; change5s: number | null; change30s: number | null }
  edgeExplanation?: string
  yesAskAtDecision: number
  yesBidAtDecision: number
  dynamicMinEdge: number
  depthCheck?: string
}

interface OpenPosition {
  id: string
  side: 'yes' | 'no'
  action: 'buy' | 'sell'
  entryPriceCents: number
  count: number
  btcPriceAtEntry: number
  ageSeconds: number
  estimatedPnLCents: number
}

interface BotState {
  running: boolean
  ordersPlaced: number
  fillsReceived: number
  inventoryYes: number
  inventoryNo: number
  isDemo: boolean
  dryRun: boolean
  orderbookReady: boolean
  yesBid: number | null
  yesAsk: number | null
  btcPrice: number
  strikePrice: number
  // P&L
  realizedPnLCents: number
  unrealizedPnLCents: number
  totalPnLCents: number
  winRate: number
  totalTrades: number
  avgLatencyMs: number
  bestTradeCents: number
  worstTradeCents: number
  // Exit strategy
  exitOrdersPlaced: number
  stopLossesTriggered: number
  takeProfitsTriggered: number
  timeExitsTriggered: number
  maxHoldSeconds: number
  stopLossBtcUsd: number
  takeProfitCents: number
  openPositions: OpenPosition[]
  // Momentum
  btcChange2s: number | null
  btcChange5s: number | null
  btcChange30s: number | null
  btcPriceHistory: { price: number; timestamp: number }[]
}

export default function Dashboard() {
  const [botState, setBotState] = useState<BotState>({
    running: false, ordersPlaced: 0, fillsReceived: 0,
    inventoryYes: 0, inventoryNo: 0, isDemo: true, dryRun: true,
    orderbookReady: false, yesBid: null, yesAsk: null, btcPrice: 0, strikePrice: 0,
    realizedPnLCents: 0, unrealizedPnLCents: 0, totalPnLCents: 0,
    winRate: 0, totalTrades: 0, avgLatencyMs: 0, bestTradeCents: 0, worstTradeCents: 0,
    exitOrdersPlaced: 0, stopLossesTriggered: 0, takeProfitsTriggered: 0, timeExitsTriggered: 0,
    maxHoldSeconds: 30, stopLossBtcUsd: 30, takeProfitCents: 10,
    openPositions: [],
    btcChange2s: null, btcChange5s: null, btcChange30s: null,
    btcPriceHistory: [],
  })
  const [auditLog, setAuditLog] = useState<SnipeAuditEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [showExitInfo, setShowExitInfo] = useState(false)
  const [auditFilter, setAuditFilter] = useState<'all' | 'filled' | 'skipped' | 'exits' | 'errors'>('all')
  const [pingResult, setPingResult] = useState<{
    success: boolean
    target: string
    method: string
    summary: {
      avgLatency: number | null
      minLatency: number | null
      maxLatency: number | null
      jitter: number | null
      successful: number
      failed: number
      total: number
      threshold: number
      verdict: 'institutional' | 'good' | 'slow' | 'unreachable'
    }
    individualResults: string[]
    errors: string[]
  } | null>(null)
  const [pingRunning, setPingRunning] = useState(false)
  const [showPingModal, setShowPingModal] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  // Use refs for high-frequency updates
  const btcPriceRef = useRef<number>(0)
  const yesBidRef = useRef<number | null>(null)
  const yesAskRef = useRef<number | null>(null)
  const [, forceRender] = useState(0)

  // Edge Detection
  const prevDistanceRef = useRef<number | null>(null)
  const prevYesAskRef = useRef<number | null>(null)
  const [edgeFlash, setEdgeFlash] = useState(false)
  const flashTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Throttle renders (10fps max)
  const lastRenderRef = useRef(0)
  const throttledUpdate = useCallback(() => {
    const now = Date.now()
    if (now - lastRenderRef.current < 100) return
    lastRenderRef.current = now
    forceRender(n => n + 1)
  }, [])

  // Ping test
  const runPingTest = useCallback(async () => {
    setPingRunning(true)
    setShowPingModal(true)
    try {
      const res = await fetch('/api/ping')
      const data = await res.json()
      setPingResult(data)
    } catch (err: any) {
      setPingResult({
        success: false,
        target: 'trading-api.kalshi.com',
        method: 'TCP/HTTP connection latency',
        summary: { avgLatency: null, minLatency: null, maxLatency: null, jitter: null, successful: 0, failed: 5, total: 5, threshold: 10, verdict: 'unreachable' },
        individualResults: [],
        errors: [err.message],
      })
    } finally {
      setPingRunning(false)
    }
  }, [])

  // Connect to WebSocket
  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/ws`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => setConnected(true)

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)

          switch (msg.type) {
            case 'bot_state':
              setBotState(prev => {
                const next = { ...prev, ...msg }
                if (msg.btcPrice) btcPriceRef.current = msg.btcPrice
                if (msg.yesBid !== undefined) yesBidRef.current = msg.yesBid
                if (msg.yesAsk !== undefined) yesAskRef.current = msg.yesAsk

                // Edge detection
                if (msg.strikePrice && msg.btcPrice && msg.yesAsk !== undefined) {
                  const distToStrike = msg.strikePrice - msg.btcPrice
                  const prevDist = prevDistanceRef.current
                  const prevAsk = prevYesAskRef.current

                  if (prevDist !== null && prevAsk !== null) {
                    const btcMovedCloser = distToStrike < prevDist
                    const kalshiDidntMove = msg.yesAsk <= prevAsk
                    if (btcMovedCloser && kalshiDidntMove) {
                      setEdgeFlash(true)
                      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
                      flashTimerRef.current = setTimeout(() => setEdgeFlash(false), 1500)
                    }
                  }
                  prevDistanceRef.current = distToStrike
                  prevYesAskRef.current = msg.yesAsk
                }

                return next
              })
              throttledUpdate()
              break

            case 'audit':
              setAuditLog(prev => {
                const entry: SnipeAuditEntry = {
                  time: msg.time,
                  btcPrice: msg.btcPrice,
                  trigger: msg.trigger,
                  action: msg.action,
                  status: msg.status,
                  orderId: msg.orderId,
                  edge: msg.edge,
                  skipReason: msg.skipReason,
                  latencyMs: msg.latencyMs,
                  momentumContext: msg.momentumContext,
                  edgeExplanation: msg.edgeExplanation,
                  yesAskAtDecision: msg.yesAskAtDecision,
                  yesBidAtDecision: msg.yesBidAtDecision,
                  dynamicMinEdge: msg.dynamicMinEdge ?? 0,
                  depthCheck: msg.depthCheck,
                }
                return [entry, ...prev].slice(0, 200)
              })
              break

            case 'orderbook':
              if (msg.yesBid !== undefined) yesBidRef.current = msg.yesBid
              if (msg.yesAsk !== undefined) yesAskRef.current = msg.yesAsk
              throttledUpdate()
              break

            case 'trade_update':
              // Force re-render for position updates
              forceRender(n => n + 1)
              break
          }
        } catch {}
      }

      ws.onclose = () => { setConnected(false); reconnectTimer = setTimeout(connect, 3000) }
      ws.onerror = () => setConnected(false)
    }

    connect()
    return () => {
      clearTimeout(reconnectTimer)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    }
  }, [throttledUpdate])

  // ── Formatters ──

  function formatTime(iso: string) {
    if (!iso) return '--'
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any)
  }

  function formatBtc(price: number) {
    if (!price || price === 0) return '--'
    return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  function formatPnl(cents: number) {
    const dollars = cents / 100
    const sign = dollars >= 0 ? '+' : ''
    return `${sign}$${dollars.toFixed(2)}`
  }

  function formatPnlColor(cents: number) {
    if (cents > 0) return 'text-emerald-400'
    if (cents < 0) return 'text-red-400'
    return 'text-gray-500'
  }

  // ── BTC Sparkline ──
  function renderSparkline() {
    const history = botState.btcPriceHistory
    if (history.length < 2) return null

    const prices = history.map(p => p.price)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const range = max - min || 1

    const width = 280
    const height = 40
    const points = prices.map((p, i) => {
      const x = (i / (prices.length - 1)) * width
      const y = height - ((p - min) / range) * height
      return `${x},${y}`
    }).join(' ')

    // Determine color based on recent trend
    const last5 = prices.slice(-5)
    const isUp = last5[last5.length - 1] >= last5[0]
    const color = isUp ? '#34d399' : '#f87171'

    return (
      <svg width={width} height={height} className="opacity-60">
        <polyline
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          points={points}
        />
      </svg>
    )
  }

  const spread = botState.yesBid !== null && botState.yesAsk !== null
    ? botState.yesAsk - botState.yesBid : null

  // ── Audit filtering ──
  const filteredAudit = auditLog.filter(a => {
    switch (auditFilter) {
      case 'filled': return a.status === 'filled' && !a.trigger.startsWith('EXIT:')
      case 'skipped': return a.status === 'canceled' && !a.trigger.startsWith('EXIT:')
      case 'exits': return a.trigger.startsWith('EXIT:')
      case 'errors': return a.status === 'error'
      default: return true
    }
  })

  return (
    <main className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0a0a]/90 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">KalshiSniper</h1>
              <p className="text-[10px] text-gray-500">Latency Arbitrage Bot</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full ${connected ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full ${botState.dryRun ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
              {botState.dryRun ? 'DRY RUN' : 'LIVE'}
            </span>
            <button
              onClick={runPingTest}
              className="px-3 py-1 text-xs font-medium text-purple-400 hover:text-purple-300 border border-purple-500/20 hover:border-purple-500/40 rounded-lg transition-all"
            >
              ⚡ Network Test
            </button>
            <Link href="/settings" className="px-3 py-1 text-xs text-gray-400 hover:text-white border border-white/10 rounded-lg transition-colors">
              Settings
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">

        {/* ═══════════════════ P&L CARD ═══════════════════ */}
        <div className="bg-[#111] border border-white/5 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">💰 P&L Dashboard</span>
            {botState.totalTrades > 0 && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded ${botState.winRate >= 50 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                Win Rate: {botState.winRate}%
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
            {/* Realized P&L */}
            <div>
              <div className="text-[10px] text-gray-600 mb-0.5">Realized P&L</div>
              <div className={`text-2xl font-mono font-bold ${formatPnlColor(botState.realizedPnLCents)}`}>
                {formatPnl(botState.realizedPnLCents)}
              </div>
            </div>

            {/* Unrealized P&L */}
            <div>
              <div className="text-[10px] text-gray-600 mb-0.5">Unrealized P&L</div>
              <div className={`text-2xl font-mono font-bold ${formatPnlColor(botState.unrealizedPnLCents)}`}>
                {formatPnl(botState.unrealizedPnLCents)}
              </div>
            </div>

            {/* Total Trades */}
            <div>
              <div className="text-[10px] text-gray-600 mb-0.5">Completed Trades</div>
              <div className="text-2xl font-mono font-bold text-white">
                {botState.totalTrades}
              </div>
            </div>

            {/* Avg Latency */}
            <div>
              <div className="text-[10px] text-gray-600 mb-0.5">Decision Latency</div>
              <div className="text-2xl font-mono font-bold text-white">
                {botState.avgLatencyMs > 0 ? `${botState.avgLatencyMs}ms` : '--'}
              </div>
            </div>
          </div>

          {/* Exit Stats Row */}
          <div className="grid grid-cols-5 gap-2 pt-3 border-t border-white/5">
            <div className="text-center">
              <div className="text-[10px] text-gray-600">Exits Fired</div>
              <div className="text-sm font-mono text-white">{botState.exitOrdersPlaced}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-red-500/60">🛑 Stop-Losses</div>
              <div className="text-sm font-mono text-red-400">{botState.stopLossesTriggered}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-emerald-500/60">💰 Take-Profits</div>
              <div className="text-sm font-mono text-emerald-400">{botState.takeProfitsTriggered}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-gray-500">⏰ Time Exits</div>
              <div className="text-sm font-mono text-gray-400">{botState.timeExitsTriggered}</div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-gray-600">Best Trade</div>
              <div className="text-sm font-mono text-emerald-400">
                {botState.bestTradeCents > 0 ? `+${botState.bestTradeCents}¢` : '--'}
              </div>
            </div>
          </div>
        </div>

        {/* ═══════════════════ DUAL PRICE FEED ═══════════════════ */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Binance Futures BTC/USDT */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">⚡ Binance Futures BTC/USDT</span>
              <span className="text-[10px] text-gray-600">Real-time</span>
            </div>
            <div className="text-3xl font-mono font-bold text-amber-400 tracking-tight">
              {formatBtc(btcPriceRef.current)}
            </div>

            {/* Momentum indicators */}
            <div className="flex gap-3 mt-2">
              {botState.btcChange2s !== null && (
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  botState.btcChange2s >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                }`}>
                  2s: {botState.btcChange2s >= 0 ? '+' : ''}${botState.btcChange2s.toFixed(0)}
                </span>
              )}
              {botState.btcChange5s !== null && (
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  botState.btcChange5s >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                }`}>
                  5s: {botState.btcChange5s >= 0 ? '+' : ''}${botState.btcChange5s.toFixed(0)}
                </span>
              )}
              {botState.btcChange30s !== null && (
                <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                  botState.btcChange30s >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                }`}>
                  30s: {botState.btcChange30s >= 0 ? '+' : ''}${botState.btcChange30s.toFixed(0)}
                </span>
              )}
            </div>

            {/* Sparkline */}
            <div className="mt-2">
              {renderSparkline()}
            </div>
          </div>

          {/* Kalshi Orderbook */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">📖 Kalshi Orderbook</span>
              {botState.orderbookReady ? (
                <span className="text-[10px] text-emerald-500">Ready</span>
              ) : (
                <span className="text-[10px] text-amber-500">Waiting...</span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-[10px] text-gray-500">YES Bid</div>
                <div className="text-2xl font-mono font-semibold text-emerald-400">
                  {yesBidRef.current !== null ? `${yesBidRef.current}¢` : '--'}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">YES Ask</div>
                <div className="text-2xl font-mono font-semibold text-red-400">
                  {yesAskRef.current !== null ? `${yesAskRef.current}¢` : '--'}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Spread</div>
                <div className="text-2xl font-mono font-semibold text-white">
                  {spread !== null ? `${spread}¢` : '--'}
                </div>
              </div>
            </div>
            <div className="text-[10px] text-gray-600 mt-1">
              YES Ask = 100¢ − max(NO bids) | Binary parity
            </div>
          </div>
        </div>

        {/* ═══════════════════ EDGE MONITOR + OPEN POSITIONS ═══════════════════ */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Edge Distance Card */}
          <div
            className={`rounded-xl p-4 transition-all duration-300 ${
              edgeFlash
                ? 'border-2 border-emerald-400 bg-emerald-500/10 shadow-lg shadow-emerald-500/20'
                : 'border border-white/5 bg-[#111]'
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-gray-500">🎯 Edge Monitor</span>
                {edgeFlash && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/20 text-emerald-300 animate-pulse">
                    ⚡ EDGE FORMING
                  </span>
                )}
              </div>
              {botState.strikePrice ? (
                <span className="text-[10px] text-gray-600">Strike: ${botState.strikePrice.toLocaleString()}</span>
              ) : (
                <span className="text-[10px] text-amber-500">Waiting...</span>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-gray-500">BTC → Strike</span>
                <span className={`text-xl font-mono font-bold ${edgeFlash ? 'text-emerald-300' : 'text-white'}`}>
                  {botState.strikePrice && btcPriceRef.current
                    ? `$${Math.abs(botState.strikePrice - btcPriceRef.current).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                    : '--'}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-[10px] text-gray-500">YES Ask</span>
                <span className={`text-xl font-mono font-bold ${edgeFlash ? 'text-emerald-300' : 'text-red-400'}`}>
                  {yesAskRef.current !== null ? `${yesAskRef.current}¢` : '--'}
                </span>
              </div>
            </div>
          </div>

          {/* Open Positions */}
          <div className="bg-[#111] border border-white/5 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">📦 Open Positions</span>
              <span className={`text-xs font-mono ${botState.openPositions.length > 0 ? 'text-amber-400' : 'text-gray-600'}`}>
                {botState.openPositions.length} active
              </span>
            </div>
            {botState.openPositions.length === 0 ? (
              <div className="text-center py-4 text-gray-700 text-xs">No open positions</div>
            ) : (
              <div className="space-y-2">
                {botState.openPositions.map(pos => {
                  const ageColor = pos.ageSeconds > botState.maxHoldSeconds * 0.8
                    ? 'text-red-400'
                    : pos.ageSeconds > botState.maxHoldSeconds * 0.5
                    ? 'text-amber-400'
                    : 'text-gray-400'

                  return (
                    <div key={pos.id} className="bg-white/[0.02] border border-white/5 rounded-lg p-2">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                            pos.side === 'yes' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400'
                          }`}>
                            {pos.side.toUpperCase()}
                          </span>
                          <span className="text-xs font-mono text-white">@ {pos.entryPriceCents}¢</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] font-mono ${formatPnlColor(pos.estimatedPnLCents)}`}>
                            {formatPnl(pos.estimatedPnLCents)}
                          </span>
                          <span className={`text-[10px] font-mono ${ageColor}`}>
                            ⏱️ {pos.ageSeconds}s / {botState.maxHoldSeconds}s
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* ═══════════════════ BOT STATS ═══════════════════ */}
        <div className="grid grid-cols-5 gap-2">
          {[
            { label: 'Orders Fired', value: botState.ordersPlaced, color: 'text-white' },
            { label: 'Fills', value: botState.fillsReceived, color: 'text-emerald-400' },
            { label: 'Inv YES', value: `${botState.inventoryYes}/20`, color: 'text-white' },
            { label: 'Inv NO', value: `${botState.inventoryNo}/20`, color: 'text-white' },
            { label: 'Exit Config', value: `${botState.maxHoldSeconds}s / $${botState.stopLossBtcUsd} / ${botState.takeProfitCents}¢`, color: 'text-gray-400' },
          ].map(s => (
            <div key={s.label} className="bg-[#111] border border-white/5 rounded-lg p-3 text-center">
              <div className="text-[10px] text-gray-500 mb-0.5">{s.label}</div>
              <div className={`text-sm font-semibold font-mono ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ═══════════════════ EXIT STRATEGY INFO (collapsible) ═══════════════════ */}
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowExitInfo(!showExitInfo)}
            className="w-full px-4 py-2 flex items-center justify-between text-left hover:bg-white/[0.02]"
          >
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider text-gray-500">🛡️ Exit Strategy Configuration</span>
            </div>
            <span className="text-xs text-gray-500">{showExitInfo ? '▲' : '▼'}</span>
          </button>
          {showExitInfo && (
            <div className="px-4 pb-3 space-y-2 border-t border-white/5 pt-3">
              <div className="grid grid-cols-3 gap-4 text-xs">
                <div>
                  <div className="text-gray-600 text-[10px]">Max Hold Time</div>
                  <div className="font-mono text-white">{botState.maxHoldSeconds}s</div>
                  <div className="text-gray-700 text-[10px]">Auto-exit after this duration</div>
                </div>
                <div>
                  <div className="text-gray-600 text-[10px]">Stop-Loss</div>
                  <div className="font-mono text-red-400">${botState.stopLossBtcUsd} BTC</div>
                  <div className="text-gray-700 text-[10px]">Exit if BTC reverses this much</div>
                </div>
                <div>
                  <div className="text-gray-600 text-[10px]">Take-Profit</div>
                  <div className="font-mono text-emerald-400">{botState.takeProfitCents}¢</div>
                  <div className="text-gray-700 text-[10px]">Exit when position hits this profit</div>
                </div>
              </div>
              <div className="text-[10px] text-gray-600 pt-1">
                Entry: <code className="text-gray-500">SPIKE_THRESHOLD=$50</code> · <code className="text-gray-500">MIN_EDGE_CENTS=1¢</code> &nbsp;|&nbsp; Exit: <code className="text-gray-500">MAX_HOLD_SECONDS</code> · <code className="text-gray-500">STOP_LOSS_BTC_USD</code> · <code className="text-gray-500">TAKE_PROFIT_CENTS</code>
              </div>
            </div>
          )}
        </div>

        {/* ═══════════════════ AUDIT LOG ═══════════════════ */}
        <div className="bg-[#111] border border-white/5 rounded-xl overflow-hidden">
          <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-xs font-medium text-gray-400">Snipe Audit Log</h2>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-600">{auditLog.length} events</span>
              <div className="flex gap-1">
                {(['all', 'filled', 'skipped', 'exits', 'errors'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setAuditFilter(f)}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      auditFilter === f
                        ? 'bg-white/10 text-white'
                        : 'text-gray-600 hover:text-gray-400'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {filteredAudit.length === 0 ? (
            <div className="px-4 py-12 text-center text-gray-700">
              <div className="text-2xl mb-2">🔫</div>
              <div className="text-sm">Waiting for BTC spike...</div>
              <div className="text-xs text-gray-800 mt-1">Snipe events will appear here in real-time</div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead className="text-gray-600 uppercase tracking-wider">
                  <tr>
                    {['Time', 'Trigger', 'Action', 'Edge', 'Latency', 'Status'].map(h => (
                      <th key={h} className="font-medium text-left px-2 py-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {filteredAudit.slice(0, 50).map((a, i) => (
                    <tr key={i} className="hover:bg-white/[0.02]">
                      <td className="px-2 py-1.5 text-gray-500 tabular-nums whitespace-nowrap">
                        {formatTime(a.time)}
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {a.trigger.includes('EXIT:') ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/10 text-orange-400">
                              {a.trigger}
                            </span>
                          ) : a.trigger.includes('Spike') ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400">
                              {a.trigger}
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400">
                              {a.trigger}
                            </span>
                          )}
                          {/* Skip reason badge */}
                          {a.skipReason && (
                            <span className="px-1 py-0.5 rounded text-[9px] bg-gray-500/10 text-gray-500">
                              {a.skipReason}
                            </span>
                          )}
                        </div>
                        {/* Edge explanation tooltip */}
                        {a.edgeExplanation && (
                          <div className="text-[9px] text-gray-700 mt-0.5 max-w-xs truncate" title={a.edgeExplanation}>
                            {a.edgeExplanation}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-gray-300 text-[11px]">{a.action}</td>
                      <td className={`px-2 py-1.5 tabular-nums ${formatPnlColor(a.edge)}`}>
                        {a.edge !== 0 ? formatPnl(a.edge) : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 tabular-nums">
                        {a.latencyMs !== undefined ? `${a.latencyMs}ms` : '--'}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          a.status === 'filled' ? 'bg-emerald-500/10 text-emerald-400' :
                          a.status === 'dry_run' ? 'bg-amber-500/10 text-amber-400' :
                          a.status === 'canceled' ? 'bg-gray-500/10 text-gray-400' :
                          'bg-red-500/10 text-red-400'
                        }`}>
                          {a.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Strategy Info */}
        <div className="p-3 bg-blue-500/5 border border-blue-500/10 rounded-lg">
          <p className="text-[11px] text-blue-400/80">
            <strong>Strategy:</strong> Binance Futures (aggTrade) → event-driven spike detection →
            momentum filter (30s confirm) → depth check → Kalshi IOC snipe →
            event-driven exit (stop-loss / take-profit / time).
            {botState.dryRun
              ? ' DRY RUN mode: payloads logged but no real orders placed.'
              : ' LIVE execution enabled.'}
          </p>
          <p className="text-[10px] text-blue-400/50 mt-1">
            ⚠️ Before going live: Fund Kalshi account, verify exit config, watch for fill quality in DRY RUN. Defaults: SPIKE_THRESHOLD=$50, MIN_EDGE=1¢.
          </p>
        </div>
      </div>

      {/* Ping Test Modal */}
      {showPingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowPingModal(false)}>
          <div className="w-full max-w-2xl bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-base font-semibold text-white">⚡ Network Latency Test</h2>
                <p className="text-xs text-gray-500 mt-0.5">Your server → trading-api.kalshi.com</p>
              </div>
              <button onClick={() => setShowPingModal(false)} className="text-gray-500 hover:text-white transition-colors">
                ✕
              </button>
            </div>

            <div className="px-6 py-5">
              {pingRunning ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-sm text-gray-400 mt-4">Running ping test...</p>
                  <p className="text-xs text-gray-600 mt-1">This takes ~15 seconds</p>
                </div>
              ) : pingResult ? (
                <div className="space-y-5">
                  {/* Verdict Banner */}
                  {pingResult.summary.verdict === 'institutional' && (
                    <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-center">
                      <div className="text-2xl mb-1">🏆</div>
                      <div className="text-lg font-semibold text-emerald-400">INSTITUTIONAL-GRADE SETUP</div>
                      <p className="text-xs text-emerald-400/70 mt-1">Avg latency under 10ms. Elite network. You're competing at the highest level.</p>
                    </div>
                  )}
                  {pingResult.summary.verdict === 'good' && (
                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl text-center">
                      <div className="text-2xl mb-1">✅</div>
                      <div className="text-lg font-semibold text-blue-400">GOOD — UNDER 30ms</div>
                      <p className="text-xs text-blue-400/70 mt-1">Solid connection. Focus on trade edge quality.</p>
                    </div>
                  )}
                  {pingResult.summary.verdict === 'slow' && (
                    <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-center">
                      <div className="text-2xl mb-1">⚠️</div>
                      <div className="text-lg font-semibold text-amber-400">ABOVE 30ms</div>
                      <p className="text-xs text-amber-400/70 mt-1">Latency disadvantage. Only trade high-conviction signals.</p>
                    </div>
                  )}
                  {pingResult.summary.verdict === 'unreachable' && (
                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-center">
                      <div className="text-2xl mb-1">❌</div>
                      <div className="text-lg font-semibold text-red-400">UNREACHABLE</div>
                      <p className="text-xs text-red-400/70 mt-1">Cannot connect to Kalshi API. Check network/config.</p>
                    </div>
                  )}

                  {/* Stats Grid */}
                  <div className="grid grid-cols-4 gap-3">
                    <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Avg</div>
                      <div className={`text-2xl font-mono font-bold ${
                        pingResult.summary.avgLatency !== null && pingResult.summary.avgLatency < 10
                          ? 'text-emerald-400'
                          : pingResult.summary.avgLatency !== null && pingResult.summary.avgLatency < 30
                          ? 'text-blue-400'
                          : pingResult.summary.avgLatency !== null
                          ? 'text-amber-400'
                          : 'text-gray-500'
                      }`}>
                        {pingResult.summary.avgLatency !== null ? `${pingResult.summary.avgLatency}ms` : '--'}
                      </div>
                    </div>
                    <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Min</div>
                      <div className="text-2xl font-mono font-bold text-emerald-400">
                        {pingResult.summary.minLatency !== null ? `${pingResult.summary.minLatency}ms` : '--'}
                      </div>
                    </div>
                    <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Max</div>
                      <div className="text-2xl font-mono font-bold text-red-400">
                        {pingResult.summary.maxLatency !== null ? `${pingResult.summary.maxLatency}ms` : '--'}
                      </div>
                    </div>
                    <div className="bg-white/[0.03] border border-white/5 rounded-lg p-3 text-center">
                      <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">Jitter</div>
                      <div className="text-2xl font-mono font-bold text-white">
                        {pingResult.summary.jitter !== null ? `${pingResult.summary.jitter}ms` : '--'}
                      </div>
                    </div>
                  </div>

                  {/* HFT Context */}
                  <div className="p-3 bg-purple-500/5 border border-purple-500/10 rounded-lg">
                    <h3 className="text-xs font-medium text-purple-400 mb-2">Why This Matters for HFT</h3>
                    <ul className="text-[11px] text-gray-400 space-y-1.5">
                      <li>• <strong className="text-gray-300">&lt;10ms</strong> — Institutional tier. You can compete on pure speed.</li>
                      <li>• <strong className="text-gray-300">10-30ms</strong> — Good, but speed arbitrage is limited. Focus on edge quality.</li>
                      <li>• <strong className="text-gray-300">&gt;30ms</strong> — Latency disadvantage. Only trade high-conviction signals.</li>
                      <li>• <strong className="text-gray-300">Jitter</strong> — Variability between requests. Lower = more consistent execution.</li>
                      <li>• This tests real TCP/TLS connection time to Kalshi's API — what your bot actually uses.</li>
                    </ul>
                  </div>

                  {/* Individual Results */}
                  {pingResult.individualResults.length > 0 && (
                    <div>
                      <h3 className="text-xs font-medium text-gray-500 mb-2">Individual Results</h3>
                      <div className="bg-black/30 border border-white/5 rounded-lg p-3 space-y-1">
                        {pingResult.individualResults.map((r, i) => (
                          <div key={i} className="text-[11px] font-mono text-gray-400">{r}</div>
                        ))}
                        {pingResult.errors.map((e, i) => (
                          <div key={`err-${i}`} className="text-[11px] font-mono text-red-400">{e}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Retest Button */}
                  <button
                    onClick={runPingTest}
                    disabled={pingRunning}
                    className="btn btn-secondary w-full disabled:opacity-50"
                  >
                    {pingRunning ? 'Running...' : '🔄 Re-run Test'}
                  </button>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-600 text-sm">No results available</div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
