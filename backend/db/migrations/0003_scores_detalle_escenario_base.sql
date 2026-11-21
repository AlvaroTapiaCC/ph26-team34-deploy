-- Detalle de cada score: aporte de cada factor, para la ficha y para que Claude explique (§5.4).
alter table scores add column if not exists detalle jsonb not null default '{}'::jsonb;

-- Escenario por defecto, para que siempre haya una tabla de misiones.
insert into scenarios (id, nombre, descripcion, parametros)
values ('base', 'Lluvia pronosticada', 'Escenario base con el pronóstico del día y sin observaciones simuladas.', '{}'::jsonb)
on conflict (id) do nothing;
