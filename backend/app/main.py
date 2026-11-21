from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import close_pool, get_conn
from app.routers import clasificar, crews, events, formula, missions, observations, scenarios, sim, sumideros


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    close_pool()


app = FastAPI(title="Drena API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (scenarios, sumideros, observations, formula, crews, missions, events, sim, clasificar):
    app.include_router(r.router)


@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/health/db")
def health_db():
    """Verifica la conexión a Supabase/Postgres."""
    with get_conn() as conn:
        row = conn.execute(
            "select now() as now, exists(select 1 from pg_extension where extname = 'postgis') as postgis"
        ).fetchone()
    return {"status": "ok", "db_time": row["now"].isoformat(), "postgis": row["postgis"]}


@app.get("/api/hello")
def hello():
    """Endpoint del scaffold original; lo usa la página de prueba del frontend."""
    return {"message": "Hello from FastAPI"}
