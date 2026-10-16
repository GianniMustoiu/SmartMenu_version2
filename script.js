// =====================================================
// MenuPro – Versione collegata a Supabase
// =====================================================

const cfg = window.MENUPRO_CONFIG || {};
let sb = null;

function ensureSb() {
  if (sb) return sb;
  try {
    const c = window.MENUPRO_CONFIG || cfg || {};
    if (window.supabase && c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
        !String(c.SUPABASE_ANON_KEY).includes('INCOLLA')) {
      sb = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
      window.sb = sb;
    }
  } catch (e) {
    console.error('Errore init Supabase:', e);
  }
  return sb;
}

try {
  ensureSb();
} catch (e) {
  console.error('Errore init Supabase:', e);
}
window.sb = sb;
if (!sb) console.warn('ATTENZIONE: sb è null — controlla config.js');

let currentUser = null;
let currentRistorante = null;
let cart = [];
let currentPeriod = 'oggi';
let currentSala = 0;
let menuFilterCat = 'tutti';
let lastOrdineId = null;
let sessionOrders = []; // { id, codice } ordini del tavolo in questa sessione

let chartRicaviAdmin = null;
let chartPianiAdmin = null;
let chartIncassiRist = null;
let chartStatiRist = null;

const PIANI = {
  base: { nome: 'Base', prezzo: 29 },
  pro: { nome: 'Pro', prezzo: 59 },
  enterprise: { nome: 'Enterprise', prezzo: 129 }
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2800);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatPrice(n) {
  return '€' + Number(n).toFixed(2).replace('.', ',');
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// =====================================================
// SUPABASE HELPERS
// =====================================================

async function loadRistoranti() {
  if (!sb) return [];
  const { data, error } = await sb.from('ristoranti').select('*').order('creato', { ascending: false });
  if (error) { console.error(error); toast('Errore caricamento ristoranti'); return []; }
  return data || [];
}

async function loadRistoranteFull(id, opts) {
  opts = opts || {};
  const lite = !!opts.lite; // cliente QR: niente ordini/pagamenti
  if (!sb) ensureSb();
  if (!sb) return null;
  const idClean = String(id || '').trim();
  if (!idClean) return null;
  const { data: r, error } = await sb.from('ristoranti').select('*').eq('id', idClean).maybeSingle();
  if (error) { console.error('loadRistoranteFull', idClean, error); return null; }
  if (!r) return null;

  const ordiniQ = lite
    ? Promise.resolve({ data: [] })
    : sb.from('ordini').select('*').eq('id_ristorante', id)
        .order('created_at', { ascending: false })
        .limit(120);
  const pagQ = lite
    ? Promise.resolve({ data: [] })
    : sb.from('pagamenti_abbonamento').select('*').eq('id_ristorante', id).order('data', { ascending: false }).limit(50);

  const [tavoli, piatti, categorie, ordini, pagamenti] = await Promise.all([
    sb.from('tavoli').select('*').eq('id_ristorante', id).order('numero'),
    sb.from('piatti').select('*').eq('id_ristorante', id).order('nome'),
    sb.from('categorie').select('*').eq('id_ristorante', id).order('posizione'),
    ordiniQ,
    pagQ
  ]);

  r.tavoli = tavoli.data || [];
  r.menu = (piatti.data || []).map(p => ({
    ...p,
    allergeni: p.allergeni || []
  }));
  r.categorie = (categorie.data || []).map(c => c.nome);
  if (!r.categorie.length) r.categorie = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
  r.ordini = (ordini.data || []).map(o => ({
    ...o,
    items: o.items || [],
    createdAt: o.created_at
  }));
  // solo per ordini attivi senza items (max 40) – evita query enormi
  const needRows = r.ordini.filter(o => !(o.items && o.items.length) && o.stato !== 'chiuso' && o.stato !== 'consegnato').slice(0, 40);
  if (needRows.length && sb) {
    try {
      const ids = needRows.map(o => o.id);
      const { data: righe } = await sb.from('ordine_riga').select('*').in('id_ordine', ids);
      if (righe && righe.length) {
        const byOrd = {};
        righe.forEach(row => {
          (byOrd[row.id_ordine] = byOrd[row.id_ordine] || []).push({
            nome: row.piatto || row.nome || 'Piatto',
            qty: row.qty_piatti || row.qty || 1,
            prezzo: Number(row.prezzo_pagato) || 0
          });
        });
        r.ordini.forEach(o => {
          if (!(o.items && o.items.length) && byOrd[o.id]) o.items = byOrd[o.id];
        });
      }
    } catch (e) { console.warn('ordine_riga load', e); }
  }
  r.pagamenti = pagamenti.data || [];
  r.sale = r.sale || ['Sala principale'];
  return r;
}

async function getRistorante(id) {
  return loadRistoranteFull(id);
}

// =====================================================
// LOGIN
// =====================================================

async function enterAsAdmin(email) {
  currentUser = { role: 'admin', email: email || 'admin@menupro.it' };
  $('#login-screen').classList.add('hidden');
  $('#app-admin').classList.remove('hidden');
  $('#admin-user-email').textContent = currentUser.email;
  try {
    await renderAdminDashboard();
    await renderAdminTable();
    await renderAbbonamenti();
    await renderMieiIncassi();
    await populateIncassiSelect();
  } catch (e) {
    console.error('Errore render admin:', e);
  }
  return true;
}

async function enterAsRistoratore(r) {
  currentRistorante = await loadRistoranteFull(r.id || r.ristoranteId);
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: r.id || r.ristoranteId };
  $('#login-screen').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = (currentRistorante && currentRistorante.nome) || r.nome || 'Ristorante';
  $('#rist-user-email').textContent = r.email;
  // dati già caricati: non ricaricare 4 volte
  await renderRistDashboard(false);
  await renderMenuTable('', false);
  await renderOrdiniKanban(false);
  await renderTavoli(false);
  return true;
}

async function doLogin(email, pass) {
  email = (email || '').trim().toLowerCase();
  pass = (pass || '').trim();

  if (!pass) {
    toast('Inserisci la password');
    return false;
  }

  // ========== 1) API server-side /api/utenti ==========
  try {
    const resp = await fetch('/api/utenti', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', email, password: pass })
    });
    const json = await resp.json().catch(() => null);
    if (json && json.ok && json.user) {
      if (json.user.ruolo === 'admin') {
        return await enterAsAdmin(json.user.email);
      }
      if (json.user.ruolo === 'ristoratore') {
        // se l'API non manda ristoranteId, cercalo per email
        if (!json.user.ristoranteId && !json.user.id && sb) {
          const { data: r } = await sb.from('ristoranti').select('*').eq('email', json.user.email).maybeSingle();
          if (r) return await enterAsRistoratore(r);
        }
        return await enterAsRistoratore(json.user);
      }
    }
  } catch (e) {
    console.warn('API /api/utenti non disponibile, uso fallback client:', e.message);
  }

  // ========== 2) Solo account reali (niente login admin con sola password "admin") ==========
  if (!email) {
    toast('Inserisci email e password');
    return false;
  }

  if (!sb) {
    toast('Configura config.js (ANON_KEY) oppure le env su Vercel');
    return false;
  }

  try {
    // prima cerca in utenti (ristoratore)
    const { data: u } = await sb
      .from('utenti')
      .select('*')
      .eq('email', email)
      .eq('password_hash', pass)
      .maybeSingle();

    if (u && u.ruolo === 'admin') {
      return await enterAsAdmin(u.email);
    }

    if (u && u.ruolo === 'ristoratore') {
      const { data: r } = await sb.from('ristoranti').select('*').eq('email', email).maybeSingle();
      if (r) return await enterAsRistoratore(r);
      toast('Utente trovato ma nessun ristorante collegato a questa email');
      return false;
    }

    // poi cerca direttamente in ristoranti (compatibilità)
    const { data: r, error } = await sb
      .from('ristoranti')
      .select('*')
      .eq('email', email)
      .eq('password', pass)
      .maybeSingle();

    if (error) {
      console.error(error);
      toast('Errore database: ' + (error.message || 'controlla config.js'));
      return false;
    }
    if (r) return await enterAsRistoratore(r);
  } catch (e) {
    console.error(e);
    toast('Errore di connessione');
    return false;
  }

  toast('Credenziali non valide');
  return false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await doLogin($('#login-email').value, $('#login-password').value);
});

// =====================================================
// LOGOUT
// =====================================================
$$('.logout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (typeof stopOrdineStatusPolling === 'function') stopOrdineStatusPolling();
    if (typeof stopOrdiniPolling === 'function') stopOrdiniPolling();
    try { localStorage.removeItem('mp_session'); } catch (_) {}
    document.body.classList.remove('cliente-night');
    currentUser = null;
    currentRistorante = null;
    cart = [];
    lastOrdineId = null;
    sessionOrders = [];
    $('#app-admin').classList.add('hidden');
    $('#app-ristoratore').classList.add('hidden');
    $('#app-cliente').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    $('#login-form').reset();
  });
});

// =====================================================
// THEME
// =====================================================
$$('.theme-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    // default = blu notte; light = tema chiaro
    html.setAttribute('data-theme', isLight ? '' : 'light');
    $$('.theme-toggle i').forEach(i => { i.className = isLight ? 'fas fa-sun' : 'fas fa-moon'; });
  });
});

// =====================================================
// NAV ADMIN
// =====================================================
$$('#app-admin .nav-item').forEach(item => {
  item.addEventListener('click', async (e) => {
    e.preventDefault();
    $$('#app-admin .nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    $$('#app-admin .page').forEach(p => p.classList.add('hidden'));
    $(`#page-${page}`).classList.remove('hidden');
    const titles = {
      dashboard: 'Panoramica', ristoranti: 'Ristoranti', abbonamenti: 'Abbonamenti',
      'miei-incassi': 'I miei incassi', 'incassi-rist': 'Incassi ristoranti', impostazioni: 'Impostazioni'
    };
    $('#admin-page-title').textContent = titles[page] || page;
    if (page === 'dashboard') await renderAdminDashboard();
    if (page === 'ristoranti') await renderAdminTable();
    if (page === 'abbonamenti') await renderAbbonamenti();
    if (page === 'miei-incassi') await renderMieiIncassi();
    if (page === 'incassi-rist') await populateIncassiSelect();
  });
});

// =====================================================
// NAV RISTORATORE
// =====================================================
$$('#app-ristoratore .nav-item').forEach(item => {
  item.addEventListener('click', async (e) => {
    e.preventDefault();
    $$('#app-ristoratore .nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    $$('#app-ristoratore .page').forEach(p => p.classList.add('hidden'));
    $(`#page-${page}`).classList.remove('hidden');
    const titles = {
      'rist-dashboard': 'Panoramica', 'rist-menu': 'Gestione Menu',
      'rist-ordini': 'Ordini', 'rist-tavoli': 'Tavoli & QR'
    };
    $('#rist-page-title').textContent = titles[page] || page;
    if (page === 'rist-dashboard') await renderRistDashboard();
    if (page === 'rist-menu') await renderMenuTable();
    if (page === 'rist-ordini') await renderOrdiniKanban();
    if (page === 'rist-tavoli') await renderTavoli();
  });
});

// =====================================================
// CLOSE MODALS
// =====================================================
$$('.close-modal').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modal;
    if (id) $(`#${id}`).classList.add('hidden');
  });
});

// =====================================================
// TOGGLE PASSWORD
// =====================================================
$('#toggle-pass')?.addEventListener('click', () => {
  const inp = $('#password');
  const icon = $('#toggle-pass i');
  if (inp.type === 'password') {
    inp.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    inp.type = 'password';
    icon.className = 'fas fa-eye';
  }
});

// =====================================================
// ADMIN – DASHBOARD
// =====================================================
async function renderAdminDashboard() {
  const ristoranti = await loadRistoranti();
  const attivi = ristoranti.filter(r => !r.scadenza || new Date(r.scadenza) >= new Date()).length;
  let ricavi = 0;
  ristoranti.forEach(r => {
    const p = PIANI[r.id_piano];
    if (p && (!r.scadenza || new Date(r.scadenza) >= new Date())) ricavi += p.prezzo;
  });
  $('#stat-ristoranti').textContent = ristoranti.length;
  $('#stat-attivi').textContent = attivi;
  $('#stat-ricavi').textContent = formatPrice(ricavi);

  const recent = ristoranti.slice(0, 5);
  const list = $('#recent-list');
  if (!recent.length) {
    list.innerHTML = '<p style="color:var(--muted)">Nessun ristorante ancora creato.</p>';
  } else {
    list.innerHTML = recent.map(r => `
      <div class="recent-item">
        <span><strong>${r.nome}</strong> · ${r.citta || '—'}</span>
        <span class="badge badge-${r.id_piano}">${r.id_piano}</span>
      </div>
    `).join('');
  }
  renderAdminCharts(ristoranti);
}

function renderAdminCharts(ristoranti) {
  if (typeof Chart === 'undefined') return;
  const mesi = [], vals = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    mesi.push(d.toLocaleDateString('it-IT', { month: 'short' }));
    let v = 0;
    // semplificato: mostra solo ricavi del mese corrente se non ci sono pagamenti
    if (i === 0) {
      ristoranti.forEach(r => {
        const plan = PIANI[r.id_piano];
        if (plan && (!r.scadenza || new Date(r.scadenza) >= new Date())) v += plan.prezzo;
      });
    }
    vals.push(v);
  }
  const ctx1 = document.getElementById('chart-ricavi-admin');
  if (ctx1) {
    if (chartRicaviAdmin) chartRicaviAdmin.destroy();
    chartRicaviAdmin = new Chart(ctx1, {
      type: 'bar',
      data: { labels: mesi, datasets: [{ label: '€', data: vals, backgroundColor: 'rgba(59, 130, 246, 0.75)', borderRadius: 6, borderSkipped: false }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: v => '€' + v } }, x: { grid: { display: false } } } }
    });
  }
  const counts = { base: 0, pro: 0, enterprise: 0 };
  ristoranti.forEach(r => { if (counts[r.id_piano] !== undefined) counts[r.id_piano]++; });
  const ctx2 = document.getElementById('chart-piani-admin');
  if (ctx2) {
    if (chartPianiAdmin) chartPianiAdmin.destroy();
    chartPianiAdmin = new Chart(ctx2, {
      type: 'doughnut',
      data: { labels: ['Base', 'Pro', 'Enterprise'], datasets: [{ data: [counts.base, counts.pro, counts.enterprise], backgroundColor: ['#64748b', '#3b82f6', '#818cf8'], borderWidth: 0 }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } } }
    });
  }
}

// =====================================================
// ADMIN – TABELLA RISTORANTI
// =====================================================
async function renderAdminTable(filter = '') {
  let data = await loadRistoranti();
  if (filter) {
    const q = filter.toLowerCase();
    data = data.filter(r =>
      r.nome.toLowerCase().includes(q) ||
      (r.titolare || '').toLowerCase().includes(q) ||
      (r.citta || '').toLowerCase().includes(q)
    );
  }
  const body = $('#ristoranti-body');
  if (!data.length) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px">Nessun ristorante trovato</td></tr>`;
    return;
  }
  body.innerHTML = data.map(r => `
    <tr>
      <td><strong>${r.nome}</strong></td>
      <td>${r.titolare || '—'}</td>
      <td>${r.citta || '—'}</td>
      <td>${(r.sale || []).length}</td>
      <td><span class="badge badge-${r.id_piano}">${r.id_piano}</span></td>
      <td>${r.scadenza || '—'}</td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="editRistorante('${r.id}')" title="Modifica"><i class="fas fa-edit"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="apriResetPassword('${r.id}')" title="Nuova password"><i class="fas fa-key"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="adminApriMenu('${r.id}')" title="Gestisci menu"><i class="fas fa-book-open"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteRistorante('${r.id}')" title="Elimina"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

$('#search-ristoranti')?.addEventListener('input', e => renderAdminTable(e.target.value));

// Nuovo / Modifica ristorante
$('#btn-nuovo')?.addEventListener('click', () => {
  $('#modal-title').textContent = 'Nuovo ristorante';
  $('#form-ristorante').reset();
  $('#edit-id').value = '';
  $('#password').required = true;
  $('#password').type = 'password';
  $('#toggle-pass i').className = 'fas fa-eye';
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  $('#scadenza').value = d.toISOString().slice(0, 10);
  $('#sale').value = 'Sala principale';
  $('#n_tavoli').value = 8;
  $('#modal-ristorante').classList.remove('hidden');
});

async function createDefaultTavoli(ristoranteId, n) {
  const count = Math.max(1, parseInt(n) || 8);
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      id_ristorante: ristoranteId,
      numero: i,
      adulti: 4,
      bambini: 0,
      sala: 0,
      occupato: false,
      forma: 'round'
    });
  }
  if (rows.length) await sb.from('tavoli').insert(rows);
}

async function createDefaultCategorie(ristoranteId) {
  const cats = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
  await sb.from('categorie').insert(cats.map((nome, i) => ({
    id_ristorante: ristoranteId,
    nome,
    posizione: i
  })));
}

async function createDefaultMenu(ristoranteId) {
  const piatti = [
    { nome: 'Bruschetta al pomodoro', descrizione: 'Pane tostato, pomodoro fresco, basilico', prezzo: 5.50, categoria: 'Antipasti', allergeni: ['glutine'] },
    { nome: 'Spaghetti carbonara', descrizione: 'Guanciale, pecorino, uovo', prezzo: 12.00, categoria: 'Primi', allergeni: ['glutine', 'uova', 'latticini'] },
    { nome: 'Bistecca alla fiorentina', descrizione: 'Manzo, rosmarino, olio EVO', prezzo: 28.00, categoria: 'Secondi', allergeni: [] },
    { nome: 'Tiramisù', descrizione: 'Mascarpone, caffè, cacao', prezzo: 6.50, categoria: 'Dolci', allergeni: ['latticini', 'uova', 'glutine'] },
    { nome: 'Acqua naturale 75cl', descrizione: '', prezzo: 2.50, categoria: 'Bevande', allergeni: [] },
    { nome: 'Vino della casa (calice)', descrizione: '', prezzo: 4.00, categoria: 'Bevande', allergeni: [] }
  ];
  await sb.from('piatti').insert(piatti.map(p => ({
    ...p,
    id_ristorante: ristoranteId,
    disponibile: true
  })));
}

$('#form-ristorante')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) {
    toast('Database non collegato: controlla config.js (ANON_KEY)');
    return;
  }

  const id = $('#edit-id').value;
  const saleStr = $('#sale').value.trim() || 'Sala principale';
  const sale = saleStr.split(',').map(s => s.trim()).filter(Boolean);
  const nTavoli = parseInt($('#n_tavoli').value) || 8;

  const email = $('#email').value.trim().toLowerCase();
  const password = $('#password').value;
  const nomeRist = $('#nome').value.trim();
  const titolare = $('#titolare').value.trim();

  if (!email) {
    toast('Email ristoratore obbligatoria');
    return;
  }

  const data = {
    nome: nomeRist,
    titolare,
    citta: $('#citta').value.trim(),
    email,
    password: password || undefined,
    id_piano: $('#id_piano').value,
    scadenza: $('#scadenza').value || null,
    sale
  };

  if (id) {
    // --- MODIFICA ristorante ---
    if (!data.password) delete data.password;
    const { error } = await sb.from('ristoranti').update(data).eq('id', id);
    if (error) {
      toast('Errore aggiornamento ristorante: ' + error.message);
      console.error(error);
      return;
    }

    // aggiorna/crea anche l'UTENTE ristoratore
    const utenteUpdate = { nome: titolare || nomeRist, ruolo: 'ristoratore' };
    if (password) utenteUpdate.password_hash = password;

    const { data: existingUser } = await sb.from('utenti').select('id').eq('email', email).maybeSingle();
    if (existingUser) {
      const { error: errU } = await sb.from('utenti').update(utenteUpdate).eq('id', existingUser.id);
      if (errU) console.error('Errore update utente:', errU);
    } else if (password) {
      const { error: errU } = await sb.from('utenti').insert({
        email,
        password_hash: password,
        ruolo: 'ristoratore',
        nome: titolare || nomeRist
      });
      if (errU) console.error('Errore create utente:', errU);
    }
    toast('Ristorante e utente aggiornati');
  } else {
    // --- NUOVO ristorante + UTENTE ---
    if (!password) {
      toast('Password obbligatoria per il ristoratore');
      return;
    }

    const { data: inserted, error } = await sb.from('ristoranti').insert({
      ...data,
      password
    }).select().single();

    if (error) {
      toast('Errore creazione ristorante: ' + error.message);
      console.error(error);
      return;
    }

    // crea l'UTENTE ristoratore (email + password + nome)
    const { error: errUser } = await sb.from('utenti').insert({
      email,
      password_hash: password,
      ruolo: 'ristoratore',
      nome: titolare || nomeRist
    });

    if (errUser) {
      console.error('Errore creazione utente:', errUser);
      toast('Ristorante creato, ma utente non salvato: ' + errUser.message);
    } else {
      toast('Ristorante e utente ristoratore creati');
    }

    await createDefaultTavoli(inserted.id, nTavoli);
    await createDefaultCategorie(inserted.id);
    await createDefaultMenu(inserted.id);
  }

  $('#modal-ristorante').classList.add('hidden');
  await renderAdminTable($('#search-ristoranti')?.value || '');
  await renderAdminDashboard();
  await renderAbbonamenti();
});

window.editRistorante = async function(id) {
  const { data: r } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (!r) return;
  $('#modal-title').textContent = 'Modifica ristorante';
  $('#edit-id').value = r.id;
  $('#nome').value = r.nome;
  $('#titolare').value = r.titolare || '';
  $('#citta').value = r.citta || '';
  $('#email').value = r.email;
  $('#password').value = '';
  $('#password').type = 'password';
  $('#password').required = false;
  $('#toggle-pass i').className = 'fas fa-eye';
  $('#id_piano').value = r.id_piano;
  $('#scadenza').value = r.scadenza || '';
  $('#sale').value = (r.sale || []).join(', ');
  const { count } = await sb.from('tavoli').select('*', { count: 'exact', head: true }).eq('id_ristorante', id);
  $('#n_tavoli').value = count || 8;
  $('#modal-ristorante').classList.remove('hidden');
};

window.deleteRistorante = async function(id) {
  const { error } = await sb.from('ristoranti').delete().eq('id', id);
  if (error) { toast('Errore eliminazione'); return; }
  await renderAdminTable($('#search-ristoranti')?.value || '');
  await renderAdminDashboard();
  await renderAbbonamenti();
  toast('Ristorante eliminato');
};

window.adminApriMenu = function(id) {
  // richiede conferma password admin
  $('#admin-menu-rist-id').value = id;
  $('#admin-menu-password').value = '';
  $('#modal-admin-menu-login')?.classList.remove('hidden');
  setTimeout(() => $('#admin-menu-password')?.focus(), 100);
};

$('#form-admin-menu-login')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#admin-menu-rist-id')?.value;
  const pass = ($('#admin-menu-password')?.value || '').trim();
  if (!pass) { toast('Inserisci la password admin'); return; }
  if (!sb) { toast('Database non collegato'); return; }

  // verifica password rispetto all'admin loggato (email corrente)
  const email = (currentUser && currentUser.email) || '';
  let ok = false;
  if (email) {
    const { data: u } = await sb.from('utenti').select('id').eq('email', email).eq('password_hash', pass).eq('ruolo', 'admin').maybeSingle();
    ok = !!u;
  }
  if (!ok) {
    // prova qualsiasi admin con quella password
    const { data: u2 } = await sb.from('utenti').select('id').eq('password_hash', pass).eq('ruolo', 'admin').limit(1).maybeSingle();
    ok = !!u2;
  }
  if (!ok) {
    toast('Password non valida');
    return;
  }

  $('#modal-admin-menu-login').classList.add('hidden');
  const r = await loadRistoranteFull(id);
  if (!r) { toast('Ristorante non trovato'); return; }
  currentRistorante = r;
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: r.id, fromAdmin: true };
  $('#app-admin').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = r.nome + ' (admin)';
  $('#rist-user-email').textContent = 'Gestione menu';
  $$('#app-ristoratore .nav-item').forEach(n => n.classList.remove('active'));
  $$('#app-ristoratore .page').forEach(p => p.classList.add('hidden'));
  const menuNav = $$('#app-ristoratore .nav-item')[1];
  if (menuNav) menuNav.classList.add('active');
  $('#page-rist-menu').classList.remove('hidden');
  $('#rist-page-title').textContent = 'Gestione Menu';
  await renderMenuTable();
  toast('Accesso menu autorizzato');
});

// =====================================================
// ABBONAMENTI
// =====================================================
async function renderAbbonamenti() {
  const ristoranti = await loadRistoranti();
  const body = $('#abbonamenti-body');
  if (!ristoranti.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:30px">Nessun abbonamento</td></tr>`;
    return;
  }
  body.innerHTML = ristoranti.map(r => {
    const scad = r.scadenza ? new Date(r.scadenza) : null;
    const oggi = new Date();
    oggi.setHours(0,0,0,0);
    let statoLabel = 'Senza data';
    let statoClass = 'badge-base';
    let scadClass = '';
    let scadText = '—';
    if (scad) {
      scadText = scad.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
      if (scad < oggi) {
        statoLabel = 'Scaduto';
        scadClass = 'scadenza-late';
      } else {
        const diff = Math.ceil((scad - oggi) / (1000*60*60*24));
        if (diff <= 7) {
          statoLabel = 'In scadenza';
          scadClass = 'scadenza-warn';
        } else {
          statoLabel = 'Attivo';
          statoClass = 'badge-pro';
          scadClass = 'scadenza-ok';
        }
      }
    }
    return `
      <tr>
        <td><strong>${r.nome}</strong></td>
        <td><span class="badge badge-${r.id_piano}">${r.id_piano}</span></td>
        <td class="${scadClass}">${scadText}</td>
        <td><span class="badge ${statoClass}">${statoLabel}</span></td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="estendiAbbonamento('${r.id}')">
            <i class="fas fa-plus"></i> +1 mese
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

window.estendiAbbonamento = async function(id) {
  const { data: r } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (!r) return;
  let d = r.scadenza ? new Date(r.scadenza) : new Date();
  if (d < new Date()) d = new Date();
  d.setMonth(d.getMonth() + 1);
  const nuovaScad = d.toISOString().slice(0, 10);
  await sb.from('ristoranti').update({ scadenza: nuovaScad }).eq('id', id);
  const prezzo = PIANI[r.id_piano]?.prezzo || 0;
  await sb.from('pagamenti_abbonamento').insert({
    id_ristorante: id,
    importo: prezzo,
    piano: r.id_piano,
    tipo: 'rinnovo'
  });
  await renderAbbonamenti();
  await renderAdminDashboard();
  await renderMieiIncassi();
  toast('Rinnovato fino al ' + new Date(nuovaScad).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }) + ' (+' + formatPrice(prezzo) + ')');
};

// =====================================================
// MIEI INCASSI
// =====================================================
async function renderMieiIncassi() {
  const ristoranti = await loadRistoranti();
  let totale = 0, mese = 0, inAttesa = 0;
  const now = new Date();
  const pagamenti = [];

  for (const r of ristoranti) {
    const { data: pags } = await sb.from('pagamenti_abbonamento').select('*').eq('id_ristorante', r.id);
    (pags || []).forEach(p => {
      totale += Number(p.importo);
      const pd = new Date(p.data);
      if (pd.getMonth() === now.getMonth() && pd.getFullYear() === now.getFullYear()) mese += Number(p.importo);
      pagamenti.push({ ...p, ristorante: r.nome });
    });
    if (r.scadenza) {
      const scad = new Date(r.scadenza);
      const diff = (scad - now) / (1000 * 60 * 60 * 24);
      if (diff >= 0 && diff <= 7) inAttesa += PIANI[r.id_piano]?.prezzo || 0;
    }
  }

  $('#incassi-totale').textContent = formatPrice(totale);
  $('#incassi-mese').textContent = formatPrice(mese);
  $('#incassi-in-attesa').textContent = formatPrice(inAttesa);

  const scadenze = ristoranti
    .filter(r => r.scadenza)
    .map(r => ({ nome: r.nome, scadenza: r.scadenza, piano: r.id_piano }))
    .sort((a, b) => new Date(a.scadenza) - new Date(b.scadenza));

  pagamenti.sort((a, b) => new Date(b.data) - new Date(a.data));
  const list = $('#pagamenti-list');
  let html = '';
  if (scadenze.length) {
    html += '<h4 style="margin:0 0 10px;font-size:14px;color:var(--muted)">Prossime scadenze abbonamento</h4>';
    html += scadenze.map(s => {
      const d = new Date(s.scadenza);
      const oggi = new Date(); oggi.setHours(0,0,0,0);
      const late = d < oggi;
      const warn = !late && (d - oggi) / (1000*60*60*24) <= 7;
      const cls = late ? 'scadenza-late' : (warn ? 'scadenza-warn' : 'scadenza-ok');
      const label = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
      return `<div class="recent-item">
        <span><strong>${s.nome}</strong> · ${s.piano}</span>
        <span class="${cls}">scade il ${label}</span>
      </div>`;
    }).join('');
    html += '<h4 style="margin:18px 0 10px;font-size:14px;color:var(--muted)">Pagamenti ricevuti</h4>';
  }
  if (!pagamenti.length) {
    html += '<p style="color:var(--muted)">Nessun pagamento ricevuto ancora.</p>';
  } else {
    html += pagamenti.slice(0, 20).map(p => `
      <div class="recent-item">
        <span><strong>${p.ristorante}</strong> · ${p.tipo} (${p.piano})</span>
        <span>${formatPrice(p.importo)} · ${formatTime(p.data)}</span>
      </div>
    `).join('');
  }
  list.innerHTML = html;
}

// =====================================================
// INCASSI RISTORANTI
// =====================================================
async function populateIncassiSelect() {
  const ristoranti = await loadRistoranti();
  const sel = $('#select-rist-incassi');
  sel.innerHTML = '<option value="">— Seleziona —</option>' +
    ristoranti.map(r => `<option value="${r.id}">${r.nome}</option>`).join('');
}

$('#select-rist-incassi')?.addEventListener('change', async () => {
  const id = $('#select-rist-incassi').value;
  const cont = $('#incassi-rist-content');
  if (!id) {
    cont.innerHTML = '<p style="color:var(--muted)">Seleziona un ristorante per vedere i dettagli.</p>';
    return;
  }
  const r = await loadRistoranteFull(id);
  if (!r) return;

  const ordini = r.ordini || [];
  const totale = ordini.reduce((s, o) => s + (Number(o.totale) || 0), 0);
  const oggi = ordini.filter(o => new Date(o.createdAt).toDateString() === new Date().toDateString())
    .reduce((s, o) => s + Number(o.totale), 0);

  const counts = {};
  ordini.forEach(o => {
    (o.items || []).forEach(i => {
      counts[i.nome] = (counts[i.nome] || 0) + i.qty;
    });
  });
  let topPiatto = '—', topQty = 0;
  Object.entries(counts).forEach(([nome, qty]) => {
    if (qty > topQty) { topPiatto = nome; topQty = qty; }
  });

  cont.innerHTML = `
    <div class="cards">
      <div class="card">
        <div class="card-icon green"><i class="fas fa-euro-sign"></i></div>
        <div><h3>${formatPrice(totale)}</h3><p>Incasso totale</p></div>
      </div>
      <div class="card">
        <div class="card-icon blue"><i class="fas fa-calendar-day"></i></div>
        <div><h3>${formatPrice(oggi)}</h3><p>Incasso oggi</p></div>
      </div>
      <div class="card">
        <div class="card-icon orange"><i class="fas fa-utensils"></i></div>
        <div><h3>${topPiatto}</h3><p>Piatto più venduto (${topQty}x)</p></div>
      </div>
      <div class="card">
        <div class="card-icon purple"><i class="fas fa-receipt"></i></div>
        <div><h3>${ordini.length}</h3><p>Ordini totali</p></div>
      </div>
    </div>
    <div class="recent-box">
      <h3>Ultimi ordini di ${r.nome}</h3>
      <div class="recent-list">
        ${ordini.length === 0 ? '<p style="color:var(--muted)">Nessun ordine.</p>' :
          ordini.slice(0, 10).map(o => `
            <div class="recent-item">
              <span>Tavolo ${o.tavolo} · ${formatPrice(o.totale)}</span>
              <span class="badge-stato ${o.stato}">${labelStato(o.stato)}</span>
            </div>
          `).join('')}
      </div>
    </div>
  `;
});

// RESET
$('#btn-reset')?.addEventListener('click', async () => {
  await sb.from('pagamenti_abbonamento').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('ordini').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('piatti').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('categorie').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('tavoli').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await sb.from('ristoranti').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await renderAdminTable();
  await renderAdminDashboard();
  await renderAbbonamenti();
  await renderMieiIncassi();
  toast('Dati cancellati');
});

// DEMO UTENTE
$('#btn-demo-utente')?.addEventListener('click', async () => {
  const ristoranti = await loadRistoranti();
  if (!ristoranti.length) { toast('Crea prima un ristorante'); return; }
  const sel = $('#demo-ristorante');
  sel.innerHTML = ristoranti.map(r => `<option value="${r.id}">${r.nome}</option>`).join('');
  $('#modal-demo-utente').classList.remove('hidden');
});

$('#btn-avvia-demo')?.addEventListener('click', async () => {
  const ristId = $('#demo-ristorante').value;
  const tavolo = parseInt($('#demo-tavolo').value) || 1;
  const r = await loadRistoranteFull(ristId);
  if (!r) return;
  // Demo da ADMIN: NON sovrascrivere sessione → al refresh torni in ADMIN
  currentUser = { role: 'cliente', ristoranteId: ristId, tavolo, fromAdminDemo: true };
  currentRistorante = r;
  cart = [];
  lastOrdineId = null;
  sessionOrders = [];
  $('#modal-demo-utente').classList.add('hidden');
  $('#app-admin').classList.add('hidden');
  $('#app-ristoratore')?.classList.add('hidden');
  $('#login-screen')?.classList.add('hidden');
  $('#app-cliente').classList.remove('hidden');
  $('#cliente-rist-nome').textContent = r.nome;
  $('#cliente-tavolo-num').textContent = tavolo;
  document.body.classList.add('cliente-night');
  showClienteView('menu');
  renderClienteMenu();
  if (typeof setupClientePagamenti === 'function') setupClientePagamenti();
});

// =====================================================
// RISTORATORE
// =====================================================
function labelStato(s) {
  return { nuovo: 'Nuovo', in_preparazione: 'In preparazione', pronto: 'Pronto', consegnato: 'Consegnato', chiuso: 'Chiuso' }[s] || s;
}
function labelPagamentoStato(s) {
  return { pagato: 'Pagato', in_attesa: 'In attesa', non_pagato: 'Non pagato' }[s] || s || 'In attesa';
}
function defaultPagStato(metodo) {
  return metodo === 'carta' ? 'pagato' : 'in_attesa';
}

function inPeriod(iso, period) {
  const d = new Date(iso);
  const now = new Date();
  if (period === 'oggi') return d.toDateString() === now.toDateString();
  if (period === 'settimana') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return d >= weekAgo;
  }
  if (period === 'mese') {
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  return true;
}

$$('.period-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    $$('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    await renderRistDashboard();
  });
});

async function renderRistDashboard(forceReload) {
  if (!currentRistorante) return;
  if (forceReload !== false) {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
  }
  const menu = currentRistorante.menu || [];
  const ordini = currentRistorante.ordini || [];
  const tavoli = currentRistorante.tavoli || [];

  const attivi = ordini.filter(o => o.stato !== 'consegnato' && o.stato !== 'chiuso').length;
  const occupati = tavoli.filter(t => t.occupato).length ||
    new Set(ordini.filter(o => o.stato !== 'consegnato' && o.stato !== 'chiuso').map(o => o.tavolo)).size;
  const incasso = ordini.filter(o => inPeriod(o.createdAt, currentPeriod))
    .reduce((s, o) => s + Number(o.totale), 0);

  $('#rist-stat-piatti').textContent = menu.length;
  $('#rist-stat-tavoli-occ').textContent = occupati;
  $('#rist-stat-ordini-attivi').textContent = attivi;
  $('#rist-stat-incasso').textContent = formatPrice(incasso);

  const badge = $('#badge-ordini');
  const nuovi = ordini.filter(o => o.stato === 'nuovo').length;
  if (nuovi > 0) { badge.textContent = nuovi; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const recent = ordini.slice(0, 5);
  const list = $('#rist-recent-ordini');
  if (!recent.length) {
    list.innerHTML = '<p style="color:var(--muted)">Nessun ordine ancora.</p>';
  } else {
    list.innerHTML = recent.map(o => {
      const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
      return `<div class="recent-item">
        <span><strong>Tavolo ${o.tavolo}</strong> · ${formatPrice(o.totale)} · ${formatTime(o.createdAt)}</span>
        <span>
          <span class="badge-stato ${o.stato}">${labelStato(o.stato)}</span>
          <span class="badge-pag ${ps}">${labelPagamentoStato(ps)}</span>
        </span>
      </div>`;
    }).join('');
  }
  renderRistCharts();
}

function renderRistCharts() {
  if (typeof Chart === 'undefined' || !currentRistorante) return;
  const ordini = (currentRistorante.ordini || []).filter(o => inPeriod(o.createdAt, currentPeriod));
  // chart semplificato
  const ctx1 = document.getElementById('chart-incassi-rist');
  if (ctx1) {
    if (chartIncassiRist) chartIncassiRist.destroy();
    const labels = ['Incasso'];
    const data = [ordini.reduce((s, o) => s + Number(o.totale), 0)];
    chartIncassiRist = new Chart(ctx1, {
      type: 'bar',
      data: { labels, datasets: [{ label: '€', data, backgroundColor: 'rgba(59, 130, 246, 0.75)', borderRadius: 6 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  }
  const stati = { nuovo: 0, in_preparazione: 0, pronto: 0, consegnato: 0 };
  ordini.forEach(o => { if (stati[o.stato] !== undefined) stati[o.stato]++; });
  const ctx2 = document.getElementById('chart-stati-rist');
  if (ctx2) {
    if (chartStatiRist) chartStatiRist.destroy();
    chartStatiRist = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['Nuovo', 'In prep.', 'Pronto', 'Consegnato'],
        datasets: [{ data: [stati.nuovo, stati.in_preparazione, stati.pronto, stati.consegnato], backgroundColor: ['#d4890f', '#3d6b8c', '#3d7a5a', '#7a6f62'], borderWidth: 0 }]
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } }
    });
  }
}

// =====================================================
// MENU
// =====================================================
async function renderMenuTable(filter = '', forceReload) {
  if (!currentRistorante) return;
  if (forceReload !== false) {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
  }
  let menu = currentRistorante.menu || [];

  // chips categorie
  const chips = $('#categorie-chips');
  if (chips) {
    const cats = ['tutti', ...(currentRistorante.categorie || [])];
    chips.innerHTML = cats.map(c =>
      `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${c}">${c === 'tutti' ? 'Tutti' : c}</button>`
    ).join('');
    chips.querySelectorAll('.cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        menuFilterCat = chip.dataset.cat;
        renderMenuTable(filter);
      });
    });
  }

  if (menuFilterCat !== 'tutti') menu = menu.filter(p => p.categoria === menuFilterCat);
  if (filter) {
    const q = filter.toLowerCase();
    menu = menu.filter(p => p.nome.toLowerCase().includes(q));
  }

  const sel = $('#piatto-categoria');
  if (sel) {
    sel.innerHTML = (currentRistorante.categorie || []).map(c =>
      `<option value="${c}">${c}</option>`
    ).join('');
  }

  const body = $('#menu-body');
  if (!menu.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:40px">Nessun piatto. Aggiungine uno!</td></tr>`;
    return;
  }
  body.innerHTML = menu.map(p => `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          ${p.immagine ? `<img src="${p.immagine}" class="piatto-img" alt="" onerror="this.style.display='none'"/>` : ''}
          <div>
            <strong>${p.nome}</strong>
            ${p.descrizione ? `<br><small style="color:var(--muted)">${p.descrizione}</small>` : ''}
          </div>
        </div>
      </td>
      <td>${p.categoria || '—'}</td>
      <td>${formatPrice(p.prezzo)}</td>
      <td style="font-size:12px">${(p.allergeni || []).join(', ') || '—'}</td>
      <td><span class="badge ${p.disponibile ? 'badge-pro' : 'badge-base'}">${p.disponibile ? 'Sì' : 'No'}</span></td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="editPiatto('${p.id}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deletePiatto('${p.id}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

$('#search-menu')?.addEventListener('input', e => renderMenuTable(e.target.value));

function resetPiattoImage() {
  const prev = $('#piatto-preview');
  const wrap = $('#piatto-preview-wrap');
  const file = $('#piatto-file');
  if (prev) prev.src = '';
  if (wrap) wrap.classList.add('hidden');
  if (file) file.value = '';
  if ($('#piatto-immagine')) $('#piatto-immagine').value = '';
}

function showPiattoPreview(src) {
  const prev = $('#piatto-preview');
  const wrap = $('#piatto-preview-wrap');
  if (!prev || !wrap) return;
  if (src) {
    prev.src = src;
    wrap.classList.remove('hidden');
  } else {
    resetPiattoImage();
  }
}

$('#piatto-file')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) {
    toast('Immagine troppo grande (max 1.5 MB)');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    showPiattoPreview(reader.result);
    if ($('#piatto-immagine')) $('#piatto-immagine').value = '';
  };
  reader.readAsDataURL(file);
});

$('#piatto-immagine')?.addEventListener('input', (e) => {
  const url = e.target.value.trim();
  if (url) showPiattoPreview(url);
  else if (!$('#piatto-file')?.files?.length) resetPiattoImage();
});

$('#btn-rimuovi-img')?.addEventListener('click', () => resetPiattoImage());

$('#btn-nuovo-piatto')?.addEventListener('click', () => {
  $('#modal-piatto-title').textContent = 'Nuovo piatto';
  $('#form-piatto').reset();
  $('#piatto-edit-id').value = '';
  $('#piatto-disponibile').checked = true;
  resetPiattoImage();
  const sel = $('#piatto-categoria');
  sel.innerHTML = (currentRistorante.categorie || []).map(c => `<option value="${c}">${c}</option>`).join('');
  $$('#allergeni-grid input').forEach(c => c.checked = false);
  $('#modal-piatto').classList.remove('hidden');
});

$('#btn-nuova-categoria')?.addEventListener('click', () => {
  $('#form-categoria').reset();
  $('#modal-categoria').classList.remove('hidden');
});

$('#form-categoria')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#cat-nome').value.trim();
  if (!nome || !currentRistorante) return;
  if (!(currentRistorante.categorie || []).includes(nome)) {
    await sb.from('categorie').insert({
      id_ristorante: currentRistorante.id,
      nome,
      posizione: (currentRistorante.categorie || []).length
    });
    toast('Categoria creata');
  }
  $('#modal-categoria').classList.add('hidden');
  await renderMenuTable();
});

$('#form-piatto')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentRistorante) return;
  const id = $('#piatto-edit-id').value;
  const allergeni = [...$$('#allergeni-grid input:checked')].map(c => c.value);
  let immagine = ($('#piatto-immagine')?.value || '').trim();
  const previewSrc = $('#piatto-preview')?.src || '';
  if (!immagine && previewSrc && previewSrc.startsWith('data:')) immagine = previewSrc;
  else if (!immagine && previewSrc && !$('#piatto-preview-wrap')?.classList.contains('hidden')) immagine = previewSrc;

  const data = {
    id_ristorante: currentRistorante.id,
    nome: $('#piatto-nome').value.trim(),
    descrizione: $('#piatto-desc').value.trim(),
    categoria: $('#piatto-categoria').value,
    prezzo: parseFloat($('#piatto-prezzo').value) || 0,
    disponibile: $('#piatto-disponibile').checked,
    allergeni,
    immagine
  };

  if (id) {
    const { error } = await sb.from('piatti').update(data).eq('id', id);
    if (error) { toast('Errore'); console.error(error); return; }
    toast('Piatto aggiornato');
  } else {
    const { error } = await sb.from('piatti').insert(data);
    if (error) { toast('Errore'); console.error(error); return; }
    toast('Piatto aggiunto');
  }
  $('#modal-piatto').classList.add('hidden');
  await renderMenuTable($('#search-menu')?.value || '');
  await renderRistDashboard();
});

window.editPiatto = async function(id) {
  const p = currentRistorante.menu.find(x => x.id === id);
  if (!p) return;
  $('#modal-piatto-title').textContent = 'Modifica piatto';
  $('#piatto-edit-id').value = p.id;
  $('#piatto-nome').value = p.nome;
  $('#piatto-desc').value = p.descrizione || '';
  const sel = $('#piatto-categoria');
  sel.innerHTML = (currentRistorante.categorie || []).map(c =>
    `<option value="${c}" ${c === p.categoria ? 'selected' : ''}>${c}</option>`
  ).join('');
  $('#piatto-prezzo').value = p.prezzo;
  $('#piatto-disponibile').checked = p.disponibile !== false;
  if ($('#piatto-immagine')) $('#piatto-immagine').value = (p.immagine && !p.immagine.startsWith('data:')) ? p.immagine : '';
  if (p.immagine) showPiattoPreview(p.immagine);
  else resetPiattoImage();
  $$('#allergeni-grid input').forEach(c => {
    c.checked = (p.allergeni || []).includes(c.value);
  });
  $('#modal-piatto').classList.remove('hidden');
};

window.deletePiatto = async function(id) {
  await sb.from('piatti').delete().eq('id', id);
  await renderMenuTable($('#search-menu')?.value || '');
  await renderRistDashboard();
  toast('Piatto eliminato');
};

// =====================================================
// ORDINI KANBAN
// =====================================================
async function renderOrdiniKanban(forceReload) {
  if (!currentRistorante) return;
  if (forceReload !== false) {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
  }
  const ordini = currentRistorante.ordini || [];

  const nuovi = ordini.filter(o => o.stato === 'nuovo');
  const prep = ordini.filter(o => o.stato === 'in_preparazione');
  const pronti = ordini.filter(o => o.stato === 'pronto' || o.stato === 'consegnato');

  $('#count-nuovo').textContent = nuovi.length;
  $('#count-prep').textContent = prep.length;
  $('#count-pronto').textContent = pronti.length;

  function cardHtml(o) {
    const items = (o.items || []).slice(0, 3).map(i => `${i.qty}× ${i.nome}`).join(', ');
    const more = (o.items || []).length > 3 ? '...' : '';
    const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
    return `
      <div class="kanban-card stato-${o.stato}" data-id="${o.id}" draggable="true" onclick="apriDettaglioOrdine('${o.id}')">
        <h4>Tavolo ${o.tavolo} · ${formatPrice(o.totale)}</h4>
        <p>${items}${more}</p>
        <div class="pag-row">
          <span style="font-size:11px;color:var(--muted)">${formatTime(o.createdAt)} · #${o.codice}</span>
          <span class="badge-pag ${ps}">${labelPagamentoStato(ps)}</span>
        </div>
      </div>
    `;
  }

  $('#kanban-nuovo').innerHTML = nuovi.length ? nuovi.map(cardHtml).join('') : '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Nessun ordine</p>';
  $('#kanban-prep').innerHTML = prep.length ? prep.map(cardHtml).join('') : '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Nessun ordine</p>';
  $('#kanban-pronto').innerHTML = pronti.length ? pronti.map(cardHtml).join('') : '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Nessun ordine</p>';

  const badge = $('#badge-ordini');
  if (nuovi.length > 0) { badge.textContent = nuovi.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

window.apriDettaglioOrdine = async function(ordineId) {
  let o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  // assicura lista piatti (items o ordine_riga)
  let items = o.items || [];
  if ((!items || !items.length) && sb) {
    try {
      const { data: righe } = await sb.from('ordine_riga').select('*').eq('id_ordine', ordineId);
      if (righe && righe.length) {
        items = righe.map(r => ({
          nome: r.piatto || r.nome || 'Piatto',
          qty: r.qty_piatti || r.qty || 1,
          prezzo: 0
        }));
        o.items = items;
      }
    } catch (e) {}
  }
  $('#ordine-detail-title').textContent = `Ordine #${o.codice} – Tavolo ${o.tavolo}`;
  const itemsHtml = (items || []).length
    ? (items || []).map(i =>
        `<div class="r-item prep-line"><span class="prep-qty">${i.qty}×</span> <span class="prep-name">${i.nome}</span></div>`
      ).join('')
    : '<p style="color:var(--muted)">Nessun piatto in questo ordine</p>';
  const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
  const metodo = o.pagamento === 'cassa' ? 'Pago in cassa' : (o.pagamento === 'carta' ? 'Carta' : (o.pagamento || '—'));
  $('#ordine-detail-body').innerHTML = `
    <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="badge-stato ${o.stato}">${labelStato(o.stato)}</span>
      <span class="badge-pag ${ps}">${labelPagamentoStato(ps)}</span>
      <span style="color:var(--muted);font-size:13px">${formatTime(o.createdAt)}</span>
    </div>
    <h4 style="font-size:13px;margin:10px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Da preparare</h4>
    <div class="ricevuta-items prep-list">${itemsHtml}</div>
    ${o.note ? `<p style="font-size:13px;color:var(--muted);margin:12px 0"><i class="fas fa-sticky-note"></i> ${o.note}</p>` : ''}
    <p style="font-size:13px;margin:8px 0">Metodo: <strong>${metodo}</strong></p>
    <div class="ricevuta-totale"><span>Totale</span><strong>${formatPrice(o.totale)}</strong></div>
  `;
  let actions = '';
  if (o.stato === 'nuovo') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${o.id}','in_preparazione')"><i class="fas fa-fire"></i> Inizia preparazione</button>`;
  } else if (o.stato === 'in_preparazione') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${o.id}','pronto')"><i class="fas fa-check"></i> Segna pronto</button>`;
  } else if (o.stato === 'pronto') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${o.id}','consegnato')"><i class="fas fa-hand-holding"></i> Consegnato</button>`;
  }
  const nextPag = { in_attesa: 'pagato', pagato: 'non_pagato', non_pagato: 'in_attesa' }[ps] || 'pagato';
  const pagBtnLabel = { pagato: 'Segna pagato', non_pagato: 'Segna non pagato', in_attesa: 'Segna in attesa' }[nextPag];
  actions += `<button class="btn btn-secondary" onclick="togglePagamento('${o.id}')"><i class="fas fa-money-bill-wave"></i> ${pagBtnLabel}</button>`;
  if (o.stato !== 'chiuso') {
    actions += `<button class="btn btn-danger" onclick="chiudiConto('${o.id}')"><i class="fas fa-file-invoice-dollar"></i> Chiudi conto</button>`;
  }
  actions += `<button class="btn btn-secondary close-modal" data-modal="modal-ordine">Chiudi</button>`;
  $('#ordine-detail-actions').innerHTML = actions;
  $('#ordine-detail-actions .close-modal')?.addEventListener('click', () => $('#modal-ordine').classList.add('hidden'));
  $('#modal-ordine').classList.remove('hidden');
};

window.cambiaStato = async function(ordineId, nuovoStato) {
  await sb.from('ordini').update({ stato: nuovoStato }).eq('id', ordineId);
  // aggiorna occupato tavolo
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (o) {
    if (nuovoStato === 'consegnato' || nuovoStato === 'chiuso') {
      await sb.from('tavoli').update({ occupato: false }).eq('id_ristorante', currentRistorante.id).eq('numero', o.tavolo);
    } else {
      await sb.from('tavoli').update({ occupato: true }).eq('id_ristorante', currentRistorante.id).eq('numero', o.tavolo);
    }
  }
  $('#modal-ordine').classList.add('hidden');
  await renderOrdiniKanban();
  await renderRistDashboard();
  toast('Stato aggiornato: ' + labelStato(nuovoStato));
};

window.chiudiConto = async function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  await sb.from('ordini').update({ stato: 'chiuso', stato_pagamento: 'pagato' }).eq('id', ordineId);
  if (o) await sb.from('tavoli').update({ occupato: false }).eq('id_ristorante', currentRistorante.id).eq('numero', o.tavolo);
  $('#modal-ordine').classList.add('hidden');
  await renderOrdiniKanban();
  await renderRistDashboard();
  await renderTavoli();
  toast('Conto chiuso e segnato come pagato');
};

window.togglePagamento = async function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  const cur = o.stato_pagamento || defaultPagStato(o.pagamento);
  const cycle = { in_attesa: 'pagato', pagato: 'non_pagato', non_pagato: 'in_attesa' };
  const next = cycle[cur] || 'pagato';
  await sb.from('ordini').update({ stato_pagamento: next }).eq('id', ordineId);
  await renderOrdiniKanban();
  await renderRistDashboard();
  apriDettaglioOrdine(ordineId);
  toast('Stato pagamento: ' + labelPagamentoStato(next));
};

// Card navigation
document.addEventListener('click', (e) => {
  const card = e.target.closest('.card-tilt');
  if (!card) return;
  const goto = card.dataset.goto;
  const gotoRist = card.dataset.gotoRist;
  if (goto) {
    const nav = document.querySelector('#app-admin .nav-item[data-page="' + goto + '"]');
    if (nav) nav.click();
  }
  if (gotoRist) {
    const nav = document.querySelector('#app-ristoratore .nav-item[data-page="' + gotoRist + '"]');
    if (nav) nav.click();
  }
});
document.addEventListener('pointermove', (e) => {
  const card = e.target.closest('.card-tilt');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
  card.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
});

// =====================================================
// TAVOLI + QR (URL reali)
// =====================================================
function qrData(ristoranteId, tavolo) {
  // SITE_URL produzione, altrimenti origin corrente
  const site = (cfg && cfg.SITE_URL) || (window.MENUPRO_CONFIG && window.MENUPRO_CONFIG.SITE_URL) || '';
  const base = (site || window.location.origin || '').replace(/\/$/, '');
  return base + '/?r=' + encodeURIComponent(String(ristoranteId)) + '&t=' + encodeURIComponent(String(tavolo));
}

async function renderTavoli(forceReload) {
  if (!currentRistorante) return;
  if (forceReload !== false) {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
  }
  const sale = currentRistorante.sale || ['Sala principale'];
  const tavoli = currentRistorante.tavoli || [];

  const tabs = $('#sale-tabs');
  tabs.innerHTML = sale.map((s, i) =>
    `<button class="sale-tab ${i === currentSala ? 'active' : ''}" data-sala="${i}">${s}</button>`
  ).join('');
  tabs.querySelectorAll('.sale-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentSala = parseInt(tab.dataset.sala);
      renderTavoli();
    });
  });

  const salaTavoli = tavoli.filter(t => (t.sala || 0) === currentSala);
  const piantina = $('#piantina');
  if (!salaTavoli.length) {
    piantina.innerHTML = '<p style="color:var(--muted)">Nessun tavolo in questa sala.</p>';
  } else {
    piantina.innerHTML = salaTavoli.map(t => {
      const label = t.bambini ? `${t.adulti}+${t.bambini}` : `${t.adulti}`;
      return `
        <div class="tavolo-shape ${t.forma === 'round' ? 'round' : ''} ${t.occupato ? 'occupato' : ''}"
             onclick="showQR(${t.numero})" title="Tavolo ${t.numero}">
          <span>T${t.numero}</span>
          <span class="posti">${label} posti</span>
        </div>
      `;
    }).join('');
  }

  const grid = $('#tavoli-grid');
  grid.innerHTML = '';
  salaTavoli.forEach(t => {
    const label = t.bambini ? `${t.adulti} adulti + ${t.bambini} bambini` : `${t.adulti} posti`;
    const card = document.createElement('div');
    card.className = 'tavolo-card';
    card.innerHTML = `
      <h4>Tavolo ${t.numero} ${t.occupato ? '<span class="badge-stato nuovo">Occupato</span>' : ''}</h4>
      <div class="posti-info">${label}</div>
      <div class="qr-mini" id="qr-mini-${t.numero}"></div>
      <div class="tavolo-actions">
        <button class="btn btn-secondary btn-sm" onclick="showQR(${t.numero})"><i class="fas fa-qrcode"></i> QR</button>
        <button class="btn btn-secondary btn-sm" onclick="editTavolo('${t.id}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteTavolo('${t.id}')"><i class="fas fa-trash"></i></button>
      </div>
    `;
    grid.appendChild(card);
    const data = qrData(currentRistorante.id, t.numero);
    try {
      new QRCode(card.querySelector(`#qr-mini-${t.numero}`), {
        text: data, width: 110, height: 110, correctLevel: QRCode.CorrectLevel.M
      });
    } catch {
      card.querySelector(`#qr-mini-${t.numero}`).innerHTML =
        `<img src="https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(data)}" alt="QR"/>`;
    }
  });
}

$('#btn-nuova-sala')?.addEventListener('click', () => {
  $('#form-sala')?.reset();
  $('#modal-sala')?.classList.remove('hidden');
});

$('#form-sala')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = ($('#sala-nome')?.value || '').trim();
  if (!nome || !currentRistorante) return;
  if (!sb) { toast('Database non collegato'); return; }
  const sale = [...(currentRistorante.sale || []), nome];
  const { error } = await sb.from('ristoranti').update({ sale }).eq('id', currentRistorante.id);
  if (error) { toast('Errore: ' + error.message); return; }
  currentRistorante.sale = sale;
  $('#modal-sala').classList.add('hidden');
  await renderTavoli();
  toast('Sala aggiunta');
});

window.showQR = function(tavolo) {
  if (!currentRistorante) return;
  const container = $('#qrcode-container');
  container.innerHTML = '';
  const data = qrData(currentRistorante.id, tavolo);
  $('#modal-qr-title').textContent = `QR Tavolo ${tavolo}`;
  $('#qr-info').textContent = `${currentRistorante.nome} · Tavolo ${tavolo}`;
  try {
    new QRCode(container, { text: data, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } catch {
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data)}" alt="QR"/>`;
  }
  $('#modal-qr').classList.remove('hidden');
};

$('#btn-demo-ristoratore')?.addEventListener('click', () => {
  if ($('#demo-rist-email')) $('#demo-rist-email').value = '';
  if ($('#demo-rist-password')) $('#demo-rist-password').value = '';
  $('#modal-demo-ristoratore').classList.remove('hidden');
});

$('#btn-avvia-demo-rist')?.addEventListener('click', async () => {
  const email = ($('#demo-rist-email')?.value || '').trim().toLowerCase();
  const pass = ($('#demo-rist-password')?.value || '').trim();
  if (!email || !pass) { toast('Inserisci email e password'); return; }
  $('#modal-demo-ristoratore').classList.add('hidden');
  // riusa il login normale
  const ok = await doLogin(email, pass);
  if (!ok) {
    $('#app-admin').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
  } else {
    $('#app-admin').classList.add('hidden');
  }
});

$('#btn-nuovo-tavolo')?.addEventListener('click', () => {
  if (!currentRistorante) return;
  const maxNum = (currentRistorante.tavoli || []).reduce((m, t) => Math.max(m, t.numero || 0), 0);
  $('#modal-tavolo-title').textContent = 'Nuovo tavolo';
  $('#tavolo-edit-id').value = '';
  $('#tavolo-numero').value = maxNum + 1;
  $('#tavolo-adulti').value = 4;
  $('#tavolo-bambini').value = 0;
  $('#tavolo-forma').value = 'round';
  $('#modal-tavolo-edit').classList.remove('hidden');
});

$('#form-tavolo')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentRistorante) return;
  const id = $('#tavolo-edit-id').value;
  const data = {
    id_ristorante: currentRistorante.id,
    numero: parseInt($('#tavolo-numero').value) || 1,
    adulti: parseInt($('#tavolo-adulti').value) || 4,
    bambini: parseInt($('#tavolo-bambini').value) || 0,
    sala: currentSala || 0,
    forma: $('#tavolo-forma').value || 'round'
  };
  if (id) {
    await sb.from('tavoli').update(data).eq('id', id);
    toast('Tavolo aggiornato');
  } else {
    data.occupato = false;
    await sb.from('tavoli').insert(data);
    toast('Tavolo aggiunto');
  }
  $('#modal-tavolo-edit').classList.add('hidden');
  await renderTavoli();
});

window.editTavolo = function(id) {
  const t = currentRistorante.tavoli.find(x => x.id === id);
  if (!t) return;
  $('#modal-tavolo-title').textContent = 'Modifica tavolo';
  $('#tavolo-edit-id').value = t.id;
  $('#tavolo-numero').value = t.numero;
  $('#tavolo-adulti').value = t.adulti;
  $('#tavolo-bambini').value = t.bambini || 0;
  $('#tavolo-forma').value = t.forma || 'round';
  $('#modal-tavolo-edit').classList.remove('hidden');
};

window.deleteTavolo = async function(id) {
  await sb.from('tavoli').delete().eq('id', id);
  await renderTavoli();
  toast('Tavolo eliminato');
};

// =====================================================
// CLIENTE
// =====================================================
function showClienteView(view) {
  ['cliente-menu-view', 'cliente-carrello-view', 'cliente-ricevuta-view', 'cliente-stato-view'].forEach(id => {
    $(`#${id}`)?.classList.add('hidden');
  });
  $(`#cliente-${view}-view`)?.classList.remove('hidden');
}

function renderClienteMenu() {
  if (!currentRistorante) return;
  const menu = (currentRistorante.menu || []).filter(p => p.disponibile !== false);
  // Ordine categorie come in gestione menu (posizione DB), non casuale
  const ordered = (currentRistorante.categorie || []).filter(Boolean);
  const fromMenu = [...new Set(menu.map(p => p.categoria).filter(Boolean))];
  const orderedCats = [
    ...ordered.filter(c => fromMenu.includes(c)),
    ...fromMenu.filter(c => !ordered.includes(c))
  ];
  const cats = ['tutti', ...orderedCats];
  const catEl = $('#cliente-categorie');
  catEl.innerHTML = cats.map(c =>
    `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${c}">${c === 'tutti' ? 'Tutti' : c}</button>`
  ).join('');
  catEl.querySelectorAll('.cat-chip').forEach(chip => {
    chip.addEventListener('click', () => { menuFilterCat = chip.dataset.cat; renderClienteMenu(); });
  });

  let filtered;
  if (menuFilterCat === 'tutti') {
    const rank = {};
    orderedCats.forEach((c, i) => { rank[c] = i; });
    filtered = [...menu].sort((a, b) => (rank[a.categoria] ?? 999) - (rank[b.categoria] ?? 999));
  } else {
    filtered = menu.filter(p => p.categoria === menuFilterCat);
  }
  const list = $('#cliente-menu-list');
  if (!filtered.length) {
    list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px">Nessun piatto disponibile.</p>';
    return;
  }
  list.innerHTML = filtered.map(p => {
    const inCart = cart.find(c => c.id === p.id);
    const qty = inCart ? inCart.qty : 0;
    const all = (p.allergeni || []).length ? `<div class="allergeni-tags">⚠ ${(p.allergeni).join(', ')}</div>` : '';
    return `
      <div class="menu-item-card">
        ${p.immagine ? `<img src="${p.immagine}" class="piatto-img" alt="" onerror="this.style.display='none'"/>` : ''}
        <div class="menu-item-info" style="flex:1">
          <h4>${p.nome}</h4>
          ${p.descrizione ? `<p>${p.descrizione}</p>` : ''}
          <span class="prezzo">${formatPrice(p.prezzo)}</span>
          ${all}
        </div>
        <div class="menu-item-actions">
          ${qty > 0 ? `
            <button class="qty-btn" onclick="changeQty('${p.id}',-1)">−</button>
            <span class="qty-num">${qty}</span>
            <button class="qty-btn" onclick="changeQty('${p.id}',1)">+</button>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="changeQty('${p.id}',1)"><i class="fas fa-plus"></i> Aggiungi</button>
          `}
        </div>
      </div>
    `;
  }).join('');
  updateCartCount();
}

window.changeQty = function(id, delta) {
  const p = currentRistorante.menu.find(x => x.id === id);
  if (!p) return;
  let item = cart.find(c => c.id === id);
  if (!item && delta > 0) {
    cart.push({ id: p.id, nome: p.nome, prezzo: p.prezzo, qty: 1 });
  } else if (item) {
    item.qty += delta;
    if (item.qty <= 0) cart = cart.filter(c => c.id !== id);
  }
  renderClienteMenu();
  if (!$('#cliente-carrello-view').classList.contains('hidden')) renderCarrello();
};

function updateCartCount() {
  $('#cart-count').textContent = cart.reduce((s, c) => s + c.qty, 0);
}

$('#cliente-carrello-btn')?.addEventListener('click', () => {
  renderCarrello();
  showClienteView('carrello');
});
$('#btn-torna-menu')?.addEventListener('click', () => {
  showClienteView('menu');
  renderClienteMenu();
});

function renderCarrello() {
  const el = $('#carrello-items');
  if (!cart.length) {
    el.innerHTML = '<p style="color:var(--muted);text-align:center">Il carrello è vuoto.</p>';
    $('#carrello-totale').textContent = formatPrice(0);
    return;
  }
  el.innerHTML = cart.map(c => `
    <div class="carrello-item">
      <div>
        <strong>${c.nome}</strong><br>
        <small>${formatPrice(c.prezzo)} × ${c.qty}</small>
      </div>
      <div class="menu-item-actions">
        <button class="qty-btn" onclick="changeQty('${c.id}',-1)">−</button>
        <span class="qty-num">${c.qty}</span>
        <button class="qty-btn" onclick="changeQty('${c.id}',1)">+</button>
      </div>
    </div>
  `).join('');
  $('#carrello-totale').textContent = formatPrice(cart.reduce((s, c) => s + c.prezzo * c.qty, 0));
}

$('#btn-invia-ordine')?.addEventListener('click', async () => {
  if (!cart.length) { toast('Il carrello è vuoto'); return; }
  if (!currentRistorante || !currentUser) {
    toast('Sessione cliente non valida. Riscansiona il QR.');
    return;
  }
  if (!sb) {
    toast('Database non collegato: controlla config.js');
    return;
  }

  const totale = cart.reduce((s, c) => s + c.prezzo * c.qty, 0);
  const codice = 'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const pagamento = document.querySelector('input[name="pagamento"]:checked')?.value || 'carta';
  const stato_pagamento = defaultPagStato(pagamento);
  const note = ($('#ordine-note')?.value || '').trim();
  const tavoloNum = currentUser.tavolo;

  // Schema nuovo: senza colonna items (usa ordine_riga). Schema vecchio: con items jsonb.
  const ordineBase = {
    id_ristorante: currentRistorante.id,
    codice,
    tavolo: tavoloNum,
    note,
    pagamento,
    stato_pagamento,
    totale,
    stato: 'nuovo'
  };

  let inserted = null;
  let error = null;

  // prova con items (schema vecchio)
  ({ data: inserted, error } = await sb.from('ordini').insert({
    ...ordineBase,
    items: cart.map(c => ({ id: c.id, nome: c.nome, prezzo: c.prezzo, qty: c.qty }))
  }).select().single());

  // se fallisce per colonna items, riprova senza
  if (error && String(error.message || '').toLowerCase().includes('items')) {
    ({ data: inserted, error } = await sb.from('ordini').insert(ordineBase).select().single());
  }

  if (error || !inserted) {
    toast('Errore invio ordine: ' + (error?.message || 'sconosciuto'));
    console.error(error);
    return;
  }

  // UI subito dopo insert principale
  const cartSnapshot = cart.slice();
  lastOrdineId = inserted.id;
  if (!sessionOrders.find(x => x.id === inserted.id)) {
    sessionOrders.push({ id: inserted.id, codice });
  }
  $('#ricevuta-codice').textContent = codice;
  $('#ricevuta-rist').textContent = currentRistorante.nome;
  $('#ricevuta-tavolo').textContent = currentUser.tavolo;
  $('#ricevuta-ora').textContent = formatTime(inserted.created_at || new Date().toISOString());
  $('#ricevuta-pagamento').textContent = pagamento === 'cassa' ? 'Pago in cassa' : 'Carta';
  $('#ricevuta-totale').textContent = formatPrice(totale);
  $('#ricevuta-stato').textContent = 'Nuovo';
  $('#ricevuta-stato').className = 'badge-stato nuovo';
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(stato_pagamento);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + stato_pagamento;
  }
  $('#ricevuta-items').innerHTML = cartSnapshot.map(i => `
    <div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>
  `).join('');

  cart = [];
  updateCartCount();
  if ($('#ordine-note')) $('#ordine-note').value = '';
  showClienteView('ricevuta');
  if ($('#cliente-stato-btn')) $('#cliente-stato-btn').style.display = 'inline-flex';
  updateClienteOrdiniSelect();
  startOrdineStatusPolling();
  toast('Ordine inviato!');

  Promise.all([
    sb.from('ordine_riga').insert(cartSnapshot.map(c => ({
      id_ordine: inserted.id,
      id_piatto: c.id || null,
      piatto: c.nome,
      qty_piatti: c.qty,
      prezzo_pagato: Number(c.prezzo) * c.qty
    }))).catch(() => {}),
    note ? sb.from('messaggio').insert({ id_ordine: inserted.id, testo: note }).catch(() => {}) : Promise.resolve(),
    sb.from('pagamento').insert({ id_ordine: inserted.id, metodo: pagamento, importo: totale }).catch(() => {}),
    sb.from('tavoli').update({ occupato: true }).eq('id_ristorante', currentRistorante.id).eq('numero', currentUser.tavolo).catch(() => {})
  ]).catch(() => {});
});


function updateClienteOrdiniSelect() {
  const sel = $('#select-ordini-cliente');
  if (!sel) return;
  if (!sessionOrders.length) {
    sel.innerHTML = '<option value="">Nessun ordine</option>';
    return;
  }
  sel.innerHTML = sessionOrders.map(o =>
    `<option value="${o.id}">${o.codice}</option>`
  ).join('');
  if (lastOrdineId) sel.value = lastOrdineId;
}

async function loadClienteOrdineById(ordineId) {
  if (!ordineId || !sb) return;
  lastOrdineId = ordineId;
  const { data: o } = await sb.from('ordini').select('*').eq('id', ordineId).single();
  if (!o) { toast('Ordine non trovato'); return; }
  // items da jsonb o ordine_riga
  let items = o.items || [];
  if (!items.length) {
    try {
      const { data: righe } = await sb.from('ordine_riga').select('*').eq('id_ordine', ordineId);
      items = (righe || []).map(r => ({
        nome: r.piatto || r.nome,
        qty: r.qty_piatti || r.qty || 1,
        prezzo: r.prezzo_pagato && (r.qty_piatti || r.qty) ? Number(r.prezzo_pagato) / (r.qty_piatti || r.qty) : 0
      }));
    } catch (e) {}
  }
  $('#ricevuta-codice').textContent = o.codice || '';
  $('#ricevuta-rist').textContent = (currentRistorante && currentRistorante.nome) || '';
  $('#ricevuta-tavolo').textContent = o.tavolo;
  $('#ricevuta-ora').textContent = formatTime(o.created_at || o.createdAt);
  $('#ricevuta-pagamento').textContent = o.pagamento === 'cassa' ? 'Pago in cassa' : 'Carta';
  $('#ricevuta-totale').textContent = formatPrice(o.totale || 0);
  $('#ricevuta-stato').textContent = labelStato(o.stato);
  $('#ricevuta-stato').className = 'badge-stato ' + (o.stato || 'nuovo');
  const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(ps);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + ps;
  }
  $('#ricevuta-items').innerHTML = items.length
    ? items.map(i => `<div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice((i.prezzo || 0) * (i.qty || 1))}</span></div>`).join('')
    : '<p style="color:var(--muted)">Dettaglio piatti non disponibile</p>';
  showClienteView('ricevuta');
  startOrdineStatusPolling();
}

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'select-ordini-cliente') {
    const id = e.target.value;
    if (id) loadClienteOrdineById(id);
  }
});


let _statusPoll = null;
let _lastKnownStato = null;

function stopOrdineStatusPolling() {
  if (_statusPoll) { clearInterval(_statusPoll); _statusPoll = null; }
}

function applyOrdineStatusUI(o) {
  if (!o) return;
  const stato = o.stato || 'nuovo';
  const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
  if ($('#ricevuta-stato')) {
    $('#ricevuta-stato').textContent = labelStato(stato);
    $('#ricevuta-stato').className = 'badge-stato ' + stato;
  }
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(ps);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + ps;
  }
  // timeline se visibile
  const tl = $('#stato-timeline');
  if (tl && !$('#cliente-stato-view')?.classList.contains('hidden')) {
    const steps = ['nuovo', 'in_preparazione', 'pronto', 'consegnato'];
    const idx = steps.indexOf(stato);
    tl.innerHTML = steps.map((s, i) => {
      let cls = '';
      if (i < idx) cls = 'done';
      else if (i === idx) cls = 'active';
      return `<div class="stato-step ${cls}"><div class="dot"></div><span>${labelStato(s)}</span></div>`;
    }).join('');
  }
  if (_lastKnownStato && _lastKnownStato !== stato) {
    toast('Stato ordine: ' + labelStato(stato));
  }
  _lastKnownStato = stato;
}

function startOrdineStatusPolling() {
  stopOrdineStatusPolling();
  _lastKnownStato = null;
  const tick = async () => {
    if (!lastOrdineId || !sb) return;
    try {
      const { data: o } = await sb.from('ordini').select('*').eq('id', lastOrdineId).single();
      if (o) applyOrdineStatusUI(o);
    } catch (e) { console.warn('poll stato', e); }
  };
  tick();
  _statusPoll = setInterval(tick, 4000);
}

// Bottone aggiorna tenuto come opzionale ma non necessario
$('#btn-aggiorna-stato')?.addEventListener('click', async () => {
  if (!lastOrdineId || !sb) return;
  const { data: o } = await sb.from('ordini').select('*').eq('id', lastOrdineId).single();
  if (o) applyOrdineStatusUI(o);
});

$('#btn-nuovo-ordine')?.addEventListener('click', () => {
  cart = [];
  updateCartCount();
  showClienteView('menu');
  renderClienteMenu();
});

$('#cliente-stato-btn')?.addEventListener('click', async () => {
  if (!lastOrdineId) return;
  const { data: o } = await sb.from('ordini').select('*').eq('id', lastOrdineId).single();
  if (!o) return;
  $('#stato-codice').textContent = o.codice;
  const steps = ['nuovo', 'in_preparazione', 'pronto', 'consegnato'];
  const idx = steps.indexOf(o.stato);
  $('#stato-timeline').innerHTML = steps.map((s, i) => {
    let cls = '';
    if (i < idx) cls = 'done';
    else if (i === idx) cls = 'active';
    return `<div class="stato-step ${cls}"><div class="dot"></div><span>${labelStato(s)}</span></div>`;
  }).join('');
  showClienteView('stato');
});

$('#btn-torna-da-stato')?.addEventListener('click', () => {
  showClienteView('menu');
  renderClienteMenu();
});

$('#btn-indietro-stato')?.addEventListener('click', () => {
  if (lastOrdineId) showClienteView('ricevuta');
  else {
    showClienteView('menu');
    renderClienteMenu();
  }
});



// =====================================================
// RESET PASSWORD RISTORATORE
// =====================================================
/* crea admin rimosso: solo da Supabase */

window.apriResetPassword = async function(id) {
  if (!sb) { toast('Database non collegato'); return; }
  const { data: r } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (!r) return;
  $('#reset-pass-rist-id').value = r.id;
  $('#reset-pass-email').value = r.email;
  $('#reset-pass-nome').value = r.nome + ' (' + r.email + ')';
  $('#reset-pass-value').value = '';
  $('#modal-reset-pass').classList.remove('hidden');
};

$('#btn-genera-pass')?.addEventListener('click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  $('#reset-pass-value').value = s;
});

$('#form-reset-pass')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) { toast('Database non collegato'); return; }
  const id = $('#reset-pass-rist-id').value;
  const email = $('#reset-pass-email').value;
  const nuova = ($('#reset-pass-value')?.value || '').trim();
  if (!nuova || nuova.length < 4) { toast('Password troppo corta'); return; }

  const { error: e1 } = await sb.from('ristoranti').update({ password: nuova }).eq('id', id);
  if (e1) { toast('Errore ristoranti: ' + e1.message); return; }

  const { data: u } = await sb.from('utenti').select('id').eq('email', email).maybeSingle();
  if (u) {
    await sb.from('utenti').update({ password_hash: nuova }).eq('id', u.id);
  } else {
    await sb.from('utenti').insert({
      email,
      password_hash: nuova,
      ruolo: 'ristoratore',
      nome: $('#reset-pass-nome').value
    });
  }

  $('#modal-reset-pass').classList.add('hidden');
  toast('Nuova password salvata: ' + nuova);
});

// =====================================================
// AVVIO: se c'è ?r=...&t=... apri come cliente (QR)
// =====================================================
(async function initFromQR() {
  const params = new URLSearchParams(window.location.search);
  let rId = (params.get('r') || '').trim();
  try { rId = decodeURIComponent(rId); } catch (_) {}
  rId = (rId || '').trim();
  const t = parseInt(params.get('t'), 10);
  if (!rId || !t || Number.isNaN(t)) return;

  document.documentElement.classList.add('qr-entry');
  const login = $('#login-screen');
  const appC = $('#app-cliente');
  if (login) login.classList.add('hidden');
  if (appC) { appC.classList.remove('hidden'); appC.classList.add('cliente-ui'); }
  document.body.classList.add('cliente-night');
  if ($('#cliente-tavolo-num')) $('#cliente-tavolo-num').textContent = t;

  // Attendi Supabase (CDN + config)
  let tries = 0;
  while (!ensureSb() && tries < 60) {
    await new Promise(r => setTimeout(r, 100));
    tries++;
  }
  if (!sb) {
    toast('Database non collegato. Ricarica la pagina o controlla la connessione.');
    console.error('QR: sb null dopo wait. supabase=', !!window.supabase, 'config=', !!window.MENUPRO_CONFIG);
    return;
  }

  try {
    // 1) lookup diretto leggero
    let { data: raw, error } = await sb.from('ristoranti').select('*').eq('id', rId).maybeSingle();
    if (error) {
      console.error('QR select error', error);
      // retry una volta
      await new Promise(x => setTimeout(x, 300));
      ({ data: raw, error } = await sb.from('ristoranti').select('*').eq('id', rId).maybeSingle());
    }
    if (!raw) {
      // fallback: lista e match case-insensitive
      const { data: all } = await sb.from('ristoranti').select('id,nome').limit(200);
      const found = (all || []).find(x => String(x.id).toLowerCase() === rId.toLowerCase());
      if (found) {
        ({ data: raw } = await sb.from('ristoranti').select('*').eq('id', found.id).maybeSingle());
      }
    }
    if (!raw) {
      toast('Ristorante non trovato. Rigenera il QR dai Tavoli.');
      console.error('QR id non trovato', rId);
      return;
    }

    let r = await loadRistoranteFull(raw.id, { lite: true });
    if (!r) {
      // costruisci minimo senza full load
      r = {
        ...raw,
        tavoli: [],
        menu: [],
        categorie: ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'],
        ordini: [],
        pagamenti: [],
        sale: raw.sale || ['Sala principale']
      };
      try {
        const [tavoli, piatti, categorie] = await Promise.all([
          sb.from('tavoli').select('*').eq('id_ristorante', raw.id).order('numero'),
          sb.from('piatti').select('*').eq('id_ristorante', raw.id).order('nome'),
          sb.from('categorie').select('*').eq('id_ristorante', raw.id).order('posizione')
        ]);
        r.tavoli = tavoli.data || [];
        r.menu = (piatti.data || []).map(p => ({ ...p, allergeni: p.allergeni || [] }));
        r.categorie = (categorie.data || []).map(c => c.nome);
        if (!r.categorie.length) r.categorie = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
      } catch (e2) { console.warn('QR lite partial', e2); }
    }

    currentUser = { role: 'cliente', ristoranteId: raw.id, tavolo: t, fromQR: true };
    currentRistorante = r;
    try {
      const prev = JSON.parse(localStorage.getItem('mp_session') || 'null');
      if (prev && prev.role === 'cliente' && prev.fromQR && prev.ristoranteId === raw.id && String(prev.tavolo) === String(t)) {
        lastOrdineId = prev.lastOrdineId || null;
        sessionOrders = Array.isArray(prev.sessionOrders) ? prev.sessionOrders : [];
        cart = Array.isArray(prev.cart) ? prev.cart : [];
      } else {
        cart = []; lastOrdineId = null; sessionOrders = [];
      }
    } catch (_) { cart = []; lastOrdineId = null; sessionOrders = []; }

    if ($('#cliente-rist-nome')) $('#cliente-rist-nome').textContent = r.nome;
    if ($('#cliente-tavolo-num')) $('#cliente-tavolo-num').textContent = t;
    showClienteView(lastOrdineId ? 'ricevuta' : 'menu');
    renderClienteMenu();
    if (typeof setupClientePagamenti === 'function') setupClientePagamenti();
    if (typeof ensureGeoOnCliente === 'function') ensureGeoOnCliente();
    if (lastOrdineId) {
      if (typeof updateClienteOrdiniSelect === 'function') updateClienteOrdiniSelect();
      if (typeof startOrdineStatusPolling === 'function') startOrdineStatusPolling();
    }
    if (typeof saveSession === 'function') saveSession();
  } catch (e) {
    console.error('QR init error:', e);
    toast('Errore apertura menu da QR: ' + (e.message || e));
  }
})();

// =====================================================
// ESTENSIONI MenuPro v2 – offline, multi-rist, geo, drag,
// pagamenti, chiusura fiscale, PDF, stampa, polling
// =====================================================

const CIRCUITI_LABEL = {
  visa: 'Visa', mastercard: 'Mastercard', satispay: 'Satispay',
  paypal: 'PayPal', amex: 'American Express', applepay: 'Apple Pay'
};

let userRistoranti = [];       // lista ristoranti accessibili
let offlineQueue = [];         // { type, payload, ts }
let geoOk = false;
let _ordiniPoll = null;
let _lastOrdiniHash = '';

// ---- Offline queue (localStorage) ----
function loadOfflineQueue() {
  try { offlineQueue = JSON.parse(localStorage.getItem('mp_offline_q') || '[]'); } catch (e) { offlineQueue = []; }
}
function saveOfflineQueue() {
  localStorage.setItem('mp_offline_q', JSON.stringify(offlineQueue));
}
function enqueueOffline(type, payload) {
  offlineQueue.push({ type, payload, ts: Date.now() });
  saveOfflineQueue();
  const b = $('#offline-badge');
  if (b) b.classList.remove('hidden');
}

async function flushOfflineQueue() {
  if (!sb || !navigator.onLine || !offlineQueue.length) return;
  const q = [...offlineQueue];
  offlineQueue = [];
  saveOfflineQueue();
  for (const item of q) {
    try {
      if (item.type === 'update_stato') {
        await sb.from('ordini').update({ stato: item.payload.stato }).eq('id', item.payload.id);
        if (item.payload.stato === 'pronto') tryPrintComanda(item.payload.id);
      } else if (item.type === 'update_pag') {
        await sb.from('ordini').update({ stato_pagamento: item.payload.stato_pagamento }).eq('id', item.payload.id);
      }
    } catch (e) {
      offlineQueue.push(item);
    }
  }
  saveOfflineQueue();
  const b = $('#offline-badge');
  if (b) b.classList.toggle('hidden', offlineQueue.length === 0);
  if (currentRistorante && currentUser?.role !== 'cliente') {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
    if (typeof renderOrdiniKanban === 'function') await renderOrdiniKanban();
  }
}

window.addEventListener('online', () => {
  const b = $('#offline-badge');
  if (b) b.classList.add('hidden');
  flushOfflineQueue();
  toast('Connessione ripristinata – sincronizzazione...');
});
window.addEventListener('offline', () => {
  const b = $('#offline-badge');
  if (b) b.classList.remove('hidden');
  toast('Sei offline – le modifiche verranno sincronizzate');
});
loadOfflineQueue();

// Cache ristorante in IndexedDB-like (localStorage per semplicità)
function cacheRistoranteLocal(r) {
  if (!r || !r.id) return;
  try {
    localStorage.setItem('mp_cache_rist_' + r.id, JSON.stringify({
      ...r,
      _cachedAt: Date.now()
    }));
  } catch (e) {}
}
function getCachedRistorante(id) {
  try {
    const raw = localStorage.getItem('mp_cache_rist_' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Override loadRistoranteFull soft-fail offline (preserva opts.lite)
const _origLoadRist = loadRistoranteFull;
loadRistoranteFull = async function (id, opts) {
  ensureSb();
  if ((!navigator.onLine || !sb) && typeof getCachedRistorante === 'function') {
    const c = getCachedRistorante(id);
    if (c) { toast('Modalità offline – dati in cache'); return c; }
  }
  try {
    const r = await _origLoadRist(id, opts);
    if (r && typeof cacheRistoranteLocal === 'function') cacheRistoranteLocal(r);
    return r;
  } catch (e) {
    if (typeof getCachedRistorante === 'function') {
      const c = getCachedRistorante(id);
      if (c) return c;
    }
    console.warn('loadRistoranteFull error', e);
    return null;
  }
};

// ---- Multi-ristorante + staff ----
async function loadUserRistoranti(user) {
  if (!sb || !user) return [];
  if (user.ruolo === 'admin') {
    return await loadRistoranti();
  }
  // via utenti_ristoranti
  const { data: links } = await sb.from('utenti_ristoranti')
    .select('id_ristorante, ruolo_locale, ristoranti(*)')
    .eq('id_utente', user.id);
  if (links && links.length) {
    return links.map(l => ({ ...l.ristoranti, _ruolo_locale: l.ruolo_locale })).filter(Boolean);
  }
  // fallback: email match
  const { data: byEmail } = await sb.from('ristoranti').select('*').eq('email', user.email);
  return byEmail || [];
}

function applyStaffNav(isStaff) {
  $$('#rist-nav .nav-full').forEach(el => {
    el.style.display = isStaff ? 'none' : '';
  });
  if (isStaff) {
    const ordNav = document.querySelector('#rist-nav .nav-item[data-page="rist-ordini"]');
    if (ordNav) ordNav.click();
  }
}

function populateRistSwitcher() {
  const wrap = $('#rist-switcher-wrap');
  const sel = $('#rist-switcher');
  if (!wrap || !sel) return;
  if (userRistoranti.length <= 1) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  sel.innerHTML = userRistoranti.map(r =>
    `<option value="${r.id}" ${currentRistorante && r.id === currentRistorante.id ? 'selected' : ''}>${r.nome}</option>`
  ).join('');
}

$('#rist-switcher')?.addEventListener('change', async (e) => {
  const id = e.target.value;
  const r = userRistoranti.find(x => x.id === id);
  if (!r) return;
  currentRistorante = await loadRistoranteFull(id);
  currentUser.ristoranteId = id;
  $('#rist-nome-sidebar').textContent = currentRistorante.nome;
  await renderRistDashboard();
  await renderMenuTable();
  await renderOrdiniKanban();
  await renderTavoli();
  if (typeof renderChiusuraFiscale === 'function') await renderChiusuraFiscale();
  toast('Ristorante: ' + currentRistorante.nome);
});

// Patch enterAsRistoratore
const _origEnterRist = enterAsRistoratore;
enterAsRistoratore = async function (r) {
  // se arriva da login con user object
  if (r && r.ruolo === 'staff') {
    currentUser = { role: 'staff', email: r.email, id: r.id, ristoranteId: r.ristoranteId };
  }
  const ok = await _origEnterRist(r);
  if (currentUser && currentUser.role !== 'cliente') {
    const uRow = await sb?.from('utenti').select('*').eq('email', currentUser.email).maybeSingle();
    if (uRow?.data) {
      currentUser.id = uRow.data.id;
      currentUser.ruolo = uRow.data.ruolo;
      userRistoranti = await loadUserRistoranti(uRow.data);
      if (!userRistoranti.length && currentRistorante) userRistoranti = [currentRistorante];
      populateRistSwitcher();
      applyStaffNav(uRow.data.ruolo === 'staff' || (userRistoranti[0]?._ruolo_locale === 'staff'));
    }
  }
  startOrdiniPolling();
  return ok;
};

// ---- Polling silenzioso ordini ogni 3s ----
function startOrdiniPolling() {
  stopOrdiniPolling();
  _ordiniPoll = setInterval(async () => {
    if (!currentRistorante || !sb || !navigator.onLine) return;
    if (currentUser?.role === 'cliente') return;
    try {
      const { data } = await sb.from('ordini')
        .select('id,stato,stato_pagamento,totale,codice,tavolo,created_at')
        .eq('id_ristorante', currentRistorante.id)
        .order('created_at', { ascending: false })
        .limit(80);
      const hash = JSON.stringify((data || []).map(o => o.id + o.stato + o.stato_pagamento));
      if (hash !== _lastOrdiniHash) {
        _lastOrdiniHash = hash;
        // merge leggero senza ricaricare menu/tavoli interi
        if (currentRistorante && data) {
          const byId = {};
          (currentRistorante.ordini || []).forEach(o => { byId[o.id] = o; });
          currentRistorante.ordini = data.map(o => {
            const prev = byId[o.id];
            return {
              ...(prev || {}),
              ...o,
              items: (prev && prev.items) || o.items || [],
              createdAt: o.created_at
            };
          });
        }
        const onOrdini = !$('#page-rist-ordini')?.classList.contains('hidden');
        const onDash = !$('#page-rist-dashboard')?.classList.contains('hidden');
        if (onOrdini) await renderOrdiniKanban(false);
        if (onDash) await renderRistDashboard(false);
        const n = (data || []).filter(o => o.stato === 'nuovo').length;
        const badge = $('#badge-ordini');
        if (badge) {
          badge.textContent = n;
          badge.classList.toggle('hidden', n === 0);
        }
      }
    } catch (e) { /* silenzioso */ }
  }, 5000);
}
function stopOrdiniPolling() {
  if (_ordiniPoll) { clearInterval(_ordiniPoll); _ordiniPoll = null; }
}

// ---- Geo anti-truffa ----
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function requestGeoForOrder() {
  return new Promise((resolve) => {
    if (!currentRistorante?.lat || !currentRistorante?.lng) {
      // se non configurato, permettere (admin deve impostare lat/lng)
      geoOk = true;
      resolve(true);
      return;
    }
    if (!navigator.geolocation) {
      toast('Geolocalizzazione non supportata');
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const dist = haversineM(
          pos.coords.latitude, pos.coords.longitude,
          currentRistorante.lat, currentRistorante.lng
        );
        const raggio = currentRistorante.raggio_metri || 250;
        if (dist <= raggio) {
          geoOk = true;
          $('#geo-banner')?.classList.add('hidden');
          resolve(true);
        } else {
          geoOk = false;
          toast('Sei troppo lontano dal ristorante (' + Math.round(dist) + ' m). Ordine non consentito.');
          resolve(false);
        }
      },
      () => {
        toast('Posizione negata: non puoi ordinare da remoto');
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

$('#btn-geo-ok')?.addEventListener('click', async () => {
  const ok = await requestGeoForOrder();
  if (ok) toast('Posizione confermata – puoi ordinare');
});

// Mostra banner geo all'ingresso cliente
const _origInitQR = null; // already ran; hook showCliente
function ensureGeoOnCliente() {
  if (!currentRistorante) return;
  if (currentRistorante.lat && currentRistorante.lng) {
    geoOk = false;
    $('#geo-banner')?.classList.remove('hidden');
  } else {
    geoOk = true;
    $('#geo-banner')?.classList.add('hidden');
  }
}

// Patch invio ordine: geo + circuiti + pagamento config
const inviaBtn = $('#btn-invia-ordine');
if (inviaBtn) {
  const newHandler = async (e) => {
    e?.preventDefault?.();
    if (!cart.length) { toast('Il carrello è vuoto'); return; }
    if (!geoOk) {
      const ok = await requestGeoForOrder();
      if (!ok) return;
    }
    // prosegui con logica originale via click programmato non possibile: reimplementa core
    await inviaOrdineCliente();
  };
  inviaBtn.replaceWith(inviaBtn.cloneNode(true));
  $('#btn-invia-ordine')?.addEventListener('click', newHandler);
}

async function inviaOrdineCliente() {
  if (!cart.length) { toast('Il carrello è vuoto'); return; }
  if (!currentRistorante || !currentUser) {
    toast('Sessione cliente non valida. Riscansiona il QR.');
    return;
  }
  if (!sb) {
    toast('Database non collegato');
    return;
  }
  if (!geoOk) {
    const ok = await requestGeoForOrder();
    if (!ok) return;
  }

  const totale = cart.reduce((s, c) => s + c.prezzo * c.qty, 0);
  const codice = 'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  let pagamento = document.querySelector('input[name="pagamento"]:checked')?.value || 'cassa';
  const circuito = ($('#circuito-carta')?.value || '').trim() || null;
  if (pagamento === 'carta' && !circuito) {
    toast('Seleziona il circuito di pagamento');
    return;
  }
  const stato_pagamento = pagamento === 'carta' ? 'pagato' : 'in_attesa';
  const note = ($('#ordine-note')?.value || '').trim();
  const tavoloNum = currentUser.tavolo;

  const ordineBase = {
    id_ristorante: currentRistorante.id,
    codice,
    tavolo: tavoloNum,
    note,
    pagamento,
    circuito: pagamento === 'carta' ? circuito : null,
    stato_pagamento,
    totale,
    stato: 'nuovo'
  };

  let inserted = null;
  let error = null;
  ({ data: inserted, error } = await sb.from('ordini').insert({
    ...ordineBase,
    items: cart.map(c => ({ id: c.id, nome: c.nome, prezzo: c.prezzo, qty: c.qty }))
  }).select().single());

  if (error && String(error.message || '').toLowerCase().includes('items')) {
    ({ data: inserted, error } = await sb.from('ordini').insert(ordineBase).select().single());
  }
  if (error || !inserted) {
    toast('Errore invio ordine: ' + (error?.message || 'sconosciuto'));
    return;
  }

  // UI immediata dopo insert principale (non attendere le secondarie)
  const cartSnapshot = cart.slice();
  lastOrdineId = inserted.id;
  if (!sessionOrders.find(x => x.id === inserted.id)) {
    sessionOrders.push({ id: inserted.id, codice });
  }

  $('#ricevuta-codice').textContent = codice;
  $('#ricevuta-rist').textContent = currentRistorante.nome;
  $('#ricevuta-tavolo').textContent = currentUser.tavolo;
  $('#ricevuta-ora').textContent = formatTime(inserted.created_at || new Date().toISOString());
  $('#ricevuta-pagamento').textContent = pagamento === 'cassa'
    ? 'Pago in cassa'
    : ('Carta' + (circuito ? ' (' + (CIRCUITI_LABEL[circuito] || circuito) + ')' : ''));
  $('#ricevuta-totale').textContent = formatPrice(totale);
  $('#ricevuta-stato').textContent = 'Nuovo';
  $('#ricevuta-stato').className = 'badge-stato nuovo';
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(stato_pagamento);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + stato_pagamento;
  }
  $('#ricevuta-items').innerHTML = cartSnapshot.map(i =>
    `<div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>`
  ).join('');

  const pdfBtn = $('#btn-scarica-ricevuta');
  if (pdfBtn) {
    pdfBtn.style.display = pagamento === 'carta' ? 'block' : 'none';
    pdfBtn.dataset.ordineId = inserted.id;
  }

  cart = [];
  updateCartCount();
  if ($('#ordine-note')) $('#ordine-note').value = '';
  showClienteView('ricevuta');
  if ($('#cliente-stato-btn')) $('#cliente-stato-btn').style.display = 'inline-flex';
  updateClienteOrdiniSelect();
  startOrdineStatusPolling();
  toast('Ordine inviato!');
  if (typeof saveSession === 'function' && currentUser?.fromQR) saveSession();

  // Secondarie in parallelo (non bloccano UI)
  Promise.all([
    sb.from('ordine_riga').insert(cartSnapshot.map(c => ({
      id_ordine: inserted.id,
      id_piatto: c.id || null,
      piatto: c.nome,
      qty_piatti: c.qty,
      prezzo_pagato: Number(c.prezzo) * c.qty
    }))).catch(() => {}),
    note ? sb.from('messaggio').insert({ id_ordine: inserted.id, testo: note }).catch(() => {}) : Promise.resolve(),
    sb.from('pagamento').insert({
      id_ordine: inserted.id,
      metodo: pagamento,
      circuito: pagamento === 'carta' ? circuito : null,
      importo: totale
    }).catch(() => {}),
    sb.from('tavoli').update({ occupato: true })
      .eq('id_ristorante', currentRistorante.id)
      .eq('numero', currentUser.tavolo).catch(() => {})
  ]).catch(() => {});
}

// Configura opzioni pagamento cliente in base al ristorante
function setupClientePagamenti() {
  const r = currentRistorante;
  if (!r) return;
  const metodo = r.metodo_pagamento || 'entrambi';
  const opts = $$('#payment-options .payment-opt');
  opts.forEach(lab => {
    const t = lab.dataset.tipo;
    if (metodo === 'entrambi') lab.style.display = '';
    else if (metodo === 'carta') lab.style.display = t === 'carta' ? '' : 'none';
    else lab.style.display = t === 'cassa' ? '' : 'none';
  });
  // check default
  const firstVisible = document.querySelector('#payment-options .payment-opt[style=""], #payment-options .payment-opt:not([style*="none"]) input');
  if (firstVisible) firstVisible.checked = true;

  const circuiti = r.circuiti_carta || ['visa', 'mastercard', 'satispay', 'paypal'];
  const sel = $('#circuito-carta');
  const wrap = $('#circuiti-wrap');
  if (sel) {
    sel.innerHTML = circuiti.map(c =>
      `<option value="${c}">${CIRCUITI_LABEL[c] || c}</option>`
    ).join('');
  }
  function syncCircuiti() {
    const v = document.querySelector('input[name="pagamento"]:checked')?.value;
    if (wrap) wrap.style.display = (v === 'carta' && (metodo === 'carta' || metodo === 'entrambi')) ? 'block' : 'none';
  }
  $$('input[name="pagamento"]').forEach(rdo => rdo.addEventListener('change', syncCircuiti));
  syncCircuiti();
}

// Hook renderClienteMenu
const _origRenderClienteMenu = renderClienteMenu;
renderClienteMenu = function () {
  _origRenderClienteMenu();
  setupClientePagamenti();
  ensureGeoOnCliente();
};

// ---- PDF ricevuta ----
$('#btn-scarica-ricevuta')?.addEventListener('click', () => {
  if (typeof jspdf === 'undefined' && !window.jspdf) {
    toast('Libreria PDF non caricata');
    return;
  }
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) { toast('jsPDF non disponibile'); return; }
  const doc = new jsPDF();
  const codice = $('#ricevuta-codice')?.textContent || '';
  const rist = $('#ricevuta-rist')?.textContent || '';
  const tavolo = $('#ricevuta-tavolo')?.textContent || '';
  const ora = $('#ricevuta-ora')?.textContent || '';
  const pag = $('#ricevuta-pagamento')?.textContent || '';
  const totale = $('#ricevuta-totale')?.textContent || '';
  const items = [...document.querySelectorAll('#ricevuta-items .r-item')].map(el => el.textContent.trim());

  doc.setFontSize(16);
  doc.text('Ricevuta ordine', 20, 20);
  doc.setFontSize(11);
  doc.text(rist, 20, 30);
  doc.text('Codice: ' + codice, 20, 38);
  doc.text('Tavolo: ' + tavolo + '  ·  ' + ora, 20, 46);
  doc.text('Pagamento: ' + pag, 20, 54);
  let y = 64;
  doc.text('Dettaglio:', 20, y);
  y += 8;
  items.forEach(line => {
    doc.text(line, 22, y);
    y += 7;
  });
  y += 4;
  doc.setFontSize(13);
  doc.text('Totale: ' + totale, 20, y);
  y += 12;
  doc.setFontSize(9);
  doc.text('Documento non fiscale – solo ricevuta di cortesia', 20, y);
  doc.save('ricevuta-' + codice + '.pdf');
});

// Modal conferma in-app (niente alert browser)
function uiConfirm(message, title) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal-confirm');
    if (!modal) { resolve(window.confirm(message)); return; }
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const yes = document.getElementById('confirm-yes');
    const no = document.getElementById('confirm-no');
    const x = document.getElementById('confirm-x');
    if (titleEl) titleEl.textContent = title || 'Conferma';
    if (msgEl) msgEl.textContent = message;
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      yes && yes.removeEventListener('click', onYes);
      no && no.removeEventListener('click', onNo);
      x && x.removeEventListener('click', onNo);
      resolve(val);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    yes && yes.addEventListener('click', onYes);
    no && no.addEventListener('click', onNo);
    x && x.addEventListener('click', onNo);
  });
}

// ---- Drag & drop Kanban ----
function enableKanbanDrag() {
  const cols = $$('.kanban-body');
  cols.forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/ordine-id');
      const from = e.dataTransfer.getData('text/from-stato');
      const toCol = col.closest('.kanban-col');
      const to = toCol?.dataset.stato;
      if (!id || !to || from === to) return;
      // conferma salti grandi
      const order = ['nuovo', 'in_preparazione', 'pronto'];
      const fi = order.indexOf(from);
      const ti = order.indexOf(to);
      if (fi >= 0 && ti >= 0 && Math.abs(ti - fi) > 1) {
        const ok = await uiConfirm(
          'Vuoi davvero passare da "' + labelStato(from) + '" a "' + labelStato(to) + '"?',
          'Conferma spostamento'
        );
        if (!ok) return;
      }
      await cambiaStatoOrdineSafe(id, to, from);
    });
  });
}

async function cambiaStatoOrdineSafe(ordineId, nuovoStato, fromStato) {
  if (!navigator.onLine || !sb) {
    enqueueOffline('update_stato', { id: ordineId, stato: nuovoStato });
    // update locale
    const o = currentRistorante?.ordini?.find(x => x.id === ordineId);
    if (o) o.stato = nuovoStato;
    await renderOrdiniKanban();
    toast('Stato salvato offline – sarà sincronizzato');
    return;
  }
  const { error } = await sb.from('ordini').update({ stato: nuovoStato }).eq('id', ordineId);
  if (error) { toast('Errore: ' + error.message); return; }
  // stampa automatica quando passa a pronto
  if (nuovoStato === 'pronto' && fromStato === 'in_preparazione') {
    tryPrintComanda(ordineId);
  }
  if (currentRistorante) {
    currentRistorante = await loadRistoranteFull(currentRistorante.id);
  }
  await renderOrdiniKanban();
  await renderRistDashboard();
  toast('Stato: ' + labelStato(nuovoStato));
}

// Patch renderOrdiniKanban to add draggable
const _origRenderOrdini = typeof renderOrdiniKanban === 'function' ? renderOrdiniKanban : null;
if (_origRenderOrdini) {
  renderOrdiniKanban = async function () {
    await _origRenderOrdini();
    $$('.kanban-card').forEach(card => {
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => {
        const id = card.dataset.id || card.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        const col = card.closest('.kanban-col');
        e.dataTransfer.setData('text/ordine-id', id || '');
        e.dataTransfer.setData('text/from-stato', col?.dataset.stato || '');
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    // ensure data-id on cards if missing – re-scan from current data
    enableKanbanDrag();
  };
}

// Override window.avanzaStato if exists to use safe + print
if (typeof window.avanzaStato === 'function') {
  const _av = window.avanzaStato;
  window.avanzaStato = async function (ordineId, nuovoStato) {
    const o = currentRistorante?.ordini?.find(x => x.id === ordineId);
    const from = o?.stato || 'nuovo';
    await cambiaStatoOrdineSafe(ordineId, nuovoStato, from);
  };
}

// ---- Stampa comanda (Epson TM-T88) ----
// Browser non può stampare ESC/POS direttamente in silenzio.
// Strategia: 1) genera testo comanda 2) window.print con CSS termico
// Per stampa silenziosa vera: installare QZ Tray e collegare.
async function tryPrintComanda(ordineId) {
  let o = currentRistorante?.ordini?.find(x => x.id === ordineId);
  if (!o && sb) {
    const { data } = await sb.from('ordini').select('*').eq('id', ordineId).single();
    o = data;
  }
  if (!o) return;
  let items = o.items || [];
  if (!items.length && sb) {
    const { data: righe } = await sb.from('ordine_riga').select('*').eq('id_ordine', ordineId);
    items = (righe || []).map(r => ({ nome: r.piatto, qty: r.qty_piatti || 1, prezzo: 0 }));
  }
  const lines = [
    '================================',
    '  COMANDA CUCINA',
    '================================',
    'Codice: ' + (o.codice || ''),
    'Tavolo: ' + (o.tavolo || ''),
    'Ora: ' + formatTime(o.created_at || o.createdAt || new Date().toISOString()),
    '--------------------------------',
    ...items.map(i => (i.qty || 1) + 'x  ' + (i.nome || '')),
    o.note ? ('NOTE: ' + o.note) : '',
    '================================'
  ].filter(Boolean);

  const w = window.open('', '_blank', 'width=400,height=600');
  if (!w) {
    toast('Consenti popup per stampare la comanda');
    return;
  }
  w.document.write(`<!DOCTYPE html><html><head><title>Comanda ${o.codice}</title>
    <style>
      @page { size: 80mm auto; margin: 4mm; }
      body { font-family: monospace; font-size: 13px; white-space: pre-wrap; }
      @media print { body { margin: 0; } }
    </style></head><body>${lines.join('\n')}</body></html>`);
  w.document.close();
  setTimeout(() => { w.print(); }, 400);
  toast('Comanda inviata in stampa');
}

// ---- Chiusura fiscale ----
async function renderChiusuraFiscale() {
  if (!currentRistorante || !sb) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data: ordini } = await sb.from('ordini')
    .select('*')
    .eq('id_ristorante', currentRistorante.id)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');

  const list = ordini || [];
  let tot = 0, carta = 0, cassa = 0;
  list.forEach(o => {
    const t = Number(o.totale) || 0;
    tot += t;
    if (o.pagamento === 'carta') carta += t;
    else cassa += t;
  });
  if ($('#chiusura-totale-oggi')) $('#chiusura-totale-oggi').textContent = formatPrice(tot);
  if ($('#chiusura-n-ordini')) $('#chiusura-n-ordini').textContent = list.length;
  if ($('#chiusura-carta')) $('#chiusura-carta').textContent = formatPrice(carta);
  if ($('#chiusura-cassa')) $('#chiusura-cassa').textContent = formatPrice(cassa);

  const el = $('#chiusura-oggi-list');
  if (el) {
    el.innerHTML = list.length
      ? list.map(o => `
        <div class="recent-item">
          <span><strong>${o.codice}</strong> · Tav ${o.tavolo} · ${o.pagamento}${o.circuito ? ' (' + o.circuito + ')' : ''}</span>
          <span>${formatPrice(o.totale)}</span>
        </div>`).join('')
      : '<p style="color:var(--muted)">Nessun ordine oggi</p>';
  }

  const { data: storico } = await sb.from('chiusure_fiscali')
    .select('*')
    .eq('id_ristorante', currentRistorante.id)
    .order('data_giorno', { ascending: false })
    .limit(30);
  const body = $('#chiusure-storico-body');
  if (body) {
    body.innerHTML = (storico || []).length
      ? storico.map(c => `
        <tr>
          <td>${c.data_giorno}</td>
          <td>${c.n_ordini}</td>
          <td>${formatPrice(c.totale)}</td>
          <td>${formatPrice(c.totale_carta)}</td>
          <td>${formatPrice(c.totale_cassa)}</td>
          <td>${c.chiuso_at ? formatTime(c.chiuso_at) : '—'}</td>
          <td><button class="btn btn-secondary btn-sm" onclick="exportChiusuraPdf('${c.id}')"><i class="fas fa-file-pdf"></i></button></td>
        </tr>`).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--muted)">Nessuna chiusura ancora</td></tr>';
  }
}

$('#btn-chiudi-giornata')?.addEventListener('click', async () => {
  if (!currentRistorante || !sb) return;
  if (!(await uiConfirm('Chiudere la giornata fiscale di oggi?', 'Chiusura giornata'))) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data: ordini } = await sb.from('ordini')
    .select('*')
    .eq('id_ristorante', currentRistorante.id)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');
  const list = ordini || [];
  let tot = 0, carta = 0, cassa = 0;
  const dettaglio = list.map(o => {
    const t = Number(o.totale) || 0;
    tot += t;
    if (o.pagamento === 'carta') carta += t; else cassa += t;
    return { codice: o.codice, tavolo: o.tavolo, totale: t, pagamento: o.pagamento, circuito: o.circuito };
  });
  const { error } = await sb.from('chiusure_fiscali').upsert({
    id_ristorante: currentRistorante.id,
    data_giorno: today,
    totale: tot,
    n_ordini: list.length,
    totale_carta: carta,
    totale_cassa: cassa,
    dettaglio,
    chiuso_at: new Date().toISOString(),
    chiuso_da: currentUser?.id || null
  }, { onConflict: 'id_ristorante,data_giorno' });
  if (error) { toast('Errore: ' + error.message); return; }
  toast('Giornata chiusa – totale ' + formatPrice(tot));
  await renderChiusuraFiscale();
});

$('#btn-export-chiusura-pdf')?.addEventListener('click', () => {
  exportChiusuraOggiPdf();
});

function exportChiusuraOggiPdf() {
  if (!window.jspdf?.jsPDF) { toast('jsPDF non disponibile'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text('Chiusura fiscale – ' + (currentRistorante?.nome || ''), 20, 20);
  doc.setFontSize(11);
  doc.text('Data: ' + new Date().toLocaleDateString('it-IT'), 20, 30);
  doc.text('Incasso: ' + ($('#chiusura-totale-oggi')?.textContent || ''), 20, 38);
  doc.text('Ordini: ' + ($('#chiusura-n-ordini')?.textContent || ''), 20, 46);
  doc.text('Carta: ' + ($('#chiusura-carta')?.textContent || ''), 20, 54);
  doc.text('Cassa: ' + ($('#chiusura-cassa')?.textContent || ''), 20, 62);
  doc.save('chiusura-' + new Date().toISOString().slice(0, 10) + '.pdf');
}

window.exportChiusuraPdf = async function (id) {
  if (!sb || !window.jspdf?.jsPDF) return;
  const { data: c } = await sb.from('chiusure_fiscali').select('*').eq('id', id).single();
  if (!c) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(14);
  doc.text('Chiusura fiscale', 20, 20);
  doc.setFontSize(11);
  doc.text('Data giorno: ' + c.data_giorno, 20, 30);
  doc.text('Totale: ' + formatPrice(c.totale), 20, 38);
  doc.text('Ordini: ' + c.n_ordini, 20, 46);
  doc.text('Carta: ' + formatPrice(c.totale_carta), 20, 54);
  doc.text('Cassa: ' + formatPrice(c.totale_cassa), 20, 62);
  doc.save('chiusura-' + c.data_giorno + '.pdf');
};

// Nav chiusura
$$('#app-ristoratore .nav-item').forEach(item => {
  item.addEventListener('click', async () => {
    if (item.dataset.page === 'rist-chiusura') {
      await renderChiusuraFiscale();
    }
  });
});

// ---- Salvataggio ristorante: metodi pagamento + geo ----
(function patchFormRistorante() {
  const form = $('#form-ristorante');
  if (!form) return;
  form.addEventListener('submit', (e) => {
    // i valori vengono letti dal submit handler esistente; patchiamo i dati prima
    // tramite override leggero: intercettiamo dopo un tick non serve.
  }, true);
})();

// Estendi dati insert/update ristorante
const _origFormSubmit = $('#form-ristorante');
// Monkey-patch create/update data object inside existing handler is hard;
// aggiungiamo listener che aggiorna dopo il save se campi presenti.
$('#form-ristorante')?.addEventListener('submit', async () => {
  setTimeout(async () => {
    if (!sb) return;
    const id = $('#edit-id')?.value;
    // per nuovo ristorante l'id non c'è ancora: prova a cercare per email
    const email = ($('#email')?.value || '').trim().toLowerCase();
    const extra = {
      metodo_pagamento: $('#metodo_pagamento')?.value || 'entrambi',
      circuiti_carta: [...$$('#circuiti-grid input:checked')].map(c => c.value),
      lat: parseFloat($('#rist-lat')?.value) || null,
      lng: parseFloat($('#rist-lng')?.value) || null,
      raggio_metri: parseInt($('#rist-raggio')?.value, 10) || 250
    };
    if (id) {
      await sb.from('ristoranti').update(extra).eq('id', id);
    } else if (email) {
      await sb.from('ristoranti').update(extra).eq('email', email);
    }
  }, 1500);
});

// Toggle circuiti form
$('#metodo_pagamento')?.addEventListener('change', () => {
  const v = $('#metodo_pagamento').value;
  const wrap = $('#circuiti-form-wrap');
  if (wrap) wrap.style.display = v === 'cassa' ? 'none' : '';
});

// Popola campi edit
const _origEditRist = window.editRistorante;
window.editRistorante = async function (id) {
  await _origEditRist(id);
  const { data: r } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (!r) return;
  if ($('#metodo_pagamento')) $('#metodo_pagamento').value = r.metodo_pagamento || 'entrambi';
  if ($('#rist-lat')) $('#rist-lat').value = r.lat ?? '';
  if ($('#rist-lng')) $('#rist-lng').value = r.lng ?? '';
  if ($('#rist-raggio')) $('#rist-raggio').value = r.raggio_metri || 250;
  const circuiti = r.circuiti_carta || ['visa', 'mastercard', 'satispay', 'paypal'];
  $$('#circuiti-grid input').forEach(c => { c.checked = circuiti.includes(c.value); });
  const wrap = $('#circuiti-form-wrap');
  if (wrap) wrap.style.display = (r.metodo_pagamento === 'cassa') ? 'none' : '';
};


// =====================================================
// SESSIONE / REFRESH
// Admin + Ristoratore: restano al refresh (niente flash)
// Cliente da ADMIN demo: al refresh torna ADMIN
// Cliente da QR: resta cliente + ordini
// =====================================================
function saveSession() {
  try {
    if (!currentUser?.role) return;
    // Cliente da demo admin: non salvare (al refresh torna admin)
    if (currentUser.role === 'cliente' && currentUser.fromAdminDemo) return;
    localStorage.setItem('mp_session', JSON.stringify({
      role: currentUser.role,
      email: currentUser.email || null,
      id: currentUser.id || null,
      ruolo: currentUser.ruolo || currentUser.role,
      ristoranteId: currentRistorante?.id || currentUser.ristoranteId || null,
      tavolo: currentUser.tavolo != null ? currentUser.tavolo : null,
      lastOrdineId: lastOrdineId || null,
      sessionOrders: sessionOrders || [],
      cart: cart || [],
      fromQR: !!currentUser.fromQR,
      ts: Date.now()
    }));
  } catch (_) {}
}
function clearRestoringClass() {
  document.documentElement.classList.remove(
    'mp-restoring', 'mp-role-admin', 'mp-role-ristoratore', 'mp-role-staff', 'mp-role-cliente'
  );
}
async function restoreSession() {
  try {
    const raw = localStorage.getItem('mp_session');
    if (!raw || !sb) { clearRestoringClass(); return false; }
    const s = JSON.parse(raw);
    if (!s?.role || !s.ts || Date.now() - s.ts > 12 * 60 * 60 * 1000) {
      localStorage.removeItem('mp_session');
      clearRestoringClass();
      return false;
    }
    if (s.role === 'cliente' && s.fromQR && s.ristoranteId && s.tavolo != null) {
      document.documentElement.classList.add('mp-role-cliente');
      const r = await loadRistoranteFull(s.ristoranteId);
      if (!r) { clearRestoringClass(); return false; }
      currentUser = { role: 'cliente', ristoranteId: s.ristoranteId, tavolo: s.tavolo, fromQR: true };
      currentRistorante = r;
      cart = Array.isArray(s.cart) ? s.cart : [];
      lastOrdineId = s.lastOrdineId || null;
      sessionOrders = Array.isArray(s.sessionOrders) ? s.sessionOrders : [];
      document.body.classList.add('cliente-night');
      $('#login-screen')?.classList.add('hidden');
      $('#app-admin')?.classList.add('hidden');
      $('#app-ristoratore')?.classList.add('hidden');
      $('#app-cliente')?.classList.remove('hidden');
      if ($('#cliente-rist-nome')) $('#cliente-rist-nome').textContent = r.nome;
      if ($('#cliente-tavolo-num')) $('#cliente-tavolo-num').textContent = s.tavolo;
      showClienteView(lastOrdineId ? 'ricevuta' : 'menu');
      renderClienteMenu();
      if (typeof setupClientePagamenti === 'function') setupClientePagamenti();
      if (typeof ensureGeoOnCliente === 'function') ensureGeoOnCliente();
      if (typeof updateCartCount === 'function') updateCartCount();
      if (lastOrdineId) {
        if (typeof updateClienteOrdiniSelect === 'function') updateClienteOrdiniSelect();
        if (typeof startOrdineStatusPolling === 'function') startOrdineStatusPolling();
        try {
          const { data: o } = await sb.from('ordini').select('*').eq('id', lastOrdineId).single();
          if (o) {
            if ($('#ricevuta-codice')) $('#ricevuta-codice').textContent = o.codice || '';
            if ($('#ricevuta-rist')) $('#ricevuta-rist').textContent = r.nome;
            if ($('#ricevuta-tavolo')) $('#ricevuta-tavolo').textContent = o.tavolo;
            if ($('#ricevuta-totale')) $('#ricevuta-totale').textContent = formatPrice(o.totale);
            if (typeof applyOrdineStatusUI === 'function') applyOrdineStatusUI(o, true);
          }
        } catch (_) {}
      }
      clearRestoringClass();
      return true;
    }
    if (s.role === 'admin' && s.email) {
      document.documentElement.classList.add('mp-role-admin');
      await enterAsAdmin(s.email);
      clearRestoringClass();
      return true;
    }
    if ((s.role === 'ristoratore' || s.role === 'staff') && s.ristoranteId) {
      document.documentElement.classList.add(s.role === 'staff' ? 'mp-role-staff' : 'mp-role-ristoratore');
      const r = await loadRistoranteFull(s.ristoranteId);
      if (!r) { clearRestoringClass(); return false; }
      currentUser = { role: s.role, email: s.email, id: s.id, ruolo: s.ruolo || s.role, ristoranteId: s.ristoranteId };
      await enterAsRistoratore(r);
      if (s.email && typeof loadUserRistoranti === 'function') {
        const { data: u } = await sb.from('utenti').select('*').eq('email', s.email).maybeSingle();
        if (u) {
          userRistoranti = await loadUserRistoranti(u);
          if (!userRistoranti.length) userRistoranti = [r];
          if (typeof populateRistSwitcher === 'function') populateRistSwitcher();
          const meta = userRistoranti.find(x => x.id === r.id) || userRistoranti[0];
          if (typeof applyStaffNav === 'function') {
            applyStaffNav(u.ruolo === 'staff' || s.role === 'staff' || meta?._ruolo_locale === 'staff');
          }
        }
      }
      if (typeof startOrdiniPolling === 'function') startOrdiniPolling();
      clearRestoringClass();
      return true;
    }
  } catch (e) { console.warn('restoreSession', e); }
  clearRestoringClass();
  return false;
}

const _enterAdminSess = enterAsAdmin;
enterAsAdmin = async function (email) {
  const ok = await _enterAdminSess(email);
  saveSession();
  return ok;
};
const _enterRistSess = enterAsRistoratore;
enterAsRistoratore = async function (r) {
  const ok = await _enterRistSess(r);
  if (currentUser?.role !== 'cliente') saveSession();
  if (typeof startOrdiniPolling === 'function') startOrdiniPolling();
  return ok;
};
if (typeof inviaOrdineCliente === 'function') {
  const _inv = inviaOrdineCliente;
  inviaOrdineCliente = async function () {
    const res = await _inv.apply(this, arguments);
    if (currentUser?.fromQR) saveSession();
    return res;
  };
}

(async function bootSession() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('r') && params.get('t')) { clearRestoringClass(); return; }
  let n = 0;
  while (!sb && n < 40) { await new Promise(r => setTimeout(r, 50)); n++; }
  if (!currentUser) await restoreSession();
  else clearRestoringClass();
})();

console.log('MenuPro v2 extensions loaded');
