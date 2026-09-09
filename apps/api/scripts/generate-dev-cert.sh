#!/usr/bin/env bash
# Generates a self-signed certificate for local TLS_MODE=direct.
#
#   pnpm --filter @cp/api cert:dev
#
# Development only. The bridge trusts it by ADDING it as a CA
# (BRIDGE_CA_CERT_PATH), never by disabling verification — so the local setup
# exercises the same certificate check that protects a deployment.

OUT="${1:-certs}"
mkdir -p "$OUT"

# MSYS_NO_PATHCONV stops Git Bash rewriting the "/CN=..." subject into a Windows
# path, which makes openssl fail with an unhelpful error.
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes   -keyout "$OUT/dev-key.pem"   -out "$OUT/dev-cert.pem"   -days 365   -subj "/CN=localhost/O=Confirmed Payee Dev"   -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

if [ ! -s "$OUT/dev-cert.pem" ] || [ ! -s "$OUT/dev-key.pem" ]; then
  echo "Certificate generation failed — is openssl installed?" >&2
  exit 1
fi

echo ""
echo "Wrote $OUT/dev-cert.pem and $OUT/dev-key.pem"
echo ""
echo "apps/api .env:"
echo "  TLS_MODE=direct"
echo "  TLS_CERT_PATH=$(pwd)/$OUT/dev-cert.pem"
echo "  TLS_KEY_PATH=$(pwd)/$OUT/dev-key.pem"
echo ""
echo "approval-bridge .env:"
echo "  API_BASE_URL=https://127.0.0.1:3000"
echo "  BRIDGE_CA_CERT_PATH=$(pwd)/$OUT/dev-cert.pem"
