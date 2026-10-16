// Test de bout en bout de l'API. Prérequis : chaîne locale (npm run chain), contrat déployé (npm run deploy)
// et serveur lancé (npm start) avec ADMIN_USERNAME=admin. Usage : npm run smoke
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const suffix = Math.random().toString(36).slice(2, 7);
let failures = 0;

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, data };
}

function check(name, condition, detail = '') {
  console.log((condition ? 'OK     ' : 'ÉCHEC  ') + name + (condition ? '' : ' ' + detail));
  if (!condition) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const alice = await call('/register', { method: 'POST', body: { username: 'alice_' + suffix, email: `alice_${suffix}@test.local`, password: 'motdepasse1' } });
  check('inscription alice', alice.status === 201, JSON.stringify(alice.data));
  const bob = await call('/register', { method: 'POST', body: { username: 'bob_' + suffix, email: `bob_${suffix}@test.local`, password: 'motdepasse1' } });
  check('inscription bob', bob.status === 201, JSON.stringify(bob.data));
  const a = alice.data.token;
  const b = bob.data.token;

  const bad = await call('/login', { method: 'POST', body: { username: 'alice_' + suffix, password: 'faux' } });
  check('connexion refusée avec un mauvais mot de passe', bad.status === 401);

  const faucet = await call('/faucet', { method: 'POST', token: a });
  check('distribution de test pour alice', faucet.status === 201, JSON.stringify(faucet.data));
  check('statut de la distribution : confirmée', (await waitConfirmed(a, faucet.data.txHash)) === 'confirmed');

  const again = await call('/faucet', { method: 'POST', token: a });
  check('deuxième distribution refusée (une par jour)', again.status === 429);

  const send = await call('/transfer', { method: 'POST', token: a, body: { to: 'bob_' + suffix, amount: '10' } });
  check('envoi de 10 AXN à bob', send.status === 201, JSON.stringify(send.data));
  check('statut du transfert : confirmé', (await waitConfirmed(a, send.data.txHash)) === 'confirmed');
  const balBob = await call('/balance', { token: b });
  check('bob a reçu 10 AXN', Number(balBob.data.axn) === 10, JSON.stringify(balBob.data));

  const tooMuch = await call('/transfer', { method: 'POST', token: a, body: { to: 'bob_' + suffix, amount: '1000000' } });
  check('transfert au-dessus du solde ou de la limite refusé', tooMuch.status === 400, JSON.stringify(tooMuch.data));

  const self = await call('/transfer', { method: 'POST', token: a, body: { to: 'alice_' + suffix, amount: '1' } });
  check('envoi à soi-même refusé', self.status === 400);

  const mintUser = await call('/admin/mint', { method: 'POST', token: a, body: { to: 'alice_' + suffix, amount: '1' } });
  check('création de AXN refusée à un utilisateur ordinaire', mintUser.status === 403);

  const hist = await call('/history', { token: b });
  check('historique de bob contient la réception', hist.data.some((r) => r.direction === 'in' && r.kind === 'transfer'));

  console.log(failures === 0 ? '\nTous les tests passent.' : `\n${failures} test(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Impossible de joindre le serveur :', e.message);
  process.exit(1);
});
