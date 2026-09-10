require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY || ''

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
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
