# Smart Recording

Servizio standalone di **session recording** — replica della funzionalità Hotjar Recordings.
Registra sessioni utente (mouse, click, scroll, DOM) e permette il replay in dashboard.

Pensato per essere integrato in qualsiasi progetto web tramite un singolo tag `<script>`.

## Avvio

```bash
node server.js
# → Dashboard: http://localhost:4000
# → Tracker:   http://localhost:4000/tracker.js
```

Variabili d'ambiente opzionali:

| Variabile  | Default  | Descrizione               |
|------------|----------|---------------------------|
| `PORT`     | `4000`   | Porta del server          |
| `DATA_DIR` | `./data` | Cartella storage sessioni |

---

## Integrazione in un progetto

Aggiungi prima della chiusura di `</body>` in qualsiasi pagina HTML:

```html
<script>
  window.SmartRecordingConfig = {
    serverUrl: 'http://localhost:4000',  // URL del server Smart Recording
    maskInputs: true,                    // maschera i valori degli input
  };
</script>
<script src="http://localhost:4000/tracker.js"></script>
```

---

## Architettura

```
smart-recording/
├── server.js           # Backend Node.js (zero dipendenze npm)
├── package.json
├── public/
│   ├── index.html      # Dashboard dark + replay player
│   └── tracker.js      # Snippet embeddable (carica rrweb da CDN)
└── data/               # Creata automaticamente al primo avvio
    ├── sessions.json   # Indice sessioni (metadata)
    └── events/
        └── {id}.json   # Eventi rrweb per sessione
```

## API

| Metodo   | Path                          | Descrizione              |
|----------|-------------------------------|--------------------------|
| POST     | `/api/sessions/start`         | Crea sessione            |
| POST     | `/api/sessions/:id/events`    | Append eventi (batch)    |
| POST     | `/api/sessions/:id/end`       | Chiude sessione          |
| GET      | `/api/sessions`               | Lista sessioni           |
| GET      | `/api/sessions/:id`           | Metadata sessione        |
| GET      | `/api/sessions/:id/events`    | Eventi per replay        |
| DELETE   | `/api/sessions/:id`           | Elimina sessione         |

## Stack

- **Node.js** vanilla — nessun framework, nessuna dipendenza npm
- **rrweb** (CDN) — registrazione e replay DOM
- Storage **flat file JSON** (stessa filosofia di TeamTask)
