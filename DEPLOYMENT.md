# 🚀 Railway Deployment Guide

## Step 1: Connect to GitHub (Do this first)

1. Go to https://github.com and create a new repository
2. Run these commands to push your code:

```bash
# Rename branch to main (optional)
git branch -m main

# Add your GitHub remote (replace with your repo URL)
git remote add origin https://github.com/YOUR_USERNAME/polysniper.git

# Push to GitHub
git push -u origin main
```

## Step 2: Create Railway Project

### Option A: Via CLI (Recommended)
```bash
# Login to Railway (you're already logged in)
railway login

# Create a new project
railway init

# Select "Empty Project" when prompted
# Name it: polysniper
```

### Option B: Via Web Dashboard
1. Go to https://railway.com
2. Click "New Project"
3. Select "GitHub Repo" and choose your polysniper repository
4. Or select "Empty Project" and connect the repo later

## Step 3: Add PostgreSQL Database

```bash
# Add PostgreSQL to your project
railway add -d postgresql

# This will create a PostgreSQL database and set DATABASE_URL automatically
```

## Step 4: Configure Environment Variables

```bash
# Set all required environment variables
railway variables set \
  POLY_API_KEY="your_api_key" \
  POLY_API_SECRET="your_api_secret" \
  POLY_PASSPHRASE="your_passphrase" \
  WALLET_PRIVATE_KEY="your_private_key" \
  POLYGON_RPC="https://polygon-rpc.com" \
  POLYGON_WSS_RPC="wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY" \
  BANKROLL_USDC="1000" \
  PAPER_MODE="true" \
  TELEGRAM_BOT_TOKEN="your_bot_token" \
  TELEGRAM_CHAT_ID="your_chat_id"
```

**⚠️ IMPORTANT**: Replace the placeholder values with your actual credentials!

### Where to get these:
- **Polymarket API keys**: https://polymarket.com/profile (API section)
- **WALLET_PRIVATE_KEY**: Your Ethereum wallet private key (export from MetaMask)
- **POLYGON_WSS_RPC**: Get from Alchemy (https://www.alchemy.com/) or Infura
- **Telegram bot**: Create via @BotFather on Telegram
- **TELEGRAM_CHAT_ID**: Use @userinfobot on Telegram to get your chat ID

## Step 5: Configure Railway Services

Railway needs to know how to run your monorepo. Create two services:

### Service 1: Worker (Main Bot)
```bash
# Link to your project first
railway link

# Set the deploy command
railway domain  # This will give you a URL
```

In Railway dashboard:
1. Click on your service
2. Go to Settings → Deploy
3. Set:
   - **Root Directory**: `apps/worker`
   - **Build Command**: `cd ../.. && pnpm install && cd packages/db && pnpm db:generate`
   - **Start Command**: `pnpm start`

### Service 2: Web Dashboard (Optional - can run in same service)
Add a second service or configure both in one:
1. **Root Directory**: `apps/web`
2. **Build Command**: `cd ../.. && pnpm install && pnpm build`
3. **Start Command**: `pnpm start`

## Step 6: Deploy

```bash
# Deploy via GitHub push (recommended)
# Railway will automatically deploy when you push to main

# OR deploy manually
railway up
```

## Step 7: Push Database Schema

```bash
# Get the DATABASE_URL from Railway
railway variables get DATABASE_URL

# Set it temporarily and push schema
export DATABASE_URL="postgresql://..."
cd packages/db
pnpm db:push
```

Or run directly in Railway:
```bash
railway shell
cd packages/db
pnpm db:push
```

## Step 8: Monitor Your Bot

1. Check logs: `railway logs`
2. Open dashboard: `railway open`
3. Visit your web dashboard at the Railway-provided URL

## Troubleshooting

### Database connection fails
- Make sure DATABASE_URL is set in Railway
- Run `pnpm db:generate` to regenerate Prisma client

### Bot doesn't start
- Check logs: `railway logs`
- Verify all environment variables are set
- Make sure PAPER_MODE is "true" for testing

### Can't connect to Polymarket
- Verify API keys are correct
- Check wallet private key format
- Ensure POLYGON_RPC is accessible

## Testing Locally First

Before deploying, you can test locally:

```bash
# Create .env file
cp .env.example .env

# Edit .env with your credentials
nano .env

# Install dependencies
pnpm install

# Generate Prisma client
cd packages/db && pnpm db:generate
cd ../..

# Start in development mode
pnpm dev
```

This starts both the worker and web dashboard locally.
