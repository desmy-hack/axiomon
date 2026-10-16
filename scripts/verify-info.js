// Affiche ce qu'il faut saisir sur Etherscan pour vérifier le contrat (npm run verify-info).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { AbiCoder } = require('ethers');

const build = path.join(__dirname, '..', 'build');
const deploymentPath = path.join(build, 'deployment.json');
const address = process.env.CONTRACT_ADDRESS || (fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')).address : null);
if (!address) throw new Error("Adresse inconnue : lance npm run deploy ou définis CONTRACT_ADDRESS");
if (!fs.existsSync(path.join(build, 'standard-input.json'))) throw new Error("build/standard-input.json introuvable : lance npm run compile");

const initialSupply = BigInt(process.env.INITIAL_SUPPLY || '1000000');
const args = AbiCoder.defaultAbiCoder().encode(['uint256'], [initialSupply]).slice(2);
const explorer = process.env.EXPLORER_URL || 'https://sepolia.etherscan.io';

console.log(`
Vérification du contrat sur Etherscan
=====================================
1. Ouvre : ${explorer}/verifyContract?a=${address}
2. Compiler Type   : Solidity (Standard-Json-Input)
3. Compiler Version: v0.8.24+commit.e11b9ed9
4. License         : MIT
5. Envoie le fichier : ${path.join(build, 'standard-input.json')}
6. Arguments du constructeur (ABI-encodés), à coller si Etherscan les demande :

${args}

(INITIAL_SUPPLY utilisé : ${initialSupply})
Une fois vérifié, l'onglet « Contract » d'Etherscan affiche le code source et permet de lire/écrire le contrat.
`);
