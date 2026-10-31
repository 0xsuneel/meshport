// Regenerates contracts/MeshPortRouter.bytecode.json from the Hardhat
// artifact (run `npx hardhat compile` first). Only needed when the contract
// source changes — which also changes the router's address on every chain.
const fs = require('fs')
const path = require('path')
const artifact = require('./artifacts/contracts/MeshPortRouter.sol/MeshPortRouter.json')
const file = path.join(__dirname, 'MeshPortRouter.bytecode.json')
const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
fs.writeFileSync(file, JSON.stringify({
  _comment: 'Exact creation bytecode of MeshPortRouter (solc 0.8.20, evm paris, optimizer 200 runs). contracts/deploy-router-all.cjs deploys THESE bytes with CREATE2 so the router has the same address on every chain. test/MeshPortRouter.test.js fails if this no longer matches the source.',
  ...current, bytecode: artifact.bytecode,
}, null, 2) + '\n')
console.log('MeshPortRouter.bytecode.json updated')
