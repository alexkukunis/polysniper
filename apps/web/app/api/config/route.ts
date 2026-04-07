import { NextRequest, NextResponse } from 'next/server'
import { readFile, writeFile } from 'fs/promises'
import { resolve } from 'path'

const ENV_PATH = resolve(process.cwd(), '../../.env')

async function readEnv() {
  try {
    const content = await readFile(ENV_PATH, 'utf-8')
    const env: Record<string, string> = {}
    content.split('\n').forEach(line => {
      const [key, ...rest] = line.split('=')
      if (key && rest.length) env[key.trim()] = rest.join('=').trim()
    })
    return env
  } catch {
    return {}
  }
}

async function writeEnv(env: Record<string, string>) {
  const content = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
  await writeFile(ENV_PATH, content)
}

export async function GET() {
  const env = await readEnv()
  return NextResponse.json({
    apiKey: env.KALSHI_ACCESS_KEY || '',
    privateKey: env.KALSHI_PRIVATE_KEY || '',
    demo: env.KALSHI_DEMO !== 'false',
    dryRun: env.DRY_RUN !== 'false',
    btcTicker: env.KALSHI_BTC_TICKER || '',
    spikeThreshold: parseInt(env.SPIKE_THRESHOLD || '25'),
    spikeWindowMs: parseInt(env.SPIKE_WINDOW_MS || '2000'),
    minEdgeCents: parseInt(env.MIN_EDGE_CENTS || '2'),
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const env = await readEnv()

    if (body.apiKey) env.KALSHI_ACCESS_KEY = body.apiKey
    if (body.privateKey) env.KALSHI_PRIVATE_KEY = body.privateKey
    env.KALSHI_DEMO = body.demo !== false ? 'true' : 'false'
    env.DRY_RUN = body.dryRun !== false ? 'true' : 'false'
    if (body.btcTicker) env.KALSHI_BTC_TICKER = body.btcTicker
    if (body.spikeThreshold) env.SPIKE_THRESHOLD = String(body.spikeThreshold)
    if (body.spikeWindowMs) env.SPIKE_WINDOW_MS = String(body.spikeWindowMs)
    if (body.minEdgeCents) env.MIN_EDGE_CENTS = String(body.minEdgeCents)

    await writeEnv(env)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
