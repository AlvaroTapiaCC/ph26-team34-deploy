#!/usr/bin/env bash
# Validación propia antes de abrir o actualizar un PR (issue #65).
#
# Uso (desde cualquier carpeta del repo):
#   backend/scripts/pre_pr.sh                  # contra origin/main
#   backend/scripts/pre_pr.sh --base origin/feat/x
#   backend/scripts/pre_pr.sh --integracion    # además, tests contra el Supabase real
#
# Falla (exit 1) si: falla el lint o un test, hay un posible secreto en el diff, o se
# modifica README.md o un .env. Avisa (sin fallar) si el diff pasa de MAX_LINEAS.
set -uo pipefail

BASE="origin/main"
INTEGRACION=0
MAX_LINEAS=300
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --integracion) INTEGRACION=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $1"; exit 2 ;;
  esac
done

RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ/backend" || exit 2

# Python del venv (Windows: Scripts, Linux/Mac: bin)
if [ -x .venv/Scripts/python.exe ] || [ -x .venv/Scripts/python ]; then PY=.venv/Scripts/python
elif [ -x .venv/bin/python ]; then PY=.venv/bin/python
else echo "✗ No encuentro backend/.venv. Créalo: python3.12 -m venv .venv && pip install -r requirements-dev.txt"; exit 2
fi

FALLOS=0
AVISOS=0
paso() { printf '\n== %s\n' "$1"; }
mal() { printf '✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
aviso() { printf '! %s\n' "$1"; AVISOS=$((AVISOS + 1)); }
bien() { printf '✓ %s\n' "$1"; }

git fetch -q origin 2>/dev/null || aviso "No pude hacer git fetch; comparo con la copia local de $BASE"
if ! git rev-parse -q --verify "$BASE" >/dev/null; then echo "✗ No existe la base $BASE"; exit 2; fi
MB="$(git merge-base "$BASE" HEAD)"

paso "Archivos sin agregar"
SUELTOS="$(git ls-files --others --exclude-standard -- "$RAIZ")"
if [ -n "$SUELTOS" ]; then
  aviso "Archivos nuevos sin 'git add' (no se revisan ni entran al PR):"; printf '  %s
' $SUELTOS
else
  bien "Todo lo nuevo está agregado a git"
fi

paso "Archivos prohibidos"
CAMBIADOS="$(git diff --name-only "$MB")"
if printf '%s\n' "$CAMBIADOS" | grep -qx 'README.md'; then mal "Se modificó README.md (no se toca)"; else bien "README.md intacto"; fi
ENVS="$(printf '%s\n' "$CAMBIADOS" | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' || true)"
if [ -n "$ENVS" ]; then mal "Archivos .env en el diff: $ENVS"; else bien "Sin archivos .env"; fi

paso "Secretos en el diff"
# Solo líneas agregadas; se excluyen los .env.example y este script.
# Desde la raíz: revisa todo el repo (frontend, docs, etc.), no solo backend/.
SECRETOS="$(git -C "$RAIZ" diff "$MB" -- . ':(exclude)*.env.example' ':(exclude)backend/scripts/pre_pr.sh' \
  | grep -E '^\+' \
  | grep -nE 'sk-ant-[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|postgres(ql)?://[^:@/ ]+:[^@/ ]{4,}@|xi-api-key|-----BEGIN [A-Z ]*PRIVATE KEY' \
  | grep -vE 'PASSWORD@|xxxx|\.\.\.' || true)"
if [ -n "$SECRETOS" ]; then mal "Posibles secretos:"; printf '%s\n' "$SECRETOS" | cut -c1-120; else bien "Sin secretos aparentes"; fi

paso "Tamaño del diff (contra $BASE)"
LINEAS="$(git diff --numstat "$MB" | awk '{a+=$1; d+=$2} END {print a+d+0}')"
ARCHIVOS="$(printf '%s\n' "$CAMBIADOS" | grep -c . || true)"
if [ "$LINEAS" -gt "$MAX_LINEAS" ]; then aviso "$LINEAS líneas en $ARCHIVOS archivos (> $MAX_LINEAS): ¿se puede dividir? Un issue por PR."
else bien "$LINEAS líneas en $ARCHIVOS archivos"; fi

paso "Lint (ruff)"
if "$PY" -m ruff --version >/dev/null 2>&1; then
  if "$PY" -m ruff check . ; then bien "ruff sin errores"; else mal "ruff encontró errores"; fi
else
  aviso "ruff no está instalado: $PY -m pip install -r requirements-dev.txt"
fi

paso "Tests unitarios"
if "$PY" -m pytest -q; then bien "pytest OK"; else mal "Fallan tests"; fi

if [ "$INTEGRACION" = 1 ]; then
  paso "Tests de integración (Supabase real)"
  DRENA_TEST_INTEGRACION=1 "$PY" -m pytest -q -k "integracion"
  case $? in
    0) bien "Integración OK" ;;
    5) aviso "No hay tests de integración en esta rama" ;;
    *) mal "Fallan tests de integración" ;;
  esac
fi

printf '\n== Resultado: %d fallo(s), %d aviso(s)\n' "$FALLOS" "$AVISOS"
if [ "$FALLOS" -gt 0 ]; then exit 1; fi
echo "Ahora revisa la checklist de .github/pull_request_template.md y llena 'Riesgos revisados'."
