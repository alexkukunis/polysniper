import { db } from '@repo/db'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const trades = await db.trade.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return NextResponse.json(trades)
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 })
  }
}
