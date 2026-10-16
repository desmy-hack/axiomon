// Accès à la blockchain : fournisseur RPC, contrat Axiomon, compte propriétaire.
const fs = require('fs');
const path = require('path');
const { JsonRpcProvider, Wallet, NonceManager, Contract } = require('ethers');
const cfg = require('./config');
const db = require('./db');

const buildDir = path.join(__dirname, '..', 'build');
const artifactPath = path.join(buildDir, 'Axiomon.json');
if (!fs.existsSync(artifactPath)) {
  throw new Error("build/Axiomon.json introuvable : lance d'abord npm run compile");
}
const { abi } = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

let address = process.env.CONTRACT_ADDRESS;
const deploymentPath = path.join(buildDir, 'deployment.json');
if (!address && fs.existsSync(deploymentPath)) {
  address = JSON.parse(fs.readFileSync(deploymentPath, 'utf8')).address;
}
if (!address) {
  throw new Error("Adresse du contrat inconnue : lance npm run deploy ou définis CONTRACT_ADDRESS");
}

const provider = new JsonRpcProvider(cfg.rpcUrl);
const ownerWallet = new Wallet(cfg.ownerKey, provider);
// NonceManager évite les collisions de nonce quand le propriétaire envoie plusieurs transactions de suite
const owner = new NonceManager(ownerWallet);
const token = new Contract(address, abi, provider);

/** Envoie un peu d'ETH à l'utilisateur s'il n'en a plus pour payer le gaz. */
async function ensureGas(userAddress) {
  const balance = await provider.getBalance(userAddress);
  if (balance >= cfg.minGasWei) return;
  try {
    const tx = await owner.sendTransaction({ to: userAddress, value: cfg.topupWei });
    await tx.wait();
  } catch (e) {
    owner.reset();
    throw e;
  }
}

/** Enregistre la transaction dans l'historique, puis met à jour son statut à la confirmation. */
async function record(hash, kind, from, to, amount, tx, note = null) {
  await db.insertTx({ tx_hash: hash, kind, from_address: from, to_address: to, amount, note, created_at: Date.now() });
  tx.wait()
    .then((receipt) => db.setTxStatus(receipt.status === 1 ? 'confirmed' : 'failed', receipt.blockNumber, hash))
    .catch(() => db.setTxStatus('failed', null, hash))
    .catch((err) => console.error('Impossible de mettre à jour le statut de transaction :', err.message));
}

module.exports = {
  provider,
  token,
  owner,
  ownerAddress: ownerWallet.address,
  address,
  ensureGas,
  record,
};
