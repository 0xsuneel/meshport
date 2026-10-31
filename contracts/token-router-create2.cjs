// Same-address deployment of MeshPortTokenRouter (EURC / cirBTC over CCTPx)
// on every chain - the same scheme as bridge-router-create2.cjs: Arachnid's
// CREATE2 deployer, a fixed salt, committed bytecode + constructor args that
// are identical everywhere (Circle's CCTPx service has one EVM testnet
// address, plus MeshPort's fee wallet).
const { encodeAbiParameters, keccak256, getContractAddress, toHex, concat } = require('viem')
const { bytecode } = require('./MeshPortTokenRouter.bytecode.json')
const { CREATE2_DEPLOYER } = require('./bridge-router-create2.cjs')

const SALT = keccak256(toHex('MeshPortTokenRouter.v1'))
/** Circle's CrossChainTokenService (CCTPx), every EVM testnet (@circle-fin/provider-cctpx). */
const CCTPX_SERVICE_TESTNET = '0x63753E722bd2C2A5DF6EE19C5106662208B81077'

function initCode(service, feeRecipient) {
  return concat([bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [service, feeRecipient])])
}

function predictTokenRouterAddress(feeRecipient, service = CCTPX_SERVICE_TESTNET) {
  return getContractAddress({ opcode: 'CREATE2', from: CREATE2_DEPLOYER, salt: SALT, bytecode: initCode(service, feeRecipient) })
}

module.exports = { CREATE2_DEPLOYER, SALT, CCTPX_SERVICE_TESTNET, initCode, predictTokenRouterAddress }
