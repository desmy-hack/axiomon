// Chiffrement des clés privées des wallets (AES-256-GCM) avec la clé maître du serveur.
const crypto = require('crypto');
const cfg = require('./config');

const key = crypto.scryptSync(cfg.masterKey, 'axiomon-wallet-v1', 32);

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { enc: enc.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function decrypt({ enc, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
