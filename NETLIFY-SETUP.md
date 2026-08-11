# Configurar Netlify (una sola vez)

Repo: https://github.com/Criscode2022/als-cron-dashboard  
**Datos en runtime: Neon** (no solo el snapshot estático).

## Pasos en la UI de Netlify

1. https://app.netlify.com → **Add new site** → **Import** → GitHub → **`Criscode2022/als-cron-dashboard`**.
2. Build (autodetect por `netlify.toml`):

   | Campo | Valor |
   |-------|--------|
   | Branch | `main` |
   | Build command | `npm run build` |
   | Publish directory | `public` |
   | Functions directory | `netlify/functions` |

3. **Site configuration → Environment variables** → Add:

   | Key | Value | Scopes |
   |-----|--------|--------|
   | `DATABASE_URL` | URI **pooled** Neon (`…-pooler….neon.tech/neondb?sslmode=require`) | **Functions** + **Runtime** (o *All*) |

   Importante: si solo está en *Builds*, la function no la ve. Tras crear/editar la var → **Clear cache and deploy**.

   Si la URI de Neon incluye `channel_binding=require`, quítalo (o deja que la function lo ignore). Preferible:

   ```
   postgresql://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```

   Si ves **502** en `/api/health` o `/api/snapshot`: Netlify → *Functions* → `api` → **Logs** (el cuerpo de error 500/502 suele estar ahí).

4. **Deploy** desde branch `main` (no uses solo GitHub Pages).

5. Verifica en el **navegador**:
   - Abre la URL **\*.netlify.app** (no `github.io`)
   - `https://TU-SITE.netlify.app/api/health` debe devolver JSON:
     `{"ok":true,"mode":"neon-write","neon":true,...}`
   - Badge en la UI: **NEON WRITE · NETLIFY**

### GitHub Pages ≠ Neon

`https://criscode2022.github.io/als-cron-dashboard/` es **solo estático**.  
No hay serverless functions ahí: el dashboard caerá a `snapshot.json` (fallback).  
La fuente de verdad Neon solo funciona en **Netlify**.

## Actualizaciones de datos

Tras el cron o editar monorepo:

```bash
cd dashboard
npm run sync      # monorepo → Neon (+ snapshot local)
npm run publish   # push main → Netlify rebuild (estático + functions)
```

Las ediciones de directivas/AP **en la web Netlify** se guardan directo en Neon (sin tocar el monorepo).  
En local se hace dual-write: Neon + `memory.md`.

## Local

```bash
cp .env.example .env   # DATABASE_URL
npm install
npm run sync
npm start              # http://127.0.0.1:4177
```
