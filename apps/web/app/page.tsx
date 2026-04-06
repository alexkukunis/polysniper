'use client'
import { useEffect, useState, useRef } from 'react'

export default function Dashboard() {
  const [d, setD] = useState<any>(null)
  const [wsStatus, setWsStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout
    let ws: WebSocket

    function connect() {
      setWsStatus('connecting')
      // Detect protocol: if page is HTTPS, use WSS; if HTTP, use WS
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/ws`
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setWsStatus('connected')
        console.log('🔌 WebSocket connected')
      }

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          setD(data)
        } catch {}
      }

      ws.onclose = () => {
        setWsStatus('disconnected')
        console.log('⚠️ WebSocket disconnected, reconnecting in 3s...')
        reconnectTimer = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        setWsStatus('disconnected')
      }
    }

    connect()

    return () => {
      clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [])

  const state = d?.state
  const today = d?.today
  const trades = d?.trades ?? []
  const wr = today?.trades ? ((today.wins / today.trades) * 100).toFixed(1) : '--'

  return (
    <main className="bg-gray-950 min-h-screen text-white font-mono p-4">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">🎯 PolyMarket Oracle Lag Bot</h1>
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2 py-1 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-green-900 text-green-300'
                  : wsStatus === 'connecting'
                    ? 'bg-yellow-900 text-yellow-300'
                    : 'bg-red-900 text-red-300'
              }`}
            >
              {wsStatus === 'connected' ? '🟢 WS' : wsStatus === 'connecting' ? '🔄 WS' : '🔴 WS'}
            </span>
            <span
              className={`text-xs px-3 py-1 rounded-full font-bold ${
                state?.paperMode
                  ? 'bg-yellow-900 text-yellow-300'
                  : state?.running
                    ? 'bg-green-900 text-green-300'
                    : 'bg-red-900 text-red-300'
              }`}
            >
              {state?.paperMode ? 'PAPER MODE' : state?.running ? 'LIVE' : 'PAUSED'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
          {[
            {
              l: 'Bankroll',
              v: `$${state?.bankroll?.toFixed(2) ?? '--'}`,
            },
            {
              l: 'Daily P&L',
              v: `$${state?.dailyPnl?.toFixed(2) ?? '--'}`,
              c: (state?.dailyPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400',
            },
            {
              l: 'Total P&L',
              v: `$${state?.totalPnl?.toFixed(2) ?? '--'}`,
              c: (state?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400',
            },
            { l: 'Win Rate', v: `${wr}%` },
          ].map(({ l, v, c }) => (
            <div key={l} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <div className="text-xs text-gray-500 mb-1">{l}</div>
              <div className={`text-lg font-bold ${c ?? ''}`}>{v}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { l: "Today's Trades", v: today?.trades ?? 0 },
            { l: 'Wins', v: today?.wins ?? 0, c: 'text-green-400' },
            { l: 'Losses', v: today?.losses ?? 0, c: 'text-red-400' },
          ].map(({ l, v, c }) => (
            <div
              key={l}
              className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center"
            >
              <div className="text-xs text-gray-500 mb-1">{l}</div>
              <div className={`text-2xl font-bold ${c ?? ''}`}>{v}</div>
            </div>
          ))}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                {[
                  'Time',
                  'Asset',
                  'Win',
                  'Dir',
                  'Entry',
                  'Edge',
                  'Size',
                  'P&L',
                  'Close',
                  'Status',
                ].map(h => (
                  <th key={h} className="px-3 py-2 text-left whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t: any) => (
                <tr
                  key={t.id}
                  className="border-t border-gray-800 hover:bg-gray-800/50"
                >
                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                    {new Date(t.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2 font-bold">{t.asset}</td>
                  <td className="px-3 py-2">{t.window}</td>
                  <td
                    className={`px-3 py-2 font-bold ${
                      t.direction === 'UP' ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {t.direction}
                  </td>
                  <td className="px-3 py-2">{(t.entryPrice * 100).toFixed(1)}¢</td>
                  <td className="px-3 py-2 text-yellow-400">
                    {(t.edge * 100).toFixed(1)}¢
                  </td>
                  <td className="px-3 py-2">${t.size}</td>
                  <td
                    className={`px-3 py-2 font-bold ${
                      (t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}
                  >
                    {t.pnl != null ? `$${t.pnl.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-400">
                    {t.closeReason ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-bold ${
                        t.status === 'OPEN'
                          ? 'bg-blue-900 text-blue-300'
                          : t.outcome === 'WIN'
                            ? 'bg-green-900 text-green-300'
                            : t.outcome === 'LOSS'
                              ? 'bg-red-900 text-red-300'
                              : 'bg-gray-800 text-gray-400'
                      }`}
                    >
                      {t.outcome ?? t.status}
                    </span>
                  </td>
                </tr>
              ))}
              {trades.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                    No trades yet — waiting for oracle lag signals...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
