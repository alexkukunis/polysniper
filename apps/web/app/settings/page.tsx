'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function SettingsPage() {
  const [apiKey, setApiKey] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [demo, setDemo] = useState(true)
  const [dryRun, setDryRun] = useState(true)
  const [btcTicker, setBtcTicker] = useState('')
  const [spikeThreshold, setSpikeThreshold] = useState(50)
  const [spikeWindowMs, setSpikeWindowMs] = useState(2000)
  const [minEdgeCents, setMinEdgeCents] = useState(1)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setApiKey(data.apiKey || '')
        setPrivateKey(data.privateKey || '')
        setDemo(data.demo !== false)
        setDryRun(data.dryRun !== false)
        setBtcTicker(data.btcTicker || '')
        setSpikeThreshold(data.spikeThreshold || 50)
        setSpikeWindowMs(data.spikeWindowMs || 2000)
        setMinEdgeCents(data.minEdgeCents ?? 1)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          privateKey,
          demo,
          dryRun,
          btcTicker,
          spikeThreshold,
          spikeWindowMs,
          minEdgeCents,
        }),
      })

      if (!res.ok) throw new Error('Failed to save')
      setMessage({ type: 'success', text: 'Settings saved! Restart the bot for changes to take effect.' })
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return (
      <main className="min-h-screen bg-[#171717] flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#171717]">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#171717]/80 backdrop-blur-xl">
        <div className="max-w-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-sm text-gray-400 hover:text-white transition-colors">
              ← Back
            </Link>
            <div className="h-4 w-px bg-white/10" />
            <div>
              <h1 className="text-lg font-medium text-white">Settings</h1>
              <p className="text-xs text-gray-500 mt-0.5">API keys, oracle config, sniper params</p>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8">
        {message && (
          <div className={`mb-6 p-4 rounded-lg border text-sm ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-red-500/10 border-red-500/20 text-red-400'
          }`}>
            {message.text}
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-6">
          {/* API Configuration */}
          <div className="card p-5">
            <h2 className="text-sm font-medium text-gray-400 mb-4">API Configuration</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Kalshi Access Key</label>
                <input type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder="a952bcbe-..." className="input font-mono text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">Private Key (PEM)</label>
                <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----..." rows={4}
                  className="input font-mono text-xs resize-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-2">Environment</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => setDemo(true)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      demo ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}>
                    <div className="text-sm font-medium text-amber-400">🧪 Demo</div>
                    <div className="text-xs text-gray-500 mt-1">No liquidity</div>
                  </button>
                  <button type="button" onClick={() => setDemo(false)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      !demo ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}>
                    <div className="text-sm font-medium text-emerald-400">💰 Live</div>
                    <div className="text-xs text-gray-500 mt-1">Real funds</div>
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-2">Execution Mode</label>
                <div className="grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => setDryRun(true)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      dryRun ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}>
                    <div className="text-sm font-medium text-amber-400">🔬 Dry Run</div>
                    <div className="text-xs text-gray-500 mt-1">Log payloads, no orders</div>
                  </button>
                  <button type="button" onClick={() => setDryRun(false)}
                    className={`p-4 rounded-lg border-2 text-left transition-all ${
                      !dryRun ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                    }`}>
                    <div className="text-sm font-medium text-emerald-400">🔫 Live Execute</div>
                    <div className="text-xs text-gray-500 mt-1">Real IOC orders</div>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* BTC Market Ticker */}
          <div className="card p-5">
            <h2 className="text-sm font-medium text-gray-400 mb-4">Target Market</h2>
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">
                Kalshi BTC Market Ticker
              </label>
              <input type="text" value={btcTicker} onChange={(e) => setBtcTicker(e.target.value)}
                placeholder="KXBTC-26APR06-T70K" className="input font-mono text-sm" />
              <p className="text-xs text-gray-600 mt-1.5">
                Find at <a href="https://kalshi.com/markets/kxbtc" target="_blank" className="text-blue-400 underline">kalshi.com/markets/kxbtc</a> — copy the ticker from the URL
              </p>
            </div>
            {!demo && !btcTicker && (
              <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                ⚠️ Required for live trading. Bot won't start without it.
              </div>
            )}
          </div>

          {/* Oracle Config */}
          <div className="card p-5">
            <h2 className="text-sm font-medium text-gray-400 mb-4">Oracle (Binance BTC/USDT)</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">
                  Spike Threshold ($)
                </label>
                <input type="number" value={spikeThreshold} onChange={(e) => setSpikeThreshold(parseInt(e.target.value) || 25)}
                  min={5} max={500} className="input text-sm" />
                <p className="text-xs text-gray-600 mt-1.5">Fire when BTC moves this much within the window</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">
                  Lookback Window (ms)
                </label>
                <input type="number" value={spikeWindowMs} onChange={(e) => setSpikeWindowMs(parseInt(e.target.value) || 2000)}
                  min={500} max={10000} step={500} className="input text-sm" />
              </div>
            </div>
          </div>

          {/* Sniper Params */}
          <div className="card p-5">
            <h2 className="text-sm font-medium text-gray-400 mb-4">Sniper Parameters</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1.5">
                  Minimum Edge (cents)
                </label>
                <input type="number" value={minEdgeCents} onChange={(e) => setMinEdgeCents(parseInt(e.target.value) || 3)}
                  min={3} max={10} className="input text-sm" />
                <p className="text-xs text-gray-600 mt-1.5">Base edge (¢). Bot adds fees + spread on top dynamically (min ~5¢ total)</p>
              </div>

              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <p className="text-xs text-blue-400">
                  <strong>Safety Rails (hardcoded):</strong><br/>
                  • 1 contract per order (micro-lot)<br/>
                  • Max 20 contracts per side (loose mode)<br/>
                  • 100ms throttle between orders<br/>
                  • IOC orders (take liquidity, never rest)
                </p>
              </div>
            </div>
          </div>

          <button type="submit" disabled={saving}
            className="btn btn-primary w-full disabled:opacity-50">
            {saving ? (
              <><div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-gray-900 border-t-transparent"></div>Saving...</>
            ) : 'Save Settings'}
          </button>
        </form>
      </div>
    </main>
  )
}
