import { db } from '@repo/db'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/parity-opportunities — Fetch recent parity opportunities (last 50)
 */
export async function GET() {
  try {
    const opportunities = await db.parityOpportunity.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return NextResponse.json(opportunities)
  } catch (err: any) {
    return NextResponse.json({ error: 'Failed to fetch opportunities: ' + err.message }, { status: 500 })
  }
}
