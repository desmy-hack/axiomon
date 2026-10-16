// Accès PostgreSQL via Supabase. Toutes les opérations sont asynchrones.
const { Pool, types } = require('pg');

// BIGINT (horodatages en millisecondes, COUNT) : pg les renvoie en texte par défaut, ce qui casserait
// les calculs comme last_faucet_at + 24 h (concaténation au lieu d'addition). Ces valeurs tiennent dans un Number.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL manquante. Ajoute la chaîne de connexion PostgreSQL de Supabase dans .env.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase fournit généralement une connexion TLS. Pour une URL locale, SSL peut être désactivé avec PGSSLMODE=disable.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

async function query(text, values = []) {
  return pool.query(text, values);
}
async function one(text, values = []) {
  const result = await query(text, values);
  return result.rows[0] || null;
}
async function many(text, values = []) {
  const result = await query(text, values);
  return result.rows;
}
async function count(text) {
  const row = await one(text);
  return Number(row?.n || 0);
}

// Migration au démarrage : ajoute les colonnes et tables des nouvelles fonctionnalités sans toucher aux données existantes.
// (Le même SQL est dans migrations/001_fonctionnalites.sql si tu préfères le lancer à la main dans Supabase.)
async function init() {
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen INTEGER NOT NULL DEFAULT 0');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until BIGINT NOT NULL DEFAULT 0');
  await query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note TEXT');
  await query(`CREATE TABLE IF NOT EXISTS audit (
    id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT)`);
  await query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

const historySql = (limit) => `SELECT t.tx_hash, t.kind, t.from_address, t.to_address, t.amount, t.status, t.note, t.created_at,
    uf.username AS from_name, ut.username AS to_name
    FROM transactions t LEFT JOIN users uf ON uf.address = t.from_address
    LEFT JOIN users ut ON ut.address = t.to_address
    WHERE t.from_address = $1 OR t.to_address = $2
    ORDER BY t.created_at DESC LIMIT ${limit}`;

module.exports = {
  init,
  close: () => pool.end(),
  getUserById: (id) => one('SELECT * FROM users WHERE id = $1', [id]),
  getUserByUsername: (username) => one('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]),
  getUserByEmail: (email) => one('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]),
  insertUser: async (u) => one(`INSERT INTO users
    (username, email, password_hash, address, key_enc, key_iv, key_tag, role, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [u.username, u.email, u.password_hash, u.address, u.key_enc, u.key_iv, u.key_tag, u.role, u.created_at]),
  setFaucet: (now, id) => query('UPDATE users SET last_faucet_at = $1 WHERE id = $2', [now, id]),
  searchUsers: (q, id) => many("SELECT username FROM users WHERE username ILIKE $1 ESCAPE '\\' AND id <> $2 ORDER BY username LIMIT 6", [q, id]),
  txSince: (start) => many('SELECT kind, amount, status, created_at FROM transactions WHERE created_at >= $1', [start]),
  usersSince: (start) => many('SELECT created_at FROM users WHERE created_at >= $1', [start]),
  recentTx: () => many(`SELECT t.tx_hash, t.kind, t.amount, t.status, t.created_at,
    uf.username AS from_name, ut.username AS to_name
    FROM transactions t LEFT JOIN users uf ON uf.address = t.from_address
    LEFT JOIN users ut ON ut.address = t.to_address
    ORDER BY t.created_at DESC LIMIT 12`),
  recentUsers: () => many('SELECT username, created_at FROM users ORDER BY id DESC LIMIT 6'),
  allUserAddresses: () => many('SELECT username, address FROM users ORDER BY id DESC LIMIT 100'),
  listUsers: () => many('SELECT username, address, role, frozen, created_at FROM users ORDER BY id DESC LIMIT 200'),
  countUsers: () => count('SELECT COUNT(*) AS n FROM users'),
  countTx: () => count('SELECT COUNT(*) AS n FROM transactions'),
  insertTx: (t) => query(`INSERT INTO transactions
    (tx_hash, kind, from_address, to_address, amount, status, note, created_at)
    VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT (tx_hash) DO NOTHING`,
    [t.tx_hash, t.kind, t.from_address, t.to_address, t.amount, t.note ?? null, t.created_at]),
  setTxStatus: (status, blockNumber, hash) => query('UPDATE transactions SET status = $1, block_number = $2 WHERE tx_hash = $3', [status, blockNumber, hash]),
  history: (from, to) => many(historySql(100), [from, to]),
  historyAll: (from, to) => many(historySql(5000), [from, to]),
  setFrozen: (frozen, id) => query('UPDATE users SET frozen = $1 WHERE id = $2', [frozen, id]),
  setLogin: (fails, lockedUntil, id) => query('UPDATE users SET failed_logins = $1, locked_until = $2 WHERE id = $3', [fails, lockedUntil, id]),
  sentSince: (address, since) => many("SELECT amount FROM transactions WHERE from_address = $1 AND kind = 'transfer' AND status <> 'failed' AND created_at >= $2", [address, since]),
  insertAudit: (at, actor, action, detail) => query('INSERT INTO audit (at, actor, action, detail) VALUES ($1,$2,$3,$4)', [at, actor, action, detail]),
  listAudit: () => many('SELECT at, actor, action, detail FROM audit ORDER BY id DESC LIMIT 100'),
  getSetting: (key) => one('SELECT value FROM settings WHERE key = $1', [key]),
  setSetting: (key, value) => query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]),
};

pool.on('error', (err) => console.error('Erreur inattendue du pool PostgreSQL :', err.message));
