-- CreateTable
CREATE TABLE "DailyStats" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "parityTrades" INTEGER NOT NULL DEFAULT 0,
    "opportunitiesSeen" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "pnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalVolume" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgCombinedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bestProfit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "running" BOOLEAN NOT NULL DEFAULT true,
    "paperMode" BOOLEAN NOT NULL DEFAULT true,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "pausedReason" TEXT,
    "bankroll" DOUBLE PRECISION NOT NULL,
    "dailyPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPnl" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marketsScanned" INTEGER NOT NULL DEFAULT 0,
    "activeSubscriptions" INTEGER NOT NULL DEFAULT 0,
    "openParityPositions" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "kalshiAccessKey" TEXT,
    "kalshiPrivateKey" TEXT,
    "kalshiApiUrl" TEXT,
    "kalshiWsUrl" TEXT,
    "telegramBotToken" TEXT,
    "telegramChatId" TEXT,
    "bankrollUsdc" DOUBLE PRECISION NOT NULL DEFAULT 1000,
    "paperMode" BOOLEAN NOT NULL DEFAULT true,
    "minProfitCents" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "scanIntervalMs" INTEGER NOT NULL DEFAULT 500,
    "marketDiscoveryIntervalMs" INTEGER NOT NULL DEFAULT 120000,
    "maxConcurrentTrades" INTEGER NOT NULL DEFAULT 5,
    "maxPositionPct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "dailyLossPct" DOUBLE PRECISION NOT NULL DEFAULT 3,
    "minTradeSizeUsd" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParityTrade" (
    "id" TEXT NOT NULL,
    "eventTicker" TEXT NOT NULL,
    "marketTicker" TEXT NOT NULL,
    "yesTicker" TEXT NOT NULL,
    "noTicker" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "yesBid" DOUBLE PRECISION NOT NULL,
    "noBid" DOUBLE PRECISION NOT NULL,
    "yesAsk" DOUBLE PRECISION NOT NULL,
    "noAsk" DOUBLE PRECISION NOT NULL,
    "combinedCost" DOUBLE PRECISION NOT NULL,
    "guaranteedProfit" DOUBLE PRECISION NOT NULL,
    "count" INTEGER NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "yesOrderId" TEXT,
    "noOrderId" TEXT,
    "yesFilled" BOOLEAN NOT NULL DEFAULT false,
    "noFilled" BOOLEAN NOT NULL DEFAULT false,
    "yesFillPrice" DOUBLE PRECISION,
    "noFillPrice" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "actualProfit" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'TRIGGERED',
    "closeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParityTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParityOpportunity" (
    "id" TEXT NOT NULL,
    "eventTicker" TEXT NOT NULL,
    "marketTicker" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "yesBid" DOUBLE PRECISION NOT NULL,
    "noBid" DOUBLE PRECISION NOT NULL,
    "yesAsk" DOUBLE PRECISION NOT NULL,
    "noAsk" DOUBLE PRECISION NOT NULL,
    "combinedCost" DOUBLE PRECISION NOT NULL,
    "guaranteedProfit" DOUBLE PRECISION NOT NULL,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParityOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyStats_date_key" ON "DailyStats"("date");

-- CreateIndex
CREATE INDEX "ParityTrade_status_idx" ON "ParityTrade"("status");

-- CreateIndex
CREATE INDEX "ParityTrade_dryRun_idx" ON "ParityTrade"("dryRun");

-- CreateIndex
CREATE INDEX "ParityTrade_createdAt_idx" ON "ParityTrade"("createdAt");

-- CreateIndex
CREATE INDEX "ParityOpportunity_createdAt_idx" ON "ParityOpportunity"("createdAt");

-- CreateIndex
CREATE INDEX "ParityOpportunity_triggered_idx" ON "ParityOpportunity"("triggered");
