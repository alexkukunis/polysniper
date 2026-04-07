import { NextRequest, NextResponse } from 'next/server'

// Worker HTTP API proxy
// Derives HTTP URL from WORKER_WS_URL env var (ws://host:port -> http://host:port)
const WORKER_WS = process.env.WORKER_WS_URL || (
  process.env.NODE_ENV === 'production'
    ? null
    : 'ws://localhost:3002/ws'
)

function getWorkerHttpUrl(): string | null {
  if (!WORKER_WS) return null
  // Convert ws://host:port/ws -> http://host:port
  return WORKER_WS.replace('wss://', 'https://').replace('ws://', 'http://').replace('/ws', '')
}

export async function GET(req: NextRequest) {
  const httpUrl = getWorkerHttpUrl()
  if (!httpUrl) {
    return NextResponse.json({ error: 'Worker URL not configured' }, { status: 503 })
  }

  // Forward the request path to worker
  const url = new URL(req.url)
  const workerApiUrl = `${httpUrl}${url.pathname}${url.search}`

  try {
    const response = await fetch(workerApiUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    })

    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 })
  }
}
