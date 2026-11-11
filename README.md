# Fera's Pizza_Lab — sito, ordini online e gestione

Sistema completo per **Fera's Pizza_Lab** (Corso Butera 125, Bagheria): landing, menu con ordini per **asporto e consegna**, pagina di stato ordine per il cliente e **pannello di gestione** con notifiche. Niente prenotazione tavoli.

Gira tutto su un unico **Cloudflare Worker** con asset statici + **D1**. Nessun build step, nessuna dipendenza a runtime.

## Pagine

| Percorso | Cosa fa |
|---|---|
| `/` | Landing: forno animato, pizze della casa (dal menu live), come ordinare, orari, contatti, mappa (caricata solo su richiesta) |
| `/menu` | Menu completo, ricerca, "senza ingredienti", aggiunte a pagamento, carrello, scelta asporto/consegna, fasce orarie reali, checkout |
| `/ordine?id=…&t=…` | Stato ordine per il cliente, si aggiorna da solo (inviato → confermato → pronto/in consegna → consegnato) |
| `/admin` | Pannello di gestione (utente `FERAS`) |
| `/privacy` | Informativa privacy ordini |

## Pannello di gestione

- **Ordini live**: colonne Da confermare / In preparazione / Pronti; suono ripetuto finché un nuovo ordine non viene confermato; badge e titolo lampeggiante; stampa comanda 80 mm; link WhatsApp al cliente con messaggio già scritto; annullamento con motivo; storico per data; "schermo sempre acceso" per il tablet in cucina.
- **Notifiche push** (Web Push standard, gratis): arrivano anche a pannello chiuso su Android/Chrome/desktop; su iPhone dopo "Aggiungi alla schermata Home".
- **Pausa ordini** con un tocco dalla barra in alto.
- **Menu**: categorie e prodotti (crea, modifica, elimina, riordina), interruttore **Disponibile/Terminato** per la serata, foto (ridimensionate nel browser e salvate in D1), etichette, aggiunte a pagamento per categoria.
- **Impostazioni**: asporto/consegna on-off, costo e minimo consegna, consegna gratuita sopra soglia, tempi di preparazione e consegna, intervallo fasce, ordini massimi per fascia, orari settimanali (fino a 2 fasce al giorno), chiusure straordinarie, metodi di pagamento, sconto online %, contatti e social, avviso sul sito, cambio password.
- **Clienti**: rubrica automatica dagli ordini, ricerca, ordinamento, export CSV.
- **Statistiche**: ordini, incasso, scontrino medio, consegne/asporto, incasso giornaliero, orari di punta, prodotti più venduti.

I prezzi sono **sempre ricalcolati sul server**: il browser invia solo prodotti e quantità.
Pagamento: contanti o carta con POS al ritiro/consegna (nessun pagamento online).

## Pubblicazione (prima volta)

```bash
npm install
npx wrangler login

# 1. Database
npx wrangler d1 create feraspizza-db
#    → copia il database_id in wrangler.toml

# 2. Password del pannello (utente: FERAS)
npx wrangler secret put ADMIN_PASSWORD

# 3. Notifiche push (generare UNA volta, non cambiarle più)
node scripts/generate-vapid.mjs
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT      # es. mailto:tuaemail@gmail.com

# 4. Pubblica
npx wrangler deploy
```

Al primo accesso il Worker crea da solo le tabelle e carica il menu iniziale (preso da Glovo, novembre 2026: **verificare i prezzi**, quelli Glovo possono essere maggiorati).
La password di `ADMIN_PASSWORD` serve solo per il primo accesso: viene salvata come hash e poi si cambia dal pannello.

In alternativa ai comandi: Cloudflare → Workers → *Create* → *Import a repository* → `feraspizza`, poi impostare i secret in *Settings → Variables and Secrets* e collegare il database D1 con binding `DB`.

Dominio: Workers → feraspizza → *Settings → Domains & Routes → Add custom domain*.

## Sviluppo locale

```bash
printf 'ADMIN_PASSWORD=provalocale\n' > .dev.vars
node scripts/generate-vapid.mjs >> .dev.vars   # facoltativo
npx wrangler dev
```

## Struttura

```
src/worker.js        router, header di sicurezza, cron per ritentare le push
src/lib/db.js        schema D1 e bootstrap automatico
src/lib/seed.js      menu e impostazioni iniziali
src/lib/orders.js    menu pubblico, fasce orarie, creazione ordini, statistiche
src/lib/admin.js     CRUD menu, immagini, impostazioni, clienti
src/lib/auth.js      login PBKDF2, sessioni su dispositivo fidato (1 anno), rate limit
src/lib/push.js      Web Push RFC 8291/8292 con WebCrypto
public/              pagine e asset (logo vettoriale, font self-hosted)
```

Sito realizzato da Daniele Zobel.
