import { NextRequest, NextResponse } from 'next/server'

// Start/stop the bot by signaling the worker
export async function GET() {
  return NextResponse.json({ running: false })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    // In MVP, the bot runs with the worker process. This endpoint is a placeholder.
    // To truly start/stop, you'd need an HTTP endpoint on the worker.
    return NextResponse.json({ success: true, action: body.action })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
