import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import psycopg
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db import DatabaseUnavailable, close_pool, ejecutar_con_timeout, get_conn
from app.routers import clasificar, crews, events, formula, missions, observations, scenarios, sim, sumideros

HEALTH_DB_TIMEOUT_S = 3


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


@app.exception_handler(DatabaseUnavailable)
async def db_unavailable(_: Request, exc: DatabaseUnavailable):
    """Cualquier endpoint que necesite la base responde 503 si no está disponible."""
    return JSONResponse(status_code=503, content={"status": "error", "detail": str(exc)})


for r in (scenarios, sumideros, observations, formula, crews, missions, events, sim, clasificar):
    app.include_router(r.router)


@app.get("/health")
def health():
    """Solo indica que la API está viva; no toca la base."""
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.get("/health/db")
def health_db():
    """Verifica la conexión a Supabase/Postgres.

    Responde en a lo más ~HEALTH_DB_TIMEOUT_S segundos: el plazo cubre tanto la espera por una
    conexión como la consulta. Si la base no está, no entrega conexión o se cuelga, responde 503.
    """
    limite = time.monotonic() + HEALTH_DB_TIMEOUT_S
    try:
        with get_conn(timeout=HEALTH_DB_TIMEOUT_S) as conn:
            row = ejecutar_con_timeout(conn, _consulta_health, limite - time.monotonic())
    except (DatabaseUnavailable, psycopg.OperationalError) as e:
        return JSONResponse(status_code=503, content={"status": "error", "detail": str(e)})
    return {"status": "ok", "db_time": row["now"].isoformat(), "postgis": row["postgis"]}


def _consulta_health(conn):
    return conn.execute(
        "select now() as now, exists(select 1 from pg_extension where extname = 'postgis') as postgis"
    ).fetchone()


@app.get("/api/hello")
def hello():
    """Endpoint del scaffold original; lo usa la página de prueba del frontend."""
    return {"message": "Hello from FastAPI"}
