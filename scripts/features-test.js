// Teste les fonctionnalités ajoutées : verrouillage, gel, limite journalière, note, CSV, estimation, audit, infos du token.
// Prérequis : comme pour `npm run smoke` (chaîne locale, contrat déployé, serveur lancé avec ADMIN_USERNAME=admin).
// Les tests d'administration nécessitent le compte « admin » : crée-le avant (ou définis ADMIN_PASSWORD).
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AdminTest123!';
const suffix = Math.random().toString(36).slice(2, 7);
let failures = 0;

async function call(path, { method = 'GET', body, token, raw } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  let data = {};
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, data };
}
function check(name, ok, detail = '') {
  console.log((ok ? 'OK     ' : 'ÉCHEC  ') + name + (ok ? '' : ' ' + detail));
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function register(username) {
  const r = await call('/register', { method: 'POST', body: { username, email: username + '@test.local', password: 'MotDePasse123' } });
  return r.data.token;
}
async function waitConfirmed(token, hash) {
  for (let i = 0; i < 30; i++) {
    const { data } = await call('/history', { token });
    const row = data.find((r) => r.txHash === hash);
    if (row && row.status !== 'pending') return row.status;
    await sleep(1000);
  }
  return 'pending';
}

async function main() {
  // Administrateur
  let adminToken;
  const reg = await call('/register', { method: 'POST', body: { username: 'admin', email: 'admin@test.local', password: ADMIN_PASSWORD } });
  if (reg.status === 201) adminToken = reg.data.token;
  else adminToken = (await call('/login', { method: 'POST', body: { username: 'admin', password: ADMIN_PASSWORD } })).data.token;
  check('compte admin disponible', Boolean(adminToken), 'définis ADMIN_PASSWORD si le compte admin existe déjà');

  const alice = 'alice_' + suffix;
  const bob = 'bob_' + suffix;
  const a = await register(alice);
  const b = await register(bob);

  // Infos du token (publiques)
  const info = await call('/token-info');
  check('infos du token', info.data.symbol === 'AXN' && Number(info.data.cap) > 0 && /^0x/.test(info.data.contract), JSON.stringify(info.data));

  // Distribution puis transfert avec note
  const faucet = await call('/faucet', { method: 'POST', token: a });
  check('distribution de test', faucet.status === 201, JSON.stringify(faucet.data));
  await waitConfirmed(a, faucet.data.txHash);

  const est = await call(`/estimate?to=${bob}&amount=5`, { token: a });
  check('estimation des frais', est.status === 200 && est.data.gas && est.data.feeEth !== undefined, JSON.stringify(est.data));

  const t1 = await call('/transfer', { method: 'POST', token: a, body: { to: bob, amount: '5', note: '=cmd|"x"  Pizza\nvendredi' } });
  check('transfert avec note', t1.status === 201, JSON.stringify(t1.data));
  await waitConfirmed(a, t1.data.txHash);
  const hist = await call('/history', { token: a });
  const row = hist.data.find((r) => r.txHash === t1.data.txHash);
  check('note enregistrée et nettoyée', row && row.note && !row.note.includes('\n'), JSON.stringify(row));

  // Export CSV
  const csv = await call('/history/export.csv', { token: a, raw: true });
  check('export CSV', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && csv.text.includes('Transfert') && csv.text.includes("'=cmd"), csv.text.slice(0, 200));

  // Limite journalière
  const bal = await call('/balance', { token: a });
  check('solde expose la limite journalière', Number(bal.data.dailyLimit) > 0 && Number(bal.data.dailyRemaining) <= Number(bal.data.dailyLimit), JSON.stringify(bal.data));
  if (adminToken) {
    const setLimit = await call('/admin/daily-limit', { method: 'POST', token: adminToken, body: { amount: '8' } });
    check('admin : limite journalière modifiée', setLimit.status === 201, JSON.stringify(setLimit.data));
    const over = await call('/transfer', { method: 'POST', token: a, body: { to: bob, amount: '4' } });
    check('limite journalière appliquée (5 déjà envoyés + 4 > 8)', over.status === 400 && /journali/i.test(over.data.error || ''), JSON.stringify(over.data));
    await call('/admin/daily-limit', { method: 'POST', token: adminToken, body: { amount: '20000' } });

    // Gel
    const userRoleFreeze = await call('/admin/freeze', { method: 'POST', token: a, body: { username: bob, frozen: true } });
    check('gel refusé à un utilisateur ordinaire', userRoleFreeze.status === 403);
    const freeze = await call('/admin/freeze', { method: 'POST', token: adminToken, body: { username: alice, frozen: true } });
    check('admin : compte gelé', freeze.status === 200 && freeze.data.frozen === true, JSON.stringify(freeze.data));
    const blocked = await call('/transfer', { method: 'POST', token: a, body: { to: bob, amount: '1' } });
    check('envoi refusé pour un compte gelé', blocked.status === 403, JSON.stringify(blocked.data));
    await call('/admin/freeze', { method: 'POST', token: adminToken, body: { username: alice, frozen: false } });
    const ok = await call('/transfer', { method: 'POST', token: a, body: { to: bob, amount: '1' } });
    check('envoi possible après dégel', ok.status === 201, JSON.stringify(ok.data));
    const freezeAdmin = await call('/admin/freeze', { method: 'POST', token: adminToken, body: { username: 'admin', frozen: true } });
    check("un admin ne peut pas être gelé", freezeAdmin.status === 400);
  }

  // Verrouillage de connexion
  const victim = 'carl_' + suffix;
  await register(victim);
  let last;
  for (let i = 0; i < 5; i++) last = await call('/login', { method: 'POST', body: { username: victim, password: 'mauvais' + i } });
  check('5 échecs de connexion', last.status === 401, JSON.stringify(last.data));
  const locked = await call('/login', { method: 'POST', body: { username: victim, password: 'MotDePasse123' } });
  check('compte verrouillé même avec le bon mot de passe', locked.status === 429, JSON.stringify(locked.data));

  // Journal d'audit
  if (adminToken) {
    const log = await call('/admin/audit', { token: adminToken });
    const actions = Array.isArray(log.data) ? log.data.map((x) => x.action) : [];
    check("journal d'audit (gel, limite, verrouillage)", ['gel', 'dégel', 'limite journalière', 'verrouillage'].every((x) => actions.includes(x)), JSON.stringify(actions));
    const forbidden = await call('/admin/audit', { token: a });
    check("journal d'audit réservé à l'admin", forbidden.status === 403);
    const users = await call('/admin/users', { token: adminToken });
    check('liste admin expose le statut de gel', Array.isArray(users.data) && users.data.every((u) => 'frozen' in u), JSON.stringify(users.data).slice(0, 200));
  }

  console.log(failures === 0 ? '\nTous les tests passent.' : `\n${failures} test(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('Impossible de joindre le serveur :', e.message); process.exit(1); });
