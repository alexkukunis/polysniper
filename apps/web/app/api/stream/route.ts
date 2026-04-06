import { db } from '@repo/db'
import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (d: any) =>
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`))

      // Send initial data immediately
      try {
        const [state, today, parityTrades, parityOpportunities] = await Promise.all([
          db.botState.findUnique({ where: { id: 'singleton' } }),
          db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
          db.parityTrade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
          db.parityOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
        ])
        send({ state, today, parityTrades, parityOpportunities })
      } catch {}

      const iv = setInterval(async () => {
        try {
          const [state, today, parityTrades, parityOpportunities] = await Promise.all([
            db.botState.findUnique({ where: { id: 'singleton' } }),
            db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
            db.parityTrade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
            db.parityOpportunity.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
          ])
          send({ state, today, parityTrades, parityOpportunities })
        } catch {}
      }, 3000)

      req.signal.addEventListener('abort', () => {
        clearInterval(iv)
        ctrl.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
