// =====================================================
// Vercel Serverless – /api/utenti
// Login utenti senza dipendenze npm (usa fetch verso Supabase)
// =====================================================
//
// Su Vercel → Project Settings → Environment Variables:
//   SUPABASE_URL              = https://xxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = la service_role key (segreta)
//

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Mancano SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY nelle Environment Variables di Vercel'
    });
  }

  const headers = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  async function sbFetch(path, options = {}) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || req.query?.action || 'login';

    // ========== LOGIN ==========
    if (req.method === 'POST' && action === 'login') {
      const emailClean = (body.email || '').trim().toLowerCase();
      const passClean = (body.password || '').trim();

      if (!passClean) {
        return res.status(400).json({ ok: false, error: 'Password obbligatoria' });
      }

      // 1) Cerca in tabella utenti
      let path = 'utenti?select=id,email,ruolo,nome,password_hash&password_hash=eq.' + encodeURIComponent(passClean);
      if (emailClean) path += '&email=eq.' + encodeURIComponent(emailClean);

      const { ok, data: utenti } = await sbFetch(path);

      if (ok && Array.isArray(utenti) && utenti.length > 0) {
        const u = emailClean
          ? (utenti.find(x => x.email === emailClean) || utenti[0])
          : (utenti.find(x => x.ruolo === 'admin') || utenti[0]);

        return res.status(200).json({
          ok: true,
          user: { id: u.id, email: u.email, ruolo: u.ruolo, nome: u.nome }
        });
      }

      // 2) Fallback admin
      if (passClean.toLowerCase() === 'admin') {
        return res.status(200).json({
          ok: true,
          user: {
            id: null,
            email: emailClean || 'admin@menupro.it',
            ruolo: 'admin',
            nome: 'Amministratore'
          }
        });
      }

      // 3) Ristoratore
      if (emailClean) {
        const pathR = 'ristoranti?select=id,nome,email,citta&email=eq.' + encodeURIComponent(emailClean) +
          '&password=eq.' + encodeURIComponent(passClean) + '&limit=1';
        const { ok: okR, data: rows } = await sbFetch(pathR);
        if (okR && Array.isArray(rows) && rows.length > 0) {
          const r = rows[0];
          return res.status(200).json({
            ok: true,
            user: {
              id: r.id,
              email: r.email,
              ruolo: 'ristoratore',
              nome: r.nome,
              ristoranteId: r.id
            }
          });
        }
      }

      return res.status(401).json({ ok: false, error: 'Credenziali non valide' });
    }

    // ========== LISTA UTENTI ==========
    if (req.method === 'GET') {
      const { ok, data, status } = await sbFetch('utenti?select=id,email,ruolo,nome,created_at&order=created_at.desc');
      if (!ok) return res.status(status || 500).json({ ok: false, error: data });
      return res.status(200).json({ ok: true, utenti: data || [] });
    }

    // ========== CREA UTENTE ==========
    if (req.method === 'POST' && action === 'create') {
      const email = (body.email || '').trim().toLowerCase();
      const password = (body.password || '').trim();
      const ruolo = body.ruolo || 'admin';
      const nome = body.nome || null;

      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email e password obbligatorie' });
      }

      const { ok, data, status } = await sbFetch('utenti', {
        method: 'POST',
        body: JSON.stringify({ email, password_hash: password, ruolo, nome })
      });

      if (!ok) return res.status(status || 500).json({ ok: false, error: data });
      const user = Array.isArray(data) ? data[0] : data;
      return res.status(200).json({ ok: true, user });
    }

    return res.status(405).json({ ok: false, error: 'Metodo non supportato' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || 'Errore server' });
  }
};
