# ALS Cron Dashboard

Panel web del generador diario UX/UI (`ux-projects`). **Fuente de verdad: Neon Postgres** (proyecto `als-cron-dashboard` / `lucky-truth-29119436`).

## Arquitectura

```
monorepo ux-projects ──npm run sync──► Neon (tablas dashboard_*)
         │                                  │
         │                                  ├── local server  /api/*
         │                                  └── Netlify functions /api/*
         └── memory.md (dual-write al editar en local)
```

| Entorno | Datos | Escritura directivas / AP |
|---------|--------|---------------------------|
| Local `npm start` | **Neon** (`DATABASE_URL`) | Neon + `memory.md` |
| Netlify | **Neon** (env del site) | Neon |
| Fallback estático | `public/data/snapshot.json` | No |

## Setup

### 1. Neon

Proyecto ya creado vía Neon MCP. Connection string en `dashboard/.env` (no se commitea):

```bash
cp .env.example .env
# DATABASE_URL=postgresql://...@...-pooler....neon.tech/neondb?sslmode=require
```

Tablas: `dashboard_meta`, `directives`, `anti_patterns`, `projects`, `project_docs`, `files`, `briefing`, `snapshot_state`.

### 2. Local

```bash
cd dashboard
npm install
npm run sync          # monorepo → snapshot.json + push Neon
npm start             # http://127.0.0.1:4177  (lee/escribe Neon)
```

### 3. Netlify

1. Site importado desde `Criscode2022/als-cron-dashboard` (branch `main`).
2. En **Site settings → Environment variables** añade **`DATABASE_URL`** (la misma de Neon, pooled).
3. Redeploy. La UI llamará a `/api/*` → Netlify Functions → Neon.

```bash
npm run publish       # sync + push GitHub → Netlify rebuild
```

## Scripts

| Script | Qué hace |
|--------|----------|
| `npm run sync` | Parse monorepo → JSON local **y push a Neon** |
| `npm run sync:local` | Solo JSON (sin Neon) |
| `npm start` | API + UI; reads/writes Neon |
| `npm run build` | Snapshot local para publish (sin requerir Neon en CI) |
| `npm run publish` | Sync + push `main` del repo dashboard |

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | `{ mode: "neon-write", source: "neon" }` |
| GET | `/api/snapshot` | Snapshot completo desde Neon |
| POST | `/api/sync` | Local: monorepo→Neon · Netlify: reload Neon |
| POST | `/api/directives` | Body `{ directives: [...] }` → Neon |
| POST | `/api/anti-patterns` | Body `{ antiPatterns: [...] }` → Neon |

## Hook del cron (WRITEBACK)

Tras actualizar `memory.md` / cases:

```bash
cd dashboard && npm run sync && npm run publish
```

Así Neon y el site Netlify quedan al día.

## Estructura

```
dashboard/
├── .env / .env.example     # DATABASE_URL (local)
├── netlify/
│   └── functions/api.mjs   # API serverless → Neon
├── public/                 # SPA + snapshot fallback
├── scripts/
│   ├── lib/db.mjs          # push/load/save Neon
│   ├── sync-data.mjs
│   ├── server.mjs
│   └── publish-github.mjs
└── netlify.toml
```
