// Regenerates contracts/MeshPortBridgeRouter.bytecode.json from the Hardhat
// artifact (run `npx hardhat compile` first). Only needed when the contract
// source changes — which also changes the router's address on every chain.
const fs = require('fs')
const path = require('path')
const artifact = require('./artifacts/contracts/MeshPortBridgeRouter.sol/MeshPortBridgeRouter.json')
const file = path.join(__dirname, 'MeshPortBridgeRouter.bytecode.json')
const current = JSON.parse(fs.readFileSync(file, 'utf8'))
fs.writeFileSync(file, JSON.stringify({ ...current, bytecode: artifact.bytecode }, null, 2) + '\n')
console.log('MeshPortBridgeRouter.bytecode.json updated')
