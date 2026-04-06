import { NextRequest, NextResponse } from 'next/server'
import { db } from '@repo/db'

export async function GET() {
  try {
    const state = await db.botState.findUnique({ where: { id: 'singleton' } })
    return NextResponse.json({
      success: true,
      state: state || { running: false, paperMode: true, pausedReason: null },
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, reason } = body

    const currentState = await db.botState.findUnique({ where: { id: 'singleton' } })

    switch (action) {
      case 'start': {
        if (currentState?.running) {
          return NextResponse.json({ success: false, message: 'Bot is already running' }, { status: 400 })
        }

        await db.botState.upsert({
          where: { id: 'singleton' },
          update: { running: true, pausedReason: null },
          create: {
            id: 'singleton',
            running: true,
            paperMode: currentState?.paperMode ?? true,
            bankroll: currentState?.bankroll ?? 1000,
            dailyPnl: 0,
            totalPnl: currentState?.totalPnl ?? 0,
          },
        })

        return NextResponse.json({ success: true, message: 'Bot started' })
      }

      case 'stop': {
        if (!currentState?.running) {
          return NextResponse.json({ success: false, message: 'Bot is not running' }, { status: 400 })
        }

        await db.botState.update({
          where: { id: 'singleton' },
          data: { running: false, pausedReason: null },
        })

        return NextResponse.json({ success: true, message: 'Bot stopped' })
      }

      case 'pause': {
        if (!currentState?.running) {
          return NextResponse.json({ success: false, message: 'Bot is not running' }, { status: 400 })
        }

        await db.botState.update({
          where: { id: 'singleton' },
          data: { running: false, pausedReason: reason || 'Manual pause' },
        })

        return NextResponse.json({ success: true, message: 'Bot paused' })
      }

      case 'resume': {
        if (currentState?.running) {
          return NextResponse.json({ success: false, message: 'Bot is already running' }, { status: 400 })
        }

        await db.botState.update({
          where: { id: 'singleton' },
          data: { running: true, pausedReason: null, dailyPnl: 0 },
        })

        return NextResponse.json({ success: true, message: 'Bot resumed' })
      }

      default:
        return NextResponse.json({ success: false, message: 'Invalid action' }, { status: 400 })
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
