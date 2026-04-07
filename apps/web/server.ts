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

const WORKER_WS = process.env.WORKER_WS_URL || 'ws://localhost:3002/ws'

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

  const PORT = process.env.PORT || 3000
  const HOST = '0.0.0.0'
  server.listen(PORT, HOST, () => {
    console.log(`🚀 Dashboard live at http://${HOST}:${PORT}`)
  })
})
