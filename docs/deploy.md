# Deploy de Drena

| Pieza | Dónde | URL |
|---|---|---|
| Frontend (Next.js, carpeta `frontend/`) | Vercel, proyecto `ph26-team34` | la URL de producción del proyecto en Vercel |
| Backend (FastAPI, carpeta `backend/`) | Render, plan gratuito | https://ph26-team34-api.onrender.com |
| Base de datos, fotos y tiempo real | Supabase (Postgres + PostGIS, Storage, Realtime) | ver Project Settings en Supabase |

## Repos

- **Oficial:** `platanus-hack/platanus-hack-26-cl-team-34`. Aquí van los PRs y los issues.
- **Espejo:** `AlvaroTapiaCC/ph26-team34-deploy`. Lo usan Vercel y Render, porque no somos admin del repo oficial.

El remoto `origin` tiene dos URLs de push, así que cada `git push` sube a los dos repos:

```
git remote set-url --add --push origin https://github.com/platanus-hack/platanus-hack-26-cl-team-34.git
git remote set-url --add --push origin https://github.com/AlvaroTapiaCC/ph26-team34-deploy.git
git remote -v   # debe mostrar una URL de fetch y dos de push
```

> **Ojo con los merges desde la web de GitHub:** un PR mergeado en el repo oficial **no** llega solo al espejo. Después de mergear, alguien con el remoto configurado tiene que correr:
>
> ```
> git switch main && git pull && git push
> ```
>
> Con eso `main` del espejo se actualiza y Vercel y Render despliegan.

## Backend (Render)

- **Root directory:** `backend`
- **Build:** `pip install -r requirements.txt`
- **Start:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- **Health check:** `/health` (la base se revisa en `/health/db`)
- **Python:** 3.12 (`backend/.python-version`)

Variables de entorno (la lista completa está en `backend/.env.example`):

| Variable | De dónde sale |
|---|---|
| `DATABASE_URL` | Supabase → Connect → Connection String → **Session pooler** |
| `SUPABASE_URL` | Supabase → Project Settings → Data API |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API Keys → Secret key |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → Publishable key |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | opcionales (por defecto `claude-opus-5-5` y `low`) |
| `ELEVENLABS_API_KEY` | elevenlabs.io → API Keys (voz de `/cuadrilla`) |
| `CORS_ORIGINS` | URL de Vercel; varias separadas por coma (`*` mientras desarrollamos) |

**Redeploy manual:** Render → servicio `ph26-team34-api` → *Manual Deploy* → *Deploy latest commit*.
Para cambiar variables: *Environment* → editar → *Save, rebuild and deploy*.

**Plan gratuito:** el servicio se duerme tras unos 15 minutos sin tráfico y tarda ~50 s en despertar. Antes de la demo, abrir `/health` un par de minutos antes, o pasar a un plan pagado con los créditos.

## Frontend (Vercel)

- **Root directory:** `frontend`
- **Framework:** Next.js (detección automática)

Variables (Project Settings → Environment Variables):

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://ph26-team34-api.onrender.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | igual que `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la **publishable** key, nunca la secret |

Las variables `NEXT_PUBLIC_*` se fijan al momento del build: después de cambiarlas hay que redeployar (*Deployments* → … → *Redeploy*).

## Base de datos (Supabase)

Las migraciones están en `backend/db/migrations/` y se aplican con:

```
cd backend
py -3.12 -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt     # en Mac/Linux: .venv/bin/pip
.venv/Scripts/python -m db.migrate
```

El script registra lo aplicado en `schema_migrations`, así que se puede correr varias veces.

Seguridad: todas las tablas tienen RLS. El navegador (publishable key) solo puede **leer**; las escrituras pasan por el backend.

## Correr en local

```
# Backend
cd backend
cp .env.example .env        # y completar
.venv/Scripts/uvicorn app.main:app --reload      # http://localhost:8000/docs

# Frontend
cd frontend
npm install
npm run dev                 # http://localhost:3000
```
