// Déploie Axiomon avec le compte propriétaire défini dans .env (OWNER_PRIVATE_KEY, RPC_URL).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { JsonRpcProvider, Wallet, ContractFactory, formatEther } = require('ethers');

async function main() {
  const { RPC_URL, OWNER_PRIVATE_KEY } = process.env;
  if (!RPC_URL || !OWNER_PRIVATE_KEY) throw new Error('RPC_URL et OWNER_PRIVATE_KEY sont requis dans .env');

  const artifactPath = path.join(__dirname, '..', 'build', 'Axiomon.json');
  if (!fs.existsSync(artifactPath)) throw new Error("build/Axiomon.json introuvable : lance d'abord npm run compile");
  const { abi, bytecode } = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  const provider = new JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(OWNER_PRIVATE_KEY, provider);
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log(`Réseau : chainId ${network.chainId}`);
  console.log(`Propriétaire : ${wallet.address} (${formatEther(balance)} ETH)`);
  if (balance === 0n) throw new Error('Le compte propriétaire n\'a pas d\'ETH pour payer le gaz.');

  const initialSupply = BigInt(process.env.INITIAL_SUPPLY || '1000000');
  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(initialSupply);
  console.log('Transaction envoyée :', contract.deploymentTransaction().hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log('Axiomon déployé à :', address);

  fs.writeFileSync(
    path.join(__dirname, '..', 'build', 'deployment.json'),
    JSON.stringify({ address, chainId: Number(network.chainId), deployedAt: new Date().toISOString() }, null, 2)
  );
  console.log('Adresse enregistrée dans build/deployment.json');
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});
