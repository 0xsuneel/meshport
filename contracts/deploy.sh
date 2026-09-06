#!/bin/bash
# ArcPayRewards — One-command deployment to Arc Testnet via Foundry
# Run from the contracts/ folder: bash deploy.sh

set -e

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║     ArcPay Rewards Contract Deployment        ║"
echo "║     Arc Testnet via Foundry                   ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# ── Check requirements ─────────────────────────────────────────────────────────
if ! command -v forge &> /dev/null; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi

# ── Check private key ──────────────────────────────────────────────────────────
if [ -z "$PRIVATE_KEY" ]; then
  echo ""
  echo "⚠️  No PRIVATE_KEY found in environment."
  echo ""
  echo "Options:"
  echo "  1. Use your ArcPay wallet's private key (export from Settings)"
  echo "  2. Create a new admin wallet: cast wallet new"
  echo ""
  read -p "Enter private key (0x...): " PRIVATE_KEY
fi

# Strip 0x prefix if present, then re-add
PRIVATE_KEY=$(echo "$PRIVATE_KEY" | sed 's/^0x//')
PRIVATE_KEY="0x${PRIVATE_KEY}"

USDC_CONTRACT="0x3600000000000000000000000000000000000000"
RPC_URL="https://rpc.testnet.arc.network"

echo ""
echo "📋 Deployment Config:"
echo "   RPC:   $RPC_URL"
echo "   USDC:  $USDC_CONTRACT"
echo ""
echo "⏳ Compiling ArcPayRewards.sol..."

# Compile and deploy in one step
DEPLOY_OUTPUT=$(forge create ArcPayRewards.sol:ArcPayRewards \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --constructor-args "$USDC_CONTRACT" \
  2>&1)

echo "$DEPLOY_OUTPUT"

# Extract contract address
CONTRACT_ADDR=$(echo "$DEPLOY_OUTPUT" | grep "Deployed to:" | awk '{print $3}')
TX_HASH=$(echo "$DEPLOY_OUTPUT" | grep "Transaction hash:" | awk '{print $3}')

if [ -z "$CONTRACT_ADDR" ]; then
  echo ""
  echo "❌ Deployment failed. Check output above."
  exit 1
fi

echo ""
echo "╔═══════════════════════════════════════════════╗"
echo "║  ✅ Contract Deployed Successfully!           ║"
echo "╠═══════════════════════════════════════════════╣"
printf "║  Address:  %-35s ║\n" "$CONTRACT_ADDR"
printf "║  Tx Hash:  %-35s ║\n" "${TX_HASH:0:35}..."
echo "╚═══════════════════════════════════════════════╝"
echo ""
echo "📝 Next steps:"
echo ""
echo "1. Add to arcpay/.env:"
echo "   VITE_REWARDS_CONTRACT=$CONTRACT_ADDR"
echo ""
echo "2. Fund the treasury — send USDC to the contract:"
echo "   cast send $CONTRACT_ADDR --rpc-url $RPC_URL --private-key $PRIVATE_KEY"
echo "   (or transfer from your wallet directly)"
echo ""
echo "3. Verify on ArcScan:"
echo "   https://testnet.arcscan.app/address/$CONTRACT_ADDR"
echo ""

# Auto-update .env if we can find it
ENV_FILE="../.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q "VITE_REWARDS_CONTRACT" "$ENV_FILE"; then
    sed -i "s|VITE_REWARDS_CONTRACT=.*|VITE_REWARDS_CONTRACT=$CONTRACT_ADDR|" "$ENV_FILE"
    echo "✅ Auto-updated ../.env with contract address"
  else
    echo "VITE_REWARDS_CONTRACT=$CONTRACT_ADDR" >> "$ENV_FILE"
    echo "✅ Added VITE_REWARDS_CONTRACT to ../.env"
  fi
fi
