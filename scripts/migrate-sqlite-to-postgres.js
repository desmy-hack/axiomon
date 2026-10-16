// Importe users et transactions depuis la base SQLite locale vers Supabase PostgreSQL.
// Exécution : node scripts/migrate-sqlite-to-postgres.js
// Le script n'efface rien dans SQLite et refuse d'importer si les tables PostgreSQL ne sont pas vides.
require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquante dans .env');
  const sqlitePath = process.env.SQLITE_IMPORT_PATH || path.join(__dirname, '..', 'data', 'axiomon.db');
  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const integrity = sqlite.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Contrôle SQLite échoué : ${integrity}`);
    const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
    const txs = sqlite.prepare('SELECT * FROM transactions ORDER BY id').all();
    console.log(`Source SQLite : ${users.length} utilisateurs, ${txs.length} transactions.`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const counts = await client.query(`SELECT
        (SELECT COUNT(*)::int FROM public.users) AS users,
        (SELECT COUNT(*)::int FROM public.transactions) AS transactions`);
      if (counts.rows[0].users || counts.rows[0].transactions) {
        throw new Error('Les tables Supabase ne sont pas vides. Import annulé pour éviter les doublons.');
      }

      for (const u of users) {
        await client.query(`INSERT INTO public.users
          (id, username, email, password_hash, address, key_enc, key_iv, key_tag, role, last_faucet_at, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u.id, u.username, u.email, u.password_hash, u.address, u.key_enc, u.key_iv, u.key_tag, u.role, u.last_faucet_at, u.created_at]);
      }
      for (const t of txs) {
        await client.query(`INSERT INTO public.transactions
          (id, tx_hash, kind, from_address, to_address, amount, status, block_number, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [t.id, t.tx_hash, t.kind, t.from_address, t.to_address, t.amount, t.status, t.block_number, t.created_at]);
      }

      // Synchronise les séquences d'identifiants après l'import des ID historiques.
      await client.query(`SELECT setval(pg_get_serial_sequence('public.users','id'), COALESCE((SELECT MAX(id) FROM public.users), 1), EXISTS(SELECT 1 FROM public.users))`);
      await client.query(`SELECT setval(pg_get_serial_sequence('public.transactions','id'), COALESCE((SELECT MAX(id) FROM public.transactions), 1), EXISTS(SELECT 1 FROM public.transactions))`);
      await client.query('COMMIT');
      console.log('Migration terminée. Les identifiants et les clés privées chiffrées ont été conservés.');
      console.log(`Vérification : ${users.length} utilisateurs et ${txs.length} transactions importés.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } finally {
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Échec de la migration :', err.message);
  process.exitCode = 1;
});
