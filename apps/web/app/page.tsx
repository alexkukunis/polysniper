'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'

export default function Dashboard() {
  const [d, setD] = useState<any>(null)
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting')
  const [botAction, setBotAction] = useState<'idle' | 'starting' | 'stopping' | 'pausing' | 'resuming'>('idle')
  const [botMessage, setBotMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [activeTab, setActiveTab] = useState<'trades' | 'opportunities'>('trades')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout
    let ws: WebSocket

    function connect() {
      setWsStatus('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/ws`
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => setWsStatus('connected')

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          
          // Handle event-driven messages
          if (msg.type === 'initial_state') {
            // Initial state from DB on connect
            setD(msg.data)
          } else if (msg.type === 'trade') {
            // Real-time trade event — update trades list
            setD((prev: any) => {
              if (!prev) return prev
              const existingTrades = prev.parityTrades || []
              const tradeIndex = existingTrades.findIndex((t: any) => t.id === msg.data.id)
              let newTrades = [...existingTrades]
              
              if (tradeIndex >= 0) {
                newTrades[tradeIndex] = msg.data
              } else {
                newTrades = [msg.data, ...existingTrades].slice(0, 50)
              }
              
              return { ...prev, parityTrades: newTrades }
            })
          } else if (msg.type === 'opportunity') {
            // Real-time opportunity event
            setD((prev: any) => {
              if (!prev) return prev
              const existingOpps = prev.parityOpportunities || []
              const newOpps = [msg.data, ...existingOpps].slice(0, 50)
              return { ...prev, parityOpportunities: newOpps }
            })
          } else if (msg.type === 'state_update') {
            // Full state refresh from worker
            setD(msg.data)
          } else if (msg.type === 'fill') {
            // Fill event — trigger state refresh
            setD((prev: any) => prev) // Force re-render
          }
        } catch {}
      }

      ws.onclose = () => {
        setWsStatus('disconnected')
        reconnectTimer = setTimeout(connect, 3000)
      }

      ws.onerror = () => setWsStatus('disconnected')
    }

    connect()
    return () => { clearTimeout(reconnectTimer); ws?.close() }
  }, [])

  const controlBot = async (action: 'start' | 'stop' | 'pause' | 'resume') => {
    setBotAction(action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : action === 'pause' ? 'pausing' : 'resuming')
    setBotMessage(null)

    try {
      const res = await fetch('/api/bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })

      const data = await res.json()

      if (data.success) {
        setBotMessage({ type: 'success', text: data.message })
      } else {
        setBotMessage({ type: 'error', text: data.message || data.error })
      }
    } catch (err: any) {
      setBotMessage({ type: 'error', text: 'Failed to control bot' })
    } finally {
      setBotAction('idle')
      setTimeout(() => setBotMessage(null), 3000)
    }
  }

  const state = d?.state
  const today = d?.today
  const parityTrades = d?.parityTrades ?? []
  const parityOpportunities = d?.parityOpportunities ?? []

  // Derived parity-specific metrics
  const filledTrades = parityTrades.filter((t: any) => t.status === 'FILLED')
  const partialFills = parityTrades.filter((t: any) => t.status === 'PARTIAL_FILL')
  const openPositions = parityTrades.filter((t: any) => t.status === 'ORDERED' || t.status === 'TRIGGERED')
  const totalParityPnl = filledTrades.reduce((sum: number, t: any) => sum + (t.actualProfit ?? 0), 0)
  const avgCombinedCost = filledTrades.length > 0
    ? filledTrades.reduce((sum: number, t: any) => sum + (t.combinedCost ?? 0), 0) / filledTrades.length
    : 0
  const bestTrade = filledTrades.length > 0
    ? Math.max(...filledTrades.map((t: any) => t.actualProfit ?? 0))
    : 0
  const fillRate = parityTrades.length > 0
    ? ((filledTrades.length / parityTrades.length) * 100).toFixed(1)
    : '--'
  const oppToTradeRatio = parityOpportunities.length > 0
    ? ((parityTrades.length / parityOpportunities.length) * 100).toFixed(1)
    : '--'

  const stats = [
    {
      label: 'Bankroll',
      value: state?.bankroll != null ? `$${state.bankroll.toFixed(2)}` : '--',
      change: null as string | null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      label: 'Daily P&L',
      value: state?.dailyPnl != null ? `$${state.dailyPnl >= 0 ? '+' : ''}${state.dailyPnl.toFixed(2)}` : '--',
      change: (state?.dailyPnl ?? 0) >= 0 ? 'positive' : 'negative',
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
    },
    {
      label: 'Fill Rate',
      value: `${fillRate}%`,
      change: fillRate !== '--' && parseFloat(fillRate as string) >= 50 ? 'positive' : fillRate !== '--' ? 'negative' : null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
    {
      label: 'Markets Scanned',
      value: state?.marketsScanned != null ? state.marketsScanned.toString() : '--',
      change: null as string | null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      ),
    },
    {
      label: 'Open Positions',
      value: state?.openParityPositions != null ? state.openParityPositions.toString() : openPositions.length.toString(),
      change: null as string | null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
      ),
    },
    {
      label: 'Opportunities',
      value: today?.opportunitiesSeen != null ? today.opportunitiesSeen.toString() : parityOpportunities.length.toString(),
      change: null as string | null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
    },
    {
      label: 'Avg Cost',
      value: avgCombinedCost > 0 ? `${(avgCombinedCost / 100).toFixed(3)}¢` : '--',
      change: avgCombinedCost > 0 && avgCombinedCost < 98.5 ? 'positive' : null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      ),
    },
    {
      label: 'Best Trade',
      value: bestTrade > 0 ? `$${(bestTrade / 100).toFixed(2)}` : '--',
      change: bestTrade > 0 ? 'positive' : null,
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
        </svg>
      ),
    },
  ]

  return (
    <main className="min-h-screen bg-[#171717]">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#171717]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-white">KalshiSniper</h1>
              <p className="text-xs text-gray-500 mt-0.5">Parity Arbitrage Bot</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {/* Status Badges */}
            <span
              className={`badge ${
                wsStatus === 'connected'
                  ? 'badge-success'
                  : wsStatus === 'connecting'
                    ? 'badge-warning'
                    : 'badge-danger'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                wsStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : wsStatus === 'connecting' ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
            
            {state && (
              <>
                <span
                  className={`badge ${
                    state?.paperMode
                      ? 'badge-warning'
                      : state?.running
                        ? 'badge-success'
                        : 'badge-danger'
                  }`}
                >
                  {state?.paperMode ? 'PAPER' : state?.running ? 'LIVE' : 'PAUSED'}
                </span>
                {state?.dryRun && (
                  <span className="badge badge-info">DRY RUN</span>
                )}
              </>
            )}

            {/* Bot Control Button */}
            {state && (
              <button
                onClick={() => {
                  if (state.running) {
                    controlBot('stop')
                  } else {
                    controlBot('start')
                  }
                }}
                disabled={botAction !== 'idle'}
                className={`btn ${
                  state.running
                    ? 'btn-danger disabled:opacity-50'
                    : 'btn-success disabled:opacity-50'
                }`}
              >
                {botAction === 'starting' ? (
                  <>
                    <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    Starting...
                  </>
                ) : botAction === 'stopping' ? (
                  <>
                    <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                    Stopping...
                  </>
                ) : state.running ? (
                  <>
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                    Stop
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    Start
                  </>
                )}
              </button>
            )}

            <Link
              href="/settings"
              className="btn btn-secondary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Bot Message */}
        {botMessage && (
          <div
            className={`mb-6 p-4 rounded-lg border ${
              botMessage.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                : 'bg-red-500/10 border-red-500/20 text-red-400'
            }`}
          >
            {botMessage.text}
          </div>
        )}

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {stats.map(({ label, value, change, icon }) => (
            <div
              key={label}
              className="card p-4"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-gray-500">{icon}</span>
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {label}
                </div>
              </div>
              <div className={`text-2xl font-semibold ${
                change === 'positive' ? 'text-emerald-400' : change === 'negative' ? 'text-red-400' : 'text-white'
              }`}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Today's Summary */}
        {today && (
          <div className="card p-5 mb-6">
            <h2 className="text-sm font-medium text-gray-400 mb-4">Today's Summary</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
              <div>
                <div className="text-xs text-gray-500 mb-1">Parity Fills</div>
                <div className="text-2xl font-semibold text-white">{today.parityTrades ?? filledTrades.length}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Opportunities</div>
                <div className="text-2xl font-semibold text-purple-400">{today.opportunitiesSeen ?? parityOpportunities.length}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Capture Rate</div>
                <div className="text-2xl font-semibold text-amber-400">{oppToTradeRatio}%</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Total P&L</div>
                <div className={`text-2xl font-semibold ${(today.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  ${(today.pnl ?? 0) >= 0 ? '+' : ''}{(today.pnl ?? 0).toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Tabbed Table Section */}
        <div className="card overflow-hidden">
          {/* Tab Headers */}
          <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
            <button
              onClick={() => setActiveTab('trades')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === 'trades'
                  ? 'bg-white/10 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              Parity Trades
              <span className="ml-1.5 text-xs opacity-60">({parityTrades.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('opportunities')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === 'opportunities'
                  ? 'bg-white/10 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              Opportunities
              <span className="ml-1.5 text-xs opacity-60">({parityOpportunities.length})</span>
            </button>
          </div>

          {/* Parity Trades Table */}
          {activeTab === 'trades' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-500 text-xs uppercase tracking-wider">
                  <tr>
                    {['Time', 'Event', 'YES Ask', 'NO Ask', 'Combined', 'Profit', 'Contracts', 'Status', 'Legs'].map(h => (
                      <th key={h} className="font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {parityTrades.map((t: any) => (
                    <tr key={t.id}>
                      <td className="text-gray-500 tabular-nums whitespace-nowrap">
                        {new Date(t.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="font-medium text-xs">{t.eventTicker}</td>
                      <td className="tabular-nums text-gray-300">{(t.yesAsk ?? 0).toFixed(1)}¢</td>
                      <td className="tabular-nums text-gray-300">{(t.noAsk ?? 0).toFixed(1)}¢</td>
                      <td className={`tabular-nums font-medium ${
                        (t.combinedCost ?? 100) < 98.5 ? 'text-emerald-400' : 'text-gray-300'
                      }`}>
                        {(t.combinedCost ?? 0).toFixed(1)}¢
                      </td>
                      <td className={`font-medium tabular-nums ${
                        (t.actualProfit ?? 0) > 0 ? 'text-emerald-400' : 'text-gray-500'
                      }`}>
                        {t.actualProfit != null ? `$${(t.actualProfit / 100).toFixed(2)}` : '—'}
                      </td>
                      <td className="tabular-nums">{t.count ?? '—'}</td>
                      <td>
                        <span
                          className={`badge ${
                            t.status === 'FILLED'
                              ? 'badge-success'
                              : t.status === 'PARTIAL_FILL'
                                ? 'badge-warning'
                                : t.status === 'ORDERED'
                                  ? 'badge-info'
                                  : t.status === 'CANCELLED' || t.status === 'EXPIRED'
                                    ? 'badge-danger'
                                    : 'badge-secondary'
                          }`}
                        >
                          {t.status}
                        </span>
                      </td>
                      <td className="text-xs">
                        <div className="flex gap-2">
                          {t.yesFilled ? (
                            <span className="badge badge-success text-xs">YES ✓</span>
                          ) : t.yesOrderId ? (
                            <span className="badge badge-info text-xs">YES ⏳</span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                          {t.noFilled ? (
                            <span className="badge badge-success text-xs">NO ✓</span>
                          ) : t.noOrderId ? (
                            <span className="badge badge-info text-xs">NO ⏳</span>
                          ) : (
                            <span className="text-gray-600">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {parityTrades.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-6 py-16 text-center">
                        <div className="text-gray-600">
                          <div className="text-4xl mb-3">🎯</div>
                          <div className="text-sm">No parity trades yet</div>
                          <div className="text-xs text-gray-700 mt-1">Scanning all markets for opportunities...</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Opportunities Table */}
          {activeTab === 'opportunities' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-gray-500 text-xs uppercase tracking-wider">
                  <tr>
                    {['Time', 'Event', 'Asset', 'YES Bid', 'NO Bid', 'YES Ask', 'NO Ask', 'Combined', 'Profit', 'Triggered'].map(h => (
                      <th key={h} className="font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {parityOpportunities.map((o: any) => (
                    <tr key={o.id}>
                      <td className="text-gray-500 tabular-nums whitespace-nowrap">
                        {new Date(o.createdAt).toLocaleTimeString()}
                      </td>
                      <td className="font-medium text-xs">{o.eventTicker}</td>
                      <td>{o.asset}</td>
                      <td className="tabular-nums text-gray-300">{o.yesBid.toFixed(1)}¢</td>
                      <td className="tabular-nums text-gray-300">{o.noBid.toFixed(1)}¢</td>
                      <td className="tabular-nums text-gray-300">{o.yesAsk.toFixed(1)}¢</td>
                      <td className="tabular-nums text-gray-300">{o.noAsk.toFixed(1)}¢</td>
                      <td className={`tabular-nums font-medium ${
                        o.combinedCost < 98.5 ? 'text-emerald-400' : 'text-gray-300'
                      }`}>
                        {o.combinedCost.toFixed(1)}¢
                      </td>
                      <td className="tabular-nums text-emerald-400">
                        ${(o.guaranteedProfit / 100).toFixed(2)}
                      </td>
                      <td>
                        <span className={`badge ${o.triggered ? 'badge-success' : 'badge-secondary'}`}>
                          {o.triggered ? 'Yes' : 'No'}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {parityOpportunities.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-6 py-16 text-center">
                        <div className="text-gray-600">
                          <div className="text-4xl mb-3">⚡</div>
                          <div className="text-sm">No opportunities detected yet</div>
                          <div className="text-xs text-gray-700 mt-1">Scanner checks all markets every 2 minutes</div>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Strategy Info */}
        <div className="card p-5 mt-6 bg-white/[0.02] border-purple-500/20">
          <h3 className="text-sm font-medium mb-3 text-white">🎯 How Parity Arbitrage Works</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-gray-400">
            <div>
              <div className="font-medium text-gray-300 mb-1">1. Scan</div>
              <p>Real-time WebSocket stream from all Kalshi binary markets — crypto, politics, weather, sports, and more.</p>
            </div>
            <div>
              <div className="font-medium text-gray-300 mb-1">2. Detect</div>
              <p>When <code className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded text-xs">YES + NO &lt; $1.00</code>, a risk-free profit exists. The bot scans every 500ms.</p>
            </div>
            <div>
              <div className="font-medium text-gray-300 mb-1">3. Execute</div>
              <p>Places <code className="text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded text-xs">post_only</code> orders on both sides. Both fill → guaranteed $1.00 payout.</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
