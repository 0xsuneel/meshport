// Compile contracts with the local solcjs (0.8.20) into Hardhat artifacts -
// for environments where Hardhat can't download its compiler. Then:
//   node contracts/compile-solcjs.cjs MeshPortCheckout.sol test-helpers/RevertingReceiver.sol
//   npx hardhat test --no-compile test/MeshPortCheckout.test.js
const fs = require('fs')
const path = require('path')
const solc = require('solc')
const files = process.argv.slice(2)
const sources = Object.fromEntries(files.map(f => [`contracts/${f}`, { content: fs.readFileSync(path.join(__dirname, f), 'utf8') }]))
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources,
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})))
const errors = (out.errors || []).filter(e => e.severity === 'error')
if (errors.length) { console.error(errors.map(e => e.formattedMessage).join('\n')); process.exit(1) }
for (const [sourceName, contracts] of Object.entries(out.contracts)) {
  for (const [contractName, c] of Object.entries(contracts)) {
    const dir = path.join(__dirname, 'artifacts', sourceName) // hardhat.config paths.artifacts
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${contractName}.json`), JSON.stringify({
      _format: 'hh-sol-artifact-1', contractName, sourceName, abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      linkReferences: {}, deployedLinkReferences: {},
    }, null, 2))
    console.log('compiled', sourceName, contractName)
  }
}
