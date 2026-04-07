#!/usr/bin/env bash
set -e

echo "🚀 Starting service: $RAILWAY_SERVICE_NAME"

case "$RAILWAY_SERVICE_NAME" in
  *worker*)
    echo "📡 Launching worker..."
    exec pnpm --filter @repo/worker start
    ;;
  *)
    echo "🌐 Launching web..."
    exec pnpm --filter @repo/web start
    ;;
esac
