-- Esquema inicial de Drena (docs/plan-desarrollo.md §9.4)
-- Coordenadas en WGS84 (EPSG:4326). Distancias en metros con ::geography.

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Red de sumideros (fase Antes)
-- ---------------------------------------------------------------------------
create table if not exists intersections (
  id          text primary key,
  nombre      text not null,
  geom        geometry(Point, 4326) not null,
  comuna      text not null default 'Ñuñoa'
);

create table if not exists sumideros (
  id              text primary key,                 -- id del catastro DOH o 'campo-<n>'
  geom            geometry(Point, 4326) not null,
  fuente          text not null check (fuente in ('doh', 'campo', 'osm', 'manual')),
  intersection_id text references intersections(id),
  street_id       text,
  orden_en_calle  int,                              -- 0 = el más alto de la calle
  elevacion       double precision,
  -- arboles, feria, obras, suelo, pendiente, area_aporte, criticidad... (normalizados 0-1)
  features        jsonb not null default '{}'::jsonb,
  is_simulated    boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists sumideros_geom_idx on sumideros using gist (geom);
create index if not exists sumideros_street_idx on sumideros (street_id);

create table if not exists street_chains (
  street_id     text primary key,
  nombre        text,
  sumidero_ids  text[] not null,                    -- de mayor a menor elevación
  distancias_m  double precision[] not null         -- distancia acumulada desde el primero
);

create table if not exists scenarios (
  id           text primary key,
  nombre       text not null,
  descripcion  text,
  parametros   jsonb not null default '{}'::jsonb   -- parámetros de lluvia
);

-- ---------------------------------------------------------------------------
-- Observaciones y Claude (fase Durante)
-- ---------------------------------------------------------------------------
create table if not exists observations (
  id            uuid primary key default gen_random_uuid(),
  sumidero_id   text references sumideros(id),
  geom          geometry(Point, 4326),
  fuente        text not null check (fuente in ('vecino', 'cuadrilla', 'camara')),
  tipo          text not null check (tipo in ('foto_rejilla', 'foto_agua', 'texto', 'cuadro_camara')),
  media_url     text,
  texto         text,
  ts            timestamptz not null default now(),
  is_simulated  boolean not null default false
);
create index if not exists observations_geom_idx on observations using gist (geom);
create index if not exists observations_sumidero_idx on observations (sumidero_id, ts desc);

create table if not exists claude_cache (
  cache_key   text primary key,                     -- hash del contenido + versión del prompt
  respuesta   jsonb not null,
  modelo      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists classifications (
  id              uuid primary key default gen_random_uuid(),
  observation_id  uuid not null references observations(id) on delete cascade,
  resultado       jsonb not null,                   -- esquemas de la sección 5
  modelo          text not null,
  prompt_version  text not null,
  cache_key       text,
  latencia_ms     int,
  respuesta_cruda text,
  created_at      timestamptz not null default now()
);
create index if not exists classifications_obs_idx on classifications (observation_id);

-- ---------------------------------------------------------------------------
-- Fórmula
-- ---------------------------------------------------------------------------
create table if not exists scores (
  sumidero_id  text not null references sumideros(id) on delete cascade,
  scenario_id  text not null references scenarios(id) on delete cascade,
  modo         text not null check (modo in ('antes', 'durante')),
  p_pred       double precision,
  p_obs        double precision,
  p_ef         double precision,
  c            double precision,
  prioridad    double precision,
  rank         int,
  explicacion  text,
  computed_at  timestamptz not null default now(),
  primary key (sumidero_id, scenario_id, modo)
);
create index if not exists scores_rank_idx on scores (scenario_id, modo, rank);

-- ---------------------------------------------------------------------------
-- Casos, cuadrillas, misiones y rutas
-- ---------------------------------------------------------------------------
create table if not exists cases (
  id           uuid primary key default gen_random_uuid(),
  geom         geometry(Point, 4326) not null,
  sumidero_id  text references sumideros(id),
  estado       text not null default 'abierto'
               check (estado in ('abierto', 'asignado', 'en_curso', 'resuelto', 'descartado')),
  urgente      boolean not null default false,
  abierto_at   timestamptz not null default now(),
  cerrado_at   timestamptz
);
create index if not exists cases_geom_idx on cases using gist (geom);

create table if not exists case_observations (
  case_id         uuid not null references cases(id) on delete cascade,
  observation_id  uuid not null references observations(id) on delete cascade,
  primary key (case_id, observation_id)
);

create table if not exists crews (
  id            text primary key,
  nombre        text not null,
  equipamiento  text[] not null default '{}',
  estado        text not null default 'disponible',
  geom_actual   geometry(Point, 4326),
  is_simulated  boolean not null default true
);

create table if not exists crew_positions (
  id       bigint generated always as identity primary key,
  crew_id  text not null references crews(id) on delete cascade,
  geom     geometry(Point, 4326) not null,
  ts       timestamptz not null default now()
);
create index if not exists crew_positions_idx on crew_positions (crew_id, ts desc);

create table if not exists missions (
  id           uuid primary key default gen_random_uuid(),
  crew_id      text references crews(id),
  sumidero_id  text references sumideros(id),
  case_id      uuid references cases(id),
  orden        int,
  estado       text not null default 'pendiente'
               check (estado in ('pendiente', 'en_camino', 'en_sitio', 'cerrada', 'cancelada')),
  asignada_at  timestamptz not null default now(),
  cerrada_at   timestamptz,
  check (sumidero_id is not null or case_id is not null)
);
create index if not exists missions_crew_idx on missions (crew_id, orden);

create table if not exists routes (
  crew_id      text not null references crews(id) on delete cascade,
  version      int not null,
  geojson      jsonb not null,
  paradas      jsonb not null default '[]'::jsonb,
  computed_at  timestamptz not null default now(),
  primary key (crew_id, version)
);

create table if not exists closures (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references missions(id) on delete cascade,
  foto_url       text,
  clasificacion  jsonb,
  verificado     boolean not null default false,
  created_at     timestamptz not null default now()
);

create table if not exists cleaning_history (
  id            bigint generated always as identity primary key,
  sumidero_id   text not null references sumideros(id) on delete cascade,
  fecha         date not null,
  is_simulated  boolean not null default true
);
create index if not exists cleaning_history_idx on cleaning_history (sumidero_id, fecha desc);

-- Línea de tiempo para auditoría, informe y repetición de la demo
create table if not exists events (
  id       bigint generated always as identity primary key,
  tipo     text not null,
  payload  jsonb not null default '{}'::jsonb,
  ts       timestamptz not null default now()
);
create index if not exists events_ts_idx on events (ts);

-- ---------------------------------------------------------------------------
-- RLS en la misma transacción que crea las tablas: ninguna queda expuesta a la
-- Data API ni un instante. Sin políticas, el navegador (anon) no lee nada; las
-- políticas de lectura se agregan en 0002. El backend usa DATABASE_URL y no pasa por RLS.
-- ---------------------------------------------------------------------------
alter table intersections     enable row level security;
alter table sumideros         enable row level security;
alter table street_chains     enable row level security;
alter table scenarios         enable row level security;
alter table observations      enable row level security;
alter table claude_cache      enable row level security;
alter table classifications   enable row level security;
alter table scores            enable row level security;
alter table cases             enable row level security;
alter table case_observations enable row level security;
alter table crews             enable row level security;
alter table crew_positions    enable row level security;
alter table missions          enable row level security;
alter table routes            enable row level security;
alter table closures          enable row level security;
alter table cleaning_history  enable row level security;
alter table events            enable row level security;
