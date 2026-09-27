require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || ''

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Arc Testnet's EVM does not support the PUSH0 opcode that solc 0.8.20
      // emits by default (its default evmVersion is "shanghai"). Without this
      // pin, a contract that compiles cleanly still fails to deploy on Arc.
      // Matches the "EVM: Paris" setting documented in contracts/README.md
      // for deploying the same contracts manually via Remix.
      evmVersion: 'paris',
    },
  },
  networks: {
    arcTestnet: {
      url: 'https://rpc.testnet.arc.network',
      chainId: 5042002,
      accounts: ADMIN_PRIVATE_KEY ? [ADMIN_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources:   './contracts',
    artifacts: './contracts/artifacts',
    cache:     './contracts/cache',
  },
}
