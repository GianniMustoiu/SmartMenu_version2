if (!emailClean || !passClean) {
  return res.status(400).json({ ok: false, error: 'Email e password obbligatorie' });
}

const path = 'utenti?select=id,email,ruolo,nome,password_hash'
  + '&email=eq.' + encodeURIComponent(emailClean)
  + '&password_hash=eq.' + encodeURIComponent(passClean)
  + '&limit=1';
const { ok, data: utenti } = await sbFetch(path);
if (ok && utenti?.length) {
  const u = utenti[0];
  return res.status(200).json({ ok: true, user: { id: u.id, email: u.email, ruolo: u.ruolo, nome: u.nome } });
}
