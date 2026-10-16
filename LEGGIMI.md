# MenuPro PWA – come caricare i file

Struttura del progetto (come nella cartella):

```
index.html            (modificato)
script.js             (modificato)
style.css             (modificato: aggiunte in fondo)
offline.js            (NUOVO – database locale, coda, sincronizzazione)
sw.js                 (NUOVO – Service Worker)
manifest.webmanifest  (NUOVO)
vercel.json           (NUOVO – se ne hai già uno, unisci la sezione "headers")
config.js             (invariato)
icons/                (NUOVO – icone app)
api/utenti.js         (invariato – è il tuo utenti.js, nella cartella api/ come vuole Vercel)
```

Dopo il deploy:
1. Apri il sito UNA volta con la connessione attiva e accedi (serve per salvare app e dati sul dispositivo).
2. Installa l'app: Chrome/Android → "Installa app"; iPhone/iPad → Condividi → "Aggiungi a Home".
3. Prova: modalità aereo → cambia lo stato di un ordine → togli la modalità aereo: parte da sola la sincronizzazione.
