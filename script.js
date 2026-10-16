// =====================================================
// MenuPro – Versione collegata a Supabase
// =====================================================

const cfg = window.MENUPRO_CONFIG || {};
let sb = null;
try {
  if ((window.supabase || window.OFFLINE) && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
      !String(cfg.SUPABASE_ANON_KEY).includes('INCOLLA')) {
    // OFFLINE.wrap(): stesso client di prima, ma con database locale e coda di sincronizzazione.
    // Se la libreria Supabase non è disponibile (offline al primo avvio) funziona solo in locale.
    const realClient = window.supabase
      ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY,
          window.OFFLINE ? { global: { fetch: window.OFFLINE.fetch } } : undefined)
      : null;
    sb = window.OFFLINE ? window.OFFLINE.wrap(realClient) : realClient;
  } else {
    console.warn('Supabase non configurato correttamente in config.js');
  }
} catch (e) {
  console.error('Errore init Supabase:', e);
}
window.sb = sb; // per debug in console
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

async function loadRistoranteFull(id) {
  const { data: r, error } = await sb.from('ristoranti').select('*').eq('id', id).single();
  if (error || !r) return null;

  const [tavoli, piatti, categorie, ordini, pagamenti] = await Promise.all([
    sb.from('tavoli').select('*').eq('id_ristorante', id).order('numero'),
    sb.from('piatti').select('*').eq('id_ristorante', id).order('nome'),
    sb.from('categorie').select('*').eq('id_ristorante', id).order('posizione'),
    sb.from('ordini').select('*').eq('id_ristorante', id).order('created_at', { ascending: false }),
    sb.from('pagamenti_abbonamento').select('*').eq('id_ristorante', id).order('data', { ascending: false })
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
  // se items vuoti, prova ordine_riga in batch leggero
  const needRows = r.ordini.filter(o => !(o.items && o.items.length));
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
            prezzo: 0
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
  // il ruolo va impostato PRIMA di caricare i dati: serve a salvarli per l'uso offline
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: r.id || r.ristoranteId };
  currentRistorante = await loadRistoranteFull(r.id || r.ristoranteId);
  if (!currentRistorante) {
    currentUser = null;
    toast(navigator.onLine === false
      ? 'Sei offline e i dati del ristorante non sono ancora salvati su questo dispositivo'
      : 'Impossibile caricare i dati del ristorante');
    return false;
  }
  // ricorda l'accesso su questo dispositivo (mai la password): dopo un ricaricamento
  // l'app si riapre da sola, anche offline
  const session = {
    role: 'ristoratore', ristoranteId: currentRistorante.id,
    email: r.email, nome: currentRistorante.nome || r.nome || ''
  };
  try { localStorage.setItem('menupro_session', JSON.stringify(session)); } catch (e) { console.warn('localStorage non disponibile', e); }
  if (window.OFFLINE) window.OFFLINE.saveSession(session);
  $('#login-screen').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = (currentRistorante && currentRistorante.nome) || r.nome || 'Ristorante';
  $('#rist-user-email').textContent = r.email;
  await renderRistDashboard();
  await renderMenuTable();
  await renderOrdiniKanban();
  await renderTavoli();
  return true;
}

async function doLogin(email, pass) {
  email = (email || '').trim().toLowerCase();
  pass = (pass || '').trim();

  if (!pass) {
    toast('Inserisci la password');
    return false;
  }

  if (navigator.onLine === false) {
    toast('Sei offline: il primo accesso richiede la connessione. Se avevi già effettuato l\'accesso su questo dispositivo, riapri l\'app.');
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
        if (!json.user.ristoranteId && sb) {
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
  btn.addEventListener('click', async () => {
    // se ci sono modifiche non ancora inviate chiede conferma; poi svuota i dati locali
    if (window.OFFLINE) {
      if (!(await window.OFFLINE.beforeLogout())) return;
      await window.OFFLINE.onLogout();
    }
    try { localStorage.removeItem('menupro_session'); } catch (e) {}
    stopOrdineStatusPolling();
    document.body.classList.remove('cliente-night');
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
  currentUser = { role: 'cliente', ristoranteId: ristId, tavolo };
  currentRistorante = r;
  cart = [];
  lastOrdineId = null;
  $('#modal-demo-utente').classList.add('hidden');
  $('#app-admin').classList.add('hidden');
  $('#app-cliente').classList.remove('hidden');
  $('#cliente-rist-nome').textContent = r.nome;
  $('#cliente-tavolo-num').textContent = tavolo;
  document.body.classList.add('cliente-night');
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

async function renderRistDashboard() {
  if (!currentRistorante) return;
  currentRistorante = await loadRistoranteFull(currentRistorante.id);
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
async function renderMenuTable(filter = '') {
  if (!currentRistorante) return;
  currentRistorante = await loadRistoranteFull(currentRistorante.id);
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
async function renderOrdiniKanban() {
  if (!currentRistorante) return;
  currentRistorante = await loadRistoranteFull(currentRistorante.id);
  const ordini = currentRistorante.ordini || [];

  const nuovi = ordini.filter(o => o.stato === 'nuovo');
  const prep = ordini.filter(o => o.stato === 'in_preparazione');
  const pronti = ordini.filter(o => o.stato === 'pronto' || o.stato === 'consegnato');

  $('#count-nuovo').textContent = nuovi.length;
  $('#count-prep').textContent = prep.length;
  $('#count-pronto').textContent = pronti.length;

  function cardHtml(o) {
    const pend = (window.OFFLINE && window.OFFLINE.isPending('ordini', o.id))
      ? '<span class="pending-badge" title="In attesa di sincronizzazione"><i class="fas fa-clock"></i></span>' : '';
    const items = (o.items || []).slice(0, 3).map(i => `${i.qty}× ${i.nome}`).join(', ');
    const more = (o.items || []).length > 3 ? '...' : '';
    const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
    return `
      <div class="kanban-card stato-${o.stato}" onclick="apriDettaglioOrdine('${o.id}')">
        <h4>Tavolo ${o.tavolo} · ${formatPrice(o.totale)} ${pend}</h4>
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
  actions += `<button class="btn btn-secondary" onclick="stampaOrdine('${o.id}')"><i class="fas fa-print"></i> Stampa</button>`;
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
  const base = (cfg.SITE_URL || window.location.origin).replace(/\/$/, '');
  return `${base}/?r=${ristoranteId}&t=${tavolo}`;
}

async function renderTavoli() {
  if (!currentRistorante) return;
  currentRistorante = await loadRistoranteFull(currentRistorante.id);
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

  // salva righe ordine se la tabella esiste
  try {
    const righe = cart.map(c => ({
      id_ordine: inserted.id,
      id_piatto: c.id || null,
      piatto: c.nome,
      qty_piatti: c.qty,
      prezzo_pagato: Number(c.prezzo) * c.qty
    }));
    await sb.from('ordine_riga').insert(righe);
  } catch (e) { console.warn('ordine_riga skip', e); }

  try {
    if (note) await sb.from('messaggio').insert({ id_ordine: inserted.id, testo: note });
  } catch (e) { console.warn('messaggio skip', e); }

  try {
    await sb.from('pagamento').insert({
      id_ordine: inserted.id,
      metodo: pagamento,
      importo: totale
    });
  } catch (e) { console.warn('pagamento skip', e); }


  await sb.from('tavoli').update({ occupato: true })
    .eq('id_ristorante', currentRistorante.id)
    .eq('numero', currentUser.tavolo);

  lastOrdineId = inserted.id;
  if (!sessionOrders.find(x => x.id === inserted.id)) {
    sessionOrders.push({ id: inserted.id, codice });
  }
  updateClienteOrdiniSelect();

  $('#ricevuta-codice').textContent = codice;
  $('#ricevuta-rist').textContent = currentRistorante.nome;
  $('#ricevuta-tavolo').textContent = currentUser.tavolo;
  $('#ricevuta-ora').textContent = formatTime(inserted.created_at);
  $('#ricevuta-pagamento').textContent = pagamento === 'cassa' ? 'Pago in cassa' : 'Carta';
  $('#ricevuta-totale').textContent = formatPrice(totale);
  $('#ricevuta-stato').textContent = 'Nuovo';
  $('#ricevuta-stato').className = 'badge-stato nuovo';
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(stato_pagamento);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + stato_pagamento;
  }
  $('#ricevuta-items').innerHTML = cart.map(i => `
    <div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>
  `).join('');

  cart = [];
  updateCartCount();
  $('#ordine-note').value = '';
  showClienteView('ricevuta');
  $('#cliente-stato-btn').style.display = 'inline-flex';
  startOrdineStatusPolling();
  toast(window.OFFLINE && window.OFFLINE.pendingCount() > 0
    ? 'Ordine salvato: verrà inviato appena torna la connessione'
    : 'Ordine inviato!');
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
  const rId = params.get('r');
  const t = parseInt(params.get('t'), 10);
  if (!rId || !t) return;

  // Nascondi subito il login (anche se il DB è lento)
  document.documentElement.classList.add('qr-entry');
  const login = $('#login-screen');
  const appC = $('#app-cliente');
  if (login) login.classList.add('hidden');
  if (appC) { appC.classList.remove('hidden'); appC.classList.add('cliente-ui'); }
  document.body.classList.add('cliente-night');

  // ruolo impostato prima del caricamento: serve a salvare il menu per l'uso offline
  currentUser = { role: 'cliente', ristoranteId: rId, tavolo: t };

  try {
    let r = null;
    if (sb) r = await loadRistoranteFull(rId);
    if (!r) {
      toast('Ristorante non trovato o database non collegato');
      return;
    }
    currentUser = { role: 'cliente', ristoranteId: rId, tavolo: t };
    currentRistorante = r;
    cart = [];
    lastOrdineId = null;
    document.body.classList.add('cliente-night');
    if ($('#cliente-rist-nome')) $('#cliente-rist-nome').textContent = r.nome;
    if ($('#cliente-tavolo-num')) $('#cliente-tavolo-num').textContent = t;
    showClienteView('menu');
    renderClienteMenu();
  } catch (e) {
    console.error('QR init error:', e);
    toast('Errore apertura menu da QR');
  }
})();


// =====================================================
// STAMPA COMANDA / RICEVUTA (funziona anche offline)
// =====================================================
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.stampaOrdine = function(ordineId) {
  const o = currentRistorante && (currentRistorante.ordini || []).find(x => x.id === ordineId);
  if (!o) return;
  const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
  const metodo = o.pagamento === 'cassa' ? 'Pago in cassa' : (o.pagamento === 'carta' ? 'Carta' : (o.pagamento || '—'));
  const righe = (o.items || []).map(i =>
    `<tr><td class="q">${escapeHtml(i.qty)}×</td><td>${escapeHtml(i.nome)}</td></tr>`).join('');
  let area = document.getElementById('print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'print-area';
    document.body.appendChild(area);
  }
  area.innerHTML = `
    <h2>${escapeHtml(currentRistorante.nome)}</h2>
    <p class="big">Tavolo ${escapeHtml(o.tavolo)}</p>
    <p>Ordine #${escapeHtml(o.codice)} · ${escapeHtml(formatTime(o.createdAt))}</p>
    <hr>
    <table>${righe || '<tr><td>Nessun piatto</td></tr>'}</table>
    ${o.note ? `<hr><p>Note: ${escapeHtml(o.note)}</p>` : ''}
    <hr>
    <p class="tot">Totale ${escapeHtml(formatPrice(o.totale))}</p>
    <p>${escapeHtml(metodo)} – ${escapeHtml(labelPagamentoStato(ps))}</p>
  `;
  window.print();
};

// =====================================================
// RIAPERTURA SESSIONE (anche offline)
// Se questo dispositivo era già entrato come ristoratore, riapre direttamente l'app.
// =====================================================
(async function restoreSavedSession() {
  const done = () => document.documentElement.classList.remove('restoring');
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('r') && params.get('t')) return;   // arrivo da QR = cliente

    let s = null;
    try { s = JSON.parse(localStorage.getItem('menupro_session') || 'null'); } catch (e) {}
    if (!s && window.OFFLINE) s = await window.OFFLINE.loadSession();
    if (!s || s.role !== 'ristoratore' || !s.ristoranteId) return;

    const ok = await enterAsRistoratore({
      id: s.ristoranteId, ristoranteId: s.ristoranteId, email: s.email, nome: s.nome
    });
    // online ma il ristorante non esiste più: la sessione salvata non vale
    if (!ok && navigator.onLine !== false) {
      try { localStorage.removeItem('menupro_session'); } catch (e) {}
    }
  } catch (e) {
    console.error('Ripristino sessione fallito:', e);
    toast('Non sono riuscito a riaprire la sessione: accedi di nuovo');
  } finally {
    done();
  }
})();
