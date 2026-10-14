// =====================================================
// MenuPro – Demo Completa (riscritta)
// =====================================================

const STORAGE_KEY = 'menupro_v2';
let ristoranti = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
let currentUser = null;
let currentRistorante = null;
let cart = [];
let currentPeriod = 'oggi';
let currentSala = 0;
let menuFilterCat = 'tutti';
let lastOrdineId = null;

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

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ristoranti));
}
function toast(msg) {
  const t = $('#toast');
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
function getRistorante(id) {
  return ristoranti.find(r => r.id === id);
}
function ensure(r) {
  if (!r.menu) r.menu = [];
  if (!r.ordini) r.ordini = [];
  if (!r.categorie) r.categorie = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
  if (!r.sale) r.sale = ['Sala principale'];
  if (!r.tavoli) r.tavoli = [];
  if (!r.pagamenti) r.pagamenti = [];
}

// ---------- LOGIN (unico form) ----------
function doLogin(email, pass) {
  email = (email || '').trim().toLowerCase();
  pass = (pass || '').trim();

  // Admin: password "admin" (case-insensitive)
  if (pass.toLowerCase() === 'admin') {
    if (!email) email = 'admin@menupro.it';
    currentUser = { role: 'admin', email };
    $('#login-screen').classList.add('hidden');
    $('#app-admin').classList.remove('hidden');
    $('#admin-user-email').textContent = email;
    renderAdminDashboard();
    renderAdminTable();
    renderAbbonamenti();
    renderMieiIncassi();
    populateIncassiSelect();
    return true;
  }

  if (!email || !pass) {
    toast('Inserisci email e password');
    return false;
  }

  // Ristoratore
  const r = ristoranti.find(x => x.email === email && x.password === pass);
  if (r) {
    ensure(r);
    currentUser = { role: 'ristoratore', email, ristoranteId: r.id };
    currentRistorante = r;
    $('#login-screen').classList.add('hidden');
    $('#app-ristoratore').classList.remove('hidden');
    $('#rist-nome-sidebar').textContent = r.nome;
    $('#rist-user-email').textContent = email;
    renderRistDashboard();
    renderMenuTable();
    renderOrdiniKanban();
    renderTavoli();
    return true;
  }

  // Messaggi più chiari
  const emailExists = ristoranti.some(x => x.email === email);
  if (emailExists) {
    toast('Password errata per questo ristorante');
  } else if (ristoranti.length === 0) {
    toast('Nessun ristorante creato. Entra come admin (password: admin)');
  } else {
    toast('Credenziali non valide. Admin: password admin');
  }
  return false;
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  doLogin($('#login-email').value, $('#login-password').value);
});

// ---------- LOGOUT ----------
$$('.logout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
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

// ---------- THEME ----------
$$('.theme-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? '' : 'dark');
    $$('.theme-toggle i').forEach(i => { i.className = isDark ? 'fas fa-moon' : 'fas fa-sun'; });
  });
});

// ---------- NAV ADMIN ----------
$$('#app-admin .nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
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
    if (page === 'abbonamenti') renderAbbonamenti();
    if (page === 'miei-incassi') renderMieiIncassi();
    if (page === 'incassi-rist') populateIncassiSelect();
  });
});

// ---------- NAV RIST ----------
$$('#app-ristoratore .nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
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
    if (page === 'rist-dashboard') renderRistDashboard();
    if (page === 'rist-menu') renderMenuTable();
    if (page === 'rist-ordini') renderOrdiniKanban();
    if (page === 'rist-tavoli') renderTavoli();
  });
});

// ---------- CLOSE MODALS ----------
$$('.close-modal').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.modal;
    if (id) $(`#${id}`).classList.add('hidden');
  });
});

// ---------- TOGGLE PASSWORD ----------
$('#toggle-pass').addEventListener('click', () => {
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

// ========== ADMIN ==========

function renderAdminDashboard() {
  const attivi = ristoranti.filter(r => !r.scadenza || new Date(r.scadenza) >= new Date()).length;
  let ricavi = 0;
  ristoranti.forEach(r => {
    const p = PIANI[r.id_piano];
    if (p && (!r.scadenza || new Date(r.scadenza) >= new Date())) ricavi += p.prezzo;
  });
  $('#stat-ristoranti').textContent = ristoranti.length;
  $('#stat-attivi').textContent = attivi;
  $('#stat-ricavi').textContent = formatPrice(ricavi);

  const recent = [...ristoranti].reverse().slice(0, 5);
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
  renderAdminCharts();
}

function renderAdminCharts() {
  if (typeof Chart === 'undefined') return;
  const mesi = [], vals = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    mesi.push(d.toLocaleDateString('it-IT', { month: 'short' }));
    let v = 0;
    ristoranti.forEach(r => {
      (r.pagamenti || []).forEach(p => {
        const pd = new Date(p.data);
        if (pd.getMonth() === d.getMonth() && pd.getFullYear() === d.getFullYear()) v += p.importo || 0;
      });
    });
    if (v === 0 && i === 0) {
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

function renderAdminTable(filter = '') {
  let data = ristoranti;
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
        <button class="btn btn-secondary btn-sm" onclick="adminApriMenu('${r.id}')" title="Gestisci menu"><i class="fas fa-book-open"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteRistorante('${r.id}')" title="Elimina"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

$('#search-ristoranti').addEventListener('input', e => renderAdminTable(e.target.value));

// Nuovo / Modifica ristorante
$('#btn-nuovo').addEventListener('click', () => {
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

function createDefaultTavoli(n) {
  const tavoli = [];
  const count = Math.max(1, parseInt(n) || 8);
  for (let i = 1; i <= count; i++) {
    tavoli.push({
      id: uid(),
      numero: i,
      adulti: 4,
      bambini: 0,
      sala: 0,
      occupato: false,
      forma: 'round'
    });
  }
  return tavoli;
}

$('#form-ristorante').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#edit-id').value;
  const saleStr = $('#sale').value.trim() || 'Sala principale';
  const sale = saleStr.split(',').map(s => s.trim()).filter(Boolean);
  const nTavoli = parseInt($('#n_tavoli').value) || 8;

  const data = {
    id: id || uid(),
    nome: $('#nome').value.trim(),
    titolare: $('#titolare').value.trim(),
    citta: $('#citta').value.trim(),
    email: $('#email').value.trim().toLowerCase(),
    password: $('#password').value,
    id_piano: $('#id_piano').value,
    scadenza: $('#scadenza').value || null,
    sale,
    creato: new Date().toISOString()
  };

  if (id) {
    const idx = ristoranti.findIndex(r => r.id === id);
    if (idx > -1) {
      const old = ristoranti[idx];
      if (!data.password) data.password = old.password;
      data.menu = old.menu || [];
      data.ordini = old.ordini || [];
      data.categorie = old.categorie || ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
      data.tavoli = old.tavoli && old.tavoli.length ? old.tavoli : createDefaultTavoli(nTavoli);
      data.pagamenti = old.pagamenti || [];
      ristoranti[idx] = data;
      toast('Ristorante aggiornato');
    }
  } else {
    data.menu = [
      { id: uid(), nome: 'Bruschetta al pomodoro', descrizione: 'Pane tostato, pomodoro fresco, basilico', prezzo: 5.50, categoria: 'Antipasti', disponibile: true, allergeni: ['glutine'], immagine: '' },
      { id: uid(), nome: 'Spaghetti carbonara', descrizione: 'Guanciale, pecorino, uovo', prezzo: 12.00, categoria: 'Primi', disponibile: true, allergeni: ['glutine', 'uova', 'latticini'], immagine: '' },
      { id: uid(), nome: 'Bistecca alla fiorentina', descrizione: 'Manzo, rosmarino, olio EVO', prezzo: 28.00, categoria: 'Secondi', disponibile: true, allergeni: [], immagine: '' },
      { id: uid(), nome: 'Tiramisù', descrizione: 'Mascarpone, caffè, cacao', prezzo: 6.50, categoria: 'Dolci', disponibile: true, allergeni: ['latticini', 'uova', 'glutine'], immagine: '' },
      { id: uid(), nome: 'Acqua naturale 75cl', descrizione: '', prezzo: 2.50, categoria: 'Bevande', disponibile: true, allergeni: [], immagine: '' },
      { id: uid(), nome: 'Vino della casa (calice)', descrizione: '', prezzo: 4.00, categoria: 'Bevande', disponibile: true, allergeni: [], immagine: '' }
    ];
    data.ordini = [];
    data.categorie = ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande'];
    data.tavoli = createDefaultTavoli(nTavoli);
    data.pagamenti = [];
    ristoranti.push(data);
    toast('Ristorante creato con menu di esempio');
  }
  save();
  $('#modal-ristorante').classList.add('hidden');
  renderAdminTable($('#search-ristoranti').value);
  renderAdminDashboard();
  renderAbbonamenti();
});

window.editRistorante = function(id) {
  const r = getRistorante(id);
  if (!r) return;
  $('#modal-title').textContent = 'Modifica ristorante';
  $('#edit-id').value = r.id;
  $('#nome').value = r.nome;
  $('#titolare').value = r.titolare || '';
  $('#citta').value = r.citta || '';
  $('#email').value = r.email;
  $('#password').value = r.password || '';
  $('#password').type = 'password';
  $('#password').required = false;
  $('#toggle-pass i').className = 'fas fa-eye';
  $('#id_piano').value = r.id_piano;
  $('#scadenza').value = r.scadenza || '';
  $('#sale').value = (r.sale || []).join(', ');
  $('#n_tavoli').value = (r.tavoli || []).length || 8;
  $('#modal-ristorante').classList.remove('hidden');
};

window.deleteRistorante = function(id) {
  if (!confirm('Eliminare questo ristorante?')) return;
  ristoranti = ristoranti.filter(r => r.id !== id);
  save();
  renderAdminTable($('#search-ristoranti').value);
  renderAdminDashboard();
  renderAbbonamenti();
  toast('Ristorante eliminato');
};

// Admin apre menu di un ristorante (entra come ristoratore temporaneo)
window.adminApriMenu = function(id) {
  const r = getRistorante(id);
  if (!r) return;
  ensure(r);
  currentRistorante = r;
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: r.id, fromAdmin: true };
  $('#app-admin').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = r.nome + ' (admin)';
  $('#rist-user-email').textContent = 'Gestione menu';
  // forza pagina menu
  $$('#app-ristoratore .nav-item').forEach(n => n.classList.remove('active'));
  $$('#app-ristoratore .page').forEach(p => p.classList.add('hidden'));
  const menuNav = $$('#app-ristoratore .nav-item')[1];
  if (menuNav) menuNav.classList.add('active');
  $('#page-rist-menu').classList.remove('hidden');
  $('#rist-page-title').textContent = 'Gestione Menu';
  renderMenuTable();
};

// ABBONAMENTI
function renderAbbonamenti() {
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
        statoClass = 'badge-base';
        scadClass = 'scadenza-late';
      } else {
        const diff = Math.ceil((scad - oggi) / (1000*60*60*24));
        if (diff <= 7) {
          statoLabel = 'In scadenza';
          statoClass = 'badge-base';
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

window.estendiAbbonamento = function(id) {
  const r = getRistorante(id);
  if (!r) return;
  let d = r.scadenza ? new Date(r.scadenza) : new Date();
  if (d < new Date()) d = new Date();
  d.setMonth(d.getMonth() + 1);
  r.scadenza = d.toISOString().slice(0, 10);
  // registra pagamento
  if (!r.pagamenti) r.pagamenti = [];
  const prezzo = PIANI[r.id_piano]?.prezzo || 0;
  r.pagamenti.push({
    id: uid(),
    importo: prezzo,
    piano: r.id_piano,
    data: new Date().toISOString(),
    tipo: 'rinnovo'
  });
  save();
  renderAbbonamenti();
  renderAdminDashboard();
  renderMieiIncassi();
  const nuovaScad = new Date(r.scadenza).toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  toast('Rinnovato fino al ' + nuovaScad + ' (+' + formatPrice(prezzo) + ')');
};

// MIEI INCASSI
function renderMieiIncassi() {
  let totale = 0, mese = 0, inAttesa = 0;
  const now = new Date();
  const pagamenti = [];
  ristoranti.forEach(r => {
    (r.pagamenti || []).forEach(p => {
      totale += p.importo;
      const pd = new Date(p.data);
      if (pd.getMonth() === now.getMonth() && pd.getFullYear() === now.getFullYear()) {
        mese += p.importo;
      }
      pagamenti.push({ ...p, ristorante: r.nome });
    });
    // in attesa: se scade entro 7 giorni
    if (r.scadenza) {
      const scad = new Date(r.scadenza);
      const diff = (scad - now) / (1000 * 60 * 60 * 24);
      if (diff >= 0 && diff <= 7) {
        inAttesa += PIANI[r.id_piano]?.prezzo || 0;
      }
    }
  });
  $('#incassi-totale').textContent = formatPrice(totale);
  $('#incassi-mese').textContent = formatPrice(mese);
  $('#incassi-in-attesa').textContent = formatPrice(inAttesa);

  // prossime scadenze
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

// INCASSI RISTORANTI
function populateIncassiSelect() {
  const sel = $('#select-rist-incassi');
  sel.innerHTML = '<option value="">— Seleziona —</option>' +
    ristoranti.map(r => `<option value="${r.id}">${r.nome}</option>`).join('');
}

$('#select-rist-incassi').addEventListener('change', () => {
  const id = $('#select-rist-incassi').value;
  const cont = $('#incassi-rist-content');
  if (!id) {
    cont.innerHTML = '<p style="color:var(--muted)">Seleziona un ristorante per vedere i dettagli.</p>';
    return;
  }
  const r = getRistorante(id);
  if (!r) return;
  ensure(r);

  const ordini = r.ordini || [];
  const totale = ordini.reduce((s, o) => s + (o.totale || 0), 0);
  const oggi = ordini.filter(o => new Date(o.createdAt).toDateString() === new Date().toDateString())
    .reduce((s, o) => s + o.totale, 0);

  // piatto più venduto
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
          [...ordini].reverse().slice(0, 10).map(o => `
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
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Cancellare TUTTI i dati demo?')) return;
  ristoranti = [];
  save();
  renderAdminTable();
  renderAdminDashboard();
  renderAbbonamenti();
  renderMieiIncassi();
  toast('Dati cancellati');
});

// DEMO UTENTE
$('#btn-demo-utente').addEventListener('click', () => {
  const sel = $('#demo-ristorante');
  if (!ristoranti.length) {
    toast('Crea prima un ristorante');
    return;
  }
  sel.innerHTML = ristoranti.map(r => `<option value="${r.id}">${r.nome}</option>`).join('');
  $('#modal-demo-utente').classList.remove('hidden');
});

$('#btn-avvia-demo').addEventListener('click', () => {
  const ristId = $('#demo-ristorante').value;
  const tavolo = parseInt($('#demo-tavolo').value) || 1;
  const r = getRistorante(ristId);
  if (!r) return;
  ensure(r);
  currentUser = { role: 'cliente', ristoranteId: ristId, tavolo };
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

// ========== RISTORATORE ==========

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
  btn.addEventListener('click', () => {
    $$('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    renderRistDashboard();
  });
});

function renderRistDashboard() {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const menu = currentRistorante.menu || [];
  const ordini = currentRistorante.ordini || [];
  const tavoli = currentRistorante.tavoli || [];

  const attivi = ordini.filter(o => o.stato !== 'consegnato' && o.stato !== 'chiuso').length;
  const occupati = tavoli.filter(t => t.occupato).length ||
    new Set(ordini.filter(o => o.stato !== 'consegnato' && o.stato !== 'chiuso').map(o => o.tavolo)).size;
  const incasso = ordini.filter(o => inPeriod(o.createdAt, currentPeriod))
    .reduce((s, o) => s + o.totale, 0);

  $('#rist-stat-piatti').textContent = menu.length;
  $('#rist-stat-tavoli-occ').textContent = occupati;
  $('#rist-stat-ordini-attivi').textContent = attivi;
  $('#rist-stat-incasso').textContent = formatPrice(incasso);

  const badge = $('#badge-ordini');
  const nuovi = ordini.filter(o => o.stato === 'nuovo').length;
  if (nuovi > 0) { badge.textContent = nuovi; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');

  const recent = [...ordini].reverse().slice(0, 5);
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
  const buckets = {}, labels = [];
  if (currentPeriod === 'oggi') {
    for (let h = 10; h <= 22; h++) { const k = h + ':00'; labels.push(k); buckets[k] = 0; }
    ordini.forEach(o => {
      const h = new Date(o.createdAt).getHours();
      const k = Math.min(22, Math.max(10, h)) + ':00';
      if (buckets[k] !== undefined) buckets[k] += o.totale;
    });
  } else {
    const days = currentPeriod === 'settimana' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      labels.push(k); buckets[k] = 0;
    }
    ordini.forEach(o => {
      const k = new Date(o.createdAt).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
      if (buckets[k] !== undefined) buckets[k] += o.totale;
    });
  }
  const ctx1 = document.getElementById('chart-incassi-rist');
  if (ctx1) {
    if (chartIncassiRist) chartIncassiRist.destroy();
    chartIncassiRist = new Chart(ctx1, {
      type: 'line',
      data: { labels, datasets: [{ label: 'Incasso', data: labels.map(l => buckets[l] || 0), borderColor: '#c45c26', backgroundColor: 'rgba(196,92,38,0.12)', fill: true, tension: 0.35, pointRadius: 3 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: v => '€' + v } }, x: { grid: { display: false } } } }
    });
  }
  const all = currentRistorante.ordini || [];
  const stCounts = {
    Nuovi: all.filter(o => o.stato === 'nuovo').length,
    Prep: all.filter(o => o.stato === 'in_preparazione').length,
    Pronti: all.filter(o => o.stato === 'pronto' || o.stato === 'consegnato').length,
    Pagati: all.filter(o => (o.stato_pagamento || defaultPagStato(o.pagamento)) === 'pagato').length,
    'In attesa': all.filter(o => (o.stato_pagamento || defaultPagStato(o.pagamento)) === 'in_attesa').length
  };
  const ctx2 = document.getElementById('chart-stati-rist');
  if (ctx2) {
    if (chartStatiRist) chartStatiRist.destroy();
    chartStatiRist = new Chart(ctx2, {
      type: 'bar',
      data: { labels: Object.keys(stCounts), datasets: [{ data: Object.values(stCounts), backgroundColor: ['#d4890f', '#3d6b8c', '#3d7a5a', '#2a5a40', '#c4a574'], borderRadius: 6 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } }, x: { grid: { display: false } } } }
    });
  }
}

// MENU
function renderMenuTable(filter = '') {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  let menu = currentRistorante.menu || [];

  // chips categorie
  const cats = ['tutti', ...(currentRistorante.categorie || [])];
  const chips = $('#categorie-chips');
  if (chips) {
    chips.innerHTML = cats.map(c =>
      `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${c}">${c === 'tutti' ? 'Tutti' : c}</button>`
    ).join('');
    chips.querySelectorAll('.cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        menuFilterCat = chip.dataset.cat;
        renderMenuTable($('#search-menu').value);
      });
    });
  }

  if (menuFilterCat !== 'tutti') menu = menu.filter(p => p.categoria === menuFilterCat);
  if (filter) {
    const q = filter.toLowerCase();
    menu = menu.filter(p => p.nome.toLowerCase().includes(q));
  }

  // select categorie nel form
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

$('#search-menu').addEventListener('input', e => renderMenuTable(e.target.value));

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

$('#btn-nuovo-piatto').addEventListener('click', () => {
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

$('#btn-nuova-categoria').addEventListener('click', () => {
  $('#form-categoria').reset();
  $('#modal-categoria').classList.remove('hidden');
});

$('#form-categoria').addEventListener('submit', (e) => {
  e.preventDefault();
  const nome = $('#cat-nome').value.trim();
  if (!nome || !currentRistorante) return;
  ensure(currentRistorante);
  if (!currentRistorante.categorie.includes(nome)) {
    currentRistorante.categorie.push(nome);
    syncRist();
    toast('Categoria creata');
  }
  $('#modal-categoria').classList.add('hidden');
  renderMenuTable();
});

$('#form-piatto').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const id = $('#piatto-edit-id').value;
  const allergeni = [...$$('#allergeni-grid input:checked')].map(c => c.value);
  let immagine = ($('#piatto-immagine')?.value || '').trim();
  const previewSrc = $('#piatto-preview')?.src || '';
  if (!immagine && previewSrc && previewSrc.startsWith('data:')) {
    immagine = previewSrc;
  } else if (!immagine && previewSrc && !$('#piatto-preview-wrap')?.classList.contains('hidden')) {
    immagine = previewSrc;
  }
  const data = {
    id: id || uid(),
    nome: $('#piatto-nome').value.trim(),
    descrizione: $('#piatto-desc').value.trim(),
    categoria: $('#piatto-categoria').value,
    prezzo: parseFloat($('#piatto-prezzo').value) || 0,
    disponibile: $('#piatto-disponibile').checked,
    allergeni,
    immagine
  };
  if (id) {
    const idx = currentRistorante.menu.findIndex(p => p.id === id);
    if (idx > -1) currentRistorante.menu[idx] = data;
    toast('Piatto aggiornato');
  } else {
    currentRistorante.menu.push(data);
    toast('Piatto aggiunto');
  }
  syncRist();
  $('#modal-piatto').classList.add('hidden');
  renderMenuTable($('#search-menu').value);
  renderRistDashboard();
});

window.editPiatto = function(id) {
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

window.deletePiatto = function(id) {
  if (!confirm('Eliminare questo piatto?')) return;
  currentRistorante.menu = currentRistorante.menu.filter(p => p.id !== id);
  syncRist();
  renderMenuTable($('#search-menu').value);
  renderRistDashboard();
  toast('Piatto eliminato');
};

function syncRist() {
  const idx = ristoranti.findIndex(r => r.id === currentRistorante.id);
  if (idx > -1) ristoranti[idx] = currentRistorante;
  save();
}

// ORDINI KANBAN
function renderOrdiniKanban() {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const ordini = currentRistorante.ordini || [];

  const nuovi = ordini.filter(o => o.stato === 'nuovo');
  const prep = ordini.filter(o => o.stato === 'in_preparazione');
  const pronti = ordini.filter(o => o.stato === 'pronto' || o.stato === 'consegnato');
  // chiusi non mostrati

  $('#count-nuovo').textContent = nuovi.length;
  $('#count-prep').textContent = prep.length;
  $('#count-pronto').textContent = pronti.length;

  function cardHtml(o) {
    const items = (o.items || []).slice(0, 3).map(i => `${i.qty}× ${i.nome}`).join(', ');
    const more = (o.items || []).length > 3 ? '...' : '';
    const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
    return `
      <div class="kanban-card stato-${o.stato}" onclick="apriDettaglioOrdine('${o.id}')">
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

window.apriDettaglioOrdine = function(ordineId) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  $('#ordine-detail-title').textContent = `Ordine #${o.codice} – Tavolo ${o.tavolo}`;
  const itemsHtml = (o.items || []).map(i =>
    `<div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>`
  ).join('');
  const ps = o.stato_pagamento || defaultPagStato(o.pagamento);
  const metodo = o.pagamento === 'cassa' ? 'Pago in cassa' : (o.pagamento === 'carta' ? 'Carta' : (o.pagamento || '—'));
  $('#ordine-detail-body').innerHTML = `
    <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="badge-stato ${o.stato}">${labelStato(o.stato)}</span>
      <span class="badge-pag ${ps}">${labelPagamentoStato(ps)}</span>
      <span style="color:var(--muted);font-size:13px">${formatTime(o.createdAt)}</span>
    </div>
    <div class="ricevuta-items">${itemsHtml}</div>
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
  actions += `<button class="btn btn-secondary" onclick="togglePagamento('${o.id}')" title="Clicca per cambiare stato pagamento"><i class="fas fa-money-bill-wave"></i> ${pagBtnLabel}</button>`;
  if (o.stato !== 'chiuso') {
    actions += `<button class="btn btn-danger" onclick="chiudiConto('${o.id}')"><i class="fas fa-file-invoice-dollar"></i> Chiudi conto</button>`;
  }
  actions += `<button class="btn btn-secondary close-modal" data-modal="modal-ordine">Chiudi</button>`;
  $('#ordine-detail-actions').innerHTML = actions;
  // re-bind close
  $('#ordine-detail-actions .close-modal')?.addEventListener('click', () => $('#modal-ordine').classList.add('hidden'));
  $('#modal-ordine').classList.remove('hidden');
};

window.cambiaStato = function(ordineId, nuovoStato) {
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  o.stato = nuovoStato;
  // marca tavolo
  if (nuovoStato === 'consegnato') {
    const t = (currentRistorante.tavoli || []).find(t => t.numero === o.tavolo);
    if (t) t.occupato = false;
  } else {
    const t = (currentRistorante.tavoli || []).find(t => t.numero === o.tavolo);
    if (t) t.occupato = true;
  }
  syncRist();
  $('#modal-ordine').classList.add('hidden');
  renderOrdiniKanban();
  renderRistDashboard();
  toast('Stato aggiornato: ' + labelStato(nuovoStato));
};

window.chiudiConto = function(ordineId) {
  if (!confirm('Chiudere il conto di questo ordine? Non sarà più visibile nelle colonne attive.')) return;
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  o.stato = 'chiuso';
  o.stato_pagamento = 'pagato';
  const t = (currentRistorante.tavoli || []).find(t => t.numero === o.tavolo);
  if (t) t.occupato = false;
  syncRist();
  $('#modal-ordine').classList.add('hidden');
  renderOrdiniKanban();
  renderRistDashboard();
  renderTavoli();
  toast('Conto chiuso e segnato come pagato');
};

window.togglePagamento = function(ordineId) {
  if (!currentRistorante) return;
  const o = currentRistorante.ordini.find(x => x.id === ordineId);
  if (!o) return;
  const cur = o.stato_pagamento || defaultPagStato(o.pagamento);
  const cycle = { in_attesa: 'pagato', pagato: 'non_pagato', non_pagato: 'in_attesa' };
  o.stato_pagamento = cycle[cur] || 'pagato';
  syncRist();
  renderOrdiniKanban();
  renderRistDashboard();
  apriDettaglioOrdine(ordineId);
  toast('Stato pagamento: ' + labelPagamentoStato(o.stato_pagamento));
};

// Card navigation + iOS spotlight
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


// TAVOLI
function renderTavoli() {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const sale = currentRistorante.sale || ['Sala principale'];
  const tavoli = currentRistorante.tavoli || [];

  // tabs sale
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

  // piantina
  const salaTavoli = tavoli.filter(t => (t.sala || 0) === currentSala);
  const piantina = $('#piantina');
  if (!salaTavoli.length) {
    piantina.innerHTML = '<p style="color:var(--muted)">Nessun tavolo in questa sala. Modifica il ristorante per aggiungerne.</p>';
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

  // griglia con QR
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
    const data = `menupro://ordine?r=${currentRistorante.id}&t=${t.numero}`;
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
  const nome = prompt('Nome nuova sala:');
  if (!nome || !nome.trim()) return;
  ensure(currentRistorante);
  currentRistorante.sale.push(nome.trim());
  syncRist();
  renderTavoli();
  toast('Sala aggiunta');
});

window.showQR = function(tavolo) {
  if (!currentRistorante) return;
  const container = $('#qrcode-container');
  container.innerHTML = '';
  const data = `menupro://ordine?r=${currentRistorante.id}&t=${tavolo}`;
  $('#modal-qr-title').textContent = `QR Tavolo ${tavolo}`;
  $('#qr-info').textContent = `${currentRistorante.nome} · Tavolo ${tavolo}`;
  try {
    new QRCode(container, { text: data, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  } catch {
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data)}" alt="QR"/>`;
  }
  $('#modal-qr').classList.remove('hidden');
};


// DEMO RISTORATORE
$('#btn-demo-ristoratore')?.addEventListener('click', () => {
  const sel = $('#demo-ristoratore-select');
  if (!ristoranti.length) { toast('Crea prima un ristorante'); return; }
  sel.innerHTML = ristoranti.map(r => `<option value="${r.id}">${r.nome}</option>`).join('');
  $('#modal-demo-ristoratore').classList.remove('hidden');
});

$('#btn-avvia-demo-rist')?.addEventListener('click', () => {
  const id = $('#demo-ristoratore-select').value;
  const r = getRistorante(id);
  if (!r) return;
  ensure(r);
  currentUser = { role: 'ristoratore', email: r.email, ristoranteId: r.id, fromAdmin: true };
  currentRistorante = r;
  $('#modal-demo-ristoratore').classList.add('hidden');
  $('#app-admin').classList.add('hidden');
  $('#app-ristoratore').classList.remove('hidden');
  $('#rist-nome-sidebar').textContent = r.nome + ' (demo)';
  $('#rist-user-email').textContent = r.email;
  renderRistDashboard();
  renderMenuTable();
  renderOrdiniKanban();
  renderTavoli();
});

// TAVOLI CRUD
$('#btn-nuovo-tavolo')?.addEventListener('click', () => {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const maxNum = (currentRistorante.tavoli || []).reduce((m, t) => Math.max(m, t.numero || 0), 0);
  $('#modal-tavolo-title').textContent = 'Nuovo tavolo';
  $('#tavolo-edit-id').value = '';
  $('#tavolo-numero').value = maxNum + 1;
  $('#tavolo-adulti').value = 4;
  $('#tavolo-bambini').value = 0;
  $('#tavolo-forma').value = 'round';
  $('#modal-tavolo-edit').classList.remove('hidden');
});

$('#form-tavolo')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const id = $('#tavolo-edit-id').value;
  const data = {
    id: id || uid(),
    numero: parseInt($('#tavolo-numero').value) || 1,
    adulti: parseInt($('#tavolo-adulti').value) || 4,
    bambini: parseInt($('#tavolo-bambini').value) || 0,
    sala: currentSala || 0,
    occupato: false,
    forma: $('#tavolo-forma').value || 'round'
  };
  if (id) {
    const idx = currentRistorante.tavoli.findIndex(t => t.id === id);
    if (idx > -1) {
      data.occupato = currentRistorante.tavoli[idx].occupato;
      data.sala = currentRistorante.tavoli[idx].sala;
      currentRistorante.tavoli[idx] = data;
      toast('Tavolo aggiornato');
    }
  } else {
    currentRistorante.tavoli.push(data);
    toast('Tavolo aggiunto');
  }
  syncRist();
  $('#modal-tavolo-edit').classList.add('hidden');
  renderTavoli();
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

window.deleteTavolo = function(id) {
  if (!confirm('Eliminare questo tavolo?')) return;
  currentRistorante.tavoli = currentRistorante.tavoli.filter(t => t.id !== id);
  syncRist();
  renderTavoli();
  toast('Tavolo eliminato');
};

// ========== CLIENTE ==========

function showClienteView(view) {
  ['cliente-menu-view', 'cliente-carrello-view', 'cliente-ricevuta-view', 'cliente-stato-view'].forEach(id => {
    $(`#${id}`).classList.add('hidden');
  });
  $(`#cliente-${view}-view`).classList.remove('hidden');
}

function renderClienteMenu() {
  if (!currentRistorante) return;
  ensure(currentRistorante);
  const menu = (currentRistorante.menu || []).filter(p => p.disponibile !== false);
  const cats = ['tutti', ...new Set(menu.map(p => p.categoria).filter(Boolean))];
  const catEl = $('#cliente-categorie');
  catEl.innerHTML = cats.map(c =>
    `<button class="cat-chip ${c === menuFilterCat ? 'active' : ''}" data-cat="${c}">${c === 'tutti' ? 'Tutti' : c}</button>`
  ).join('');
  catEl.querySelectorAll('.cat-chip').forEach(chip => {
    chip.addEventListener('click', () => { menuFilterCat = chip.dataset.cat; renderClienteMenu(); });
  });

  let filtered = menuFilterCat === 'tutti' ? menu : menu.filter(p => p.categoria === menuFilterCat);
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

$('#cliente-carrello-btn').addEventListener('click', () => {
  renderCarrello();
  showClienteView('carrello');
});
$('#btn-torna-menu').addEventListener('click', () => {
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

$('#btn-invia-ordine').addEventListener('click', () => {
  if (!cart.length) { toast('Il carrello è vuoto'); return; }
  if (!currentRistorante) return;
  ensure(currentRistorante);

  const totale = cart.reduce((s, c) => s + c.prezzo * c.qty, 0);
  const codice = 'ORD-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const pagamento = document.querySelector('input[name="pagamento"]:checked')?.value || 'carta';
  const stato_pagamento = defaultPagStato(pagamento);
  const ordine = {
    id: uid(),
    codice,
    tavolo: currentUser.tavolo,
    items: cart.map(c => ({ id: c.id, nome: c.nome, prezzo: c.prezzo, qty: c.qty })),
    note: $('#ordine-note').value.trim(),
    pagamento,
    stato_pagamento,
    totale,
    stato: 'nuovo',
    createdAt: new Date().toISOString()
  };
  currentRistorante.ordini.push(ordine);
  // marca tavolo occupato
  const t = (currentRistorante.tavoli || []).find(t => t.numero === currentUser.tavolo);
  if (t) t.occupato = true;
  syncRist();
  lastOrdineId = ordine.id;

  $('#ricevuta-codice').textContent = codice;
  $('#ricevuta-rist').textContent = currentRistorante.nome;
  $('#ricevuta-tavolo').textContent = currentUser.tavolo;
  $('#ricevuta-ora').textContent = formatTime(ordine.createdAt);
  $('#ricevuta-pagamento').textContent = pagamento === 'cassa' ? 'Pago in cassa' : 'Carta';
  $('#ricevuta-totale').textContent = formatPrice(totale);
  $('#ricevuta-stato').textContent = 'Nuovo';
  $('#ricevuta-stato').className = 'badge-stato nuovo';
  if ($('#ricevuta-pag-stato')) {
    $('#ricevuta-pag-stato').textContent = labelPagamentoStato(stato_pagamento);
    $('#ricevuta-pag-stato').className = 'badge-pag ' + stato_pagamento;
  }
  $('#ricevuta-items').innerHTML = ordine.items.map(i => `
    <div class="r-item"><span>${i.qty}× ${i.nome}</span><span>${formatPrice(i.prezzo * i.qty)}</span></div>
  `).join('');

  cart = [];
  updateCartCount();
  $('#ordine-note').value = '';
  showClienteView('ricevuta');
  $('#cliente-stato-btn').style.display = 'inline-flex';
  toast('Ordine inviato!');
});

$('#btn-aggiorna-stato').addEventListener('click', () => {
  if (!lastOrdineId || !currentRistorante) return;
  // rileggi da storage
  ristoranti = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  currentRistorante = getRistorante(currentRistorante.id);
  const o = currentRistorante.ordini.find(x => x.id === lastOrdineId);
  if (o) {
    $('#ricevuta-stato').textContent = labelStato(o.stato);
    $('#ricevuta-stato').className = 'badge-stato ' + o.stato;
    toast('Stato: ' + labelStato(o.stato));
  }
});

$('#btn-nuovo-ordine').addEventListener('click', () => {
  cart = [];
  updateCartCount();
  showClienteView('menu');
  renderClienteMenu();
});

$('#cliente-stato-btn').addEventListener('click', () => {
  if (!lastOrdineId || !currentRistorante) return;
  ristoranti = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  currentRistorante = getRistorante(currentRistorante.id);
  const o = currentRistorante.ordini.find(x => x.id === lastOrdineId);
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

$('#btn-torna-da-stato').addEventListener('click', () => {
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