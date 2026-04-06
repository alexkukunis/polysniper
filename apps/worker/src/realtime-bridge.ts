/**
 * RealTimeBridge — Event-driven WebSocket bridge between worker and web dashboard.
 * 
 * Instead of polling the database every 3 seconds, the worker pushes events
 * to this bridge via HTTP POST, which immediately broadcasts to all connected
 * WebSocket clients.
 * 
 * Usage:
 * - Worker: POST /api/realtime with { type: 'trade', data: {...} }
 * - Web: WebSocket /ws receives { type: 'trade', data: {...} }
 */

import { WebSocket, WebSocketServer } from 'ws'
import { createServer, Server } from 'http'
import { db } from '@repo/db'

interface RealtimeEvent {
  type: 'trade' | 'opportunity' | 'fill' | 'state_update' | 'balance'
  data: any
  timestamp: number
}

interface WSClient extends WebSocket {
  isAlive?: boolean
}

export class RealTimeBridge {
  private wss: WebSocketServer | null = null
  private server: Server | null = null
  private clients: Set<WSClient> = new Set()
  private httpPort: number
  private wsPath: string

  constructor(httpPort = 3002, wsPath = '/ws-realtime') {
    this.httpPort = httpPort
    this.wsPath = wsPath
  }

  /**
   * Start the real-time bridge server.
   * Creates an HTTP server with embedded WebSocket server.
   */
  async start() {
    this.server = createServer()
    this.wss = new WebSocketServer({ 
      server: this.server, 
      path: this.wsPath,
      maxPayload: 1024 * 1024, // 1MB
    })

    this.wss.on('connection', (ws: WSClient) => {
      ws.isAlive = true
      this.clients.add(ws)
      console.log(`🔌 Real-time bridge client connected (${this.clients.size} total)`)

      // Send initial state on connect
      this.sendInitialState(ws)

      ws.on('pong', () => {
        ws.isAlive = true
      })

      ws.on('close', () => {
        this.clients.delete(ws)
        console.log(`⚠️ Real-time bridge client disconnected (${this.clients.size} total)`)
      })

      ws.on('error', (err) => {
        console.error('❌ Real-time bridge WebSocket error:', err.message)
        this.clients.delete(ws)
      })
    })

    // Keep-alive ping every 30s
    const pingInterval = setInterval(() => {
      this.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          console.log('🔌 Terminating dead client')
          ws.terminate()
          this.clients.delete(ws)
          return
        }
        ws.isAlive = false
        ws.ping()
      })
    }, 30_000)

    this.wss.on('close', () => {
      clearInterval(pingInterval)
    })

    // Handle HTTP POST events from worker
    this.server.on('request', async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/event') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            const event: RealtimeEvent = JSON.parse(body)
            await this.broadcast(event)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, clients: this.clients.size }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid event format' }))
          }
        })
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', clients: this.clients.size }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    return new Promise<void>((resolve) => {
      this.server!.listen(this.httpPort, () => {
        console.log(`🚀 Real-time bridge live at http://localhost:${this.httpPort}`)
        console.log(`🔌 WebSocket at ws://localhost:${this.httpPort}${this.wsPath}`)
        resolve()
      })
    })
  }

  /**
   * Send initial dashboard state to a newly connected client.
   */
  private async sendInitialState(ws: WSClient) {
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

  /**
   * Broadcast an event to all connected WebSocket clients.
   */
  async broadcast(event: RealtimeEvent) {
    if (this.clients.size === 0) return

    const message = JSON.stringify(event)
    let sent = 0

    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message)
        sent++
      }
    })

    if (sent > 0) {
      console.log(`📡 Broadcast ${event.type} to ${sent} client(s)`)
    }
  }

  /**
   * Helper: Broadcast a trade event.
   */
  async broadcastTrade(trade: any) {
    await this.broadcast({
      type: 'trade',
      data: trade,
      timestamp: Date.now(),
    })
  }

  /**
   * Helper: Broadcast an opportunity event.
   */
  async broadcastOpportunity(opportunity: any) {
    await this.broadcast({
      type: 'opportunity',
      data: opportunity,
      timestamp: Date.now(),
    })
  }

  /**
   * Helper: Broadcast a fill event.
   */
  async broadcastFill(fill: any) {
    await this.broadcast({
      type: 'fill',
      data: fill,
      timestamp: Date.now(),
    })
  }

  /**
   * Helper: Broadcast a full state update (triggers DB refresh).
   */
  async broadcastStateUpdate() {
    try {
      const [state, today, parityTrades, parityOpportunities] = await Promise.all([
        db.botState.findUnique({ where: { id: 'singleton' } }),
        db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
        db.parityTrade.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
        db.parityOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }).catch(() => []),
      ])

      await this.broadcast({
        type: 'state_update',
        data: { state, today, parityTrades, parityOpportunities },
        timestamp: Date.now(),
      })
    } catch (err) {
      console.error('❌ Failed to broadcast state update:', err)
    }
  }

  /**
   * Get the HTTP endpoint for worker to push events.
   */
  getEventUrl(): string {
    return `http://localhost:${this.httpPort}/api/event`
  }

  /**
   * Stop the bridge server.
   */
  stop() {
    this.clients.forEach((ws) => ws.terminate())
    this.clients.clear()
    this.wss?.close()
    this.server?.close()
    console.log('🛑 Real-time bridge stopped')
  }

  /**
   * Get connected client count.
   */
  getClientCount(): number {
    return this.clients.size
  }
}
