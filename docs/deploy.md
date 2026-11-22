# Deploy de Drena

| Pieza | Dónde | URL |
|---|---|---|
| Frontend (Next.js, carpeta `frontend/`) | Vercel, proyecto `ph26-team34` | https://ph26-team34.vercel.app |
| Backend (FastAPI, carpeta `backend/`) | Render, plan gratuito | https://ph26-team34-api.onrender.com |
| Base de datos, fotos y tiempo real | Supabase (Postgres + PostGIS, Storage, Realtime) | ver Project Settings en Supabase |

## Repos

- **Oficial:** `platanus-hack/platanus-hack-26-cl-team-34`. Aquí van los PRs y los issues.
- **Espejo:** `AlvaroTapiaCC/ph26-team34-deploy`. Lo usan Vercel y Render, porque no somos admin del repo oficial.

### Publicar el `main` oficial en el espejo (deploy)

Vercel y Render despliegan solos cuando cambia `main` **del espejo**. Un PR mergeado en el repo oficial no llega solo al espejo: después de cada merge que queramos en producción, alguien con permiso de push en el espejo corre:

```bash
git fetch origin                     # trae el main oficial
git log --oneline -5 origin/main     # revisar qué se va a publicar
git push https://github.com/AlvaroTapiaCC/ph26-team34-deploy.git origin/main:main
```

- Publica **exactamente** el `main` oficial (`origin/main`), no lo que haya en tu copia local.
- Es un fast-forward: el espejo nunca tiene commits propios. **Nunca uses `--force`.** Si el push se rechaza, el espejo divergió: avisa al equipo antes de tocar nada.
- Para comprobar que quedaron iguales:

  ```bash
  git ls-remote https://github.com/AlvaroTapiaCC/ph26-team34-deploy.git refs/heads/main
  git rev-parse origin/main          # debe ser el mismo commit
  ```

- Después, revisar el deploy: en Vercel (*Deployments*) y en Render (*Events*). Abrir https://ph26-team34.vercel.app en escritorio y en celular (debe decir **Drena**) y https://ph26-team34-api.onrender.com/health.

> Atajo opcional: con dos URLs de push en `origin` (`git remote set-url --add --push origin <url>` una vez por repo), cada `git push` de una rama sube a los dos. Igual hay que publicar `main` como arriba, porque los merges se hacen en la web.

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
| `ADMIN_TOKEN` | opcional: si se define, `/formula/recompute` exige el header `X-Admin-Token` |
| `OSRM_URL` | opcional (por defecto el OSRM público `https://router.project-osrm.org`) |
| `ELEVENLABS_API_KEY` | elevenlabs.io → API Keys (voz de `/cuadrilla`) |
| `CORS_ORIGINS` | URL de Vercel; varias separadas por coma (`*` mientras desarrollamos) |

**Redeploy manual:** Render → servicio `ph26-team34-api` → *Manual Deploy* → *Deploy latest commit*.
Para cambiar variables: *Environment* → editar → *Save, rebuild and deploy*.

**Plan gratuito:** el servicio se duerme tras unos 15 minutos sin tráfico y tarda ~50 s en despertar. Antes de la demo, abrir `/health` un par de minutos antes, o pasar a un plan pagado con los créditos.

## Frontend (Vercel)

- **Root directory:** `frontend`
- **Framework:** Next.js (detección automática)

`/central/validacion` se genera al compilar. Lee los resultados publicados en `data/validacion/` del mismo checkout. Conserva activa la opción de Vercel [Include source files outside of the Root Directory in the Build Step](https://vercel.com/docs/monorepos/monorepo-faq#can-i-share-source-files-between-projects-are-shared-packages-supported) para incluirlos con `frontend`. Publica nuevamente al actualizar los resultados.

Variables (Project Settings → Environment Variables):

| Variable | Valor |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://ph26-team34-api.onrender.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | igual que `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la **publishable** key, nunca la secret |
| `NEXT_PUBLIC_CREW_TOKEN` | igual que `CREW_TOKEN` de Render (app `/cuadrilla`); nunca el `ADMIN_TOKEN` |

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

### Backend (FastAPI · http://localhost:8000/docs)

```bash
cd backend
python3.12 -m venv .venv                  # Windows: py -3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt     # Windows: .venv/Scripts/pip
cp .env.example .env                      # y completar (ver tabla de variables arriba)
.venv/bin/python -m db.migrate            # solo si apuntas a una base nueva
.venv/bin/uvicorn app.main:app --reload   # Windows: .venv/Scripts/uvicorn
```

Tests: `.venv/bin/python -m pytest` (con `DRENA_TEST_INTEGRACION=1` corren además los de integración contra Supabase).

### Frontend (Next.js · http://localhost:3000)

```bash
cd frontend
cp .env.example .env.local                # NEXT_PUBLIC_API_URL=http://localhost:8000
npm ci
npm run dev
```

Build de producción: `npm run build`.
