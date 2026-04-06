import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(__dirname, '../../.env') })

import { createServer } from 'http'
import { parse } from 'url'
import next from 'next'
import { WebSocketServer, WebSocket } from 'ws'
import { db } from '@repo/db'

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

interface WSClient extends WebSocket {
  isAlive?: boolean
}

// Worker's real-time bridge URL
const WORKER_RT_URL = process.env.WORKER_RT_URL || 'ws://localhost:3002/ws-realtime'

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server for dashboard clients
  const wss = new WebSocketServer({ server, path: '/ws' })

  // Connection to worker's real-time bridge
  let workerWs: WebSocket | null = null
  let dashboardClients = new Set<WSClient>()

  function connectToWorker() {
    console.log(`🔌 Connecting to worker real-time bridge: ${WORKER_RT_URL}`)
    
    workerWs = new WebSocket(WORKER_RT_URL)

    workerWs.on('open', () => {
      console.log('✅ Connected to worker real-time bridge')
    })

    workerWs.on('message', (data: Buffer) => {
      try {
        const event = JSON.parse(data.toString())
        // Forward worker events to all dashboard clients
        const message = JSON.stringify(event)
        dashboardClients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message)
          }
        })
      } catch (err) {
        console.error('❌ Failed to parse worker event:', err)
      }
    })

    workerWs.on('close', () => {
      console.log('⚠️ Worker disconnected — reconnecting in 3s...')
      setTimeout(connectToWorker, 3000)
    })

    workerWs.on('error', (err) => {
      console.error('❌ Worker WebSocket error:', err.message)
    })
  }

  // Connect to worker on startup
  connectToWorker()

  // Handle dashboard client connections
  wss.on('connection', (ws: WSClient) => {
    ws.isAlive = true
    dashboardClients.add(ws)
    console.log(`🔌 Dashboard client connected (${dashboardClients.size} total)`)

    // Send initial state from DB immediately
    sendInitialState(ws)

    ws.on('pong', () => {
      ws.isAlive = true
    })

    ws.on('close', () => {
      dashboardClients.delete(ws)
      console.log(`⚠️ Dashboard client disconnected (${dashboardClients.size} total)`)
    })
  })

  // Keep-alive ping for dashboard clients every 30s
  const pingInterval = setInterval(() => {
    dashboardClients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate()
        dashboardClients.delete(ws)
        return
      }
      ws.isAlive = false
      ws.ping()
    })
  }, 30_000)

  wss.on('close', () => {
    clearInterval(pingInterval)
  })

  async function sendInitialState(ws: WebSocket) {
    try {
      const [state, today, parityTrades, parityOpportunities] = await Promise.all([
        db.botState.findUnique({ where: { id: 'singleton' } }),
        db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
        db.parityTrade.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
        db.parityOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }).catch(() => []),
      ])
      
      ws.send(JSON.stringify({
        type: 'initial_state',
        data: { state, today, parityTrades, parityOpportunities },
        timestamp: Date.now(),
      }))
    } catch (err) {
      console.error('❌ Failed to send initial state:', err)
    }
  }

  const PORT = process.env.PORT || 3000
  server.listen(PORT, () => {
    console.log(`🚀 Dashboard live at http://localhost:${PORT}`)
    console.log(`🔌 Dashboard WebSocket at ws://localhost:${PORT}/ws`)
  })
})
