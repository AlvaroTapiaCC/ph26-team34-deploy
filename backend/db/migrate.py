"""Aplica las migraciones SQL de backend/db/migrations en orden.

Uso (desde backend/):  .venv/Scripts/python -m db.migrate
Registra lo aplicado en la tabla `schema_migrations`, así que se puede correr varias veces.
"""
from __future__ import annotations

from pathlib import Path

import psycopg

from app.config import get_settings

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def main() -> None:
    url = get_settings().database_url
    if not url:
        raise SystemExit("Falta DATABASE_URL en backend/.env")
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            "create table if not exists schema_migrations ("
            " name text primary key, applied_at timestamptz not null default now())"
        )
        conn.execute("alter table schema_migrations enable row level security")
        done = {r[0] for r in conn.execute("select name from schema_migrations")}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in done:
                print(f"  ya aplicada  {path.name}")
                continue
            with conn.transaction():
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute("insert into schema_migrations (name) values (%s)", (path.name,))
            print(f"  aplicada     {path.name}")


if __name__ == "__main__":
    main()
