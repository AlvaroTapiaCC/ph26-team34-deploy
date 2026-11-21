-- Datos descriptivos de cada sumidero para el mapa y la ficha (issue #14).
-- comuna y calle vienen del catastro DOH; etiquetas marca subconjuntos como la zona de la
-- prueba de campo ('zona_mut'). Son datos públicos del catastro: heredan el SELECT de anon.
alter table sumideros add column if not exists comuna text;
alter table sumideros add column if not exists calle text;
alter table sumideros add column if not exists etiquetas text[] not null default '{}';
create index if not exists sumideros_comuna_idx on sumideros (comuna);
create index if not exists sumideros_etiquetas_idx on sumideros using gin (etiquetas);
