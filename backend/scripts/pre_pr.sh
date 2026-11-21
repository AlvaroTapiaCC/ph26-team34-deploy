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
set -euo pipefail

BASE="origin/main"
INTEGRACION=0
MAX_LINEAS=300
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      if [ "$#" -lt 2 ] || [[ "$2" == -* ]]; then
        echo "✗ --base requiere una referencia de Git"
        exit 2
      fi
      BASE="$2"
      shift 2
      ;;
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
else echo "✗ No encuentro backend/.venv. Desde backend, crea .venv con Python 3.12 e instala requirements-dev.txt con su pip."; exit 2
fi

FALLOS=0
AVISOS=0
paso() { printf '\n== %s\n' "$1"; }
mal() { printf '✗ %s\n' "$1"; FALLOS=$((FALLOS + 1)); }
aviso() { printf '! %s\n' "$1"; AVISOS=$((AVISOS + 1)); }
bien() { printf '✓ %s\n' "$1"; }

git fetch -q origin 2>/dev/null || aviso "No pude hacer git fetch; comparo con la copia local de $BASE"
if ! git rev-parse -q --verify "$BASE" >/dev/null; then echo "✗ No existe la base $BASE"; exit 2; fi
if ! MB="$(git merge-base "$BASE" HEAD)"; then
  echo "✗ No pude encontrar un ancestro común con $BASE"
  exit 2
fi

paso "Archivos sin agregar"
SUELTOS="$(git ls-files --others --exclude-standard -- "$RAIZ")"
if [ -n "$SUELTOS" ]; then
  aviso "Archivos nuevos sin 'git add' (no se revisan ni entran al PR):"
  printf '%s\n' "$SUELTOS" | sed 's/^/  /'
else
  bien "Todo lo nuevo está agregado a git"
fi

revisar_diff() {
  local etapa="$1" estados envs diff
  local patron='sk-ant-[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|postgres(ql)?://[^:@/ ]+:[^@/ ]{4,}@|xi-api-key["[:space:]]*[:=][[:space:]"]*[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY'
  shift

  estados="$(git -C "$RAIZ" diff --name-status --no-renames "$@" --)"
  if printf '%s\n' "$estados" | awk -F '\t' '$2 == "README.md" { visto = 1 } END { exit !visto }'; then
    mal "$etapa: se modificó README.md"
  fi
  envs="$(printf '%s\n' "$estados" | awk -F '\t' '$1 != "D" && $2 ~ /(^|\/)\.env($|\.)/ && $2 !~ /(^|\/)\.env\.example$/ { print $2 }')"
  if [ -n "$envs" ]; then mal "$etapa: archivos .env en el diff: $envs"; fi

  diff="$(git -C "$RAIZ" diff --no-color --no-ext-diff --no-textconv --unified=0 "$@" --)"
  # Filtra por coincidencia para no ocultar un secreto que comparte línea con un placeholder.
  if printf '%s\n' "$diff" | grep -E '^\+' | grep -oE -- "$patron" \
    | grep -vxF -- 'postgresql://postgres.xxxx:PASSWORD@' >/dev/null; then
    mal "$etapa: posibles secretos en líneas agregadas (valores omitidos)"
  fi
}

paso "Archivos prohibidos y secretos"
revisar_diff "Cambios del PR" "$MB" HEAD
revisar_diff "Cambios staged" --cached HEAD
revisar_diff "Cambios locales"
if [ "$FALLOS" -eq 0 ]; then bien "Sin archivos prohibidos ni secretos aparentes"; fi

paso "Tamaño del diff (contra $BASE)"
CAMBIADOS="$(git -C "$RAIZ" diff --name-only "$MB")"
LINEAS="$(git -C "$RAIZ" diff --numstat "$MB" | awk '{a+=$1; d+=$2} END {print a+d+0}')"
ARCHIVOS="$(printf '%s\n' "$CAMBIADOS" | grep -c . || true)"
if [ "$LINEAS" -gt "$MAX_LINEAS" ]; then aviso "$LINEAS líneas en $ARCHIVOS archivos (> $MAX_LINEAS): ¿se puede dividir? Un issue por PR."
else bien "$LINEAS líneas en $ARCHIVOS archivos"; fi

paso "Lint (ruff)"
if "$PY" -m ruff --version >/dev/null 2>&1; then
  if "$PY" -m ruff check . ; then bien "ruff sin errores"; else mal "ruff encontró errores"; fi
else
  mal "ruff no está instalado: $PY -m pip install -r requirements-dev.txt"
fi

paso "Tests unitarios"
if DRENA_TEST_INTEGRACION=0 "$PY" -m pytest -q; then bien "pytest OK"; else mal "Fallan tests"; fi

if [ "$INTEGRACION" = 1 ]; then
  paso "Tests de integración (Supabase real)"
  ESTADO_INTEGRACION=0
  DRENA_TEST_INTEGRACION=1 "$PY" -m pytest -q -k "integracion" || ESTADO_INTEGRACION=$?
  case "$ESTADO_INTEGRACION" in
    0) bien "Integración OK" ;;
    5) aviso "No hay tests de integración en esta rama" ;;
    *) mal "Fallan tests de integración" ;;
  esac
fi

printf '\n== Resultado: %d fallo(s), %d aviso(s)\n' "$FALLOS" "$AVISOS"
if [ "$FALLOS" -gt 0 ]; then exit 1; fi
echo "Ahora revisa la checklist de .github/pull_request_template.md y llena 'Riesgos revisados'."
