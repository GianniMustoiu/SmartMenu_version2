IMPORTANTE – perché i QR non funzionavano
========================================
Su https://smartmenuversion2.vercel.app/config.js  →  HTTP 404
Senza config.js Supabase non si avvia → "ristorante non trovato / database non collegato"

COSA FARE
1. Decomprimi questo zip
2. Su Vercel (progetto smartmenuversion2) assicurati che in ROOT ci siano TUTTI questi file:
   - index.html
   - script.js
   - style.css
   - config.js      ← QUESTO MANCAVA
   - manifest.json
   - sw.js
   - vercel.json
3. Dopo il deploy verifica aprendo nel browser:
   https://smartmenuversion2.vercel.app/config.js
   Deve mostrare il JavaScript, NON "NOT_FOUND"
4. Hard refresh / cancella cache telefono
5. Rigenera i QR da Tavoli & QR

Il database Supabase non cambia. Non serve una repo nuova.
