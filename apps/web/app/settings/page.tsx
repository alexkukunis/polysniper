'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

interface Config {
  id: string
  polyApiKey: string | null
  polyApiSecret: string | null
  polyPassphrase: string | null
  walletPrivateKey: string | null
  polygonRpc: string | null
  polygonWssRpc: string | null
  telegramBotToken: string | null
  telegramChatId: string | null
  bankrollUsdc: number
  paperMode: boolean
}

export default function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [showSecrets, setShowSecrets] = useState(false)

  useEffect(() => {
    fetchConfig()
  }, [])

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config')
      if (!res.ok) throw new Error('Failed to fetch config')
      const data = await res.json()
      setConfig(data)
    } catch (err) {
      setMessage({ type: 'error', text: 'Failed to load settings' })
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
      setMessage({ type: 'error', text: 'Failed to save settings' })
    } finally {
      setSaving(false)
    }
  }

  const updateField = (field: keyof Config, value: any) => {
    if (!config) return
    setConfig({ ...config, [field]: value })
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent mb-3"></div>
          <div className="text-sm text-gray-500">Loading settings...</div>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="btn btn-secondary"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </Link>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-gradient">Settings</h1>
              <p className="text-xs text-gray-500 mt-0.5">Configure your trading bot</p>
            </div>
          </div>
          <button
            onClick={() => setShowSecrets(!showSecrets)}
            className="btn btn-secondary"
          >
            {showSecrets ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Hide
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                Show
              </>
            )}
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Message */}
        {message && (
          <div
            className={`mb-6 p-4 rounded-lg border ${
              message.type === 'success'
                ? 'bg-success-muted border-success/20 text-success'
                : 'bg-danger-muted border-danger/20 text-danger'
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Polymarket API */}
          <div className="card p-6">
            <h2 className="text-lg font-medium mb-6">API Credentials</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">API Key</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config?.polyApiKey || ''}
                  onChange={(e) => updateField('polyApiKey', e.target.value)}
                  className="input"
                  placeholder="your_api_key"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">API Secret</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config?.polyApiSecret || ''}
                  onChange={(e) => updateField('polyApiSecret', e.target.value)}
                  className="input"
                  placeholder="your_api_secret"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Passphrase</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config?.polyPassphrase || ''}
                  onChange={(e) => updateField('polyPassphrase', e.target.value)}
                  className="input"
                  placeholder="your_passphrase"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Wallet Private Key</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config?.walletPrivateKey || ''}
                  onChange={(e) => updateField('walletPrivateKey', e.target.value)}
                  className="input"
                  placeholder="0x..."
                />
              </div>
            </div>
          </div>

          {/* Blockchain */}
          <div className="card p-6">
            <h2 className="text-lg font-medium mb-6">Blockchain RPC</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">HTTP RPC URL</label>
                <input
                  type="url"
                  value={config?.polygonRpc || ''}
                  onChange={(e) => updateField('polygonRpc', e.target.value)}
                  className="input"
                  placeholder="https://polygon-rpc.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">WebSocket RPC URL</label>
                <input
                  type="url"
                  value={config?.polygonWssRpc || ''}
                  onChange={(e) => updateField('polygonWssRpc', e.target.value)}
                  className="input"
                  placeholder="wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
                />
              </div>
            </div>
          </div>

          {/* Trading Config */}
          <div className="card p-6">
            <h2 className="text-lg font-medium mb-6">Trading Configuration</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Bankroll (USDC)</label>
                <input
                  type="number"
                  value={config?.bankrollUsdc || 0}
                  onChange={(e) => updateField('bankrollUsdc', parseFloat(e.target.value) || 0)}
                  className="input"
                  min="0"
                  step="0.01"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Trading Mode</label>
                <div className="flex gap-4 mt-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={config?.paperMode === true}
                      onChange={() => updateField('paperMode', true)}
                      className="w-4 h-4 text-accent bg-surface border-border focus:ring-accent/50"
                    />
                    <span className="text-sm text-gray-300">Paper Trading</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={config?.paperMode === false}
                      onChange={() => updateField('paperMode', false)}
                      className="w-4 h-4 text-accent bg-surface border-border focus:ring-accent/50"
                    />
                    <span className="text-sm text-gray-300">Live Trading</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Telegram Alerts */}
          <div className="card p-6">
            <h2 className="text-lg font-medium mb-6">Telegram Alerts <span className="text-gray-500 text-sm font-normal">(Optional)</span></h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Bot Token</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={config?.telegramBotToken || ''}
                  onChange={(e) => updateField('telegramBotToken', e.target.value)}
                  className="input"
                  placeholder="your_bot_token"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-2">Chat ID</label>
                <input
                  type="text"
                  value={config?.telegramChatId || ''}
                  onChange={(e) => updateField('telegramChatId', e.target.value)}
                  className="input"
                  placeholder="your_chat_id"
                />
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end gap-3">
            <Link
              href="/"
              className="btn btn-secondary"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-primary"
            >
              {saving ? (
                <>
                  <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                  Saving...
                </>
              ) : 'Save Settings'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
