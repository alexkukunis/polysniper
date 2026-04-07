#!/bin/bash

# Ping Test for trading-api.kalshi.com
# This script verifies network latency is under 10ms (institutional-grade setup)

echo "========================================="
echo "  Network Latency Test - Kalshi API"
echo "========================================="
echo ""

TARGET="trading-api.kalshi.com"
THRESHOLD=10

echo "Pinging ${TARGET}..."
echo "Threshold: ${THRESHOLD}ms (institutional-grade)"
echo ""

# Send 10 pings and capture output
PING_OUTPUT=$(ping -c 10 -W 2 "${TARGET}" 2>&1)
PING_EXIT_CODE=$?

echo "${PING_OUTPUT}"
echo ""

if [ $PING_EXIT_CODE -ne 0 ]; then
  echo "❌ PING FAILED - Host may be unreachable or ICMP is blocked"
  exit 1
fi

# Extract average RTT from ping output
# Linux format: rtt min/avg/max/mdev = X/X/X/X ms
# macOS format: round-trip min/avg/max/stddev = X/X/X/X ms
AVG_PING=$(echo "${PING_OUTPUT}" | grep -oP 'rtt min/avg/max/mdev = \K[0-9.]+' | cut -d'/' -f2)

if [ -z "$AVG_PING" ]; then
  # Try macOS format
  AVG_PING=$(echo "${PING_OUTPUT}" | grep -oP 'round-trip min/avg/max/stddev = \K[0-9.]+' | cut -d'/' -f2)
fi

if [ -z "$AVG_PING" ]; then
  echo "⚠️  Could not parse ping statistics"
  exit 1
fi

# Compare with threshold (using bc for floating point comparison)
IS_UNDER_THRESHOLD=$(echo "${AVG_PING} < ${THRESHOLD}" | bc -l)

echo ""
echo "========================================="
if [ "$IS_UNDER_THRESHOLD" -eq 1 ]; then
  echo "✅ INSTITUTIONAL-GRADE SETUP CONFIRMED"
  echo "Average latency: ${AVG_PING}ms (under ${THRESHOLD}ms)"
  echo "You have an elite physical network setup!"
  echo "========================================="
  exit 0
else
  echo "⚠️  LATENCY ABOVE THRESHOLD"
  echo "Average latency: ${AVG_PING}ms (above ${THRESHOLD}ms)"
  echo "Consider optimizing your network infrastructure"
  echo "========================================="
  exit 1
fi
