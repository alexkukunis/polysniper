#!/usr/bin/env bash
# Generate base64-encoded Kalshi private key for Railway deployment
# Usage: ./scripts/encode-key.sh

set -e

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ No .env file found in current directory"
  exit 1
fi

# Extract the private key from .env (handles multi-line values)
# This looks for the line starting with KALSHI_PRIVATE_KEY= and extracts the value
echo "🔍 Extracting KALSHI_PRIVATE_KEY from .env..."

# Use awk to extract multi-line value between quotes
awk '/^KALSHI_PRIVATE_KEY=/{
  gsub(/KALSHI_PRIVATE_KEY=/, "")
  gsub(/"/, "")
  print
  while (getline && !/^$/) {
    gsub(/"/, "")
    print
  }
}' "$ENV_FILE" | base64 -w 0

echo ""
echo ""
echo "✅ Copy the base64 string above and set it in Railway as KALSHI_PRIVATE_KEY_B64"
echo ""
echo "💡 Railway Deployment Instructions:"
echo "   1. Go to Railway dashboard → Your worker service → Variables"
echo "   2. Add/Update: KALSHI_PRIVATE_KEY_B64=<paste the base64 string above>"
echo "   3. Make sure KALSHI_ACCESS_KEY and KALSHI_DEMO are also set"
echo "   4. Redeploy the service"
