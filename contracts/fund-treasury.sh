#!/bin/bash
# Fund the ArcPayRewards treasury with USDC
# Usage: bash fund-treasury.sh CONTRACT_ADDRESS AMOUNT_USDC

CONTRACT=$1
AMOUNT_USDC=${2:-10}  # default 10 USDC

if [ -z "$CONTRACT" ]; then
  echo "Usage: bash fund-treasury.sh 0xCONTRACT_ADDRESS [amount_usdc]"
  exit 1
fi

USDC="0x3600000000000000000000000000000000000000"
RPC="https://rpc.testnet.arc.network"

if [ -z "$PRIVATE_KEY" ]; then
  read -p "Enter admin private key (0x...): " PRIVATE_KEY
fi

# Convert USDC amount to 6-decimal raw value
AMOUNT_RAW=$(echo "$AMOUNT_USDC * 1000000" | bc | cut -d. -f1)

echo "Sending $AMOUNT_USDC USDC to treasury at $CONTRACT..."

TX=$(cast send "$USDC" \
  "transfer(address,uint256)(bool)" \
  "$CONTRACT" "$AMOUNT_RAW" \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  2>&1)

echo "$TX"
echo ""
echo "Treasury funded! Check balance:"
echo "cast call $CONTRACT 'treasuryBalance()(uint256)' --rpc-url $RPC"
