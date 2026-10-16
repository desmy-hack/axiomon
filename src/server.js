const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Wallet, isAddress, getAddress, parseUnits, formatUnits, ZeroAddress } = require('ethers');

const cfg = require('./config');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const chain = require('./chain');

const app = express();
app.set('trust proxy', 1); // derrière le proxy de l'hébergeur, req.ip doit être l'IP du visiteur
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Outils ----------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Limiteur très simple en mémoire (suffisant pour un TP, à remplacer en production)
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
function parseAmount(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!AMOUNT_RE.test(text)) throw httpError(400, 'Montant invalide. Exemple : 12.5');
  const wei = parseUnits(text, 18);
  if (wei <= 0n) throw httpError(400, 'Le montant doit être supérieur à 0.');
  return { text, wei };
}

async function resolveRecipient(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw httpError(400, 'Indique un destinataire.');
  if (isAddress(raw)) return getAddress(raw);
  const user = await db.getUserByUsername(raw);
  if (!user) throw httpError(404, 'Destinataire introuvable.');
  return user.address;
}

const userView = (u) => ({ username: u.username, email: u.email, address: u.address, role: u.role, frozen: Boolean(u.frozen) });

// Journal d'audit : qui a fait quoi (actions d'administration et verrouillages)
const audit = (actor, action, detail) => db.insertAudit(Date.now(), actor, action, String(detail ?? ''));

// Mémo facultatif joint à un transfert : 80 caractères, sans caractères de contrôle
function cleanNote(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return text || null;
}

function assertActive(u) {
  if (u.frozen) throw httpError(403, "Ton compte est gelé par l'administrateur : envois impossibles.");
}

// Limite journalière : plafond d'AXN envoyés par adresse sur 24 h glissantes (modifiable par l'admin)
async function dailyLimitWei() {
  const row = await db.getSetting('daily_limit');
  return parseUnits(row ? row.value : cfg.dailyLimit, 18);
}
async function spentLast24h(address) {
  const rows = await db.sentSince(address, Date.now() - 24 * 3600 * 1000);
  return rows.reduce((t, r) => t + parseUnits(r.amount, 18), 0n);
}
const signToken = (u) => jwt.sign({ uid: u.id }, cfg.jwtSecret, { expiresIn: '12h' });

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Connexion requise.' });
  try {
    const payload = jwt.verify(token, cfg.jwtSecret);
    const user = await db.getUserById(payload.uid);
    if (!user) throw new Error('inconnu');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée. Reconnecte-toi.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: "Réservé à l'administrateur." });
  next();
}

// Un envoi à la fois par utilisateur, pour éviter les conflits de nonce
const locks = new Map();
function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

const FAUCET_DELAY_MS = 24 * 3600 * 1000;

// ---------- Public ----------

app.get('/api/config', wrap(async (req, res) => {
  const network = await chain.provider.getNetwork();
  res.json({
    name: await chain.token.name(),
    symbol: await chain.token.symbol(),
    contract: chain.address,
    chainId: Number(network.chainId),
    explorer: cfg.explorerUrl,
    faucetAmount: cfg.faucetAmount,
  });
}));

app.get('/api/token-info', wrap(async (req, res) => {
  const [supply, cap, max, decimals, name, symbol, daily, network] = await Promise.all([
    chain.token.totalSupply(), chain.token.cap(), chain.token.maxTransferAmount(), chain.token.decimals(),
    chain.token.name(), chain.token.symbol(), dailyLimitWei(), chain.provider.getNetwork(),
  ]);
  res.json({
    name, symbol, decimals: Number(decimals),
    contract: chain.address, owner: chain.ownerAddress,
    chainId: Number(network.chainId), explorer: cfg.explorerUrl,
    totalSupply: formatUnits(supply, 18), cap: formatUnits(cap, 18),
    maxTransfer: formatUnits(max, 18), dailyLimit: formatUnits(daily, 18),
  });
}));

app.post('/api/register', limit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) {
    throw httpError(400, "Nom d'utilisateur : 3 à 20 caractères (lettres, chiffres, _).");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw httpError(400, 'Adresse e-mail invalide.');
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError(400, 'Mot de passe : 8 caractères minimum.');
  }
  if (await db.getUserByUsername(username) || await db.getUserByEmail(email)) {
    throw httpError(409, "Ce nom d'utilisateur ou cet e-mail est déjà utilisé.");
  }

  const wallet = Wallet.createRandom();
  const k = encrypt(wallet.privateKey);
  const user = await db.insertUser({
    username,
    email,
    password_hash: await bcrypt.hash(password, 10),
    address: wallet.address,
    key_enc: k.enc,
    key_iv: k.iv,
    key_tag: k.tag,
    role: username.toLowerCase() === cfg.adminUsername ? 'admin' : 'user',
    created_at: Date.now(),
  });
  res.status(201).json({ token: signToken(user), user: userView(user) });
}));

app.post('/api/login', limit(20, 15 * 60 * 1000), wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.getUserByUsername(String(username || ''));
  const now = Date.now();
  if (user && Number(user.locked_until) > now) {
    const minutes = Math.ceil((Number(user.locked_until) - now) / 60000);
    throw httpError(429, `Compte verrouillé après trop d'échecs. Réessaie dans ${minutes} min.`);
  }
  const ok = user && (await bcrypt.compare(String(password || ''), user.password_hash));
  if (!ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      if (fails >= cfg.maxFailedLogins) {
        await db.setLogin(0, now + cfg.lockMinutes * 60000, user.id);
        await audit('système', 'verrouillage', `${user.username} : ${fails} échecs de connexion`);
      } else {
        await db.setLogin(fails, 0, user.id);
      }
    }
    throw httpError(401, 'Identifiants incorrects.');
  }
  if (user.failed_logins || Number(user.locked_until)) await db.setLogin(0, 0, user.id);
  res.json({ token: signToken(user), user: userView(user) });
}));

// ---------- Utilisateur connecté ----------

app.get('/api/me', auth, (req, res) => res.json(userView(req.user)));

// Suggestions de noms d'utilisateur pour le champ « destinataire » (6 résultats au plus)
app.get('/api/users/search', auth, limit(60, 60 * 1000), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 20).replace(/[\\%_]/g, '\\$&');
  if (!q) return res.json([]);
  res.json((await db.searchUsers(q + '%', req.user.id)).map((r) => r.username));
}));

app.get('/api/balance', auth, wrap(async (req, res) => {
  const a = req.user.address;
  const [axn, eth, max] = await Promise.all([
    chain.token.balanceOf(a),
    chain.provider.getBalance(a),
    chain.token.maxTransferAmount(),
  ]);
  const dailyLimit = await dailyLimitWei();
  const spent = await spentLast24h(a);
  res.json({
    axn: formatUnits(axn, 18),
    eth: formatUnits(eth, 18),
    maxTransfer: formatUnits(max, 18),
    dailyLimit: formatUnits(dailyLimit, 18),
    dailyRemaining: formatUnits(dailyLimit > spent ? dailyLimit - spent : 0n, 18),
    frozen: Boolean(req.user.frozen),
    faucetAvailableAt: req.user.last_faucet_at ? req.user.last_faucet_at + FAUCET_DELAY_MS : 0,
  });
}));

app.post('/api/faucet', auth, limit(10, 60 * 1000), wrap(async (req, res) => {
  const u = req.user;
  assertActive(u);
  const now = Date.now();
  if (u.last_faucet_at && now < u.last_faucet_at + FAUCET_DELAY_MS) {
    throw httpError(429, "Tu as déjà reçu des AXN aujourd'hui. Reviens demain.");
  }
  const { text, wei } = parseAmount(cfg.faucetAmount);
  const reserve = await chain.token.balanceOf(chain.ownerAddress);
  if (reserve < wei) throw httpError(503, 'La réserve de distribution est vide.');

  await db.setFaucet(now, u.id); // on réserve le créneau avant l'envoi
  try {
    const tx = await chain.token.connect(chain.owner).transfer(u.address, wei);
    await chain.record(tx.hash, 'faucet', chain.ownerAddress, u.address, text, tx);
    res.status(201).json({ txHash: tx.hash, amount: text });
  } catch (e) {
    await db.setFaucet(u.last_faucet_at ?? null, u.id);
    chain.owner.reset();
    throw e;
  }
}));

// Estimation des frais de réseau avant l'envoi (payés par Axiomon, affichés à titre d'information)
app.get('/api/estimate', auth, limit(60, 60 * 1000), wrap(async (req, res) => {
  const { wei } = parseAmount(req.query.amount);
  const dest = await resolveRecipient(req.query.to);
  let gas = 65000n; // valeur typique d'un transfert ERC-20, si l'estimation échoue
  try {
    gas = await chain.token.getFunction('transfer').estimateGas(dest, wei, { from: req.user.address });
  } catch { /* on garde la valeur typique */ }
  const fee = await chain.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  res.json({ gas: gas.toString(), feeEth: formatUnits(gas * price, 18) });
}));

app.post('/api/transfer', auth, limit(30, 60 * 1000), wrap(async (req, res) => {
  const u = req.user;
  assertActive(u);
  const { text, wei } = parseAmount(req.body?.amount);
  const dest = await resolveRecipient(req.body?.to);
  const note = cleanNote(req.body?.note);
  if (dest === u.address) throw httpError(400, "Tu ne peux pas t'envoyer des AXN à toi-même.");

  const [balance, max] = await Promise.all([
    chain.token.balanceOf(u.address),
    chain.token.maxTransferAmount(),
  ]);
  if (wei > max) {
    throw httpError(400, `Montant trop élevé : la limite par transfert est de ${formatUnits(max, 18)} AXN.`);
  }
  if (wei > balance) {
    throw httpError(400, `Solde insuffisant : tu as ${formatUnits(balance, 18)} AXN.`);
  }

  const txHash = await withLock('user-' + u.id, async () => {
    // Vérifié dans le verrou : deux envois simultanés ne peuvent pas dépasser la limite journalière
    const spent = await spentLast24h(u.address);
    const daily = await dailyLimitWei();
    if (spent + wei > daily) {
      const left = daily > spent ? daily - spent : 0n;
      throw httpError(400, `Limite journalière atteinte : il te reste ${formatUnits(left, 18)} AXN à envoyer aujourd'hui (limite ${formatUnits(daily, 18)} AXN par 24 h).`);
    }
    await chain.ensureGas(u.address);
    const signer = new Wallet(decrypt({ enc: u.key_enc, iv: u.key_iv, tag: u.key_tag }), chain.provider);
    const tx = await chain.token.connect(signer).transfer(dest, wei);
    await chain.record(tx.hash, 'transfer', u.address, dest, text, tx, note);
    return tx.hash;
  });
  res.status(201).json({ txHash });
}));

function historyRows(user, rows) {
  return rows.map((r) => ({
    txHash: r.tx_hash,
    kind: r.kind,
    direction: r.from_address === user.address ? 'out' : 'in',
    counterparty: r.from_address === user.address
      ? (r.to_name || r.to_address)
      : (r.kind === 'transfer' ? (r.from_name || r.from_address) : null),
    amount: r.amount,
    status: r.status,
    note: r.note || null,
    createdAt: Number(r.created_at),
  }));
}

app.get('/api/history', auth, wrap(async (req, res) => {
  res.json(historyRows(req.user, await db.history(req.user.address, req.user.address)));
}));

// Export CSV (séparateur « ; » pour Excel en français). Les cellules qui commencent par = + - @ sont neutralisées.
const csvCell = (value) => {
  let t = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};
const KIND_LABEL = { transfer: 'Transfert', faucet: 'Distribution', mint: 'Création' };
app.get('/api/history/export.csv', auth, limit(10, 60 * 1000), wrap(async (req, res) => {
  const rows = historyRows(req.user, await db.historyAll(req.user.address, req.user.address));
  const lines = [['Date', 'Type', 'Sens', 'Contrepartie', 'Montant AXN', 'Statut', 'Note', 'Transaction']];
  for (const r of rows) {
    lines.push([
      new Date(r.createdAt).toISOString(), KIND_LABEL[r.kind] || r.kind, r.direction === 'out' ? 'Envoyé' : 'Reçu',
      r.counterparty || '', String(r.amount).replace('.', ','), r.status, r.note || '', r.txHash,
    ]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="axiomon-historique.csv"');
  res.send('\ufeff' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n'));
}));

// ---------- Administration ----------

app.get('/api/admin/stats', auth, adminOnly, wrap(async (req, res) => {
  const [supply, cap, max, ownerAxn, ownerEth] = await Promise.all([
    chain.token.totalSupply(),
    chain.token.cap(),
    chain.token.maxTransferAmount(),
    chain.token.balanceOf(chain.ownerAddress),
    chain.provider.getBalance(chain.ownerAddress),
  ]);
  res.json({
    totalSupply: formatUnits(supply, 18),
    cap: formatUnits(cap, 18),
    maxTransfer: formatUnits(max, 18),
    ownerAxn: formatUnits(ownerAxn, 18),
    ownerEth: formatUnits(ownerEth, 18),
    ownerAddress: chain.ownerAddress,
    users: await db.countUsers(),
    transactions: await db.countTx(),
  });
}));


// Tableau de bord : séries temporelles calculées depuis SQLite, soldes lus sur la chaîne (cache 30 s)
const RANGES = { '24h': { buckets: 24, size: 3600e3 }, '7d': { buckets: 7, size: 86400e3 }, '30d': { buckets: 30, size: 86400e3 } };
let holdersCache = { at: 0, rows: [] };

async function topHolders() {
  if (Date.now() - holdersCache.at < 30000) return holdersCache.rows;
  const users = await db.allUserAddresses();
  const balances = await Promise.all(users.map((u) => chain.token.balanceOf(u.address).catch(() => 0n)));
  const rows = users
    .map((u, i) => ({ username: u.username, address: u.address, axn: Number(formatUnits(balances[i], 18)) }))
    .filter((r) => r.axn > 0)
    .sort((a, b) => b.axn - a.axn)
    .slice(0, 8);
  holdersCache = { at: Date.now(), rows };
  return rows;
}

app.get('/api/admin/metrics', auth, adminOnly, wrap(async (req, res) => {
  const range = RANGES[req.query.range] ? req.query.range : '24h';
  const { buckets, size } = RANGES[range];
  const now = Date.now();
  const end = Math.ceil((now + 1) / size) * size;
  const start = end - buckets * size;

  const series = Array.from({ length: buckets }, (_, i) => ({ t: start + i * size, tx: 0, transfers: 0, volume: 0, signups: 0 }));
  const kinds = {};
  const status = { confirmed: 0, pending: 0, failed: 0 };
  let largest = 0;
  let transferCount = 0;
  let transferVolume = 0;

  for (const r of await db.txSince(start)) {
    const b = series[Math.min(buckets - 1, Math.floor((r.created_at - start) / size))];
    const amount = Number(r.amount);
    b.tx += 1;
    kinds[r.kind] = kinds[r.kind] || { count: 0, volume: 0 };
    kinds[r.kind].count += 1;
    kinds[r.kind].volume += amount;
    status[r.status] = (status[r.status] || 0) + 1;
    if (r.kind === 'transfer') {
      b.transfers += 1;
      b.volume += amount;
      transferCount += 1;
      transferVolume += amount;
      if (amount > largest) largest = amount;
    }
  }
  for (const u of await db.usersSince(start)) {
    series[Math.min(buckets - 1, Math.floor((u.created_at - start) / size))].signups += 1;
  }

  const activity = [
    ...(await db.recentTx()).map((r) => ({
      type: r.kind, at: r.created_at, status: r.status, amount: r.amount,
      from: r.from_name, to: r.to_name, txHash: r.tx_hash,
    })),
    ...(await db.recentUsers()).map((u) => ({ type: 'signup', at: u.created_at, username: u.username })),
  ].sort((a, b) => b.at - a.at).slice(0, 14);

  res.json({
    range, bucketMs: size, series, kinds, status,
    summary: { transferCount, transferVolume, largest, average: transferCount ? transferVolume / transferCount : 0 },
    holders: await topHolders(),
    activity,
    serverTime: now,
  });
}));

app.get('/api/admin/users', auth, adminOnly, wrap(async (req, res) => res.json(await db.listUsers())));

app.post('/api/admin/mint', auth, adminOnly, wrap(async (req, res) => {
  const { text, wei } = parseAmount(req.body?.amount);
  const dest = await resolveRecipient(req.body?.to);
  const [supply, cap] = await Promise.all([chain.token.totalSupply(), chain.token.cap()]);
  if (supply + wei > cap) throw httpError(400, `Dépasse le plafond de ${formatUnits(cap, 18)} AXN.`);
  try {
    const tx = await chain.token.connect(chain.owner).mint(dest, wei);
    await chain.record(tx.hash, 'mint', ZeroAddress, dest, text, tx);
    await audit(req.user.username, 'création', `${text} AXN → ${String(req.body?.to).trim()}`);
    res.status(201).json({ txHash: tx.hash });
  } catch (e) {
    chain.owner.reset();
    throw e;
  }
}));

app.post('/api/admin/limit', auth, adminOnly, wrap(async (req, res) => {
  const { wei } = parseAmount(req.body?.amount);
  try {
    const tx = await chain.token.connect(chain.owner).setMaxTransferAmount(wei);
    await audit(req.user.username, 'limite par transfert', `Nouvelle limite : ${formatUnits(wei, 18)} AXN`);
    res.status(201).json({ txHash: tx.hash });
  } catch (e) {
    chain.owner.reset();
    throw e;
  }
}));

app.post('/api/admin/daily-limit', auth, adminOnly, wrap(async (req, res) => {
  const { text } = parseAmount(req.body?.amount);
  await db.setSetting('daily_limit', text);
  await audit(req.user.username, 'limite journalière', `Nouvelle limite : ${text} AXN par 24 h`);
  res.status(201).json({ dailyLimit: text });
}));

app.post('/api/admin/freeze', auth, adminOnly, wrap(async (req, res) => {
  const target = await db.getUserByUsername(String(req.body?.username || ''));
  if (!target) throw httpError(404, 'Utilisateur introuvable.');
  if (target.id === req.user.id || target.role === 'admin') throw httpError(400, 'Un compte administrateur ne peut pas être gelé.');
  const frozen = req.body?.frozen ? 1 : 0;
  await db.setFrozen(frozen, target.id);
  await audit(req.user.username, frozen ? 'gel' : 'dégel', target.username);
  res.json({ username: target.username, frozen: Boolean(frozen) });
}));

app.get('/api/admin/audit', auth, adminOnly, wrap(async (req, res) => res.json(await db.listAudit())));

// ---------- Erreurs ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  const message = status === 500 ? err.shortMessage || err.reason || 'Erreur interne du serveur.' : err.message;
  res.status(status).json({ error: message });
});

db.init().then(() => app.listen(cfg.port, async () => {
  console.log(`Axiomon : http://localhost:${cfg.port}`);
  console.log(`Contrat : ${chain.address}`);
  console.log(`Propriétaire : ${chain.ownerAddress}`);
  try {
    const code = await chain.provider.getCode(chain.address);
    if (code === '0x') console.warn("Attention : aucun contrat à cette adresse sur ce réseau. Vérifie RPC_URL et CONTRACT_ADDRESS.");
  } catch (e) {
    console.warn('Impossible de joindre le réseau :', e.shortMessage || e.message);
  }
})).catch((e) => {
  console.error('Démarrage impossible (base de données) :', e.message);
  process.exit(1);
});
