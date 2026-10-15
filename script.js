// =====================================================
// MenuPro – Versione sicura (Supabase Auth + RLS + RPC)
// =====================================================

const cfg = window.MENUPRO_CONFIG || {};
let sb = null;
try {
  if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      !String(cfg.SUPABASE_ANON_KEY).includes('INCOLLA')) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  } else {
    console.warn('Supabase non configurato correttamente in config.js');
  }
} catch (e) {
  console.error('Errore init Supabase:', e);
}

let currentUser = null;
let currentRistorante = null;
let cart = [];
let currentPeriod = 'oggi';
let currentSala = 0;
let menuFilterCat = 'tutti';
let lastOrdineId = null;
let loginMsg = '';
let ordiniChannel = null;

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

// ---------- utilità ----------
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// accetta solo URL http(s) o immagini data: (evita javascript: e simili)
function safeImg(u) {
  const s = String(u || '').trim();
  return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(s) ? s : '';
}

function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2800);
}

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.connect(g); g.connect(ac.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ac.currentTime + 0.25);
  } catch (e) { /* audio non disponibile */ }
}

function formatPrice(n) {
  return '€' + Number(n).toFixed(2).replace('.', ',');
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function isScaduto(scadenza) {
  return !!scadenza && scadenza < new Date().toISOString().slice(0, 10);
}

// chiamate alle API serverless (solo admin)
async function api(action, payload) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return { ok: false, error: 'Sessione scaduta, rifai il login' };
  try {
    const r = await fetch('/api/utenti', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
      body: JSON.stringify({ action, ...payload })
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: 'Errore di rete' };
  }
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

async function loadRistoranteFull(id) {
  const { data: r, error } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (error || !r) return null;

  const [tavoli, piatti, categorie, ordini, pagamenti] = await Promise.all([
    sb.from('tavoli').select('*').eq('id_ristorante', id).order('numero'),
    sb.from('piatti').select('*').eq('id_ristorante', id).order('nome'),
    sb.from('categorie').select('*').eq('id_ristorante', id).order('posizione'),
    sb.from('ordini').select('*').eq('id_ristorante', id).order('created_at', { ascending: false }).limit(500),
    sb.from('pagamenti_abbonamento').select('*').eq('id_ristorante', id).order('data', { ascending: false })
  ]);

  r.tavoli = tavoli.data || [];
  r.menu = (piatti.data || []).map(p => ({ ...p, allergeni: p.allergeni || [] }));
  r.categorie = (categorie.data || []).map(c => c.nome);
  if (!r.categorie.length) r.categorie = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
  r.ordini = (ordini.data || []).map(o => ({ ...o, items: o.items || [], createdAt: o.created_at }));
  r.pagamenti = pagamenti.data || [];
  r.sale = r.sale || ['Sala principale'];
  return r;
}

// menu pubblico per il cliente da QR (nessun dato sensibile, solo se abbonamento valido)
async function loadMenuPubblico(id) {
  const { data, error } = await sb.rpc('menu_pubblico', { p_id: id });
  if (error || !data) return null;
  return {
    id: data.id,
    nome: data.nome,
    menu: (data.menu || []).map(p => ({ ...p, allergeni: p.allergeni || [] })),
    categorie: data.categorie || [],
    tavoli: [], ordini: [], sale: []
  };
}

// =====================================================
// LOGIN (Supabase Auth)
// =====================================================

async function enterAsAdmin(email) {
  currentUser = { role: 'admin', email: email || '' };
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
  const rid = r.id || r.ristoranteId;
  const full = await loadRistoranteFull(rid);
  if (!full) { loginMsg = 'Ristorante non trovato'; return false; }
  if (isScaduto(full.scadenza)) {
    loginMsg = "Abbonamento scaduto: contatta l'amministratore";
    return false;
  }
  currentRistorante = full;
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: rid };
  $('#login-screen').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = full.nome || 'Ristorante';
  $('#rist-user-email').textContent = r.email || '';
  await renderRistDashboard();
  await renderMenuTable();
  await renderOrdiniKanban();
  await renderTavoli();
  subscribeOrdini(rid);
  return true;
}

// aggiornamento in tempo reale degli ordini
function subscribeOrdini(rid) {
  if (!sb) return;
  if (ordiniChannel) { sb.removeChannel(ordiniChannel); ordiniChannel = null; }
  ordiniChannel = sb.channel('ordini-' + rid)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'ordini', filter: 'id_ristorante=eq.' + rid },
      async (payload) => {
        if (!currentRistorante || currentUser?.role !== 'ristoratore') return;
        if (payload.eventType === 'INSERT') { beep(); toast('Nuovo ordine!'); }
        await renderRistDashboard();
        if (!$('#page-rist-ordini').classList.contains('hidden')) await renderOrdiniKanban();
      })
    .subscribe();
}

async function enterWithSession() {
  if (!sb) return false;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return false;
  const { data: p } = await sb.from('profili').select('*').eq('id', session.user.id).maybeSingle();
  if (!p) { loginMsg = 'Account non abilitato'; return false; }
  if (p.ruolo === 'admin') return await enterAsAdmin(p.email);
  if (p.ruolo === 'ristoratore' && p.id_ristorante) {
    return await enterAsRistoratore({ id: p.id_ristorante, email: p.email });
  }
  loginMsg = 'Account non abilitato';
  return false;
}

async function doLogin(email, pass) {
  email = (email || '').trim().toLowerCase();
  pass = pass || '';
  loginMsg = '';
  if (!email || !pass) { toast('Inserisci email e password'); return false; }
  if (!sb) { toast('Database non collegato: controlla config.js'); return false; }

  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { toast('Credenziali non valide'); return false; }

  const ok = await enterWithSession();
  if (!ok) {
    await sb.auth.signOut();
    toast(loginMsg || 'Account non abilitato');
  }
  return ok;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await doLogin($('#login-email').value, $('#login-password').value);
});

// =====================================================
// LOGOUT
// =====================================================
$$('.logout-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    if (ordiniChannel && sb) { sb.removeChannel(ordiniChannel); ordiniChannel = null; }
    if (sb) await sb.auth.signOut();
    currentUser = null;
    currentRistorante = null;
    cart = [];
    lastOrdineId = null;
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
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? '' : 'dark');
    $$('.theme-toggle i').forEach(i => { i.className = isDark ? 'fas fa-moon' : 'fas fa-sun'; });
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
  const attivi = ristoranti.filter(r => !isScaduto(r.scadenza)).length;
  let ricavi = 0;
  ristoranti.forEach(r => {
    const p = PIANI[r.id_piano];
    if (p && !isScaduto(r.scadenza)) ricavi += p.prezzo;
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
        <span><strong>${esc(r.nome)}</strong> · ${esc(r.citta || '—')}</span>
        <span class="badge badge-${esc(r.id_piano)}">${esc(r.id_piano)}</span>
      </div>
    `).join('');
  }
  await renderAdminCharts(ristoranti);
}

async function renderAdminCharts(ristoranti) {
  if (typeof Chart === 'undefined') return;

  // ricavi reali degli ultimi 6 mesi, dai pagamenti registrati
  const now = new Date();
  const mesi = [], vals = [], keys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    mesi.push(d.toLocaleDateString('it-IT', { month: 'short' }));
    keys.push(d.getFullYear() + '-' + d.getMonth());
    vals.push(0);
  }
  const { data: pags } = await sb.from('pagamenti_abbonamento').select('importo,data');
  (pags || []).forEach(p => {
    const d = new Date(p.data);
    const idx = keys.indexOf(d.getFullYear() + '-' + d.getMonth());
    if (idx >= 0) vals[idx] += Number(p.importo) || 0;
  });

  const ctx1 = document.getElementById('chart-ricavi-admin');
  if (ctx1) {
    if (chartRicaviAdmin) chartRicaviAdmin.destroy();
    chartRicaviAdmin = new Chart(ctx1, {
      type: 'bar',
      data: { labels: mesi, datasets: [{ label: '€', data: vals, backgroundColor: 'rgba(196, 92, 38, 0.7)', borderRadius: 6, borderSkipped: false }] },
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
      data: { labels: ['Base', 'Pro', 'Enterprise'], datasets: [{ data: [counts.base, counts.pro, counts.enterprise], backgroundColor: ['#c4a574', '#c45c26', '#3d6b8c'], borderWidth: 0 }] },
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
      (r.nome || '').toLowerCase().includes(q) ||
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
      <td><strong>${esc(r.nome)}</strong></td>
      <td>${esc(r.titolare || '—')}</td>
      <td>${esc(r.citta || '—')}</td>
      <td>${(r.sale || []).length}</td>
      <td><span class="badge badge-${esc(r.id_piano)}">${esc(r.id_piano)}</span></td>
      <td>${esc(r.scadenza || '—')}</td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="editRistorante('${esc(r.id)}')" title="Modifica"><i class="fas fa-edit"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="apriResetPassword('${esc(r.id)}')" title="Nuova password"><i class="fas fa-key"></i></button>
        <button class="btn btn-secondary btn-sm" onclick="adminApriMenu('${esc(r.id)}')" title="Gestisci menu"><i class="fas fa-book-open"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteRistorante('${esc(r.id)}')" title="Elimina"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

$('#search-ristoranti')?.addEventListener('input', e => renderAdminTable(e.target.value));

$('#btn-nuovo')?.addEventListener('click', () => {
  $('#modal-title').textContent = 'Nuovo ristorante';
  $('#form-ristorante').reset();
  $('#edit-id').value = '';
  $('#email').readOnly = false;
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
  const count = Math.min(200, Math.max(1, parseInt(n) || 8));
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({ id_ristorante: ristoranteId, numero: i, adulti: 4, bambini: 0, sala: 0, occupato: false, forma: 'round' });
  }
  await sb.from('tavoli').insert(rows);
}

async function createDefaultCategorie(ristoranteId) {
  const cats = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
  await sb.from('categorie').insert(cats.map((nome, i) => ({ id_ristorante: ristoranteId, nome, posizione: i })));
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
  await sb.from('piatti').insert(piatti.map(p => ({ ...p, id_ristorante: ristoranteId, disponibile: true })));
}

$('#form-ristorante')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) { toast('Database non collegato: controlla config.js'); return; }

  const id = $('#edit-id').value;
  const sale = ($('#sale').value.trim() || 'Sala principale').split(',').map(s => s.trim()).filter(Boolean);
  const nTavoli = parseInt($('#n_tavoli').value) || 8;
  const email = $('#email').value.trim().toLowerCase();
  const password = $('#password').value;
  const nomeRist = $('#nome').value.trim();
  const titolare = $('#titolare').value.trim();
  const piano = $('#id_piano').value;

  if (!email) { toast('Email ristoratore obbligatoria'); return; }
  if (piano === 'base' && sale.length > 1) { toast('Il piano Base consente una sola sala'); return; }
  if (password && password.length < 8) { toast('La password deve avere almeno 8 caratteri'); return; }

  const data = {
    nome: nomeRist, titolare, citta: $('#citta').value.trim(), email,
    id_piano: piano, scadenza: $('#scadenza').value || null, sale
  };

  if (id) {
    const { error } = await sb.from('ristoranti').update(data).eq('id', id);
    if (error) { toast('Errore aggiornamento: ' + error.message); return; }
    if (password) {
      const res = await api('reset_password', { id_ristorante: id, password });
      if (!res.ok) { toast('Ristorante aggiornato, ma password non cambiata: ' + (res.error || '')); return; }
    }
    toast('Ristorante aggiornato');
  } else {
    if (!password) { toast('Password obbligatoria per il ristoratore'); return; }

    const { data: inserted, error } = await sb.from('ristoranti').insert(data).select().single();
    if (error) { toast('Errore creazione ristorante: ' + error.message); return; }

    const res = await api('crea_ristoratore', { email, password, nome: titolare || nomeRist, id_ristorante: inserted.id });
    if (!res.ok) {
      await sb.from('ristoranti').delete().eq('id', inserted.id);
      toast('Account non creato: ' + (res.error || 'errore'));
      return;
    }
    await createDefaultTavoli(inserted.id, nTavoli);
    await createDefaultCategorie(inserted.id);
    await createDefaultMenu(inserted.id);
    toast('Ristorante e account ristoratore creati');
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
  $('#email').readOnly = true; // l'email è l'identità dell'account
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
  if (!confirm('Eliminare questo ristorante, i suoi dati e il suo account?')) return;
  const res = await api('elimina_ristorante', { id_ristorante: id });
  if (!res.ok) { toast('Errore eliminazione: ' + (res.error || '')); return; }
  await renderAdminTable($('#search-ristoranti')?.value || '');
  await renderAdminDashboard();
  await renderAbbonamenti();
  toast('Ristorante eliminato');
};

window.adminApriMenu = async function(id) {
  const r = await loadRistoranteFull(id);
  if (!r) return;
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
};

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
    oggi.setHours(0, 0, 0, 0);
    let statoLabel = 'Senza data', statoClass = 'badge-base', scadClass = '', scadText = '—';
    if (scad) {
      scadText = scad.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
      if (scad < oggi) {
        statoLabel = 'Scaduto'; scadClass = 'scadenza-late';
      } else {
        const diff = Math.ceil((scad - oggi) / (1000 * 60 * 60 * 24));
        if (diff <= 7) { statoLabel = 'In scadenza'; scadClass = 'scadenza-warn'; }
        else { statoLabel = 'Attivo'; statoClass = 'badge-pro'; scadClass = 'scadenza-ok'; }
      }
    }
    return `
      <tr>
        <td><strong>${esc(r.nome)}</strong></td>
        <td><span class="badge badge-${esc(r.id_piano)}">${esc(r.id_piano)}</span></td>
        <td class="${scadClass}">${scadText}</td>
        <td><span class="badge ${statoClass}">${statoLabel}</span></td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="estendiAbbonamento('${esc(r.id)}')">
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
  await sb.from('pagamenti_abbonamento').insert({ id_ristorante: id, importo: prezzo, piano: r.id_piano, tipo: 'rinnovo' });
  await renderAbbonamenti();
  await renderAdminDashboard();
  await renderMieiIncassi();
  toast('Rinnovato fino al ' + new Date(nuovaScad).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }) + ' (+' + formatPrice(prezzo) + ')');
};

// =====================================================
// MIEI INCASSI (una sola query per i pagamenti)
// =====================================================
async function renderMieiIncassi() {
  const ristoranti = await loadRistoranti();
  let totale = 0, mese = 0, inAttesa = 0;
  const now = new Date();
  const pagamenti = [];

  const { data: allPags } = await sb.from('pagamenti_abbonamento').select('*');
  const nomi = Object.fromEntries(ristoranti.map(r => [r.id, r.nome]));
  (allPags || []).forEach(p => {
    totale += Number(p.importo);
    const pd = new Date(p.data);
    if (pd.getMonth() === now.getMonth() && pd.getFullYear() === now.getFullYear()) mese += Number(p.importo);
    pagamenti.push({ ...p, ristorante: nomi[p.id_ristorante] || '—' });
  });
  ristoranti.forEach(r => {
    if (r.scadenza) {
      const diff = (new Date(r.scadenza) - now) / (1000 * 60 * 60 * 24);
      if (diff >= 0 && diff <= 7) inAttesa += PIANI[r.id_piano]?.prezzo || 0;
    }
  });

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
      const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
      const late = d < oggi;
      const warn = !late && (d - oggi) / (1000 * 60 * 60 * 24) <= 7;
      const cls = late ? 'scadenza-late' : (warn ? 'scadenza-warn' : 'scadenza-ok');
      const label = d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
      return `<div class="recent-item">
        <span><strong>${esc(s.nome)}</strong> · ${esc(s.piano)}</span>
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
        <span><strong>${esc(p.ristorante)}</strong> · ${esc(p.tipo)} (${esc(p.piano)})</span>
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
    ristoranti.map(r => `<option value="${esc(r.id)}">${esc(r.nome)}</option>`).join('');
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
  ordini.forEach(o => (o.items || []).forEach(i => { counts[i.nome] = (counts[i.nome] || 0) + i.qty; }));
  let topPiatto = '—', topQty = 0;
  Object.entries(counts).forEach(([nome, qty]) => { if (qty > topQty) { topPiatto = nome; topQty = qty; } });

  cont.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-icon green"><i class="fas fa-euro-sign"></i></div>
        <div><h3>${formatPrice(totale)}</h3><p>Incasso totale</p></div></div>
      <div class="card"><div class="card-icon blue"><i class="fas fa-calendar-day"></i></div>
        <div><h3>${formatPrice(oggi)}</h3><p>Incasso oggi</p></div></div>
      <div class="card"><div class="card-icon orange"><i class="fas fa-utensils"></i></div>
        <div><h3>${esc(topPiatto)}</h3><p>Piatto più venduto (${topQty}x)</p></div></div>
      <div class="card"><div class="card-icon purple"><i class="fas fa-receipt"></i></div>
        <div><h3>${ordini.length}</h3><p>Ordini totali</p></div></div>
    </div>
    <div class="recent-box">
      <h3>Ultimi ordini di ${esc(r.nome)}</h3>
      <div class="recent-list">
        ${ordini.length === 0 ? '<p style="color:var(--muted)">Nessun ordine.</p>' :
          ordini.slice(0, 10).map(o => `
            <div class="recent-item">
              <span>Tavolo ${esc(o.tavolo)} · ${formatPrice(o.totale)}</span>
              <span class="badge-stato ${esc(o.stato)}">${labelStato(o.stato)}</span>
            </div>
          `).join('')}
      </div>
    </div>
  `;
});

// DEMO UTENTE (l'admin prova l'area cliente)
$('#btn-demo-utente')?.addEventListener('click', async () => {
  const ristoranti = await loadRistoranti();
  if (!ristoranti.length) { toast('Crea prima un ristorante'); return; }
  $('#demo-ristorante').innerHTML = ristoranti.map(r => `<option value="${esc(r.id)}">${esc(r.nome)}</option>`).join('');
  $('#modal-demo-utente').classList.remove('hidden');
});

$('#btn-avvia-demo')?.addEventListener('click', async () => {
  const ristId = $('#demo-ristorante').value;
  const tavolo = parseInt($('#demo-tavolo').value) || 1;
  const r = await loadMenuPubblico(ristId);
  if (!r) { toast('Menu non disponibile (abbonamento scaduto?)'); return; }
  currentUser = { role: 'cliente', ristoranteId: ristId, tavolo, fromAdmin: true };
  currentRistorante = r;
  cart = [];
  lastOrdineId = null;
  $('#modal-demo-utente').classList.add('hidden');
  $('#app-admin').classList.add('hidden');
  $('#app-cliente').classList.remove('hidden');
  $('#cliente-rist-nome').textContent = r.nome;
  $('#cliente-tavolo-num').textContent = tavolo;
  showClienteView('menu');
  renderClienteMenu();
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
// nessun pagamento online reale: tutto parte "in attesa" finché il ristoratore non conferma
function defaultPagStato() {
  return 'in_attesa';
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
  if (period === 'mese') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
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

async function renderRistDashboard() {
  if (!currentRistorante) return;
  const fresh = await loadRistoranteFull(currentRistorante.id);
  if (!fresh) return;
  currentRistorante = fresh;
  const menu = currentRistorante.menu || [];
  const ordini = currentRistorante.ordini || [];
  const tavoli = currentRistorante.tavoli || [];
  const aperto = o => o.stato !== 'consegnato' && o.stato !== 'chiuso';

  const attivi = ordini.filter(aperto).length;
  const occupati = tavoli.filter(t => t.occupato).length || new Set(ordini.filter(aperto).map(o => o.tavolo)).size;
  const incasso = ordini.filter(o => inPeriod(o.createdAt, currentPeriod)).reduce((s, o) => s + Number(o.totale), 0);

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
      const ps = o.stato_pagamento || defaultPagStato();
      return `<div class="recent-item">
        <span><strong>Tavolo ${esc(o.tavolo)}</strong> · ${formatPrice(o.totale)} · ${formatTime(o.createdAt)}</span>
        <span>
          <span class="badge-stato ${esc(o.stato)}">${labelStato(o.stato)}</span>
          <span class="badge-pag ${esc(ps)}">${labelPagamentoStato(ps)}</span>
        </span>
      </div>`;
    }).join('');
  }
  renderRistCharts();
}

function renderRistCharts() {
  if (typeof Chart === 'undefined' || !currentRistorante) return;
  const ordini = (currentRistorante.ordini || []).filter(o => inPeriod(o.createdAt, currentPeriod));

  // incassi raggruppati per giorno (oggi: per ora)
  const buckets = new Map();
  const perOra = currentPeriod === 'oggi';
  ordini.slice().reverse().forEach(o => {
    const d = new Date(o.createdAt);
    const k = perOra ? String(d.getHours()).padStart(2, '0') + ':00'
                     : d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
    buckets.set(k, (buckets.get(k) || 0) + Number(o.totale));
  });
  const labels = buckets.size ? [...buckets.keys()] : ['—'];
  const data = buckets.size ? [...buckets.values()] : [0];

  const ctx1 = document.getElementById('chart-incassi-rist');
  if (ctx1) {
    if (chartIncassiRist) chartIncassiRist.destroy();
    chartIncassiRist = new Chart(ctx1, {
      type: 'bar',
      data: { labels, datasets: [{ label: '€', data, backgroundColor: 'rgba(196, 92, 38, 0.7)', borderRadius: 6 }] },
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
async function renderMenuTable(filter = '') {
  if (!currentRistorante) return;
  const fresh = await loadRistoranteFull(currentRistorante.id);
  if (!fresh) return;
  currentRistorante = fresh;
  let menu = currentRistorante.menu || [];

  const chips = $('#categorie-chips');
  if (chips) {
    const cats = ['tutti', ...(currentRistorante.categorie || [])];
    chips.innerHTML = cats.map(c =>
      `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${esc(c)}">${c === 'tutti' ? 'Tutti' : esc(c)}</button>`
    ).join('');
    chips.querySelectorAll('.cat-chip').forEach(chip => {
      chip.addEventListener('click', () => { menuFilterCat = chip.dataset.cat; renderMenuTable(filter); });
    });
  }

  if (menuFilterCat !== 'tutti') menu = menu.filter(p => p.categoria === menuFilterCat);
  if (filter) {
    const q = filter.toLowerCase();
    menu = menu.filter(p => (p.nome || '').toLowerCase().includes(q));
  }

  const sel = $('#piatto-categoria');
  if (sel) sel.innerHTML = (currentRistorante.categorie || []).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  const body = $('#menu-body');
  if (!menu.length) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:40px">Nessun piatto. Aggiungine uno!</td></tr>`;
    return;
  }
  body.innerHTML = menu.map(p => {
    const img = safeImg(p.immagine);
    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          ${img ? `<img src="${esc(img)}" class="piatto-img" alt="" onerror="this.style.display='none'"/>` : ''}
          <div>
            <strong>${esc(p.nome)}</strong>
            ${p.descrizione ? `<br><small style="color:var(--muted)">${esc(p.descrizione)}</small>` : ''}
          </div>
        </div>
      </td>
      <td>${esc(p.categoria || '—')}</td>
      <td>${formatPrice(p.prezzo)}</td>
      <td style="font-size:12px">${esc((p.allergeni || []).join(', ') || '—')}</td>
      <td><span class="badge ${p.disponibile ? 'badge-pro' : 'badge-base'}">${p.disponibile ? 'Sì' : 'No'}</span></td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="editPiatto('${esc(p.id)}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deletePiatto('${esc(p.id)}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
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
  if (src) { prev.src = src; wrap.classList.remove('hidden'); }
  else resetPiattoImage();
}

$('#piatto-file')?.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) { toast('Immagine troppo grande (max 1.5 MB)'); e.target.value = ''; return; }
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
  $('#piatto-categoria').innerHTML = (currentRistorante.categorie || []).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
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
    const { error } = await sb.from('categorie').insert({
      id_ristorante: currentRistorante.id, nome, posizione: (currentRistorante.categorie || []).length
    });
    if (error) { toast('Errore: ' + error.message); return; }
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
  if (!immagine && previewSrc && !$('#piatto-preview-wrap')?.classList.contains('hidden')) immagine = previewSrc;
  immagine = safeImg(immagine);

  const data = {
    id_ristorante: currentRistorante.id,
    nome: $('#piatto-nome').value.trim(),
    descrizione: $('#piatto-desc').value.trim(),
    categoria: $('#piatto-categoria').value,
    prezzo: Math.max(0, parseFloat($('#piatto-prezzo').value) || 0),
    disponibile: $('#piatto-disponibile').checked,
    allergeni,
    immagine
  };

  const { error } = id
    ? await sb.from('piatti').update(data).eq('id', id)
    : await sb.from('piatti').insert(data);
  if (error) { toast('Errore: ' + error.message); console.error(error); return; }
  toast(id ? 'Piatto aggiornato' : 'Piatto aggiunto');
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
  $('#piatto-categoria').innerHTML = (currentRistorante.categorie || []).map(c =>
    `<option value="${esc(c)}" ${c === p.categoria ? 'selected' : ''}>${esc(c)}</option>`
  ).join('');
  $('#piatto-prezzo').value = p.prezzo;
  $('#piatto-disponibile').checked = p.disponibile !== false;
  if ($('#piatto-immagine')) $('#piatto-immagine').value = (p.immagine && !p.immagine.startsWith('data:')) ? p.immagine : '';
  if (p.immagine) showPiattoPreview(safeImg(p.immagine)); else resetPiattoImage();
  $$('#allergeni-grid input').forEach(c => { c.checked = (p.allergeni || []).includes(c.value); });
  $('#modal-piatto').classList.remove('hidden');
};

window.deletePiatto = async function(id) {
  if (!confirm('Eliminare questo piatto?')) return;
  await sb.from('piatti').delete().eq('id', id);
  await renderMenuTable($('#search-menu')?.value || '');
  await renderRistDashboard();
  toast('Piatto eliminato');
};

// =====================================================
// ORDINI KANBAN
// =====================================================
async function renderOrdiniKanban() {
  if (!currentRistorante) return;
  const fresh = await loadRistoranteFull(currentRistorante.id);
  if (!fresh) return;
  currentRistorante = fresh;
  const ordini = currentRistorante.ordini || [];

  const nuovi = ordini.filter(o => o.stato === 'nuovo');
  const prep = ordini.filter(o => o.stato === 'in_preparazione');
  const pronti = ordini.filter(o => o.stato === 'pronto' || o.stato === 'consegnato');

  $('#count-nuovo').textContent = nuovi.length;
  $('#count-prep').textContent = prep.length;
  $('#count-pronto').textContent = pronti.length;

  function cardHtml(o) {
    const items = (o.items || []).slice(0, 3).map(i => `${i.qty}× ${esc(i.nome)}`).join(', ');
    const more = (o.items || []).length > 3 ? '...' : '';
    const ps = o.stato_pagamento || defaultPagStato();
    return `
      <div class="kanban-card stato-${esc(o.stato)}" onclick="apriDettaglioOrdine('${esc(o.id)}')">
        <h4>Tavolo ${esc(o.tavolo)} · ${formatPrice(o.totale)}</h4>
        <p>${items}${more}</p>
        <div class="pag-row">
          <span style="font-size:11px;color:var(--muted)">${formatTime(o.createdAt)} · #${esc(o.codice)}</span>
          <span class="badge-pag ${esc(ps)}">${labelPagamentoStato(ps)}</span>
        </div>
      </div>`;
  }
  const vuoto = '<p style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Nessun ordine</p>';
  $('#kanban-nuovo').innerHTML = nuovi.length ? nuovi.map(cardHtml).join('') : vuoto;
  $('#kanban-prep').innerHTML = prep.length ? prep.map(cardHtml).join('') : vuoto;
  $('#kanban-pronto').innerHTML = pronti.length ? pronti.map(cardHtml).join('') : vuoto;

  const badge = $('#badge-ordini');
  if (nuovi.length > 0) { badge.textContent = nuovi.length; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

window.apriDettaglioOrdine = function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  $('#ordine-detail-title').textContent = `Ordine #${o.codice} – Tavolo ${o.tavolo}`;
  const itemsHtml = (o.items || []).map(i =>
    `<div class="r-item"><span>${i.qty}× ${esc(i.nome)}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>`
  ).join('');
  const ps = o.stato_pagamento || defaultPagStato();
  const metodo = o.pagamento === 'cassa' ? 'Pago in cassa' : (o.pagamento === 'carta' ? 'Carta' : (o.pagamento || '—'));
  $('#ordine-detail-body').innerHTML = `
    <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="badge-stato ${esc(o.stato)}">${labelStato(o.stato)}</span>
      <span class="badge-pag ${esc(ps)}">${labelPagamentoStato(ps)}</span>
      <span style="color:var(--muted);font-size:13px">${formatTime(o.createdAt)}</span>
    </div>
    <div class="ricevuta-items">${itemsHtml}</div>
    ${o.note ? `<p style="font-size:13px;color:var(--muted);margin:12px 0"><i class="fas fa-sticky-note"></i> ${esc(o.note)}</p>` : ''}
    <p style="font-size:13px;margin:8px 0">Metodo: <strong>${esc(metodo)}</strong></p>
    <div class="ricevuta-totale"><span>Totale</span><strong>${formatPrice(o.totale)}</strong></div>
  `;
  let actions = '';
  if (o.stato === 'nuovo') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${esc(o.id)}','in_preparazione')"><i class="fas fa-fire"></i> Inizia preparazione</button>`;
  } else if (o.stato === 'in_preparazione') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${esc(o.id)}','pronto')"><i class="fas fa-check"></i> Segna pronto</button>`;
  } else if (o.stato === 'pronto') {
    actions = `<button class="btn btn-primary" onclick="cambiaStato('${esc(o.id)}','consegnato')"><i class="fas fa-hand-holding"></i> Consegnato</button>`;
  }
  const nextPag = { in_attesa: 'pagato', pagato: 'non_pagato', non_pagato: 'in_attesa' }[ps] || 'pagato';
  const pagBtnLabel = { pagato: 'Segna pagato', non_pagato: 'Segna non pagato', in_attesa: 'Segna in attesa' }[nextPag];
  actions += `<button class="btn btn-secondary" onclick="togglePagamento('${esc(o.id)}')"><i class="fas fa-money-bill-wave"></i> ${pagBtnLabel}</button>`;
  actions += `<button class="btn btn-secondary" onclick="stampaComanda('${esc(o.id)}')"><i class="fas fa-print"></i> Stampa</button>`;
  if (o.stato !== 'chiuso') {
    actions += `<button class="btn btn-danger" onclick="chiudiConto('${esc(o.id)}')"><i class="fas fa-file-invoice-dollar"></i> Chiudi conto</button>`;
  }
  actions += `<button class="btn btn-secondary close-modal" data-modal="modal-ordine">Chiudi</button>`;
  $('#ordine-detail-actions').innerHTML = actions;
  $('#ordine-detail-actions .close-modal')?.addEventListener('click', () => $('#modal-ordine').classList.add('hidden'));
  $('#modal-ordine').classList.remove('hidden');
};

window.stampaComanda = function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  const righe = (o.items || []).map(i => `<div style="display:flex;justify-content:space-between"><span>${i.qty}× ${esc(i.nome)}</span></div>`).join('');
  const w = window.open('', '_blank', 'width=360,height=600');
  if (!w) { toast('Consenti i popup per stampare'); return; }
  w.document.write(`<html><head><title>Comanda ${esc(o.codice)}</title></head>
    <body style="font-family:monospace;font-size:16px;padding:12px">
    <h2>Tavolo ${esc(o.tavolo)}</h2><p>#${esc(o.codice)} · ${formatTime(o.createdAt)}</p><hr>
    ${righe}${o.note ? `<hr><p><strong>NOTE:</strong> ${esc(o.note)}</p>` : ''}
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
};

// libera il tavolo solo se non restano altri ordini aperti
async function aggiornaOccupazioneTavolo(tavolo, ordineId, nuovoStato) {
  const chiude = nuovoStato === 'consegnato' || nuovoStato === 'chiuso';
  const altriAperti = (currentRistorante.ordini || []).some(x =>
    x.id !== ordineId && x.tavolo === tavolo && x.stato !== 'consegnato' && x.stato !== 'chiuso');
  await sb.from('tavoli').update({ occupato: !chiude || altriAperti })
    .eq('id_ristorante', currentRistorante.id).eq('numero', tavolo);
}

window.cambiaStato = async function(ordineId, nuovoStato) {
  const { error } = await sb.from('ordini').update({ stato: nuovoStato }).eq('id', ordineId);
  if (error) { toast('Errore: ' + error.message); return; }
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (o) await aggiornaOccupazioneTavolo(o.tavolo, ordineId, nuovoStato);
  $('#modal-ordine').classList.add('hidden');
  await renderOrdiniKanban();
  await renderRistDashboard();
  toast('Stato aggiornato: ' + labelStato(nuovoStato));
};

window.chiudiConto = async function(ordineId) {
  if (!confirm('Chiudere il conto di questo ordine?')) return;
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  await sb.from('ordini').update({ stato: 'chiuso', stato_pagamento: 'pagato' }).eq('id', ordineId);
  if (o) await aggiornaOccupazioneTavolo(o.tavolo, ordineId, 'chiuso');
  $('#modal-ordine').classList.add('hidden');
  await renderOrdiniKanban();
  await renderRistDashboard();
  await renderTavoli();
  toast('Conto chiuso e segnato come pagato');
};

window.togglePagamento = async function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  const cur = o.stato_pagamento || defaultPagStato();
  const next = { in_attesa: 'pagato', pagato: 'non_pagato', non_pagato: 'in_attesa' }[cur] || 'pagato';
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
  if (goto) document.querySelector('#app-admin .nav-item[data-page="' + goto + '"]')?.click();
  if (gotoRist) document.querySelector('#app-ristoratore .nav-item[data-page="' + gotoRist + '"]')?.click();
});
document.addEventListener('pointermove', (e) => {
  const card = e.target.closest('.card-tilt');
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
  card.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
});

// =====================================================
// TAVOLI + QR
// =====================================================
function qrData(ristoranteId, tavolo) {
  const base = (cfg.SITE_URL || window.location.origin).replace(/\/$/, '');
  return `${base}/?r=${ristoranteId}&t=${tavolo}`;
}

async function renderTavoli() {
  if (!currentRistorante) return;
  const fresh = await loadRistoranteFull(currentRistorante.id);
  if (!fresh) return;
  currentRistorante = fresh;
  const sale = currentRistorante.sale || ['Sala principale'];
  const tavoli = currentRistorante.tavoli || [];

  const tabs = $('#sale-tabs');
  tabs.innerHTML = sale.map((s, i) =>
    `<button class="sale-tab ${i === currentSala ? 'active' : ''}" data-sala="${i}">${esc(s)}</button>`
  ).join('');
  tabs.querySelectorAll('.sale-tab').forEach(tab => {
    tab.addEventListener('click', () => { currentSala = parseInt(tab.dataset.sala); renderTavoli(); });
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
             onclick="showQR(${Number(t.numero)})" title="Tavolo ${Number(t.numero)}">
          <span>T${Number(t.numero)}</span>
          <span class="posti">${label} posti</span>
        </div>`;
    }).join('');
  }

  const grid = $('#tavoli-grid');
  grid.innerHTML = '';
  salaTavoli.forEach(t => {
    const label = t.bambini ? `${t.adulti} adulti + ${t.bambini} bambini` : `${t.adulti} posti`;
    const card = document.createElement('div');
    card.className = 'tavolo-card';
    card.innerHTML = `
      <h4>Tavolo ${Number(t.numero)} ${t.occupato ? '<span class="badge-stato nuovo">Occupato</span>' : ''}</h4>
      <div class="posti-info">${label}</div>
      <div class="qr-mini" id="qr-mini-${Number(t.numero)}"></div>
      <div class="tavolo-actions">
        <button class="btn btn-secondary btn-sm" onclick="showQR(${Number(t.numero)})"><i class="fas fa-qrcode"></i> QR</button>
        <button class="btn btn-secondary btn-sm" onclick="editTavolo('${esc(t.id)}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteTavolo('${esc(t.id)}')"><i class="fas fa-trash"></i></button>
      </div>`;
    grid.appendChild(card);
    const data = qrData(currentRistorante.id, t.numero);
    try {
      new QRCode(card.querySelector(`#qr-mini-${Number(t.numero)}`), {
        text: data, width: 110, height: 110, correctLevel: QRCode.CorrectLevel.M
      });
    } catch {
      card.querySelector(`#qr-mini-${Number(t.numero)}`).innerHTML =
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
  if (currentRistorante.id_piano === 'base' && (currentRistorante.sale || []).length >= 1) {
    toast('Le sale multiple sono disponibili dal piano Pro');
    return;
  }
  const { error } = await sb.rpc('aggiungi_sala', { p_nome: nome });
  if (error) { toast('Errore: ' + error.message); return; }
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
  if (!confirm('Eliminare questo tavolo?')) return;
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
  const cats = ['tutti', ...new Set(menu.map(p => p.categoria).filter(Boolean))];
  const catEl = $('#cliente-categorie');
  catEl.innerHTML = cats.map(c =>
    `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${esc(c)}">${c === 'tutti' ? 'Tutti' : esc(c)}</button>`
  ).join('');
  catEl.querySelectorAll('.cat-chip').forEach(chip => {
    chip.addEventListener('click', () => { menuFilterCat = chip.dataset.cat; renderClienteMenu(); });
  });

  const filtered = menuFilterCat === 'tutti' ? menu : menu.filter(p => p.categoria === menuFilterCat);
  const list = $('#cliente-menu-list');
  if (!filtered.length) {
    list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px">Nessun piatto disponibile.</p>';
    updateCartCount();
    return;
  }
  list.innerHTML = filtered.map(p => {
    const inCart = cart.find(c => c.id === p.id);
    const qty = inCart ? inCart.qty : 0;
    const all = (p.allergeni || []).length ? `<div class="allergeni-tags">⚠ ${esc(p.allergeni.join(', '))}</div>` : '';
    const img = safeImg(p.immagine);
    return `
      <div class="menu-item-card">
        ${img ? `<img src="${esc(img)}" class="piatto-img" alt="" onerror="this.style.display='none'"/>` : ''}
        <div class="menu-item-info" style="flex:1">
          <h4>${esc(p.nome)}</h4>
          ${p.descrizione ? `<p>${esc(p.descrizione)}</p>` : ''}
          <span class="prezzo">${formatPrice(p.prezzo)}</span>
          ${all}
        </div>
        <div class="menu-item-actions">
          ${qty > 0 ? `
            <button class="qty-btn" onclick="changeQty('${esc(p.id)}',-1)">−</button>
            <span class="qty-num">${qty}</span>
            <button class="qty-btn" onclick="changeQty('${esc(p.id)}',1)">+</button>
          ` : `
            <button class="btn btn-primary btn-sm" onclick="changeQty('${esc(p.id)}',1)"><i class="fas fa-plus"></i> Aggiungi</button>
          `}
        </div>
      </div>`;
  }).join('');
  updateCartCount();
}

window.changeQty = function(id, delta) {
  const p = currentRistorante.menu.find(x => x.id === id);
  if (!p) return;
  const item = cart.find(c => c.id === id);
  if (!item && delta > 0) {
    cart.push({ id: p.id, nome: p.nome, prezzo: p.prezzo, qty: 1 });
  } else if (item) {
    item.qty = Math.min(50, item.qty + delta);
    if (item.qty <= 0) cart = cart.filter(c => c.id !== id);
  }
  renderClienteMenu();
  if (!$('#cliente-carrello-view').classList.contains('hidden')) renderCarrello();
};

function updateCartCount() {
  $('#cart-count').textContent = cart.reduce((s, c) => s + c.qty, 0);
}

$('#cliente-carrello-btn')?.addEventListener('click', () => { renderCarrello(); showClienteView('carrello'); });
$('#btn-torna-menu')?.addEventListener('click', () => { showClienteView('menu'); renderClienteMenu(); });

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
        <strong>${esc(c.nome)}</strong><br>
        <small>${formatPrice(c.prezzo)} × ${c.qty}</small>
      </div>
      <div class="menu-item-actions">
        <button class="qty-btn" onclick="changeQty('${esc(c.id)}',-1)">−</button>
        <span class="qty-num">${c.qty}</span>
        <button class="qty-btn" onclick="changeQty('${esc(c.id)}',1)">+</button>
      </div>
    </div>
  `).join('');
  $('#carrello-totale').textContent = formatPrice(cart.reduce((s, c) => s + c.prezzo * c.qty, 0));
}

// L'ordine passa da una funzione server che ricalcola i prezzi: il totale del browser non conta.
$('#btn-invia-ordine')?.addEventListener('click', async () => {
  const btn = $('#btn-invia-ordine');
  if (!cart.length) { toast('Il carrello è vuoto'); return; }
  if (!currentRistorante || !currentUser || !sb) { toast('Sessione non valida. Riscansiona il QR.'); return; }

  const pagamento = document.querySelector('input[name="pagamento"]:checked')?.value || 'cassa';
  const note = ($('#ordine-note')?.value || '').trim().slice(0, 300);

  btn.disabled = true;
  const { data: res, error } = await sb.rpc('crea_ordine', {
    p_ristorante: currentRistorante.id,
    p_tavolo: currentUser.tavolo,
    p_items: cart.map(c => ({ id: c.id, qty: c.qty })),
    p_note: note,
    p_pagamento: pagamento
  });
  btn.disabled = false;

  if (error || !res) {
    toast('Errore invio ordine: ' + (error?.message || 'sconosciuto'));
    return;
  }

  lastOrdineId = res.id;
  const statoPag = res.stato_pagamento || 'in_attesa';
  $('#ricevuta-codice').textContent = res.codice;
  $('#ricevuta-rist').textContent = currentRistorante.nome;
  $('#ricevuta-tavolo').textContent = currentUser.tavolo;
  $('#ricevuta-ora').textContent = formatTime(res.created_at);
  $('#ricevuta-pagamento').textContent = pagamento === 'carta' ? 'Carta' : 'Pago in cassa';
  $('#ricevuta-totale').textContent = formatPrice(res.totale);
  $('#ricevuta-stato').textContent = 'Nuovo';
  $('#ricevuta-stato').className = 'badge-stato nuovo';
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(statoPag);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + statoPag;
  }
  $('#ricevuta-items').innerHTML = (res.items || []).map(i => `
    <div class="r-item"><span>${i.qty}× ${esc(i.nome)}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>
  `).join('');

  cart = [];
  updateCartCount();
  $('#ordine-note').value = '';
  showClienteView('ricevuta');
  $('#cliente-stato-btn').style.display = 'inline-flex';
  toast('Ordine inviato!');
});

async function aggiornaStatoRicevuta(silent) {
  if (!lastOrdineId) return;
  const { data: o } = await sb.rpc('stato_ordine', { p_id: lastOrdineId });
  if (!o) return;
  $('#ricevuta-stato').textContent = labelStato(o.stato);
  $('#ricevuta-stato').className = 'badge-stato ' + o.stato;
  if ($('#ricevuta-pag-stato') && o.stato_pagamento) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(o.stato_pagamento);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + o.stato_pagamento;
  }
  if (!silent) toast('Stato: ' + labelStato(o.stato));
}

$('#btn-aggiorna-stato')?.addEventListener('click', () => aggiornaStatoRicevuta(false));

// il cliente non ha una sessione, quindi niente realtime: aggiorna ogni 10 secondi
setInterval(() => {
  if (currentUser?.role === 'cliente' && lastOrdineId &&
      !$('#cliente-ricevuta-view').classList.contains('hidden')) aggiornaStatoRicevuta(true);
}, 10000);

$('#btn-nuovo-ordine')?.addEventListener('click', () => {
  cart = [];
  updateCartCount();
  showClienteView('menu');
  renderClienteMenu();
});

$('#cliente-stato-btn')?.addEventListener('click', async () => {
  if (!lastOrdineId) return;
  const { data: o } = await sb.rpc('stato_ordine', { p_id: lastOrdineId });
  if (!o) return;
  $('#stato-codice').textContent = o.codice;
  const steps = ['nuovo', 'in_preparazione', 'pronto', 'consegnato'];
  const idx = steps.indexOf(o.stato);
  $('#stato-timeline').innerHTML = steps.map((s, i) => {
    const cls = i < idx ? 'done' : (i === idx ? 'active' : '');
    return `<div class="stato-step ${cls}"><div class="dot"></div><span>${labelStato(s)}</span></div>`;
  }).join('');
  showClienteView('stato');
});

$('#btn-torna-da-stato')?.addEventListener('click', () => { showClienteView('menu'); renderClienteMenu(); });

$('#btn-indietro-stato')?.addEventListener('click', () => {
  if (lastOrdineId) showClienteView('ricevuta');
  else { showClienteView('menu'); renderClienteMenu(); }
});

// =====================================================
// RESET PASSWORD RISTORATORE (via API, solo admin)
// =====================================================
window.apriResetPassword = async function(id) {
  if (!sb) { toast('Database non collegato'); return; }
  const { data: r } = await sb.from('ristoranti').select('id,nome,email').eq('id', id).single();
  if (!r) return;
  $('#reset-pass-rist-id').value = r.id;
  $('#reset-pass-nome').value = r.nome + ' (' + r.email + ')';
  $('#reset-pass-value').value = '';
  $('#modal-reset-pass').classList.remove('hidden');
};

$('#btn-genera-pass')?.addEventListener('click', () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  $('#reset-pass-value').value = [...buf].map(n => chars[n % chars.length]).join('');
});

$('#form-reset-pass')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#reset-pass-rist-id').value;
  const nuova = ($('#reset-pass-value')?.value || '').trim();
  if (nuova.length < 8) { toast('La password deve avere almeno 8 caratteri'); return; }

  const res = await api('reset_password', { id_ristorante: id, password: nuova });
  if (!res.ok) { toast('Errore: ' + (res.error || 'impossibile aggiornare')); return; }

  $('#reset-pass-value').value = '';
  $('#modal-reset-pass').classList.add('hidden');
  toast('Password aggiornata');
});

// =====================================================
// AVVIO: QR cliente oppure ripristino sessione
// =====================================================
(async function init() {
  const params = new URLSearchParams(window.location.search);
  const rId = params.get('r');
  const t = parseInt(params.get('t'), 10);

  // nessun QR: prova a ripristinare l'eventuale sessione salvata
  if (!rId || !t) {
    try { await enterWithSession(); } catch (e) { console.error(e); }
    return;
  }

  document.documentElement.classList.add('qr-entry');
  $('#login-screen')?.classList.add('hidden');
  $('#app-cliente')?.classList.remove('hidden');

  try {
    const r = sb ? await loadMenuPubblico(rId) : null;
    if (!r) {
      toast('Menu non disponibile (ristorante non trovato o abbonamento scaduto)');
      return;
    }
    currentUser = { role: 'cliente', ristoranteId: rId, tavolo: t };
    currentRistorante = r;
    cart = [];
    lastOrdineId = null;
    $('#cliente-rist-nome').textContent = r.nome;
    $('#cliente-tavolo-num').textContent = t;
    showClienteView('menu');
    renderClienteMenu();
  } catch (e) {
    console.error('QR init error:', e);
    toast('Errore apertura menu da QR');
  }
})();
