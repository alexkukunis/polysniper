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
        const [state, today, trades] = await Promise.all([
          db.botState.findUnique({ where: { id: 'singleton' } }),
          db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
          db.trade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
        ])
        send({ state, today, trades })
      } catch {}

      const iv = setInterval(async () => {
        try {
          const [state, today, trades] = await Promise.all([
            db.botState.findUnique({ where: { id: 'singleton' } }),
            db.dailyStats.findFirst({ orderBy: { date: 'desc' } }),
            db.trade.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
          ])
          send({ state, today, trades })
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
