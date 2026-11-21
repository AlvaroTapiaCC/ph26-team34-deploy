-- Permisos explícitos para el navegador (revisión del PR #57).
--
-- Supabase da por defecto TODOS los privilegios a anon y authenticated sobre cada tabla
-- nueva de public (incluido TRUNCATE, que RLS no controla). Las políticas de 0002/0004
-- ya limitan qué filas se leen; esto agrega la segunda capa: el navegador solo tiene
-- SELECT, y solo en las tablas que muestra la demo. Las escrituras van por el backend.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on
  intersections, sumideros, street_chains, scenarios, scores, cases, missions, routes
to anon, authenticated;

-- Tablas y secuencias que se creen después: sin acceso del navegador salvo GRANT explícito
-- en su migración.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
