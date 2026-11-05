-- 0010 · Bloque 3, primer paso: apertura de turno de Recepción (solo datos ficticios). Indicado el 4 nov 2026:
--   - un solo turno de Recepción abierto a la vez por sucursal, validado en el servidor y en la base;
--   - la bolsa de visitas y el cajón de mensualidades son lugares de efectivo separados, cada uno con su responsable;
--   - al abrir se registra solo el total contado de cada lugar ($0 es válido); sin fondo fijo ni desglose;
--   - abrir no registra cobros ni movimientos; la entrega entre turnos es del bloque 5;
--   - el cajón se muestra «No conciliado: faltan datos de Open Desk».

-- ---------------------------------------------------------------------------
-- Lugares de efectivo: uno de cada tipo por sucursal, también para sucursales que se creen después.
-- ---------------------------------------------------------------------------
create table lugar_efectivo (
  id          uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursal (id),
  tipo        text not null check (tipo in ('bolsa_visitas', 'cajon_mensualidades')),
  creado_en   timestamptz not null default now(),
  unique (sucursal_id, tipo)
);
insert into lugar_efectivo (sucursal_id, tipo)
  select s.id, t.tipo from sucursal s cross join (values ('bolsa_visitas'), ('cajon_mensualidades')) as t(tipo);

create function crear_lugares_efectivo() returns trigger
language plpgsql as $$
begin
  insert into lugar_efectivo (sucursal_id, tipo)
  values (new.id, 'bolsa_visitas'), (new.id, 'cajon_mensualidades')
  on conflict do nothing;
  return new;
end;
$$;
create trigger sucursal_lugares_efectivo
  after insert on sucursal
  for each row execute function crear_lugares_efectivo();
create trigger lugar_efectivo_sin_borrar
  before delete on lugar_efectivo
  for each row execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Turno de Recepción. Uno abierto a la vez por sucursal: lo garantiza este índice aunque dos personas
-- intenten abrir al mismo tiempo.
-- ---------------------------------------------------------------------------
create table turno (
  id           uuid primary key default gen_random_uuid(),
  sucursal_id  uuid not null references sucursal (id),
  abierto_por  uuid not null references usuario (id),
  abierto_en   timestamptz not null default now(),
  cerrado_en   timestamptz,
  constraint turno_cierre_posterior check (cerrado_en is null or cerrado_en >= abierto_en)
);
create unique index turno_uno_abierto_por_sucursal on turno (sucursal_id) where cerrado_en is null;
create trigger turno_sin_borrar
  before delete on turno
  for each row execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Responsable de cada lugar de efectivo por periodo. La bolsa y el cajón se registran por separado,
-- aunque sean la misma persona (regla provisional de esta prueba). Un solo responsable vigente por lugar.
-- ---------------------------------------------------------------------------
create table responsable_lugar (
  id          uuid primary key default gen_random_uuid(),
  lugar_id    uuid not null references lugar_efectivo (id),
  turno_id    uuid not null references turno (id),
  usuario_id  uuid not null references usuario (id),
  desde       timestamptz not null default now(),
  hasta       timestamptz,
  constraint responsable_periodo check (hasta is null or hasta >= desde),
  unique (turno_id, lugar_id)
);
create unique index responsable_vigente_por_lugar on responsable_lugar (lugar_id) where hasta is null;
create trigger responsable_lugar_sin_borrar
  before delete on responsable_lugar
  for each row execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Conteos: el total contado en un lugar, en un momento del turno. Por ahora solo «apertura».
-- No se editan ni se borran: una diferencia se registra, no se corrige.
-- ---------------------------------------------------------------------------
create table conteo_efectivo (
  id          bigint generated always as identity primary key,
  turno_id    uuid not null references turno (id),
  lugar_id    uuid not null references lugar_efectivo (id),
  momento     text not null check (momento in ('apertura')),
  importe     numeric(12, 2) not null check (importe >= 0),
  contado_por uuid not null references usuario (id),
  en          timestamptz not null default now(),
  unique (turno_id, lugar_id, momento)
);
create trigger conteo_efectivo_inmutable
  before update or delete on conteo_efectivo
  for each row execute function impedir_modificacion();
create trigger conteo_efectivo_sin_vaciar
  before truncate on conteo_efectivo
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Permisos PROVISIONALES: abre turno Recepción; consultan Recepción, Encargado, Administración y Dirección.
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values
  ('recepcion',      'turno.abrir'),
  ('recepcion',      'turno.consultar'),
  ('encargado',      'turno.consultar'),
  ('administracion', 'turno.consultar'),
  ('direccion',      'turno.consultar');
