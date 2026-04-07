/**
 * Environment variable helper — handles both local .env files and Railway's format.
 * Railway sometimes mangles multi-line values, so we support base64-encoded keys.
 */

import { resolve } from 'path'
import { config } from 'dotenv'

/**
 * Load environment variables from .env file (local dev only).
 * In production (Railway), vars are injected directly into the container.
 */
export function loadEnv() {
  const envPath = resolve(__dirname, '../../../.env')
  const envResult = config({ path: envPath })

  if (envResult.error) {
    // Only warn in local dev, not in Railway
    if (!process.env.RAILWAY_SERVICE_NAME) {
      console.warn(`⚠️  Failed to load .env file: ${envResult.error.message}`)
    }
  } else if (envResult.parsed && Object.keys(envResult.parsed).length > 0) {
    console.log(`✅ Loaded ${Object.keys(envResult.parsed).length} variables from .env file`)
  }

  return envResult
}

/**
 * Get the Kalshi private key, handling both regular and base64-encoded formats.
 * 
 * Railway sometimes mangles multi-line values. To work around this, you can:
 * 1. Base64 encode your key: `base64 -i key.pem`
 * 2. Set KALSHI_PRIVATE_KEY_B64 to the base64 string in Railway
 * 
 * This function will try both KALSHI_PRIVATE_KEY_B64 and KALSHI_PRIVATE_KEY
 */
export function getKalshiPrivateKey(): string {
  // Try base64-encoded version first (Railway-friendly)
  const b64Key = process.env.KALSHI_PRIVATE_KEY_B64
  if (b64Key) {
    try {
      return Buffer.from(b64Key, 'base64').toString('utf-8')
    } catch (err) {
      console.error('❌ Failed to decode KALSHI_PRIVATE_KEY_B64:', err)
    }
  }

  // Fall back to regular key
  return process.env.KALSHI_PRIVATE_KEY || ''
}

/**
 * Validate Kalshi credentials are properly configured
 */
export function validateKalshiCredentials(): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  const key = process.env.KALSHI_ACCESS_KEY
  const secret = getKalshiPrivateKey()
  const demo = process.env.KALSHI_DEMO !== 'false'

  // Check access key
  if (!key) {
    errors.push('KALSHI_ACCESS_KEY is not set')
  } else if (key.trim() === '') {
    errors.push('KALSHI_ACCESS_KEY is empty')
  }

  // Check private key
  if (!secret) {
    errors.push('KALSHI_PRIVATE_KEY is not set (try KALSHI_PRIVATE_KEY_B64 for Railway)')
  } else if (!secret.includes('BEGIN RSA PRIVATE KEY')) {
    errors.push('KALSHI_PRIVATE_KEY does not contain valid PEM format')
    errors.push('Tip: Use base64 encoding → set KALSHI_PRIVATE_KEY_B64 in Railway')
  }

  // Check demo mode
  console.log(`🔑 Kalshi Config:`)
  console.log(`   Access Key: ${key ? `${key.substring(0, 8)}...` : 'MISSING'}`)
  console.log(`   Private Key: ${secret ? 'SET (' + secret.split('\n').length + ' lines)' : 'MISSING'}`)
  console.log(`   Mode: ${demo ? 'DEMO' : 'PRODUCTION'}`)

  return {
    valid: errors.length === 0,
    errors,
  }
}
