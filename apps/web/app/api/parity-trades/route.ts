import { db } from '@repo/db'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/parity-trades — Fetch parity trade history (last 100)
 */
export async function GET() {
  try {
    const trades = await db.parityTrade.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return NextResponse.json(trades)
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch parity trades: ' + err.message }, { status: 500 })
  }
}
