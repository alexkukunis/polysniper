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
        polyApiKey: null,
        polyApiSecret: null,
        polyPassphrase: null,
        walletPrivateKey: null,
        polygonRpc: null,
        polygonWssRpc: null,
        telegramBotToken: null,
        telegramChatId: null,
        bankrollUsdc: 1000,
        paperMode: true,
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
        polyApiKey: body.polyApiKey || null,
        polyApiSecret: body.polyApiSecret || null,
        polyPassphrase: body.polyPassphrase || null,
        walletPrivateKey: body.walletPrivateKey || null,
        polygonRpc: body.polygonRpc || null,
        polygonWssRpc: body.polygonWssRpc || null,
        telegramBotToken: body.telegramBotToken || null,
        telegramChatId: body.telegramChatId || null,
        bankrollUsdc: body.bankrollUsdc ?? 1000,
        paperMode: body.paperMode ?? true,
      },
      create: {
        id: 'singleton',
        polyApiKey: body.polyApiKey || null,
        polyApiSecret: body.polyApiSecret || null,
        polyPassphrase: body.polyPassphrase || null,
        walletPrivateKey: body.walletPrivateKey || null,
        polygonRpc: body.polygonRpc || null,
        polygonWssRpc: body.polygonWssRpc || null,
        telegramBotToken: body.telegramBotToken || null,
        telegramChatId: body.telegramChatId || null,
        bankrollUsdc: body.bankrollUsdc ?? 1000,
        paperMode: body.paperMode ?? true,
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
