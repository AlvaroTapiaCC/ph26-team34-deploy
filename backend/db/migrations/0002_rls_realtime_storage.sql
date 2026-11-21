-- Seguridad, Realtime y Storage.
--
-- El backend escribe y lee todo con DATABASE_URL / secret key, que no pasan por RLS.
-- El navegador (publishable key) solo puede LEER lo que muestra la demo sin datos
-- personales ni crudos: la red de sumideros, los escenarios, el ranking y el estado
-- operativo (casos, misiones, rutas). Lo demás se sirve por la API del backend.
-- (RLS ya quedó activo en 0001; ver 0004 para el ajuste del proyecto existente.)

do $$
declare t text;
begin
  foreach t in array array[
    'intersections','sumideros','street_chains','scenarios','scores',
    'cases','missions','routes'
  ] loop
    execute format('drop policy if exists "lectura publica" on %I', t);
    execute format('create policy "lectura publica" on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;
-- Sin lectura anónima: observations y classifications (reportes crudos de vecinos),
-- crews y crew_positions (posiciones de cuadrillas), case_observations, closures,
-- cleaning_history, events y claude_cache.

-- Realtime (§9.4)
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['scores','cases','missions','routes','crews','observations'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- Bucket de fotos PRIVADO: sin políticas en storage.objects, nadie lo lee con la
-- publishable key. El backend sube con la secret key y entrega enlaces firmados
-- que vencen (services/storage.py).
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do update set public = false;
