require('dotenv').config();
const { parseEther } = require('ethers');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name} (voir .env.example)`);
  return value;
}

const masterKey = required('MASTER_KEY');
const jwtSecret = required('JWT_SECRET');
if (masterKey.length < 16 || jwtSecret.length < 16) {
  throw new Error('MASTER_KEY et JWT_SECRET doivent faire au moins 16 caractères.');
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  rpcUrl: required('RPC_URL'),
  ownerKey: required('OWNER_PRIVATE_KEY'),
  jwtSecret,
  masterKey,
  adminUsername: (process.env.ADMIN_USERNAME || 'admin').toLowerCase(),
  explorerUrl: process.env.EXPLORER_URL || 'https://sepolia.etherscan.io',
  faucetAmount: process.env.FAUCET_AMOUNT || '100',
  topupWei: parseEther(process.env.GAS_TOPUP_ETH || '0.002'),
  minGasWei: parseEther(process.env.GAS_MIN_ETH || '0.0005'),
  dailyLimit: process.env.DAILY_LIMIT || '20000',
  maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS || 5),
  lockMinutes: Number(process.env.LOCK_MINUTES || 15),
  dbPath: process.env.DB_PATH || null,
};
