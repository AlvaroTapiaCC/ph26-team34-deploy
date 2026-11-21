-- Corrige el proyecto ya creado con la versión anterior de 0002 (revisión del PR #57):
-- 1. Quita la lectura anónima de reportes crudos, posiciones de cuadrillas y otros datos
--    internos. Quedan públicos solo: intersections, sumideros, street_chains, scenarios,
--    scores, cases, missions y routes.
-- 2. Deja privado el bucket `photos` (se accede con enlaces firmados desde el backend).
-- Es idempotente: en una base nueva (0001 y 0002 ya corregidas) no cambia nada.

do $$
declare t text;
begin
  foreach t in array array[
    'observations','classifications','case_observations','crews','crew_positions',
    'closures','cleaning_history','events','claude_cache'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "lectura publica" on %I', t);
  end loop;
end $$;

update storage.buckets set public = false where id = 'photos';
