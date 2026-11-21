-- Casos sin coordenadas exactas para el navegador (revisión del PR #57).
--
-- cases.geom puede venir del GPS de un reporte de vecino: es dato personal. `cases` pasa
-- a ser privada (solo backend) y el navegador lee `casos_publicos`, que un trigger mantiene
-- sincronizada con una ubicación pública:
--   - la del sumidero asociado, si lo hay;
--   - si no, la coordenada redondeada a 0,001° (~110 m).
-- casos_publicos está en Realtime: /central sigue viendo casos en vivo sin el GPS.
--
-- Regla para misiones y rutas visibles en el navegador: sus paradas usan esta ubicación
-- pública (o la del sumidero), nunca cases.geom. La app de cuadrilla obtiene la ubicación
-- exacta desde el backend.

create table if not exists casos_publicos (
  id           uuid primary key references cases(id) on delete cascade,
  sumidero_id  text,
  geom         geometry(Point, 4326) not null,
  estado       text not null,
  urgente      boolean not null,
  abierto_at   timestamptz not null,
  cerrado_at   timestamptz
);
alter table casos_publicos enable row level security;

create or replace function casos_publicos_sync() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'DELETE' then
    delete from casos_publicos where id = old.id;
    return old;
  end if;
  insert into casos_publicos (id, sumidero_id, geom, estado, urgente, abierto_at, cerrado_at)
  values (
    new.id,
    new.sumidero_id,
    coalesce((select s.geom from sumideros s where s.id = new.sumidero_id),
             st_snaptogrid(new.geom, 0.001)),
    new.estado, new.urgente, new.abierto_at, new.cerrado_at)
  on conflict (id) do update set
    sumidero_id = excluded.sumidero_id, geom = excluded.geom, estado = excluded.estado,
    urgente = excluded.urgente, abierto_at = excluded.abierto_at, cerrado_at = excluded.cerrado_at;
  return new;
end $$;
revoke all on function casos_publicos_sync() from public, anon, authenticated;

drop trigger if exists casos_publicos_sync on cases;
create trigger casos_publicos_sync
  after insert or update or delete on cases
  for each row execute function casos_publicos_sync();

-- Copiar los casos que ya existan
insert into casos_publicos (id, sumidero_id, geom, estado, urgente, abierto_at, cerrado_at)
select c.id, c.sumidero_id,
       coalesce(s.geom, st_snaptogrid(c.geom, 0.001)),
       c.estado, c.urgente, c.abierto_at, c.cerrado_at
  from cases c left join sumideros s on s.id = c.sumidero_id
on conflict (id) do nothing;

-- cases queda privada: sin política, sin GRANT y fuera de Realtime
drop policy if exists "lectura publica" on cases;
revoke all on cases from anon, authenticated;
do $$
begin
  if exists (select 1 from pg_publication_tables
              where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cases') then
    alter publication supabase_realtime drop table cases;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'casos_publicos') then
    alter publication supabase_realtime add table casos_publicos;
  end if;
end $$;

-- casos_publicos: solo lectura para el navegador
drop policy if exists "lectura publica" on casos_publicos;
create policy "lectura publica" on casos_publicos for select to anon, authenticated using (true);
revoke all on casos_publicos from anon, authenticated;
grant select on casos_publicos to anon, authenticated;
