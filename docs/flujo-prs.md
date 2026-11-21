# Flujo de PRs

1. **Un issue por PR.** Si una tarea crece, divídela en otro issue. Ideal: menos de ~300 líneas.
2. Rama desde `main` actualizado (`git switch main && git pull`). Solo apila sobre otro PR si de verdad depende de él, y dilo en la descripción.
3. Antes de abrir o actualizar el PR, corre la validación:

   ```bash
   backend/scripts/pre_pr.sh                  # lint, tests, secretos, archivos prohibidos, tamaño
   backend/scripts/pre_pr.sh --integracion    # además, tests contra el Supabase real (si tocas la base)
   backend/scripts/pre_pr.sh --base origin/feat/otra-rama   # si el PR parte de otra rama
   ```

   Requiere el venv: `cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt` (en Windows `.venv/Scripts/pip`).
   El script revisa por separado los cambios publicados en la rama, los agregados al índice y las ediciones locales. Si detecta posibles secretos, indica en qué grupo los encontró y omite los valores.
4. Revisa la checklist de la plantilla (`.github/pull_request_template.md`). Llena **"Riesgos revisados"** con lo que verificaste y lo que queda pendiente a propósito.
5. Nadie mergea sin aprobación. Al responder una revisión: un commit por punto o grupo de puntos, más un comentario que explique qué cambió y cómo se probó.

Lo que más nos han pedido corregir en las revisiones, y que la checklist busca atrapar antes:
- **Concurrencia y plazos:** estado global compartido entre requests, servicios externos colgados.
- **Seguridad:** qué puede leer o escribir el navegador (RLS, GRANT, Realtime, Storage) y datos personales (texto crudo, fotos, coordenadas exactas).
- **Datos raros:** faltantes, NaN, duplicados, mal formados y simulados.
- **Tests:** que fallen con el código anterior, IDs únicos y limpieza solo de lo creado.
