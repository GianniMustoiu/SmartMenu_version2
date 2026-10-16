-- =====================================================
-- MenuPro – Schema completo (DROP + CREATE)
-- Esegui su Supabase SQL Editor
-- =====================================================

-- Estensione UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========== DROP (ordine inverso dipendenze) ==========
DROP TABLE IF EXISTS chiusure_fiscali CASCADE;
DROP TABLE IF EXISTS pagamenti_abbonamento CASCADE;
DROP TABLE IF EXISTS pagamento CASCADE;
DROP TABLE IF EXISTS messaggio CASCADE;
DROP TABLE IF EXISTS ordine_riga CASCADE;
DROP TABLE IF EXISTS ordini CASCADE;
DROP TABLE IF EXISTS piatti CASCADE;
DROP TABLE IF EXISTS categorie CASCADE;
DROP TABLE IF EXISTS tavoli CASCADE;
DROP TABLE IF EXISTS utenti_ristoranti CASCADE;
DROP TABLE IF EXISTS ristoranti CASCADE;
DROP TABLE IF EXISTS utenti CASCADE;

-- ========== UTENTI ==========
CREATE TABLE utenti (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  ruolo         TEXT NOT NULL CHECK (ruolo IN ('admin', 'ristoratore', 'staff')),
  nome          TEXT,
  creato        TIMESTAMPTZ DEFAULT now()
);

-- ========== RISTORANTI ==========
CREATE TABLE ristoranti (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_proprietario   UUID REFERENCES utenti(id) ON DELETE SET NULL,
  nome              TEXT NOT NULL,
  titolare          TEXT,
  citta             TEXT,
  email             TEXT,                    -- email di contatto / login legacy
  password          TEXT,                    -- legacy, preferire utenti
  id_piano          TEXT DEFAULT 'base' CHECK (id_piano IN ('base', 'pro', 'enterprise')),
  scadenza          DATE,
  sale              TEXT[] DEFAULT ARRAY['Sala principale'],
  -- Pagamenti
  metodo_pagamento  TEXT DEFAULT 'entrambi' CHECK (metodo_pagamento IN ('cassa', 'carta', 'entrambi')),
  circuiti_carta    TEXT[] DEFAULT ARRAY['visa', 'mastercard', 'satispay', 'paypal'],
  -- Geo anti-truffa
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  raggio_metri      INTEGER DEFAULT 250,
  creato            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ristoranti_proprietario ON ristoranti(id_proprietario);
CREATE INDEX idx_ristoranti_email ON ristoranti(email);

-- ========== LINK UTENTE ↔ RISTORANTE (multi + staff) ==========
CREATE TABLE utenti_ristoranti (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_utente       UUID NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  id_ristorante   UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  ruolo_locale    TEXT NOT NULL DEFAULT 'owner' CHECK (ruolo_locale IN ('owner', 'staff')),
  UNIQUE (id_utente, id_ristorante)
);

CREATE INDEX idx_ur_utente ON utenti_ristoranti(id_utente);
CREATE INDEX idx_ur_ristorante ON utenti_ristoranti(id_ristorante);

-- ========== TAVOLI ==========
CREATE TABLE tavoli (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante   UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  numero          INTEGER NOT NULL,
  adulti          INTEGER DEFAULT 4,
  bambini         INTEGER DEFAULT 0,
  sala            INTEGER DEFAULT 0,
  occupato        BOOLEAN DEFAULT false,
  forma           TEXT DEFAULT 'round' CHECK (forma IN ('round', 'rect')),
  UNIQUE (id_ristorante, numero)
);

CREATE INDEX idx_tavoli_rist ON tavoli(id_ristorante);

-- ========== CATEGORIE ==========
CREATE TABLE categorie (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante   UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  posizione       INTEGER DEFAULT 0
);

CREATE INDEX idx_categorie_rist ON categorie(id_ristorante);

-- ========== PIATTI ==========
CREATE TABLE piatti (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante   UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  descrizione     TEXT,
  categoria       TEXT,
  prezzo          NUMERIC(10,2) NOT NULL DEFAULT 0,
  disponibile     BOOLEAN DEFAULT true,
  allergeni       TEXT[] DEFAULT '{}',
  immagine        TEXT
);

CREATE INDEX idx_piatti_rist ON piatti(id_ristorante);

-- ========== ORDINI ==========
CREATE TABLE ordini (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante     UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  codice            TEXT NOT NULL,
  tavolo            INTEGER,
  note              TEXT,
  pagamento         TEXT DEFAULT 'cassa',           -- cassa | carta
  circuito          TEXT,                           -- visa, mastercard, satispay, paypal...
  stato_pagamento   TEXT DEFAULT 'in_attesa' CHECK (stato_pagamento IN ('in_attesa', 'pagato', 'non_pagato')),
  totale            NUMERIC(10,2) DEFAULT 0,
  stato             TEXT DEFAULT 'nuovo' CHECK (stato IN ('nuovo', 'in_preparazione', 'pronto', 'consegnato', 'chiuso')),
  items             JSONB,                          -- compatibilità
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ordini_rist ON ordini(id_ristorante);
CREATE INDEX idx_ordini_stato ON ordini(id_ristorante, stato);
CREATE INDEX idx_ordini_created ON ordini(id_ristorante, created_at DESC);

-- ========== RIGHE ORDINE ==========
CREATE TABLE ordine_riga (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ordine       UUID NOT NULL REFERENCES ordini(id) ON DELETE CASCADE,
  id_piatto       UUID,
  piatto          TEXT,
  qty_piatti      INTEGER DEFAULT 1,
  prezzo_pagato   NUMERIC(10,2) DEFAULT 0
);

CREATE INDEX idx_ordine_riga_ordine ON ordine_riga(id_ordine);

-- ========== MESSAGGI / NOTE ==========
CREATE TABLE messaggio (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ordine   UUID NOT NULL REFERENCES ordini(id) ON DELETE CASCADE,
  testo       TEXT,
  creato      TIMESTAMPTZ DEFAULT now()
);

-- ========== PAGAMENTO (dettaglio) ==========
CREATE TABLE pagamento (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ordine   UUID NOT NULL REFERENCES ordini(id) ON DELETE CASCADE,
  metodo      TEXT NOT NULL,              -- cassa | carta
  circuito    TEXT,                       -- visa, mastercard, satispay, paypal...
  importo     NUMERIC(10,2) NOT NULL DEFAULT 0,
  creato      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pagamento_ordine ON pagamento(id_ordine);

-- ========== PAGAMENTI ABBONAMENTO (admin) ==========
CREATE TABLE pagamenti_abbonamento (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante   UUID REFERENCES ristoranti(id) ON DELETE SET NULL,
  importo         NUMERIC(10,2),
  data            DATE DEFAULT CURRENT_DATE,
  note            TEXT
);

-- ========== CHIUSURE FISCALI ==========
CREATE TABLE chiusure_fiscali (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_ristorante   UUID NOT NULL REFERENCES ristoranti(id) ON DELETE CASCADE,
  data_giorno     DATE NOT NULL,
  totale          NUMERIC(12,2) NOT NULL DEFAULT 0,
  n_ordini        INTEGER DEFAULT 0,
  totale_carta    NUMERIC(12,2) DEFAULT 0,
  totale_cassa    NUMERIC(12,2) DEFAULT 0,
  dettaglio       JSONB DEFAULT '[]',
  chiuso_at       TIMESTAMPTZ DEFAULT now(),
  chiuso_da       UUID REFERENCES utenti(id),
  UNIQUE (id_ristorante, data_giorno)
);

CREATE INDEX idx_chiusure_rist ON chiusure_fiscali(id_ristorante, data_giorno DESC);

-- ========== RLS di base (anon può leggere/scrivere per demo; restringi in produzione) ==========
ALTER TABLE utenti ENABLE ROW LEVEL SECURITY;
ALTER TABLE ristoranti ENABLE ROW LEVEL SECURITY;
ALTER TABLE utenti_ristoranti ENABLE ROW LEVEL SECURITY;
ALTER TABLE tavoli ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorie ENABLE ROW LEVEL SECURITY;
ALTER TABLE piatti ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordini ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordine_riga ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaggio ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamenti_abbonamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE chiusure_fiscali ENABLE ROW LEVEL SECURITY;

-- Policy permissive per anon (demo). In produzione usa JWT / service role.
CREATE POLICY "anon_all_utenti" ON utenti FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_ristoranti" ON ristoranti FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_ur" ON utenti_ristoranti FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_tavoli" ON tavoli FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_categorie" ON categorie FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_piatti" ON piatti FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_ordini" ON ordini FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_ordine_riga" ON ordine_riga FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_messaggio" ON messaggio FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_pagamento" ON pagamento FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_pag_abb" ON pagamenti_abbonamento FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all_chiusure" ON chiusure_fiscali FOR ALL USING (true) WITH CHECK (true);

-- ========== Seed admin di esempio (cambia password!) ==========
INSERT INTO utenti (email, password_hash, ruolo, nome)
VALUES ('admin@menupro.it', 'admin123', 'admin', 'Amministratore')
ON CONFLICT (email) DO NOTHING;
