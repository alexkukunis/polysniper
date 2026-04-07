import { NextResponse } from 'next/server'

// Returns initial state - balance, orders, positions from Kalshi API
// The web server proxies this to the worker which calls Kalshi REST
export async function GET() {
  return NextResponse.json({
    balance: null,
    orders: [],
    positions: [],
    botRunning: false,
    isDemo: true,
    scanCount: 0,
  })
}
