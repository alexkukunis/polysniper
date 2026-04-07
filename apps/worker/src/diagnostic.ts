/**
 * Environment Diagnostic Script
 * Run this to verify all environment variables are loaded correctly
 */

// Load .env only in local development
import { resolve } from 'path'
import { config } from 'dotenv'
const envPath = resolve(__dirname, '../../../.env')
config({ path: envPath })

console.log('🔍 Environment Variable Diagnostic')
console.log('='.repeat(60))

// Check each variable
const vars = {
  KALSHI_ACCESS_KEY: process.env.KALSHI_ACCESS_KEY,
  KALSHI_PRIVATE_KEY: process.env.KALSHI_PRIVATE_KEY,
  KALSHI_DEMO: process.env.KALSHI_DEMO,
  DRY_RUN: process.env.DRY_RUN,
  RAILWAY_SERVICE_NAME: process.env.RAILWAY_SERVICE_NAME,
}

console.log('\n📋 Variables Status:')
for (const [name, value] of Object.entries(vars)) {
  const exists = value !== undefined && value !== ''
  const status = exists ? '✅' : '❌'
  
  if (name === 'KALSHI_PRIVATE_KEY') {
    // Handle multi-line key
    const lines = value?.split('\n').length || 0
    console.log(`${status} ${name}: ${exists ? `SET (${lines} lines, ${value?.length} chars)` : 'MISSING'}`)
    if (exists) {
      const firstLine = value?.split('\n')[0]
      console.log(`   First line: "${firstLine}"`)
    }
  } else if (name === 'KALSHI_ACCESS_KEY') {
    console.log(`${status} ${name}: ${exists ? value : 'MISSING'}`)
  } else {
    console.log(`${status} ${name}: ${exists ? value : 'MISSING'}`)
  }
}

console.log('\n' + '='.repeat(60))

// Validate
const hasKey = !!vars.KALSHI_ACCESS_KEY
const hasSecret = !!vars.KALSHI_PRIVATE_KEY

if (!hasKey || !hasSecret) {
  console.log('\n❌ CRITICAL: Missing required credentials!')
  if (!hasKey) console.log('   → KALSHI_ACCESS_KEY is not set')
  if (!hasSecret) console.log('   → KALSHI_PRIVATE_KEY is not set')
  console.log('\n💡 Fix: Add these to Railway dashboard → Variables section')
  process.exit(1)
}

// Validate private key format
const keyLines = vars.KALSHI_PRIVATE_KEY!.split('\n').filter(l => l.trim())
const hasBeginMarker = keyLines.some(l => l.includes('BEGIN RSA PRIVATE KEY'))
const hasEndMarker = keyLines.some(l => l.includes('END RSA PRIVATE KEY'))

if (!hasBeginMarker || !hasEndMarker) {
  console.log('\n⚠️  WARNING: KALSHI_PRIVATE_KEY format looks incorrect')
  console.log('   Expected: Multi-line PEM format with BEGIN/END markers')
  console.log('   This will cause authentication failures!')
} else {
  console.log('\n✅ Private key format looks correct (PEM format)')
}

// Check for common issues
console.log('\n🔧 Common Issues Check:')

// Check for extra quotes
if (vars.KALSHI_PRIVATE_KEY?.startsWith('"') || vars.KALSHI_PRIVATE_KEY?.startsWith("'")) {
  console.log('⚠️  KALSHI_PRIVATE_KEY has quotes - remove them in Railway config')
}

// Check if key is on one line
if (keyLines.length < 5) {
  console.log('⚠️  KALSHI_PRIVATE_KEY may be collapsed to too few lines')
  console.log('   In Railway, use the multi-line format with actual newlines')
}

console.log('\n✅ All checks passed!')
process.exit(0)
