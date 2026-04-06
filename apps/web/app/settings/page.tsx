'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Config {
  id: string
  kalshiAccessKey: string | null
  kalshiPrivateKey: string | null
  kalshiApiUrl: string | null
  kalshiWsUrl: string | null
  telegramBotToken: string | null
  telegramChatId: string | null
  bankrollUsdc: number
  paperMode: boolean
  kalshiDemo: boolean
  botMode: 'hybrid' | 'parity'
  // Market Maker params
  mmMinVolume24h: number
  mmMaxSpread: number
  mmBaseSpreadCents: number
  mmOrderSize: number
  mmMaxMarkets: number
  // Legacy Parity params
  minProfitCents: number
  scanIntervalMs: number
  marketDiscoveryIntervalMs: number
  maxConcurrentTrades: number
  maxPositionPct: number
  dailyLossPct: number
  minTradeSizeUsd: number
}

const DEFAULT_CONFIG: Config = {
  id: 'singleton',
  kalshiAccessKey: '',
  kalshiPrivateKey: '',
  kalshiApiUrl: 'https://api.kalshi.com/trade-api/v2',
  kalshiWsUrl: 'wss://api.kalshi.com/trade-api/ws/v2',
  telegramBotToken: '',
  telegramChatId: '',
  bankrollUsdc: 1000,
  paperMode: true,
  kalshiDemo: true,
  botMode: 'hybrid',
  // Market Maker defaults
  mmMinVolume24h: 15000,
  mmMaxSpread: 4,
  mmBaseSpreadCents: 2,
  mmOrderSize: 20,
  mmMaxMarkets: 3,
  // Legacy Parity defaults
  minProfitCents: 1.5,
  scanIntervalMs: 500,
  marketDiscoveryIntervalMs: 120000,
  maxConcurrentTrades: 5,
  maxPositionPct: 5,
  dailyLossPct: 3,
  minTradeSizeUsd: 10,
}

// Per Kalshi API docs:
// - Demo: demo-api.kalshi.co (REST + WS)
// - Production: api.kalshi.com (REST + WS) for authenticated trading
// - api.elections.kalshi.com is for UNAUTHENTICATED public data only
const KALSHI_ENDPOINTS = {
  demo: {
    rest: 'https://demo-api.kalshi.co/trade-api/v2',
    ws: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
    dashboard: 'https://demo.kalshi.co',
    label: 'Demo',
    description: 'Mock funds — paper trading only',
    icon: '🧪',
    gradient: 'from-amber-500/20 to-orange-500/20',
    border: 'border-amber-500/40',
    badge: 'bg-amber-500/10 text-amber-400 ring-1 ring-inset ring-amber-500/20',
    dot: 'bg-amber-400',
  },
  prod: {
    rest: 'https://api.kalshi.com/trade-api/v2',
    ws: 'wss://api.kalshi.com/trade-api/ws/v2',
    dashboard: 'https://kalshi.com',
    label: 'Production',
    description: 'Real funds — live execution',
    icon: '💰',
    gradient: 'from-emerald-500/20 to-green-500/20',
    border: 'border-emerald-500/40',
    badge: 'bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20',
    dot: 'bg-emerald-400',
  },
} as const

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showSecrets, setShowSecrets] = useState(false)
  const [showLegacyParams, setShowLegacyParams] = useState(false)

  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config')
      if (!res.ok) throw new Error('Failed to fetch config')
      const data = await res.json()
      setConfig({ ...DEFAULT_CONFIG, ...data })
    } catch (err) {
      setConfig(DEFAULT_CONFIG)
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!config) return

    setSaving(true)
    setMessage(null)

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })

      if (!res.ok) throw new Error('Failed to save config')

      setMessage({ type: 'success', text: 'Settings saved successfully!' })
      setTimeout(() => setMessage(null), 3000)
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to save settings. Please try again.' })
    } finally {
      setSaving(false)
    }
  }

  const updateField = (field: keyof Config, value: any) => {
    if (!config) return
    setConfig({ ...config, [field]: value })
  }

  const toggleEnvironment = (demo: boolean) => {
    if (!config) return
    const endpoints = demo ? KALSHI_ENDPOINTS.demo : KALSHI_ENDPOINTS.prod
    setConfig({
      ...config,
      kalshiDemo: demo,
      kalshiApiUrl: endpoints.rest,
      kalshiWsUrl: endpoints.ws,
    })
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-[#171717] flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-white/20 border-t-white mb-3"></div>
          <div className="text-sm text-gray-500">Loading settings...</div>
        </div>
      </main>
    )
  }

  if (!config) {
    return (
      <main className="min-h-screen bg-[#171717] flex items-center justify-center">
        <div className="text-center">
          <div className="text-sm text-gray-500">Failed to load configuration</div>
        </div>
      </main>
    )
  }

  const env = config.kalshiDemo ? KALSHI_ENDPOINTS.demo : KALSHI_ENDPOINTS.prod
  const envLabel = config.kalshiDemo ? 'Demo' : 'Production'

  return (
    <main className="min-h-screen bg-[#171717]">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#171717]/90 backdrop-blur-xl">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/"
                className="group inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-4 h-4 transition-transform group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back
              </Link>
              <div className="h-4 w-px bg-white/10" />
              <div>
                <h1 className="text-lg font-medium tracking-tight text-white">Settings</h1>
                <p className="text-xs text-gray-500 mt-0.5">Configure API keys, strategy, and risk parameters</p>
              </div>
            </div>
            <button
              onClick={() => setShowSecrets(!showSecrets)}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
            >
              {showSecrets ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                  Hide
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                  Show
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* Success/Error Messages */}
        {message && (
          <div className={`mb-6 p-4 rounded-xl border animate-slide-up ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}>
            <div className="flex items-center gap-2">
              {message.type === 'success' ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <span className="text-sm">{message.text}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* ── Bot Mode ──────────────────────────────────────────────── */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-white/[0.03] to-transparent">
              <h2 className="text-sm font-medium text-white">Bot Strategy</h2>
              <p className="text-xs text-gray-500 mt-0.5">Choose how the bot makes money</p>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Hybrid Market Making */}
                <button
                  type="button"
                  onClick={() => updateField('botMode', 'hybrid')}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    config.botMode === 'hybrid'
                      ? 'border-blue-500/50 bg-gradient-to-br from-blue-500/10 to-cyan-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">🏪</span>
                      <div>
                        <span className={`text-sm font-medium ${config.botMode === 'hybrid' ? 'text-blue-300' : 'text-gray-300'}`}>
                          Market Making
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Hybrid — Passive quotes + spread capture</p>
                      </div>
                    </div>
                    {config.botMode === 'hybrid' && (
                      <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-3">
                    Places bid/ask around fair value. Captures 2–4¢ spread per cycle. Works 24/7 on liquid markets.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">post_only maker</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">auto-reprice 12s</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">inventory aware</span>
                  </div>
                </button>

                {/* Legacy Parity Arbitrage */}
                <button
                  type="button"
                  onClick={() => updateField('botMode', 'parity')}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    config.botMode === 'parity'
                      ? 'border-purple-500/50 bg-gradient-to-br from-purple-500/10 to-pink-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">⚖️</span>
                      <div>
                        <span className={`text-sm font-medium ${config.botMode === 'parity' ? 'text-purple-300' : 'text-gray-300'}`}>
                          Parity Arbitrage
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Legacy — Buy YES+NO when combined &lt; $1</p>
                      </div>
                    </div>
                    {config.botMode === 'parity' && (
                      <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-3">
                    Buys both sides when combined cost &lt; 100¢. Mathematically guaranteed profit. Rare opportunities.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400">fill_or_kill</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400">dual-leg entry</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400">low frequency</span>
                  </div>
                </button>
              </div>

              {/* Strategy description banner */}
              {config.botMode === 'hybrid' ? (
                <div className="mt-4 p-4 rounded-xl bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="text-sm font-medium text-blue-400">Market Making Strategy</p>
                      <p className="text-xs text-blue-300/80 mt-1">
                        The bot places passive limit orders on both sides of the book. It profits from the bid-ask spread, not from predicting outcomes.
                        Kalshi's maker fee is low (~0.05%), so capturing 2–4¢ spreads yields positive expectancy.
                        Best on mid-tier markets (15k–100k daily volume) where HFT firms don't compete.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-4 p-4 rounded-xl bg-purple-500/10 border border-purple-500/20">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-purple-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="text-sm font-medium text-purple-400">Parity Arbitrage Strategy</p>
                      <p className="text-xs text-purple-300/80 mt-1">
                        In binary markets, YES + NO should always equal $1.00. When retail flow pushes the combined cost below $1,
                        buying both sides guarantees $1 payout. These opportunities are rare and competed on by HFT firms.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Environment (Demo vs Production) ──────────────────────── */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-white/[0.03] to-transparent">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium text-white">API Environment</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Demo uses mock funds. Production uses real Kalshi API</p>
                </div>
                <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ring-1 ring-inset transition-all duration-300 ${env.badge}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${env.dot} animate-pulse`} />
                  {envLabel}
                </div>
              </div>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Demo Button */}
                <button
                  type="button"
                  onClick={() => toggleEnvironment(true)}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    config.kalshiDemo
                      ? 'border-amber-500/50 bg-gradient-to-br from-amber-500/10 to-orange-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">🧪</span>
                      <div>
                        <span className={`text-sm font-medium ${config.kalshiDemo ? 'text-amber-300' : 'text-gray-300'}`}>
                          Demo
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Mock funds</p>
                      </div>
                    </div>
                    {config.kalshiDemo && (
                      <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-3">Safe testing environment</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-mono bg-black/20 rounded-md px-2 py-1.5">
                      <span className="text-gray-500">REST</span>
                      <span className="text-gray-400 truncate">demo-api.kalshi.co</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono bg-black/20 rounded-md px-2 py-1.5">
                      <span className="text-gray-500">WS</span>
                      <span className="text-gray-400 truncate">wss://demo-api.kalshi.co</span>
                    </div>
                  </div>
                </button>

                {/* Production Button */}
                <button
                  type="button"
                  onClick={() => toggleEnvironment(false)}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    !config.kalshiDemo
                      ? 'border-emerald-500/50 bg-gradient-to-br from-emerald-500/10 to-green-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">💰</span>
                      <div>
                        <span className={`text-sm font-medium ${!config.kalshiDemo ? 'text-emerald-300' : 'text-gray-300'}`}>
                          Production
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Live Kalshi API</p>
                      </div>
                    </div>
                    {!config.kalshiDemo && (
                      <div className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mb-3">Real market data & execution</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs font-mono bg-black/20 rounded-md px-2 py-1.5">
                      <span className="text-gray-500">REST</span>
                      <span className="text-gray-400 truncate">api.kalshi.com</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono bg-black/20 rounded-md px-2 py-1.5">
                      <span className="text-gray-500">WS</span>
                      <span className="text-gray-400 truncate">wss://api.kalshi.com</span>
                    </div>
                  </div>
                </button>
              </div>

              {/* Warning for Production */}
              {!config.kalshiDemo && (
                <div className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div>
                      <p className="text-sm font-medium text-red-400">Production API Connected</p>
                      <p className="text-xs text-red-300/80 mt-1">
                        Orders placed through this API will execute with real funds on Kalshi.
                        Ensure your API credentials are correct and risk limits are set before enabling.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Execution Mode (Paper vs Live) — INDEPENDENT ─────────── */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-white/[0.03] to-transparent">
              <h2 className="text-sm font-medium text-white">Execution Mode</h2>
              <p className="text-xs text-gray-500 mt-0.5">Paper mode logs trades without placing real orders. Independent of API environment.</p>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => updateField('paperMode', true)}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    config.paperMode
                      ? 'border-sky-500/50 bg-gradient-to-br from-sky-500/10 to-blue-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">📋</span>
                      <div>
                        <span className={`text-sm font-medium ${config.paperMode ? 'text-sky-300' : 'text-gray-300'}`}>
                          Paper Trading
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Simulated execution</p>
                      </div>
                    </div>
                    {config.paperMode && (
                      <div className="w-5 h-5 rounded-full bg-sky-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    Orders are calculated and logged but never sent to Kalshi. Use this to validate strategy performance risk-free.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => updateField('paperMode', false)}
                  className={`group relative p-5 rounded-xl border-2 text-left transition-all duration-200 ${
                    !config.paperMode
                      ? 'border-rose-500/50 bg-gradient-to-br from-rose-500/10 to-red-500/5'
                      : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl">⚡</span>
                      <div>
                        <span className={`text-sm font-medium ${!config.paperMode ? 'text-rose-300' : 'text-gray-300'}`}>
                          Live Execution
                        </span>
                        <p className="text-xs text-gray-500 mt-0.5">Real orders placed</p>
                      </div>
                    </div>
                    {!config.paperMode && (
                      <div className="w-5 h-5 rounded-full bg-rose-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    Orders are sent to Kalshi API and will fill with real funds. Only enable after thorough paper trading validation.
                  </p>
                </button>
              </div>

              {/* Recommended flow */}
              <div className="mt-4 p-4 rounded-xl bg-sky-500/10 border border-sky-500/20">
                <p className="text-xs text-sky-300/80">
                  <span className="font-medium text-sky-400">Recommended:</span> Start with Demo + Paper Trading → validate metrics → switch to Demo + Live → then Production + Paper → finally Production + Live.
                </p>
              </div>
            </div>
          </section>

          {/* ── API Credentials ──────────────────────────────────────── */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-white/[0.03] to-transparent">
              <h2 className="text-sm font-medium text-white">API Credentials</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Generate keys at{' '}
                <a href="https://kalshi.com/account/profile" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">
                  kalshi.com/account/profile → API Keys
                </a>
              </p>
            </div>

            <div className="p-6 space-y-5">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  Access Key ID <span className="text-red-400">*</span>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config.kalshiAccessKey || ''}
                  onChange={(e) => updateField('kalshiAccessKey', e.target.value)}
                  className="input"
                  placeholder="a952bcbe-ec3b-4b5b-b8f9-11dae589608c"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-400 mb-2">
                  Private Key (PEM) <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={config.kalshiPrivateKey || ''}
                  onChange={(e) => updateField('kalshiPrivateKey', e.target.value)}
                  className="input font-mono text-xs"
                  placeholder={`-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----`}
                  rows={4}
                  style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}
                />
              </div>
            </div>
          </section>

          {/* ── Market Maker Parameters (shown when hybrid mode) ─────── */}
          {config.botMode === 'hybrid' && (
            <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-blue-500/[0.05] to-transparent">
                <h2 className="text-sm font-medium text-white">Market Maker Parameters</h2>
                <p className="text-xs text-gray-500 mt-0.5">Controls quoting behavior for spread capture</p>
              </div>

              <div className="p-6 space-y-6">
                {/* Bankroll */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">Bankroll (USD)</label>
                  <input
                    type="number"
                    value={config.bankrollUsdc || 0}
                    onChange={(e) => updateField('bankrollUsdc', parseFloat(e.target.value) || 0)}
                    className="input"
                    min="100"
                    step="100"
                  />
                  <p className="text-xs text-gray-600 mt-1.5">Total capital available for quoting. Max 30% deployed at any time.</p>
                </div>

                {/* Market Selection */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Min 24h Volume (contracts)</label>
                    <input
                      type="number"
                      value={config.mmMinVolume24h || 15000}
                      onChange={(e) => updateField('mmMinVolume24h', parseInt(e.target.value) || 15000)}
                      className="input"
                      min="1000"
                      step="1000"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Only quote markets with ≥ this 24h volume</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Max Spread (¢)</label>
                    <input
                      type="number"
                      value={config.mmMaxSpread || 4}
                      onChange={(e) => updateField('mmMaxSpread', parseInt(e.target.value) || 4)}
                      className="input"
                      min="1"
                      max="20"
                      step="1"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Don't quote if bid-ask wider than this</p>
                  </div>
                </div>

                {/* Quoting Parameters */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Base Spread (¢)</label>
                    <input
                      type="number"
                      value={config.mmBaseSpreadCents || 2}
                      onChange={(e) => updateField('mmBaseSpreadCents', parseInt(e.target.value) || 2)}
                      className="input"
                      min="1"
                      max="10"
                      step="1"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Target spread for normal quoting</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Order Size (contracts)</label>
                    <input
                      type="number"
                      value={config.mmOrderSize || 20}
                      onChange={(e) => updateField('mmOrderSize', parseInt(e.target.value) || 20)}
                      className="input"
                      min="1"
                      max="100"
                      step="5"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Contracts per side per order</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Max Markets</label>
                    <input
                      type="number"
                      value={config.mmMaxMarkets || 3}
                      onChange={(e) => updateField('mmMaxMarkets', parseInt(e.target.value) || 3)}
                      className="input"
                      min="1"
                      max="10"
                      step="1"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Simultaneous quoting limit</p>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Legacy Parity Parameters (collapsible) ───────────────── */}
          {config.botMode === 'parity' && (
            <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
              <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-purple-500/[0.05] to-transparent">
                <h2 className="text-sm font-medium text-white">Parity Arbitrage Parameters</h2>
                <p className="text-xs text-gray-500 mt-0.5">Controls for YES+NO combined cost scanning</p>
              </div>

              <div className="p-6 space-y-6">
                {/* Bankroll */}
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">Bankroll (USD)</label>
                  <input
                    type="number"
                    value={config.bankrollUsdc || 0}
                    onChange={(e) => updateField('bankrollUsdc', parseFloat(e.target.value) || 0)}
                    className="input"
                    min="0"
                    step="0.01"
                  />
                </div>

                {/* Timing */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Scan Interval (ms)</label>
                    <input
                      type="number"
                      value={config.scanIntervalMs || 500}
                      onChange={(e) => updateField('scanIntervalMs', parseInt(e.target.value) || 500)}
                      className="input"
                      min="100"
                      step="100"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">How often to check orderbooks for parity gaps</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Market Discovery (ms)</label>
                    <input
                      type="number"
                      value={config.marketDiscoveryIntervalMs || 120000}
                      onChange={(e) => updateField('marketDiscoveryIntervalMs', parseInt(e.target.value) || 120000)}
                      className="input"
                      min="30000"
                      step="10000"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">REST scan interval for new markets</p>
                  </div>
                </div>

                {/* Profit & Size */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Min Profit (¢)</label>
                    <input
                      type="number"
                      value={config.minProfitCents || 1.5}
                      onChange={(e) => updateField('minProfitCents', parseFloat(e.target.value) || 0)}
                      className="input"
                      min="0"
                      step="0.1"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Min combined cost gap to trigger trade</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Max Concurrent Trades</label>
                    <input
                      type="number"
                      value={config.maxConcurrentTrades || 5}
                      onChange={(e) => updateField('maxConcurrentTrades', parseInt(e.target.value) || 5)}
                      className="input"
                      min="1"
                      max="20"
                      step="1"
                    />
                    <p className="text-xs text-gray-600 mt-1.5">Risk cap on open positions</p>
                  </div>
                </div>

                {/* Risk Limits */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Max Position (%)</label>
                    <input
                      type="number"
                      value={config.maxPositionPct || 5}
                      onChange={(e) => updateField('maxPositionPct', parseFloat(e.target.value) || 5)}
                      className="input"
                      min="1"
                      max="20"
                      step="0.5"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Daily Loss Limit (%)</label>
                    <input
                      type="number"
                      value={config.dailyLossPct || 3}
                      onChange={(e) => updateField('dailyLossPct', parseFloat(e.target.value) || 3)}
                      className="input"
                      min="1"
                      max="10"
                      step="0.5"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2">Min Trade Size ($)</label>
                    <input
                      type="number"
                      value={config.minTradeSizeUsd || 10}
                      onChange={(e) => updateField('minTradeSizeUsd', parseFloat(e.target.value) || 10)}
                      className="input"
                      min="1"
                      step="1"
                    />
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── Telegram Alerts ──────────────────────────────────────── */}
          <section className="rounded-2xl border border-white/10 bg-[#1e1e1e] overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10 bg-gradient-to-r from-white/[0.03] to-transparent">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-white">Telegram Alerts</h2>
                <span className="text-xs text-gray-500">(Optional)</span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">Get notified on bot start, stop, and warnings</p>
            </div>

            <div className="p-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">Bot Token</label>
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={config.telegramBotToken || ''}
                    onChange={(e) => updateField('telegramBotToken', e.target.value)}
                    className="input"
                    placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-2">Chat ID</label>
                  <input
                    type="text"
                    value={config.telegramChatId || ''}
                    onChange={(e) => updateField('telegramChatId', e.target.value)}
                    className="input"
                    placeholder="-1001234567890"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* ── API Rate Limits ──────────────────────────────────────── */}
          <section className="rounded-xl border border-blue-500/20 bg-blue-500/5">
            <div className="p-5">
              <h3 className="text-xs font-medium text-white mb-3">Kalshi API Rate Limits (Basic Tier)</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">Read requests</span>
                  <span className="text-white font-mono">20/sec</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">Write requests</span>
                  <span className="text-white font-mono">10/sec</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Per Kalshi docs: Basic tier on signup. Advanced (30/sec) via application.
                Premier/Prime require volume targets + technical review.
              </p>
            </div>
          </section>

          {/* ── Save/Cancel Buttons ──────────────────────────────────── */}
          <div className="flex items-center justify-end gap-3 pt-4">
            <Link
              href="/"
              className="px-5 py-2.5 text-sm text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl transition-all"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-all flex items-center gap-2"
            >
              {saving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Save Settings
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
