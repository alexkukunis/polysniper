'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'

export default function Dashboard() {
  const [d, setD] = useState<any>(null)
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting')
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
        try { setD(JSON.parse(e.data)) } catch {}
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

  const state = d?.state
  const today = d?.today
  const trades = d?.trades ?? []
  const wr = today?.trades ? ((today.wins / today.trades) * 100).toFixed(1) : '--'

  const stats = [
    {
      label: 'Bankroll',
      value: state?.bankroll != null ? `$${state.bankroll.toFixed(2)}` : '--',
      change: null,
    },
    {
      label: 'Daily P&L',
      value: state?.dailyPnl != null ? `$${state.dailyPnl >= 0 ? '+' : ''}${state.dailyPnl.toFixed(2)}` : '--',
      change: (state?.dailyPnl ?? 0) >= 0 ? 'positive' : 'negative',
    },
    {
      label: 'Total P&L',
      value: state?.totalPnl != null ? `$${state.totalPnl >= 0 ? '+' : ''}${state.totalPnl.toFixed(2)}` : '--',
      change: (state?.totalPnl ?? 0) >= 0 ? 'positive' : 'negative',
    },
    {
      label: 'Win Rate',
      value: `${wr}%`,
      change: wr !== '--' && parseFloat(wr) >= 50 ? 'positive' : wr !== '--' ? 'negative' : null,
    },
  ]

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-gradient">PolySniper</h1>
              <p className="text-xs text-gray-500 mt-0.5">Trading Dashboard</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
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
                wsStatus === 'connected' ? 'bg-success animate-pulse' : wsStatus === 'connecting' ? 'bg-warning' : 'bg-danger'
              }`} />
              {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting' : 'Offline'}
            </span>
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

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Key Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {stats.map(({ label, value, change }) => (
            <div
              key={label}
              className="card card-hover p-5"
            >
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                {label}
              </div>
              <div className={`text-2xl font-semibold ${
                change === 'positive' ? 'text-success' : change === 'negative' ? 'text-danger' : 'text-gray-100'
              }`}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Today's Summary */}
        {today && (
          <div className="card p-6 mb-8">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">Today's Summary</h2>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <div className="text-xs text-gray-500 mb-1">Trades</div>
                <div className="text-3xl font-semibold text-gray-100">{today.trades}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Wins</div>
                <div className="text-3xl font-semibold text-success">{today.wins}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Losses</div>
                <div className="text-3xl font-semibold text-danger">{today.losses}</div>
              </div>
            </div>
          </div>
        )}

        {/* Trades Table */}
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-border/50">
            <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Trade History</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-background-secondary/50 text-gray-500 text-xs uppercase tracking-wider">
                <tr>
                  {['Time', 'Asset', 'Direction', 'Entry', 'Edge', 'Size', 'P&L', 'Status'].map(h => (
                    <th key={h} className="px-6 py-3 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {trades.map((t: any) => (
                  <tr
                    key={t.id}
                    className="bg-surface hover:bg-surface-hover transition-colors duration-150"
                  >
                    <td className="px-6 py-4 text-gray-500 tabular-nums whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="px-6 py-4 font-medium">{t.asset}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`badge ${
                          t.direction === 'UP' ? 'badge-success' : 'badge-danger'
                        }`}
                      >
                        {t.direction}
                      </span>
                    </td>
                    <td className="px-6 py-4 tabular-nums text-gray-300">{(t.entryPrice * 100).toFixed(1)}¢</td>
                    <td className="px-6 py-4 tabular-nums text-warning">{(t.edge * 100).toFixed(1)}¢</td>
                    <td className="px-6 py-4 tabular-nums text-gray-300">${t.size}</td>
                    <td
                      className={`px-6 py-4 font-medium tabular-nums ${
                        (t.pnl ?? 0) >= 0 ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {t.pnl != null ? `$${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`badge ${
                          t.status === 'OPEN'
                            ? 'badge-info'
                            : t.outcome === 'WIN'
                              ? 'badge-success'
                              : t.outcome === 'LOSS'
                                ? 'badge-danger'
                                : 'badge-secondary'
                        }`}
                      >
                        {t.outcome ?? t.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {trades.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-16 text-center">
                      <div className="text-gray-600">
                        <div className="text-4xl mb-3">📊</div>
                        <div className="text-sm">No trades yet — waiting for signals...</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  )
}
