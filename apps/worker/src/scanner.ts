import { db } from '@repo/db'
import { PolymarketClient } from './polymarket'

const GAMMA = 'https://gamma-api.polymarket.com'

// Slugs that identify Up/Down markets per asset
const PATTERNS: Record<string, string[]> = {
  BTC: ['bitcoin up or down', 'btc up or down'],
  ETH: ['ethereum up or down', 'eth up or down'],
  SOL: ['solana up or down', 'sol up or down'],
}

export class Scanner {
  constructor(private polymarket: PolymarketClient) {}

  async start() {
    await this.scan()
    // Re-scan every 2 minutes to find new windows
    setInterval(() => this.scan(), 120_000)
  }

  private async scan() {
    console.log('🔍 Scanning for active windows...')
    try {
      const res = await fetch(`${GAMMA}/markets?active=true&limit=200&order=volume&ascending=false`)
      const data = await res.json()
      const markets = Array.isArray(data) ? data : (data.markets ?? [])

      const found: any[] = []

      for (const m of markets) {
        const q = (m.question ?? '').toLowerCase()
        let asset = ''
        for (const [a, patterns] of Object.entries(PATTERNS)) {
          if (patterns.some(p => q.includes(p))) { asset = a; break }
        }
        if (!asset) continue

        // Determine window type from question
        let window = '15min'
        if (q.includes('5 minute') || q.includes('5min')) window = '5min'
        else if (q.includes('15 minute') || q.includes('15min')) window = '15min'
        else if (q.includes('1 hour') || q.includes('1hour')) window = '1hour'

        const tokens = m.clobTokenIds ?? m.tokens?.map((t: any) => t.token_id) ?? []
        if (tokens.length < 2) continue

        const windowEndsAt = new Date(m.endDate ?? m.endDateIso ?? Date.now() + 3600000)

        // Skip if window already ended
        if (windowEndsAt < new Date()) continue

        await db.market.upsert({
          where: { id: m.id },
          create: {
            id: m.id,
            asset,
            window,
            question: m.question,
            conditionId: m.conditionId ?? m.id,
            upTokenId: tokens[0],
            downTokenId: tokens[1],
            windowEndsAt,
            active: true,
          },
          update: { active: true, windowEndsAt },
        })

        found.push({ asset, window, question: m.question })
      }

      console.log(`✅ Found ${found.length} active windows`)
      // Tell Polymarket client which asset IDs to subscribe
      const allTokenIds = found.flatMap(f => {
        // Get the tokens from the markets we just saved
        return []
      }).filter(Boolean)

      // Collect all token IDs from markets
      const marketTokens = await db.market.findMany({ 
        where: { active: true },
        select: { upTokenId: true, downTokenId: true }
      })
      
      this.polymarket.updateSubscriptions(
        marketTokens.flatMap(m => [m.upTokenId, m.downTokenId])
      )
    } catch (err) {
      console.error('Scanner error:', err)
    }
  }
}
