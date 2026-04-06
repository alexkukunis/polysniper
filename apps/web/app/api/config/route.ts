import { NextRequest, NextResponse } from 'next/server'
import { db } from '@repo/db'

export async function GET() {
  try {
    let config = await db.config.findUnique({
      where: { id: 'singleton' },
    })

    if (!config) {
      config = await db.config.create({
        data: { id: 'singleton' },
      })
    }

    return NextResponse.json(config)
  } catch (error: any) {
    console.error('Error fetching config:', error)

    // Return default config if database is not ready
    if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
      return NextResponse.json({
        id: 'singleton',
        kalshiAccessKey: null,
        kalshiPrivateKey: null,
        kalshiApiUrl: null,
        kalshiWsUrl: null,
        kalshiDemo: true,
        botMode: 'hybrid',
        telegramBotToken: null,
        telegramChatId: null,
        bankrollUsdc: 1000,
        paperMode: true,
        // Market Maker params
        mmMinVolume24h: 15000,
        mmMaxSpread: 4,
        mmBaseSpreadCents: 2,
        mmOrderSize: 20,
        mmMaxMarkets: 3,
        // Legacy Parity params
        minProfitCents: 1.5,
        scanIntervalMs: 500,
        marketDiscoveryIntervalMs: 120000,
        maxConcurrentTrades: 5,
        maxPositionPct: 5,
        dailyLossPct: 3,
        minTradeSizeUsd: 10,
      })
    }

    return NextResponse.json(
      { error: 'Failed to fetch config' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const config = await db.config.upsert({
      where: { id: 'singleton' },
      update: {
        kalshiAccessKey: body.kalshiAccessKey || null,
        kalshiPrivateKey: body.kalshiPrivateKey || null,
        kalshiApiUrl: body.kalshiApiUrl || null,
        kalshiWsUrl: body.kalshiWsUrl || null,
        kalshiDemo: body.kalshiDemo ?? true,
        botMode: body.botMode || 'hybrid',
        telegramBotToken: body.telegramBotToken || null,
        telegramChatId: body.telegramChatId || null,
        bankrollUsdc: body.bankrollUsdc ?? 1000,
        paperMode: body.paperMode ?? true,
        // Market Maker params
        mmMinVolume24h: body.mmMinVolume24h ?? 15000,
        mmMaxSpread: body.mmMaxSpread ?? 4,
        mmBaseSpreadCents: body.mmBaseSpreadCents ?? 2,
        mmOrderSize: body.mmOrderSize ?? 20,
        mmMaxMarkets: body.mmMaxMarkets ?? 3,
        // Legacy Parity params
        minProfitCents: body.minProfitCents ?? 1.5,
        scanIntervalMs: body.scanIntervalMs ?? 500,
        marketDiscoveryIntervalMs: body.marketDiscoveryIntervalMs ?? 120000,
        maxConcurrentTrades: body.maxConcurrentTrades ?? 5,
        maxPositionPct: body.maxPositionPct ?? 5,
        dailyLossPct: body.dailyLossPct ?? 3,
        minTradeSizeUsd: body.minTradeSizeUsd ?? 10,
      },
      create: {
        id: 'singleton',
        kalshiAccessKey: body.kalshiAccessKey || null,
        kalshiPrivateKey: body.kalshiPrivateKey || null,
        kalshiApiUrl: body.kalshiApiUrl || null,
        kalshiWsUrl: body.kalshiWsUrl || null,
        kalshiDemo: body.kalshiDemo ?? true,
        botMode: body.botMode || 'hybrid',
        telegramBotToken: body.telegramBotToken || null,
        telegramChatId: body.telegramChatId || null,
        bankrollUsdc: body.bankrollUsdc ?? 1000,
        paperMode: body.paperMode ?? true,
        // Market Maker params
        mmMinVolume24h: body.mmMinVolume24h ?? 15000,
        mmMaxSpread: body.mmMaxSpread ?? 4,
        mmBaseSpreadCents: body.mmBaseSpreadCents ?? 2,
        mmOrderSize: body.mmOrderSize ?? 20,
        mmMaxMarkets: body.mmMaxMarkets ?? 3,
        // Legacy Parity params
        minProfitCents: body.minProfitCents ?? 1.5,
        scanIntervalMs: body.scanIntervalMs ?? 500,
        marketDiscoveryIntervalMs: body.marketDiscoveryIntervalMs ?? 120000,
        maxConcurrentTrades: body.maxConcurrentTrades ?? 5,
        maxPositionPct: body.maxPositionPct ?? 5,
        dailyLossPct: body.dailyLossPct ?? 3,
        minTradeSizeUsd: body.minTradeSizeUsd ?? 10,
      },
    })

    return NextResponse.json(config)
  } catch (error: any) {
    console.error('Error saving config:', error)

    // Return success if database is not ready
    if (error?.code === 'P2021' || error?.message?.includes('does not exist')) {
      const body = await request.json()
      return NextResponse.json({
        id: 'singleton',
        ...body,
      })
    }

    return NextResponse.json(
      { error: 'Failed to save config' },
      { status: 500 }
    )
  }
}
