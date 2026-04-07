import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(__dirname, '../../.env') })

import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { WebSocketServer, WebSocket } from 'ws'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

// In production, WORKER_WS_URL env var MUST be set (Railway internal DNS)
// In local dev, defaults to localhost:3002
const WORKER_WS = process.env.WORKER_WS_URL || (
  process.env.NODE_ENV === 'production'
    ? null  // Must be explicitly set in production
    : 'ws://localhost:3002/ws'
)

if (process.env.NODE_ENV === 'production' && !WORKER_WS) {
  console.error('❌ ERROR: WORKER_WS_URL environment variable is not set in production.')
  console.error('   Set it in your Railway web service to your worker service URL, e.g.:')
  console.error('   ws://<worker-service-name>.railway.internal:3002/ws')
  console.error('   Or use the full Railway service URL.')
  process.exit(1)
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server for dashboard clients
  const wss = new WebSocketServer({ noServer: true })

  // Intercept WS upgrades to /ws, let Next.js HMR pass through
  server.on('upgrade', (request, socket, head) => {
    const pathname = parse(request.url || '/').pathname
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
  })

  // Connection to worker's WebSocket bridge
  let workerWs: WebSocket | null = null
  let dashboardClients = new Set<WebSocket>()

  function connectToWorker() {
    console.log(`🔌 Connecting to worker: ${WORKER_WS}`)
    workerWs = new WebSocket(WORKER_WS)

    workerWs.on('open', () => {
      console.log('✅ Connected to worker')
    })

    // Forward Kalshi WS events from worker → all dashboard clients
    workerWs.on('message', (data: Buffer) => {
      const msg = data.toString()
      dashboardClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg)
        }
      })
    })

    workerWs.on('close', () => {
      console.log('⚠️ Worker disconnected — reconnecting in 3s...')
      setTimeout(connectToWorker, 3000)
    })

    workerWs.on('error', (err) => {
      console.error('❌ Worker WS error:', err.message)
    })
  }

  connectToWorker()

  // Handle dashboard client connections
  wss.on('connection', (ws) => {
    dashboardClients.add(ws)
    console.log(`📺 Dashboard client connected (${dashboardClients.size} total)`)

    ws.on('close', () => {
      dashboardClients.delete(ws)
      console.log(`📺 Dashboard client disconnected (${dashboardClients.size} total)`)
    })
  })

  const PORT = parseInt(process.env.PORT || '3000', 10)
  const HOST = '0.0.0.0'
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Dashboard live at http://${HOST}:${PORT}`)
  })
})
