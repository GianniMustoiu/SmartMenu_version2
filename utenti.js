// =====================================================
// Vercel Serverless – /api/utenti
// Gestione account ristoratori. Solo per admin autenticati.
// Il login NON passa più da qui: lo gestisce Supabase Auth.
//
// Environment Variables su Vercel:
//   SUPABASE_URL              = https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = service_role key (segreta, mai nel frontend)
// =====================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metodo non supportato' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Configurazione server mancante' });
  }

  const baseHeaders = {
    apikey: SERVICE_KEY,
    Authorization: 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json'
  };

  async function call(path, options = {}) {
    const r = await fetch(SUPABASE_URL + path, {
      ...options,
      headers: { ...baseHeaders, ...(options.headers || {}) }
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  }

  try {
    // ---------- 1) chi sta chiamando? ----------
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, error: 'Non autenticato' });

    const who = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token }
    });
    if (!who.ok) return res.status(401).json({ ok: false, error: 'Sessione non valida' });
    const caller = await who.json();

    const prof = await call('/rest/v1/profili?select=ruolo&id=eq.' + encodeURIComponent(caller.id));
    if (!prof.ok || !prof.data?.[0] || prof.data[0].ruolo !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Solo gli admin possono farlo' });
    }

    // ---------- 2) azioni ----------
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;

    async function creaUtente(email, password, nome, idRistorante) {
      const created = await call('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { nome } })
      });
      if (!created.ok || !created.data?.id) {
        const msg = created.data?.msg || created.data?.message || 'Impossibile creare l\'account';
        return { ok: false, error: msg };
      }
      const ins = await call('/rest/v1/profili', {
        method: 'POST',
        body: JSON.stringify({ id: created.data.id, email, ruolo: 'ristoratore', nome, id_ristorante: idRistorante })
      });
      if (!ins.ok) {
        await call('/auth/v1/admin/users/' + created.data.id, { method: 'DELETE' });
        return { ok: false, error: 'Profilo non salvato' };
      }
      return { ok: true };
    }

    // crea account per un ristorante appena creato
    if (action === 'crea_ristoratore') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const nome = String(body.nome || '').slice(0, 80);
      if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: 'Email non valida' });
      if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password di almeno 8 caratteri' });
      if (!UUID_RE.test(body.id_ristorante || '')) return res.status(400).json({ ok: false, error: 'Ristorante non valido' });

      const r = await creaUtente(email, password, nome, body.id_ristorante);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    // cambia password; se l'account non esiste ancora (ristoranti vecchi) lo crea
    if (action === 'reset_password') {
      const password = String(body.password || '');
      if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password di almeno 8 caratteri' });
      if (!UUID_RE.test(body.id_ristorante || '')) return res.status(400).json({ ok: false, error: 'Ristorante non valido' });
      const rid = body.id_ristorante;

      const p = await call('/rest/v1/profili?select=id&ruolo=eq.ristoratore&id_ristorante=eq.' + rid + '&limit=1');
      if (p.ok && p.data?.[0]) {
        const upd = await call('/auth/v1/admin/users/' + p.data[0].id, {
          method: 'PUT', body: JSON.stringify({ password })
        });
        if (!upd.ok) return res.status(400).json({ ok: false, error: 'Impossibile aggiornare la password' });
        return res.status(200).json({ ok: true });
      }

      const rist = await call('/rest/v1/ristoranti?select=email,nome,titolare&id=eq.' + rid + '&limit=1');
      const row = rist.data?.[0];
      if (!row || !EMAIL_RE.test(String(row.email || '').toLowerCase())) {
        return res.status(404).json({ ok: false, error: 'Ristorante o email non trovati' });
      }
      const r = await creaUtente(String(row.email).toLowerCase(), password, row.titolare || row.nome, rid);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    // elimina ristorante, dati collegati e account
    if (action === 'elimina_ristorante') {
      if (!UUID_RE.test(body.id_ristorante || '')) return res.status(400).json({ ok: false, error: 'Ristorante non valido' });
      const rid = body.id_ristorante;

      const profili = await call('/rest/v1/profili?select=id&id_ristorante=eq.' + rid);
      for (const u of (profili.data || [])) {
        await call('/auth/v1/admin/users/' + u.id, { method: 'DELETE' });
      }
      for (const t of ['ordini', 'piatti', 'categorie', 'tavoli', 'pagamenti_abbonamento']) {
        await call('/rest/v1/' + t + '?id_ristorante=eq.' + rid, { method: 'DELETE' });
      }
      const del = await call('/rest/v1/ristoranti?id=eq.' + rid, { method: 'DELETE' });
      if (!del.ok) return res.status(500).json({ ok: false, error: 'Eliminazione non riuscita' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Azione sconosciuta' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Errore server' });
  }
};
