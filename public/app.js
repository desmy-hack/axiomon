(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NS = 'http://www.w3.org/2000/svg';

  const state = {
    token: null, user: null, config: null, balance: null,
    history: null, historyKey: '', filter: 'all', search: '', view: 'wallet',
    timer: null, faucetTimer: null, openTx: new Set(), pendingSend: null,
  };
  try { state.token = localStorage.getItem('axn_token'); } catch { /* stockage indisponible */ }

  // ---------- Outils ----------

  function icon(name) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4 });
  const fmt = (v) => nf.format(Number(v));
  const shortHash = (h) => h.slice(0, 10) + '…' + h.slice(-6);
  const shortAddr = (a) => a.slice(0, 8) + '…' + a.slice(-4);
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

  function relTime(ms) {
    const s = Math.round((ms - Date.now()) / 1000);
    const a = Math.abs(s);
    if (a < 45) return 'à l’instant';
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }

  function fmtDuration(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.max(1, Math.ceil((ms % 3600000) / 60000));
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  }

  // Montants exacts : on compare en unités de base (18 décimales) avec des BigInt
  function toWei(text) {
    if (!/^\d+(\.\d{1,18})?$/.test(text)) return null;
    const [i, f = ''] = text.split('.');
    return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  }
  function fromWei(w) {
    const s = w.toString().padStart(19, '0');
    const i = s.slice(0, -18);
    const f = s.slice(-18).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  function setMsg(id, text, kind) {
    const node = $(id);
    node.textContent = text || '';
    node.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function toast(message, kind = 'ok') {
    const box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    const node = el('div', { class: 'toast ' + kind }, icon(kind === 'ok' ? 'check' : 'x'), el('span', { text: message }));
    box.append(node);
    setTimeout(() => node.remove(), 4800);
  }

  async function copyText(text, message = 'Copié') {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      toast('Copie impossible : sélectionne le texte à la main.', 'error');
    }
  }

  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try {
      res = await fetch('/api' + path, { ...options, headers });
    } catch {
      throw new Error('Le serveur ne répond pas.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* réponse vide */ }
    if (res.status === 401 && state.token) logout();
    if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
    return data;
  }

  const onSepolia = () => state.config && state.config.chainId === 11155111;

  // ---------- Thème ----------

  function paintThemeButton() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const button = $('theme');
    button.replaceChildren(icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', dark ? 'Passer au thème clair' : 'Passer au thème sombre');
  }

  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('axn_theme', next); } catch { /* ignoré */ }
    paintThemeButton();
  });

  // ---------- Guilloché du billet ----------

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const SHAPES = [{ R: 120, r: 47, d: 70 }, { R: 112, r: 29, d: 58 }];

  function guilloche(svg) {
    svg.replaceChildren();
    for (const { R, r, d } of SHAPES) {
      const k = (R - r) / r;
      const turns = r / gcd(R, r);
      const steps = turns * 80;
      let path = '';
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * turns * 2 * Math.PI;
        const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
        const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
        path += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      }
      const node = document.createElementNS(NS, 'path');
      node.setAttribute('d', path);
      node.setAttribute('pathLength', '1');
      svg.append(node);
    }
  }

  // Le billet s'incline légèrement vers le pointeur, la bande holographique suit
  function bindTilt() {
    if (reduced || !matchMedia('(hover: hover)').matches) return;
    const wrap = $('note-wrap');
    const note = $('note');
    wrap.addEventListener('pointermove', (e) => {
      const r = wrap.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      note.style.setProperty('--ry', ((px - 0.5) * 10).toFixed(2) + 'deg');
      note.style.setProperty('--rx', ((0.5 - py) * 8).toFixed(2) + 'deg');
      note.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
    });
    wrap.addEventListener('pointerleave', () => {
      note.style.setProperty('--rx', '0deg');
      note.style.setProperty('--ry', '0deg');
      note.style.setProperty('--mx', '50%');
    });
  }

  function countTo(node, to, ms = 850) {
    const from = Number(node.dataset.v || 0);
    node.dataset.v = String(to);
    if (reduced || from === to) { node.textContent = fmt(to); return; }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (to - from) * eased);
      if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(to);
    };
    requestAnimationFrame(step);
  }

  // ---------- Session ----------

  function saveSession(data) {
    state.token = data.token;
    state.user = data.user;
    try { localStorage.setItem('axn_token', data.token); } catch { /* ignoré */ }
  }

  function logout() {
    state.token = null;
    state.user = null;
    state.balance = null;
    state.history = null;
    state.historyKey = '';
    state.openTx.clear();
    clearTimeout(state.timer);
    clearInterval(state.faucetTimer);
    stopAdmin();
    try { localStorage.removeItem('axn_token'); } catch { /* ignoré */ }
    showAuth();
  }

  function showAuth() {
    $('auth').hidden = false;
    $('app').hidden = true;
    $('session').hidden = true;
    $('nav').hidden = true;
    setTimeout(() => $('guilloche-auth').classList.add('done'), 3200);
  }

  async function showApp() {
    $('auth').hidden = true;
    $('app').hidden = false;
    $('session').hidden = false;
    $('nav').hidden = false;
    $('nav-admin').hidden = state.user.role !== 'admin';
    $('whoami').textContent = state.user.username;
    $('address').textContent = state.user.address;
    $('address-big').textContent = state.user.address;
    setView('wallet');
    renderHistory();
    setTimeout(() => $('guilloche-note').classList.add('done'), 3200);
    clearInterval(state.faucetTimer);
    state.faucetTimer = setInterval(updateFaucet, 30000);
    await refresh();
  }

  function setView(view) {
    state.view = view;
    $('view-wallet').hidden = view !== 'wallet';
    $('view-admin').hidden = view !== 'admin';
    $('view-token').hidden = view !== 'token';
    for (const button of $('nav').querySelectorAll('button')) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (view === 'admin') startAdmin(); else stopAdmin();
    if (view === 'token') loadTokenInfo();
  }

  // ---------- À propos du token ----------

  async function loadTokenInfo() {
    try {
      const t = await api('/token-info');
      const rows = [
        ['Nom', `${t.name} (${t.symbol})`],
        ['Décimales', String(t.decimals)],
        ['Offre en circulation', fmt(t.totalSupply) + ' ' + t.symbol],
        ['Plafond maximal', fmt(t.cap) + ' ' + t.symbol],
        ['Limite par transfert', fmt(t.maxTransfer) + ' ' + t.symbol],
        ['Limite journalière par adresse', fmt(t.dailyLimit) + ' ' + t.symbol],
        ['Réseau', t.chainId === 11155111 ? 'Sepolia (réseau de test)' : 'Chaîne locale (id ' + t.chainId + ')'],
        ['Adresse du contrat', t.contract],
        ['Propriétaire du contrat', t.owner],
      ];
      $('token-facts').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { class: k.startsWith('Adresse') || k.startsWith('Propriétaire') ? 'mono' : '', text: v }))));
      $('token-link').replaceChildren(t.chainId === 11155111
        ? el('a', { href: `${t.explorer}/address/${t.contract}`, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Voir le contrat sur Etherscan')
        : document.createTextNode('Chaîne locale : pas d’explorateur.'));
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- Actualisation ----------

  async function refresh() {
    try {
      const [balance, history] = await Promise.all([api('/balance'), api('/history')]);
      state.balance = balance;
      renderBalance(balance);
      setHistory(history);
    } catch { /* une session expirée est déjà gérée dans api() */ }
    scheduleRefresh();
  }

  // Plus fréquent tant qu'une transaction est en attente de confirmation
  function scheduleRefresh() {
    clearTimeout(state.timer);
    if (!state.token) return;
    const pending = (state.history || []).some((r) => r.status === 'pending');
    state.timer = setTimeout(refresh, pending ? 4000 : 12000);
  }

  // ---------- Solde ----------

  function renderBalance(b) {
    countTo($('balance-axn'), Number(b.axn));
    $('balance-eth').textContent = Number(b.eth).toFixed(4);
    $('max-transfer').textContent = fmt(b.maxTransfer) + ' AXN';
    $('daily-remaining').textContent = fmt(b.dailyRemaining) + ' AXN';
    $('frozen-banner').hidden = !b.frozen;
    updateFaucet();
    updateSendState();
  }

  function updateFaucet() {
    const b = state.balance;
    if (!b || !state.config) return;
    const wait = b.faucetAvailableAt - Date.now();
    const amount = state.config.faucetAmount;
    $('faucet-text').textContent = wait > 0
      ? `Prochaine distribution dans ${fmtDuration(wait)}.`
      : `Une fois par jour, tu peux recevoir ${amount} AXN pour essayer l’application.`;
    const button = $('faucet-btn');
    button.disabled = wait > 0;
    button.textContent = wait > 0 ? 'Déjà reçu aujourd’hui' : `Recevoir ${amount} AXN`;
  }

  // ---------- Historique ----------

  function setHistory(history) {
    const key = JSON.stringify(history);
    if (key === state.historyKey && state.history) { refreshTimes(); return; }
    state.historyKey = key;
    state.history = history;
    renderHistory();
  }

  function refreshTimes() {
    // Rien à reconstruire : on remet seulement à jour les dates relatives
    for (const row of state.history || []) {
      const node = document.querySelector(`[data-hash="${row.txHash}"] .tx-time`);
      if (node) node.textContent = relTime(row.createdAt);
    }
  }

  function statusBadge(status) {
    if (status === 'confirmed') return el('span', { class: 'badge confirmed' }, icon('check'), 'Confirmée');
    if (status === 'failed') return el('span', { class: 'badge failed' }, icon('x'), 'Échouée');
    return el('span', { class: 'badge pending' }, el('span', { class: 'dot' }), 'En attente');
  }

  function counterparty(r) {
    if (!r.counterparty) return '';
    return r.counterparty.startsWith('0x') ? shortAddr(r.counterparty) : r.counterparty;
  }

  function txRow(r) {
    const out = r.direction === 'out';
    let title;
    let ic;
    if (r.kind === 'faucet') { title = 'Distribution de test'; ic = 'drop'; }
    else if (r.kind === 'mint') { title = 'Création de AXN'; ic = 'plus'; }
    else if (out) { title = 'Envoi à ' + counterparty(r); ic = 'up'; }
    else { title = 'Réception' + (r.counterparty ? ' de ' + counterparty(r) : ''); ic = 'down'; }

    const details = el('details', { class: 'tx', 'data-hash': r.txHash });
    if (state.openTx.has(r.txHash)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) state.openTx.add(r.txHash); else state.openTx.delete(r.txHash);
    });

    const summary = el('summary', {},
      el('span', { class: 'tx-icon ' + (out ? 'out' : 'in') }, icon(ic)),
      el('div', { class: 'tx-main' },
        el('p', { class: 'tx-title', text: title }),
        el('p', { class: 'tx-sub' }, statusBadge(r.status), el('span', { class: 'tx-time', text: relTime(r.createdAt) }),
          r.note ? el('span', { class: 'tx-note', text: '« ' + r.note + ' »' }) : null)
      ),
      el('span', { class: 'tx-amount ' + (out ? 'out' : 'in'), text: (out ? '−' : '+') + ' ' + fmt(r.amount) })
    );

    const copyButton = el('button', { class: 'copy', type: 'button', text: 'Copier' });
    copyButton.addEventListener('click', () => copyText(r.txHash, 'Hash copié'));

    const explorer = onSepolia()
      ? el('a', { href: `${state.config.explorer}/tx/${r.txHash}`, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Voir sur Etherscan')
      : el('span', { class: 'hint', text: 'Chaîne locale : pas d’explorateur.' });

    const detail = el('dl', { class: 'tx-detail' },
      el('div', {}, el('dt', { text: 'Date' }), el('dd', { text: new Date(r.createdAt).toLocaleString('fr-FR') })),
      el('div', {}, el('dt', { text: 'Montant exact' }), el('dd', { text: r.amount + ' AXN' })),
      r.note ? el('div', {}, el('dt', { text: 'Note' }), el('dd', { class: 'plain', text: r.note })) : null,
      el('div', {}, el('dt', { text: 'Transaction' }), el('dd', { text: shortHash(r.txHash) }), copyButton),
      el('div', {}, explorer)
    );

    details.append(summary, detail);
    return details;
  }

  function renderHistory() {
    const box = $('history');
    if (state.history === null) {
      box.replaceChildren(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
      return;
    }
    if (state.history.length === 0) {
      const button = el('button', { class: 'primary', type: 'button', text: 'Recevoir des AXN de test' });
      button.addEventListener('click', () => { setPane('receive'); $('seg-receive').focus(); });
      const art = document.createElementNS(NS, 'svg');
      art.setAttribute('viewBox', '0 0 64 64');
      art.setAttribute('aria-hidden', 'true');
      art.innerHTML = '<rect x="6" y="16" width="52" height="32" rx="4"/><circle cx="32" cy="32" r="8"/><path d="M14 24h6M44 40h6"/>';
      box.replaceChildren(el('div', { class: 'empty' }, art, el('p', { text: 'Aucune transaction pour l’instant.' }), button));
      return;
    }
    const q = state.search.trim().toLowerCase();
    const rows = state.history.filter((r) => (state.filter === 'all' || r.direction === state.filter)
      && (!q || [r.counterparty, r.note, r.amount, r.kind, r.txHash, r.status].some((v) => String(v || '').toLowerCase().includes(q))));
    if (rows.length === 0) {
      box.replaceChildren(el('div', { class: 'empty' }, el('p', { text: q ? 'Aucun résultat pour cette recherche.' : 'Aucune transaction dans cette catégorie.' })));
      return;
    }
    box.replaceChildren(...rows.map(txRow));
  }

  // ---------- Envoi ----------

  function setPane(pane) {
    const send = pane === 'send';
    $('send-form').hidden = !send;
    $('receive-pane').hidden = send;
    $('seg-send').setAttribute('aria-selected', String(send));
    $('seg-receive').setAttribute('aria-selected', String(!send));
  }

  function amountValue() {
    return $('amount').value.trim().replace(',', '.');
  }

  function updateSendState() {
    const hint = $('amount-hint');
    const input = $('amount');
    const b = state.balance;
    const raw = amountValue();
    let error = '';
    let valid = false;
    if (b && raw) {
      const wei = toWei(raw);
      if (wei === null || wei <= 0n) error = 'Montant invalide. Exemple : 12.5';
      else if (wei > toWei(b.maxTransfer)) error = `Au-dessus de la limite : ${fmt(b.maxTransfer)} AXN par transfert.`;
      else if (wei > toWei(b.axn)) error = `Solde insuffisant : tu as ${fmt(b.axn)} AXN.`;
      else if (wei > toWei(b.dailyRemaining)) error = `Limite journalière : il te reste ${fmt(b.dailyRemaining)} AXN à envoyer aujourd’hui.`;
      else valid = true;
    }
    input.classList.toggle('invalid', Boolean(error));
    hint.classList.toggle('error', Boolean(error));
    if (error) hint.textContent = error;
    else if (b) hint.textContent = `Solde : ${fmt(b.axn)} AXN · limite : ${fmt(b.maxTransfer)} AXN par transfert`;
    else hint.textContent = '';
    $('send-btn').disabled = !(valid && $('to').value.trim()) || Boolean(b && b.frozen);
  }

  let searchTimer = null;
  function bindRecipientSearch() {
    $('to').addEventListener('input', () => {
      updateSendState();
      clearTimeout(searchTimer);
      const q = $('to').value.trim();
      if (!q || q.startsWith('0x')) { $('user-list').replaceChildren(); return; }
      searchTimer = setTimeout(async () => {
        try {
          const names = await api('/users/search?q=' + encodeURIComponent(q));
          $('user-list').replaceChildren(...names.map((n) => el('option', { value: n })));
        } catch { /* suggestions facultatives */ }
      }, 200);
    });
  }

  function bindSend() {
    $('amount').addEventListener('input', updateSendState);

    for (const chip of document.querySelectorAll('.chip[data-amount]')) {
      chip.addEventListener('click', () => {
        const b = state.balance;
        if (!b) return;
        let value = chip.dataset.amount;
        if (value === 'max') {
          const lim = toWei(b.maxTransfer);
          const bal = toWei(b.axn);
          value = fromWei(bal < lim ? bal : lim);
        }
        $('amount').value = value;
        updateSendState();
        $('amount').focus();
      });
    }

    $('send-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if ($('send-btn').disabled) return;
      const to = $('to').value.trim();
      const amount = amountValue();
      const note = $('memo').value.trim();
      state.pendingSend = { to, amount, note };
      $('c-amount').textContent = amount.replace('.', ',');
      $('c-to').textContent = to.startsWith('0x') ? shortAddr(to) : to;
      $('c-note').textContent = note;
      $('c-note-row').hidden = !note;
      estimateFee(to, amount);
      const dialog = $('confirm');
      dialog.returnValue = '';
      dialog.showModal();
    });

    $('confirm').addEventListener('close', () => {
      if ($('confirm').returnValue === 'ok' && state.pendingSend) doSend(state.pendingSend);
      state.pendingSend = null;
    });
  }

  // Estimation des frais de réseau, affichée dans la fenêtre de confirmation
  async function estimateFee(to, amount) {
    const out = $('c-fee');
    out.textContent = 'Estimation…';
    try {
      const r = await api(`/estimate?to=${encodeURIComponent(to)}&amount=${encodeURIComponent(amount)}`);
      const eth = Number(r.feeEth);
      out.textContent = `≈ ${eth < 0.000001 ? '< 0,000001' : eth.toFixed(6).replace('.', ',')} ETH · payés par Axiomon`;
    } catch {
      out.textContent = 'Payés par Axiomon';
    }
  }

  async function doSend({ to, amount, note }) {
    const button = $('send-btn');
    button.classList.add('busy');
    setMsg('send-msg', '');
    try {
      await api('/transfer', { method: 'POST', body: JSON.stringify({ to, amount, note }) });
      toast('Transaction envoyée. Confirmation en cours…');
      $('send-form').reset();
      updateSendState();
      await refresh();
    } catch (e) {
      setMsg('send-msg', e.message, 'error');
      toast(e.message, 'error');
    } finally {
      button.classList.remove('busy');
    }
  }

  // ---------- Recevoir ----------

  function bindReceive() {
    $('seg-send').addEventListener('click', () => setPane('send'));
    $('seg-receive').addEventListener('click', () => setPane('receive'));
    $('copy-address').addEventListener('click', () => copyText(state.user.address, 'Adresse copiée'));

    $('faucet-btn').addEventListener('click', async () => {
      const button = $('faucet-btn');
      button.classList.add('busy');
      setMsg('faucet-msg', '');
      try {
        const r = await api('/faucet', { method: 'POST' });
        toast(`${r.amount} AXN envoyés. Le solde se met à jour à la confirmation.`);
        await refresh();
      } catch (e) {
        setMsg('faucet-msg', e.message, 'error');
        toast(e.message, 'error');
      } finally {
        button.classList.remove('busy');
      }
    });
  }

  // ---------- Filtres de l'historique ----------

  async function exportCsv() {
    const button = $('export-csv');
    button.classList.add('busy');
    try {
      const res = await fetch('/api/history/export.csv', { headers: { Authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export impossible.');
      const url = URL.createObjectURL(await res.blob());
      const link = el('a', { href: url, download: 'axiomon-historique.csv' });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Historique exporté.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      button.classList.remove('busy');
    }
  }

  function bindFilters() {
    $('history-search').addEventListener('input', (e) => { state.search = e.target.value; renderHistory(); });
    $('export-csv').addEventListener('click', exportCsv);
    for (const button of document.querySelectorAll('.filter')) {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter;
        for (const other of document.querySelectorAll('.filter')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        renderHistory();
      });
    }
  }

  // ---------- Administration ----------

  // ---------- Tableau de bord ----------

  const admin = { range: '24h', live: true, timer: null, animate: true, ok: 0 };
  const RANGE_LABEL = { '24h': 'les dernières 24 h', '7d': 'les 7 derniers jours', '30d': 'les 30 derniers jours' };
  const KIND = {
    transfer: { label: 'Transferts', color: 'var(--green-2)', icon: 'up' },
    faucet: { label: 'Distributions', color: 'var(--brass-lt)', icon: 'drop' },
    mint: { label: 'Créations', color: '#8b7fd6', icon: 'plus' },
  };

  function stopAdmin() { clearTimeout(admin.timer); admin.timer = null; }

  function startAdmin() {
    stopAdmin();
    admin.animate = true;
    adminTick();
  }

  async function adminTick() {
    stopAdmin();
    if (state.view !== 'admin' || !state.token) return;
    if (admin.live && !document.hidden) {
      try {
        await loadAdmin();
        admin.ok = Date.now();
        setLive();
      } catch (e) {
        setLive(e.message);
      }
    }
    if (state.view === 'admin' && state.token) admin.timer = setTimeout(adminTick, 5000);
  }

  function setLive(error) {
    const box = $('live');
    box.className = 'live' + (error ? ' offline' : admin.live ? '' : ' paused');
    $('live-text').textContent = error
      ? 'Connexion perdue, nouvel essai…'
      : admin.live
        ? 'En direct · mis à jour à ' + new Date(admin.ok || Date.now()).toLocaleTimeString('fr-FR')
        : 'En pause';
  }

  async function loadAdmin() {
    const [s, m, users, auditRows] = await Promise.all([
      api('/admin/stats'), api('/admin/metrics?range=' + admin.range), api('/admin/users'), api('/admin/audit'),
    ]);
    renderKpis(s, m);
    renderSupply(s);
    renderCharts(m);
    renderKinds(m);
    renderHolders(m.holders);
    renderActivity(m.activity);
    renderUsers(users);
    renderAudit(auditRows);
    admin.animate = false;
  }

  const sum = (arr, key) => arr.reduce((t, x) => t + x[key], 0);

  function renderKpis(s, m) {
    const newUsers = sum(m.series, 'signups');
    const newTx = sum(m.series, 'tx');
    const ethLow = Number(s.ownerEth) < 0.01;
    const cards = [
      ['Offre en circulation', fmt(s.totalSupply), 'AXN', `${((Number(s.totalSupply) / Number(s.cap)) * 100).toFixed(2).replace('.', ',')} % du plafond`],
      ['Réserve du propriétaire', fmt(s.ownerAxn), 'AXN', 'Source des distributions'],
      ['Utilisateurs', String(s.users), '', newUsers ? `+${newUsers} sur la période` : 'Aucun nouveau'],
      ['Transactions', String(s.transactions), '', newTx ? `+${newTx} sur la période` : 'Aucune sur la période'],
      ['Volume transféré', fmt(m.summary.transferVolume), 'AXN', m.summary.transferCount ? `Moyenne ${fmt(m.summary.average)} AXN` : 'Aucun transfert'],
      ['ETH pour les frais', Number(s.ownerEth).toFixed(4), 'ETH', ethLow ? 'Solde bas : à recharger' : 'Suffisant'],
    ];
    $('kpis').replaceChildren(...cards.map(([k, v, unit, d], i) => el('dl', { class: 'kpi' + (i === 5 && ethLow ? ' warn' : '') },
      el('dt', { text: k }),
      el('dd', {}, v, unit ? el('small', { text: unit }) : null),
      el('span', { class: 'delta', text: d })
    )));
  }

  function renderSupply(s) {
    const pct = (Number(s.totalSupply) / Number(s.cap)) * 100;
    $('supply-text').textContent = `${fmt(s.totalSupply)} sur ${fmt(s.cap)} AXN (${pct.toFixed(2).replace('.', ',')} %)`;
    $('supply-fill').style.width = Math.max(pct, 0.8) + '%';
  }

  // --- Petits graphiques SVG maison (aucune dépendance externe) ---

  const W = 640, H = 220, ML = 36, MR = 8, MT = 10, MB = 24;

  function niceMax(v) {
    if (v <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
    return 10 * p;
  }

  function svgEl(name, attrs = {}) {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  }

  function labelFor(t, range) {
    const d = new Date(t);
    return range === '24h'
      ? d.getHours() + ' h'
      : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  }
  function fullLabel(t, range, size) {
    const d = new Date(t);
    return range === '24h'
      ? d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' → ' + new Date(t + size).getHours() + ' h'
      : d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'long' });
  }

  function showTip(event, html) {
    const tip = $('chart-tip');
    tip.innerHTML = html;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = Math.min(event.clientX + 14, innerWidth - w - 8) + 'px';
    tip.style.top = Math.max(8, event.clientY - 46) + 'px';
  }
  const hideTip = () => { $('chart-tip').hidden = true; };

  function frame(svg, max, series, range, yFmt) {
    for (let i = 0; i <= 4; i++) {
      const y = MT + ((H - MT - MB) * i) / 4;
      svg.append(svgEl('line', { x1: ML, x2: W - MR, y1: y, y2: y, class: 'ch-grid' }));
      const label = svgEl('text', { x: ML - 6, y: y + 4, class: 'ch-axis', 'text-anchor': 'end' });
      label.textContent = yFmt(max * (1 - i / 4));
      svg.append(label);
    }
    const every = Math.ceil(series.length / 8);
    const step = (W - ML - MR) / series.length;
    series.forEach((p, i) => {
      if (i % every) return;
      const label = svgEl('text', { x: ML + step * (i + 0.5), y: H - 6, class: 'ch-axis', 'text-anchor': 'middle' });
      label.textContent = labelFor(p.t, range);
      svg.append(label);
    });
  }

  const short = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0).replace('.', ',') + ' k' : String(Math.round(v * 10) / 10).replace('.', ','));

  function barChart(box, series, key, m, unit) {
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const max = niceMax(Math.max(...series.map((p) => p[key])));
    frame(svg, max, series, m.range, short);
    const step = (W - ML - MR) / series.length;
    const bw = Math.max(3, step * 0.62);
    series.forEach((p, i) => {
      const h = ((H - MT - MB) * p[key]) / max;
      const x = ML + step * i + (step - bw) / 2;
      const g = svgEl('g', { class: 'ch-col' });
      const bar = svgEl('rect', { x, y: H - MB - Math.max(h, 2), width: bw, height: Math.max(h, 2), rx: 2, class: 'ch-bar' + (p[key] ? '' : ' zero') });
      if (admin.animate && !reduced) {
        bar.style.transformOrigin = `0 ${H - MB}px`;
        bar.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 600, delay: i * 18, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
      }
      const hit = svgEl('rect', { x: ML + step * i, y: MT, width: step, height: H - MT - MB, class: 'ch-hit' });
      const tip = `<b>${fmt(p[key])} ${unit}</b><br>${fullLabel(p.t, m.range, m.bucketMs)}`;
      hit.addEventListener('pointermove', (e) => showTip(e, tip));
      hit.addEventListener('pointerleave', hideTip);
      g.append(bar, hit);
      svg.append(g);
    });
    box.replaceChildren(svg);
  }

  function areaChart(box, series, key, m, unit) {
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    const max = niceMax(Math.max(...series.map((p) => p[key])));
    frame(svg, max, series, m.range, short);
    const step = (W - ML - MR) / series.length;
    const pts = series.map((p, i) => [ML + step * (i + 0.5), H - MB - ((H - MT - MB) * p[key]) / max]);
    const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('');
    svg.append(svgEl('path', { d: `${line}L${pts[pts.length - 1][0]} ${H - MB}L${pts[0][0]} ${H - MB}Z`, class: 'ch-area' }));
    svg.append(svgEl('path', { d: line, class: 'ch-line' + (admin.animate && !reduced ? ' ch-draw' : ''), pathLength: 1 }));
    const dot = svgEl('circle', { r: 5, class: 'ch-dot', visibility: 'hidden' });
    svg.append(dot);
    series.forEach((p, i) => {
      const hit = svgEl('rect', { x: ML + step * i, y: MT, width: step, height: H - MT - MB, class: 'ch-hit' });
      const tip = `<b>${fmt(p[key])} ${unit}</b><br>${fullLabel(p.t, m.range, m.bucketMs)}`;
      hit.addEventListener('pointermove', (e) => {
        dot.setAttribute('cx', pts[i][0]); dot.setAttribute('cy', pts[i][1]); dot.setAttribute('visibility', 'visible');
        showTip(e, tip);
      });
      hit.addEventListener('pointerleave', () => { dot.setAttribute('visibility', 'hidden'); hideTip(); });
      svg.append(hit);
    });
    box.replaceChildren(svg);
  }

  function renderCharts(m) {
    const total = sum(m.series, 'tx');
    $('tx-sub').textContent = `${total} sur ${RANGE_LABEL[m.range]}`;
    $('vol-sub').textContent = m.summary.transferCount
      ? `${fmt(m.summary.transferVolume)} AXN · plus gros transfert : ${fmt(m.summary.largest)}`
      : 'Aucun transfert sur la période';
    barChart($('chart-tx'), m.series, 'tx', m, 'tx');
    areaChart($('chart-vol'), m.series, 'volume', m, 'AXN');
  }

  function renderKinds(m) {
    const entries = Object.entries(KIND).map(([k, meta]) => ({ k, ...meta, count: (m.kinds[k] && m.kinds[k].count) || 0 }));
    const total = entries.reduce((t, e) => t + e.count, 0);
    const R = 40, C = 2 * Math.PI * R;
    const svg = svgEl('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Répartition des transactions par type' });
    svg.append(svgEl('circle', { cx: 50, cy: 50, r: R, fill: 'none', stroke: 'var(--line)', 'stroke-width': 14 }));
    let offset = 0;
    for (const e of entries) {
      if (!e.count) continue;
      const len = (e.count / total) * C;
      const arc = svgEl('circle', {
        cx: 50, cy: 50, r: R, fill: 'none', stroke: e.color, 'stroke-width': 14,
        'stroke-dasharray': `${Math.max(len - 1.5, 0.5)} ${C}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 50 50)',
      });
      arc.addEventListener('pointermove', (ev) => showTip(ev, `<b>${e.label}</b><br>${e.count} (${Math.round((e.count / total) * 100)} %)`));
      arc.addEventListener('pointerleave', hideTip);
      svg.append(arc);
      offset += len;
    }
    const center = svgEl('text', { x: 50, y: 54, 'text-anchor': 'middle', class: 'ch-axis', style: 'font-size:16px;font-weight:600;fill:var(--ink)' });
    center.textContent = String(total);
    svg.append(center);
    const legend = el('ul', {}, ...entries.map((e) => el('li', {},
      el('span', { class: 'sw', style: 'background:' + e.color }), e.label, el('b', { text: String(e.count) }))));
    $('chart-kinds').replaceChildren(svg, legend);
  }

  function renderHolders(rows) {
    const box = $('holders');
    if (!rows.length) { box.replaceChildren(el('li', { class: 'sub', text: 'Aucun solde pour l’instant.' })); return; }
    const max = rows[0].axn;
    box.replaceChildren(...rows.map((r) => el('li', {},
      el('div', { class: 'row2' }, el('span', { text: r.username }), el('b', { text: fmt(r.axn) + ' AXN' })),
      el('div', { class: 'hb' }, el('span', { style: `width:${Math.max(3, (r.axn / max) * 100)}%` }))
    )));
  }

  function renderActivity(items) {
    const box = $('activity');
    if (!items.length) { box.replaceChildren(el('li', {}, el('span', { class: 'muted-empty', text: 'Rien pour l’instant.' }))); return; }
    box.replaceChildren(...items.map((a) => {
      let title;
      let ic = 'plus';
      if (a.type === 'signup') title = 'Nouveau compte : ' + a.username;
      else if (a.type === 'faucet') { title = 'Distribution à ' + (a.to || '—'); ic = 'drop'; }
      else if (a.type === 'mint') { title = 'Création pour ' + (a.to || '—'); }
      else { title = (a.from || 'Axiomon') + ' → ' + (a.to || 'adresse externe'); ic = 'up'; }
      const status = a.status === 'pending' ? ' · en attente' : a.status === 'failed' ? ' · échouée' : '';
      return el('li', {},
        el('span', { class: 'ai' }, icon(ic)),
        el('div', {}, el('span', { text: title }), el('small', { text: relTime(a.at) + status })),
        a.amount ? el('span', { class: 'amt', text: fmt(a.amount) }) : null
      );
    }));
  }

  function renderUsers(users) {
    $('users-body').replaceChildren(...users.map((u) => {
      let action = el('span', { class: 'hint', text: '–' });
      if (u.role !== 'admin') {
        action = el('button', { type: 'button', class: 'secondary small', text: u.frozen ? 'Dégeler' : 'Geler' });
        action.addEventListener('click', async () => {
          action.classList.add('busy');
          try {
            await api('/admin/freeze', { method: 'POST', body: JSON.stringify({ username: u.username, frozen: !u.frozen }) });
            toast(u.frozen ? `${u.username} dégelé.` : `${u.username} gelé.`);
            await loadAdmin();
          } catch (e) {
            toast(e.message, 'error');
            action.classList.remove('busy');
          }
        });
      }
      return el('tr', {},
        el('td', { text: u.username }),
        el('td', { class: 'mono', text: u.address }),
        el('td', { text: u.role === 'admin' ? 'Administrateur' : 'Utilisateur' }),
        el('td', { text: new Date(u.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) }),
        el('td', {}, el('span', { class: 'pill ' + (u.frozen ? 'frozen' : 'active'), text: u.frozen ? 'Gelé' : 'Actif' })),
        el('td', {}, action)
      );
    }));
  }

  function renderAudit(rows) {
    if (!rows.length) {
      $('audit-body').replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'hint', text: 'Aucune action enregistrée pour l’instant.' })));
      return;
    }
    $('audit-body').replaceChildren(...rows.map((r) => el('tr', {},
      el('td', { text: new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) }),
      el('td', { text: r.actor }),
      el('td', { text: r.action }),
      el('td', { text: r.detail || '' })
    )));
  }

  function bindAdmin() {
    for (const button of $('range-seg').querySelectorAll('button')) {
      button.addEventListener('click', () => {
        admin.range = button.dataset.range;
        for (const other of $('range-seg').querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
        startAdmin();
      });
    }
    $('live-toggle').addEventListener('click', () => {
      admin.live = !admin.live;
      $('live-toggle').setAttribute('aria-pressed', String(!admin.live));
      $('live-toggle').textContent = admin.live ? 'Pause' : 'Reprendre';
      setLive();
      if (admin.live) startAdmin();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'admin' && admin.live) startAdmin(); });

    for (const button of $('nav').querySelectorAll('button')) {
      button.addEventListener('click', () => setView(button.dataset.view));
    }
    const adminForm = (formId, path, success) => {
      $(formId).addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const button = form.querySelector('button[type=submit]');
        button.classList.add('busy');
        setMsg('admin-msg', '');
        try {
          const body = Object.fromEntries(new FormData(form).entries());
          if (body.amount) body.amount = body.amount.replace(',', '.');
          await api(path, { method: 'POST', body: JSON.stringify(body) });
          form.reset();
          toast(success);
          await refresh();
          if (state.view === 'admin') startAdmin();
        } catch (e) {
          setMsg('admin-msg', e.message, 'error');
          toast(e.message, 'error');
        } finally {
          button.classList.remove('busy');
        }
      });
    };
    adminForm('mint-form', '/admin/mint', 'AXN créés. La transaction est en cours de confirmation.');
    adminForm('daily-form', '/admin/daily-limit', 'Limite journalière enregistrée.');
    adminForm('limit-form', '/admin/limit', 'Limite envoyée. Elle sera active dès la confirmation.');
  }

  // ---------- Connexion et inscription ----------

  function strengthOf(password) {
    if (password.length < 8) return 0;
    let level = 1;
    if (password.length >= 12) level++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password)) level++;
    if (/[^A-Za-z0-9]/.test(password)) level++;
    return level;
  }

  function bindAuth() {
    const show = (login) => {
      $('login-form').hidden = !login;
      $('register-form').hidden = login;
      $('tab-login').setAttribute('aria-selected', String(login));
      $('tab-register').setAttribute('aria-selected', String(!login));
      setMsg('auth-msg', '');
    };
    $('tab-login').addEventListener('click', () => show(true));
    $('tab-register').addEventListener('click', () => show(false));

    for (const toggle of document.querySelectorAll('.pw-toggle')) {
      toggle.addEventListener('click', () => {
        const input = toggle.parentElement.querySelector('input');
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        toggle.replaceChildren(icon(reveal ? 'eye-off' : 'eye'));
        toggle.setAttribute('aria-label', reveal ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      });
    }

    const labels = ['8 caractères minimum', 'Faible', 'Moyen', 'Bon', 'Très bon'];
    $('reg-password').addEventListener('input', (e) => {
      const level = strengthOf(e.target.value);
      document.querySelector('.strength').dataset.level = String(level);
      $('strength-text').textContent = labels[level];
    });

    const submit = (formId, path) => {
      $(formId).addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.target;
        const button = form.querySelector('button[type=submit]');
        button.classList.add('busy');
        setMsg('auth-msg', '');
        try {
          saveSession(await api(path, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) }));
          form.reset();
          await showApp();
        } catch (e) {
          setMsg('auth-msg', e.message, 'error');
        } finally {
          button.classList.remove('busy');
        }
      });
    };
    submit('login-form', '/login');
    submit('register-form', '/register');
    $('logout').addEventListener('click', logout);
  }

  // ---------- Démarrage ----------

  async function init() {
    paintThemeButton();
    guilloche($('guilloche-auth'));
    guilloche($('guilloche-note'));
    bindTilt();
    bindAuth();
    bindSend();
    bindRecipientSearch();
    bindReceive();
    bindFilters();
    bindAdmin();

    try {
      state.config = await api('/config');
    } catch (e) {
      showAuth();
      setMsg('auth-msg', 'Le serveur ne répond pas : ' + e.message, 'error');
      return;
    }
    if (state.token) {
      try {
        state.user = await api('/me');
        await showApp();
        return;
      } catch { /* session invalide : retour à la connexion */ }
    }
    showAuth();
  }

  init();
})();
