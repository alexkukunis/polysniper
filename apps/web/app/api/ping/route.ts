import { NextResponse } from 'next/server';

export async function GET() {
  const target = 'https://trading-api.kalshi.com/trade-api/v1/status';
  const threshold = 10;
  const attempts = 5;
  const latencies: number[] = [];
  const errors: string[] = [];

  for (let i = 0; i < attempts; i++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(target, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });

      clearTimeout(timeout);
      const latency = Date.now() - start;
      latencies.push(latency);
    } catch (err: any) {
      const latency = Date.now() - start;
      if (err.name === 'AbortError') {
        errors.push(`Attempt ${i + 1}: TIMEOUT (>5s)`);
      } else {
        // Even errors count as latency (connection time)
        latencies.push(latency);
      }
    }
  }

  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  const minLatency = latencies.length > 0 ? Math.min(...latencies) : null;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : null;

  let verdict: 'institutional' | 'good' | 'slow' | 'unreachable' = 'unreachable';
  if (avgLatency !== null) {
    if (avgLatency < 10) verdict = 'institutional';
    else if (avgLatency < 30) verdict = 'good';
    else verdict = 'slow';
  }

  return NextResponse.json({
    success: latencies.length > 0,
    target: 'trading-api.kalshi.com (HTTPS)',
    method: 'TCP/HTTP connection latency',
    summary: {
      avgLatency,
      minLatency,
      maxLatency,
      jitter: minLatency !== null && maxLatency !== null ? maxLatency - minLatency : null,
      successful: latencies.length,
      failed: errors.length,
      total: attempts,
      threshold,
      verdict,
    },
    individualResults: latencies.map((l, i) => `Attempt ${i + 1}: ${l}ms`),
    errors,
  });
}
