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

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  // WebSocket server for real-time dashboard updates
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WSClient) => {
    ws.isAlive = true
    console.log('🔌 Dashboard client connected')

    // Send initial state immediately
    sendUpdate(ws)

    ws.on('pong', () => {
      ws.isAlive = true
    })
  })

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws: WSClient) => {
      if (ws.isAlive === false) {
        return ws.terminate()
      }
      ws.isAlive = false
      ws.ping()
    })
  }, 30_000)

  wss.on('close', () => {
    clearInterval(pingInterval)
  })

  // Broadcast updates to all connected clients every 3 seconds
  const broadcastInterval = setInterval(() => {
    broadcastUpdate()
  }, 3000)

  async function sendUpdate(ws: WebSocket) {
    try {
      const [state, today, trades] = await Promise.all([
        db.botState.findUnique({ where: { id: 'singleton' } }),
        db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
        db.trade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      ])
      ws.send(JSON.stringify({ state, today, trades }))
    } catch {}
  }

  async function broadcastUpdate() {
    try {
      const [state, today, trades] = await Promise.all([
        db.botState.findUnique({ where: { id: 'singleton' } }),
        db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
        db.trade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
      ])
      const data = JSON.stringify({ state, today, trades })
      wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data)
        }
      })
    } catch {}
  }

  const PORT = process.env.PORT || 3000
  server.listen(PORT, () => {
    console.log(`🚀 Dashboard live at http://localhost:${PORT}`)
    console.log(`🔌 WebSocket at ws://localhost:${PORT}/ws`)
  })
})
