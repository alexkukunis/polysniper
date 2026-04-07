#!/bin/bash

echo "=== KALSHI AUTHENTICATION TEST ==="
echo ""

# ──────────────────────────────────────────────
# PRODUCTION API TEST
# ──────────────────────────────────────────────
echo "🔵 Testing PRODUCTION API..."
echo "   Endpoint: https://api.elections.kalshi.com/trade-api/v2/portfolio/balance"
echo ""

PROD_ACCESS_KEY="aa30490b-39ae-4ae9-a62d-33cf44d4445c"
PROD_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAzPG15g27mYVoJoQy5EXcTwZ7F0SoCrPuuvuoD8LlEY2CoiWe
obyYGwCvl9AanRPEXTPeHlnnKWOBLWn0qaT9tOo8FXAsXgfCFl0R9xA+rZb5JrC9
dJToLJEep4hVCy0FuotO+6RKuSyfBUqBp3v+CskDTcWegtDTamzDcl6DmMRiepz2
uahDIrvy5IsECsOjCTjV0mDz4Ydlsy1VK1LioVZJNeBmst+mg4jQNkL6B5tC+mzx
WJn+oXxrrsybwqsH14d4m6Gb2ZGhPw+9sAPJu3lTWvbYQdD8geN3l+YCrdIxYnp3
QDZKvZ4jszf+UO9szI9e4LC/9fry4vhSalSlKwIDAQABAoIBAE/CDZlPZN/1RDgh
ILEn4vo6OnMuu/sWVWUdhSVFIuK24Mz7uQWWoNd5Z9y8F29j/vqKsfm74TOBTwd+
gcH3vOjIc8OgGRQrDsSnSdON1ea2p5YAGGsjfEvD2ls2umoUBnO3vXA/Wvk/vU9Q
1K56mb5Wxltg+jRM0spLM7DxyWMM765eAFOwyhWkX2X99Luufvr8MTFu2tl5lQDp
cd/PDUEsJOJJQObRcRaeZJD1xq64PcgC9+fcOXeON/JWNSrWOJ+w8m+RZupD8lcr
afoW+az4DC2R/NjKSf7veernhk2AjPzPVbJr9T1M+UkGtK5Qz+Y4AuQ6JdxCXtoz
5FqQ1CkCgYEA02DQQBeH3x0zNA7wD87qnQWYByl9WwzpAk8TnDSgqCCpuk5oei0S
3euHURgZbX2pOQg82qFOIo698iQdwXa41bgI2FzMYyNUMwBk/Ch7Or1lfU6Tv8DN
WMz1qE5wDl65nz/OXwpdYfyriz9rvtu/VUudU133byRq7JncHqDLyx0CgYEA+DUx
yqQAmE+0b+r7J139/ns9hFuU6YREJgnUvRixb1izpNnv1keGgPKBwrw3JJuzvh9E
g+7Z50wMwqCc5BpEkR3NejBmpXgCqqCxeCwTEy8AdnevANQNDnsRy3LrkZeljJI5
FSvnYuT1imPg/N7VwSIDm+oETZeyD0sUfPRFducCgYAvpP7Ls4IYtEg6T7OknIsd
YYlm898hisNqldBhwSsFOneHWu0JvOcnxlL14Gy61Twzcrvku78U4v/FeIaMeOoo
oha8Tg5zuh7ccBZTD/zWvKIHoJKFAjxG68vjZ+qyEn/ceVFW8sshrwYrmNv8ZSO3
YhfQFroS/y5qrjODY9MLsQKBgDVxRrJKE7K33rMGVmOIkmrb4EgCbBLHnuDN1xeM
HJBL+goxvrlVlzlmfdgPLJReThpOozMBF7v8nPa/HGjk2wSf9SEtELzqFTDl/rBQ
VR8ZTLE1XeIAxnrqts8mhGBJ1aRpy46qcFzTzaapkMUBueamyz4j6h9G3Vj7ooKx
Gc/bAoGBALfEwTVY4030UzBRPNmH1w8ag210KY2Dz+MXTQ0P571bR9NpWKopYP3+
RsUCyQ8JR3XJ+jdpg5It89vncFFet2GIU1nH/9C2wm9Olsjnb0c0GFiCmSBIVtxU
vn17AJtW362b5ZMDEAxg0gbSf6DMV/b3r3/u3UhVhdWWoOfnZOrX
-----END RSA PRIVATE KEY-----"

PROD_TIMESTAMP=$(date +%s)
PROD_SIGNATURE=$(echo -n "${PROD_TIMESTAMP}GET/trade-api/v2/portfolio/balance" | openssl dgst -sha256 -sign <(echo "${PROD_PRIVATE_KEY}") | openssl enc -base64 | tr -d '\n')

PROD_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  -H "KALSHI-ACCESS-KEY: ${PROD_ACCESS_KEY}" \
  -H "KALSHI-ACCESS-SIGNATURE: ${PROD_SIGNATURE}" \
  -H "KALSHI-ACCESS-TIMESTAMP: ${PROD_TIMESTAMP}" \
  "https://api.elections.kalshi.com/trade-api/v2/portfolio/balance")

PROD_HTTP_CODE=$(echo "$PROD_RESPONSE" | tail -n 1)
PROD_BODY=$(echo "$PROD_RESPONSE" | sed '$d')

echo "📥 Response Code: ${PROD_HTTP_CODE}"
echo "📥 Response Body:"
echo "$PROD_BODY" | python3 -m json.tool 2>/dev/null || echo "$PROD_BODY"
echo ""

if [ "$PROD_HTTP_CODE" = "200" ]; then
  echo "✅ PRODUCTION API AUTHENTICATION SUCCESSFUL!"
else
  echo "❌ PRODUCTION API AUTHENTICATION FAILED!"
fi

echo ""
echo "============================================="
echo ""

# ──────────────────────────────────────────────
# DEMO API TEST
# ──────────────────────────────────────────────
echo "🟡 Testing DEMO API..."
echo "   Endpoint: https://demo-api.kalshi.co/trade-api/v2/portfolio/balance"
echo ""

DEMO_ACCESS_KEY="74453c8b-0cd4-4df0-8be7-444aacf12c25"
DEMO_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2b1SEmoxVhZdaPujmArD6vqNOpUgTSCI2dquLlh47DgjBRtJ
5Jq+hdW1ic6t0Vq8GTp717RBKYQYUHDITFRCLiES8PwBPErVtRmE+tCIvHByS09E
R+vEWzZm5lbD7YwEOy10JWB6qDb3EpymXIbon6rdwIgQY1GyufHHHQOWjRGKDaSx
HYMjuCZktqi7++BzhCWQqj8EzWqIsG2HpSuFiGOh1146fgcbtPlMaI9KihPh
Dymf2/EGLhFrdX6F9S9QirITRRlacgjzfCk8N4rjjxarIlEQzh29B/mcJU/0QVB4
ffncalj95ZdC5nuSSDiyIN44830U8y5E7gP41QIDAQABAoIBAANWGrQJIbjMK1UL
4T8+KWLBwUVv7YiUNaScH8xT/+sjfREVKilKxoQuElPXPkovIry1000qobXG8WLV
WsXyPV72YMaFuTS5GaDM9rQR9LzQC3nkVnG0eiDC3gn5GfpBoy4o8/ByrWgQcSUj
qb6EAeJ+1fQ4rk+ae97MU2m6MvKPlmX6hEuSakilHSXaqBPw6gQSSqmYIDqx75Ko
IVCIPJEznmJMyl3bPLCzwaXADyqjsU8lR2nxeZNJu/pwHgIPjriXFG1bo9ABjzg5
9ryknuNyHBkKXz2QN/0bSCoQILnvySmMjqfoiIol+lbKDsMSomtITObNMO6K7IgK
Tq8/Lo0CgYEA4rcIRsVhFJnOdeKtSeXGZN/2RSuuimJqIPhXlKn3xiBrsMUBZn7N
PPm0uCK/rhB19u2nnHZ/3CIgStzai/1ho9+6ffpAGp2bsI0K+eFLoMW9qsiYvcMp
1IpsCSCXLEneX1Ta7vqgt4wa7zG53gu4YONwR6Kux0AhZCNirOm4mpsCgYEA9d19
f8llPoUhr5ARYwvN/0xdamoJFi7OcsxuYNAsKHMChjb5pJGeXLkUjlI16vNjA6fL
uUwcWbxWMh8SJsDGxczNICe0AWl/zGpgFMdWDaLMrOIBp2+BL8q82b/Y1C5Rb3c2
UD0+0rWGlomMIoonnJZPiFg6bFAgHswdStX7eU8CgYBvP7948twLftnX8Q51p6Ht
2BSBpsi0MUzAtvxLAAiMmVYe3N0uDWTq2eF7RdnnMT6hl8bauS9OtxQ/iBZaAVEL
V/qsXMNeDB7cyKktKwewcbf7eQmyfHUnTXFsHSjxW6IaB4qTIDsDNmX1H+KD+h5U
tOZg0IyRS3/XIqIGFX43pwKBgQCGS04if4oKpUNqFuI4XJlPapHX70U5VaW0dM+R
mAOWsINfdiTX6yo58Wo19te2luytcXjIpLcTmNjoFaqfekrYfe5JMwaSguKocC49
C0iIuDTd9bD7mN9SkIWo1q6D7yzSGqaTG3D2POrfzQ+7SgUq9btJeQ+oW/e/erRB
TTJH5wKBgBR45JF94hLID3T/zZkpxu/F3UzWtGt3VArZVB3wXI8nsUqZDwr0MVXp
Jvy4dy/Yve24oX+cQyvumRn8Zapa8XcvZBT3P8juKLC7d9TWy588n86H9lANh+89
iSjXco36ZNHuD7L6vpAY8fk03kzFvAvc47igTiYz/WNQZuMXdTEz
-----END RSA PRIVATE KEY-----"

DEMO_TIMESTAMP=$(date +%s)
DEMO_SIGNATURE=$(echo -n "${DEMO_TIMESTAMP}GET/trade-api/v2/portfolio/balance" | openssl dgst -sha256 -sign <(echo "${DEMO_PRIVATE_KEY}") | openssl enc -base64 | tr -d '\n')

DEMO_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Content-Type: application/json" \
  -H "KALSHI-ACCESS-KEY: ${DEMO_ACCESS_KEY}" \
  -H "KALSHI-ACCESS-SIGNATURE: ${DEMO_SIGNATURE}" \
  -H "KALSHI-ACCESS-TIMESTAMP: ${DEMO_TIMESTAMP}" \
  "https://demo-api.kalshi.co/trade-api/v2/portfolio/balance")

DEMO_HTTP_CODE=$(echo "$DEMO_RESPONSE" | tail -n 1)
DEMO_BODY=$(echo "$DEMO_RESPONSE" | sed '$d')

echo "📥 Response Code: ${DEMO_HTTP_CODE}"
echo "📥 Response Body:"
echo "$DEMO_BODY" | python3 -m json.tool 2>/dev/null || echo "$DEMO_BODY"
echo ""

if [ "$DEMO_HTTP_CODE" = "200" ]; then
  echo "✅ DEMO API AUTHENTICATION SUCCESSFUL!"
else
  echo "❌ DEMO API AUTHENTICATION FAILED!"
fi

echo ""
echo "============================================="
echo ""
echo "📊 SUMMARY:"
echo "   Production API: $([ "$PROD_HTTP_CODE" = "200" ] && echo "✅ WORKING" || echo "❌ FAILED (HTTP ${PROD_HTTP_CODE})")"
echo "   Demo API:       $([ "$DEMO_HTTP_CODE" = "200" ] && echo "✅ WORKING" || echo "❌ FAILED (HTTP ${DEMO_HTTP_CODE})")"
echo ""
echo "💡 Add both sets of credentials to Railway:"
echo "   For Production: KALSHI_ACCESS_KEY, KALSHI_PRIVATE_KEY, KALSHI_DEMO=false"
echo "   For Demo:       KALSHI_DEMO_ACCESS_KEY, KALSHI_DEMO_PRIVATE_KEY, KALSHI_DEMO=true"
