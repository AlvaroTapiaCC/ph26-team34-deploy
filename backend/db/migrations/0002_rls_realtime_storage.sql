-- Seguridad, Realtime y Storage.
--
-- El backend escribe con DATABASE_URL / secret key, que se saltan RLS.
-- El navegador (publishable key) solo puede LEER las tablas que muestra la app.
-- Sin estas políticas el frontend no vería nada, ni siquiera por Realtime.

do $$
declare t text;
begin
  foreach t in array array[
    'intersections','sumideros','street_chains','scenarios','observations','claude_cache',
    'classifications','scores','cases','case_observations','crews','crew_positions',
    'missions','routes','closures','cleaning_history','events'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- Lectura pública: lo que muestran /central, /cuadrilla y /reportar.
  -- claude_cache queda sin política: solo el backend la lee.
  foreach t in array array[
    'intersections','sumideros','street_chains','scenarios','observations','classifications',
    'scores','cases','case_observations','crews','crew_positions','missions','routes',
    'closures','cleaning_history','events'
  ] loop
    execute format('drop policy if exists "lectura publica" on %I', t);
    execute format('create policy "lectura publica" on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

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

-- Bucket de fotos: lectura pública por URL; solo el backend sube archivos.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;
