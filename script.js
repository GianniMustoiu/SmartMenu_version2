// =====================================================
// MenuPro Admin – Demo (solo frontend + localStorage)
// =====================================================

const STORAGE_KEY = 'menupro_demo_ristoranti';
let ristoranti = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
let currentUser = null;

// ---------- UTIL ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ristoranti));
}

function toast(msg, type = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2800);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- LOGIN ----------
$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const pass = $('#login-password').value;
  if (pass.length < 4) {
    toast('Password troppo corta (min 4 caratteri)');
    return;
  }
  currentUser = { email };
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-email').textContent = email;
  renderDashboard();
  renderTable();
});

$('#logout-btn').addEventListener('click', () => {
  currentUser = null;
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-form').reset();
});

// ---------- NAVIGAZIONE ----------
$$('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    item.classList.add('active');
    const page = item.dataset.page;
    $$('.page').forEach(p => p.classList.add('hidden'));
    $(`#page-${page}`).classList.remove('hidden');
    $('#page-title').textContent = item.textContent.trim();
  });
});

// ---------- THEME ----------
$('#theme-toggle').addEventListener('click', () => {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? '' : 'dark');
  $('#theme-toggle i').className = isDark ? 'fas fa-moon' : 'fas fa-sun';
});

// ---------- DASHBOARD ----------
function renderDashboard() {
  const totTavoli = ristoranti.reduce((s, r) => s + (r.n_tavoli || 0), 0);
  const attivi = ristoranti.filter(r => {
    if (!r.scadenza) return true;
    return new Date(r.scadenza) >= new Date();
  }).length;

  $('#stat-ristoranti').textContent = ristoranti.length;
  $('#stat-tavoli').textContent = totTavoli;
  $('#stat-ristoratori').textContent = ristoranti.length;
  $('#stat-attivi').textContent = attivi;

  const recent = [...ristoranti].reverse().slice(0, 5);
  const list = $('#recent-list');
  if (recent.length === 0) {
    list.innerHTML = '<p style="color:var(--muted)">Nessun ristorante ancora creato.</p>';
    return;
  }
  list.innerHTML = recent.map(r => `
    <div class="recent-item">
      <span><strong>${r.nome}</strong> · ${r.citta || '—'}</span>
      <span class="badge badge-${r.id_piano}">${r.id_piano}</span>
    </div>
  `).join('');
}

// ---------- TABELLA ----------
function renderTable(filter = '') {
  const body = $('#ristoranti-body');
  let data = ristoranti;
  if (filter) {
    const q = filter.toLowerCase();
    data = data.filter(r =>
      r.nome.toLowerCase().includes(q) ||
      (r.titolare || '').toLowerCase().includes(q) ||
      (r.citta || '').toLowerCase().includes(q)
    );
  }

  if (data.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:40px">Nessun ristorante trovato</td></tr>`;
    return;
  }

  body.innerHTML = data.map(r => `
    <tr>
      <td><strong>${r.nome}</strong></td>
      <td>${r.titolare || '—'}</td>
      <td>${r.citta || '—'}</td>
      <td>${r.n_tavoli}</td>
      <td><span class="badge badge-${r.id_piano}">${r.id_piano}</span></td>
      <td>${r.scadenza || '—'}</td>
      <td class="actions">
        <button class="btn btn-secondary btn-sm" onclick="editRistorante('${r.id}')"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm" onclick="deleteRistorante('${r.id}')"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join('');
}

$('#search-ristoranti').addEventListener('input', (e) => {
  renderTable(e.target.value);
});

// ---------- MODAL ----------
const modal = $('#modal');
$$('.close-modal').forEach(btn => btn.addEventListener('click', () => modal.classList.add('hidden')));

$('#btn-nuovo').addEventListener('click', () => {
  $('#modal-title').textContent = 'Nuovo ristorante';
  $('#form-ristorante').reset();
  $('#edit-id').value = '';
  $('#password').required = true;
  // data di default tra 1 anno
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  $('#scadenza').value = d.toISOString().slice(0, 10);
  modal.classList.remove('hidden');
});

$('#form-ristorante').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#edit-id').value;
  const data = {
    id: id || uid(),
    nome: $('#nome').value.trim(),
    titolare: $('#titolare').value.trim(),
    citta: $('#citta').value.trim(),
    n_tavoli: parseInt($('#n_tavoli').value) || 8,
    email: $('#email').value.trim().toLowerCase(),
    password: $('#password').value, // solo demo, non usata
    id_piano: $('#id_piano').value,
    scadenza: $('#scadenza').value || null,
    creato: new Date().toISOString()
  };

  if (id) {
    const idx = ristoranti.findIndex(r => r.id === id);
    if (idx > -1) {
      // mantieni password vecchia se non modificata
      if (!data.password) data.password = ristoranti[idx].password;
      ristoranti[idx] = data;
      toast('Ristorante aggiornato');
    }
  } else {
    ristoranti.push(data);
    toast('Ristorante e account creati');
  }

  save();
  modal.classList.add('hidden');
  renderTable($('#search-ristoranti').value);
  renderDashboard();
});

// ---------- EDIT / DELETE ----------
window.editRistorante = function(id) {
  const r = ristoranti.find(x => x.id === id);
  if (!r) return;
  $('#modal-title').textContent = 'Modifica ristorante';
  $('#edit-id').value = r.id;
  $('#nome').value = r.nome;
  $('#titolare').value = r.titolare || '';
  $('#citta').value = r.citta || '';
  $('#n_tavoli').value = r.n_tavoli;
  $('#email').value = r.email;
  $('#password').value = '';
  $('#password').required = false;
  $('#id_piano').value = r.id_piano;
  $('#scadenza').value = r.scadenza || '';
  modal.classList.remove('hidden');
};

window.deleteRistorante = function(id) {
  if (!confirm('Sei sicuro di voler eliminare questo ristorante?')) return;
  ristoranti = ristoranti.filter(r => r.id !== id);
  save();
  renderTable($('#search-ristoranti').value);
  renderDashboard();
  toast('Ristorante eliminato');
};

// ---------- RESET ----------
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Cancellerai TUTTI i ristoranti demo. Continuare?')) return;
  ristoranti = [];
  save();
  renderTable();
  renderDashboard();
  toast('Dati demo cancellati');
});

// ---------- INIT ----------
renderDashboard();
renderTable();