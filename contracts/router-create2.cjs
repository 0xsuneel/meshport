// Same-address deployment of MeshPortRouter (USDC, EURC and cirBTC) on every chain.
//
// Uses the standard deterministic deployment proxy (Arachnid's CREATE2
// deployer, 0x4e59…956C — present on most EVM chains). The router's address
// is a pure function of: that deployer, a fixed salt, and keccak256 of the
// init code (committed bytecode + constructor args). Constructor args are
// the same on every testnet — Circle's TokenMessengerV2 and CCTPx
// CrossChainTokenService each have one testnet address — plus the fee
// wallet, so the address is the same everywhere.
const { encodeAbiParameters, keccak256, getContractAddress, toHex, concat } = require('viem')
const { bytecode } = require('./MeshPortRouter.bytecode.json')

const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT = keccak256(toHex('MeshPortRouter.v1'))
const TOKEN_MESSENGER_V2_TESTNET = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
/** Circle's CrossChainTokenService (CCTPx), every EVM testnet (@circle-fin/provider-cctpx). */
const CCTPX_SERVICE_TESTNET = '0x63753E722bd2C2A5DF6EE19C5106662208B81077'

function initCode(tokenMessenger, service, feeRecipient) {
  return concat([bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [tokenMessenger, service, feeRecipient])])
}

function predictRouterAddress(feeRecipient, tokenMessenger = TOKEN_MESSENGER_V2_TESTNET, service = CCTPX_SERVICE_TESTNET) {
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode(tokenMessenger, service, feeRecipient) })
}

module.exports = { CREATE2_DEPLOYER, SALT, TOKEN_MESSENGER_V2_TESTNET, CCTPX_SERVICE_TESTNET, initCode, predictRouterAddress }
