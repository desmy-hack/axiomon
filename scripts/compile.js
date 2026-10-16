// Compile contracts/Axiomon.sol avec solc-js et écrit build/Axiomon.json (abi + bytecode).
// evmVersion "paris" : le bytecode reste compatible avec toutes les versions récentes de l'EVM
// (évite l'erreur "invalid opcode" rencontrée dans Remix avec une VM trop ancienne ou trop récente).
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'contracts', 'Axiomon.sol'), 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'contracts/Axiomon.sol': { content: source } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const imported = {};
function findImports(importPath) {
  try {
    const contents = fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8');
    imported[importPath] = { content: contents }; // gardé pour le fichier de vérification Etherscan
    return { contents };
  } catch {
    return { error: 'Fichier introuvable : ' + importPath };
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
(output.errors || []).forEach((e) => console.log(e.formattedMessage));
if ((output.errors || []).some((e) => e.severity === 'error')) {
  console.error('Échec de la compilation.');
  process.exit(1);
}

const contract = output.contracts['contracts/Axiomon.sol'].Axiomon;
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'build', 'Axiomon.json'),
  JSON.stringify({ abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object }, null, 2)
);
console.log('Compilation réussie : build/Axiomon.json');

// Fichier « Standard JSON input » pour vérifier le contrat sur Etherscan (mêmes réglages que la compilation ci-dessus)
const verifyInput = {
  language: 'Solidity',
  sources: { ...input.sources, ...imported },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } },
  },
};
fs.writeFileSync(path.join(root, 'build', 'standard-input.json'), JSON.stringify(verifyInput));
console.log('Fichier pour Etherscan : build/standard-input.json');
