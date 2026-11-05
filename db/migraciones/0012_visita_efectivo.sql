-- 0012 · Bloque 4, primer flujo: visita individual de $50 pagada en efectivo (solo datos ficticios).
-- Indicado el 4 nov 2026:
--   - Recepción elige la ficha existente del visitante, revisa el cobro y lo confirma;
--   - una operación = un cobro + un pase por visitante; la visita guarda la sucursal donde ocurrió;
--   - el efectivo entra a la bolsa de visitas del turno abierto, ligado a turno, lugar y responsable;
--   - «Recibido» es opcional; si se escribe, no puede ser menor que el total, y el cambio no entra a la bolsa;
--   - solo cobra la responsable vigente de la bolsa (regla de esta prueba);
--   - un doble clic o un reintento con la misma clave no crea otra visita ni otra entrada de efectivo;
--   - corrección, cancelación y devolución quedan para otro paso: aquí nada se edita ni se borra.

-- ---------------------------------------------------------------------------
-- Operación: lo que Recepción confirma de una vez. `clave` la genera el servidor al revisar el cobro y
-- viaja con la confirmación: si llega dos veces, la segunda no crea nada.
-- ---------------------------------------------------------------------------
create table operacion_visita (
  id             uuid primary key default gen_random_uuid(),
  clave          uuid not null unique,
  sucursal_id    uuid not null references sucursal (id),
  turno_id       uuid not null references turno (id),
  registrada_por uuid not null references usuario (id),
  registrada_en  timestamptz not null default now(),
  total          numeric(12, 2) not null check (total >= 0)
);
create index operacion_visita_turno on operacion_visita (turno_id);

-- Un cobro por operación. Por ahora solo efectivo confirmado; tarjeta y transferencia llegan después.
create table cobro_visita (
  id           uuid primary key default gen_random_uuid(),
  operacion_id uuid not null unique references operacion_visita (id),
  forma_pago   text not null check (forma_pago in ('efectivo')),
  estado       text not null check (estado in ('confirmado')),
  importe      numeric(12, 2) not null check (importe > 0),
  recibido     numeric(12, 2),
  cambio       numeric(12, 2),
  creado_en    timestamptz not null default now(),
  constraint cobro_recibido_coherente check (
    (recibido is null and cambio is null)
    or (recibido is not null and cambio is not null and recibido >= importe and cambio = recibido - importe))
);

-- Un pase por visitante. Guarda la sucursal donde ocurrió la visita, aunque la ficha sea de otra.
create table pase_visita (
  id           uuid primary key default gen_random_uuid(),
  operacion_id uuid not null references operacion_visita (id),
  visitante_id uuid not null references visitante (id),
  sucursal_id  uuid not null references sucursal (id),
  tarifa       numeric(12, 2) not null check (tarifa >= 0),
  descuento    numeric(12, 2) not null default 0 check (descuento >= 0),
  total        numeric(12, 2) not null,
  creado_en    timestamptz not null default now(),
  constraint pase_total_coherente check (total = tarifa - descuento and total >= 0),
  unique (operacion_id, visitante_id)
);
create index pase_visita_visitante on pase_visita (visitante_id);

-- Movimiento de efectivo: entra a un lugar, en un turno, con su responsable en ese momento.
-- Solo el importe de la visita; el cambio que se devuelve no es un movimiento de la bolsa.
create table movimiento_efectivo (
  id             bigint generated always as identity primary key,
  lugar_id       uuid not null references lugar_efectivo (id),
  turno_id       uuid not null references turno (id),
  tipo           text not null check (tipo in ('entrada_cobro_visita')),
  importe        numeric(12, 2) not null check (importe > 0),
  cobro_id       uuid not null unique references cobro_visita (id),
  responsable_id uuid not null references usuario (id),
  registrado_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);
create index movimiento_efectivo_turno on movimiento_efectivo (turno_id, lugar_id);

-- El lugar del movimiento debe ser de la misma sucursal que el turno, y el turno debe estar abierto.
create function movimiento_efectivo_valido() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
    where t.id = new.turno_id and l.id = new.lugar_id and t.cerrado_en is null
  ) then
    raise exception 'El movimiento debe ser de un lugar de la sucursal de un turno abierto'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger movimiento_efectivo_lugar_turno
  before insert on movimiento_efectivo
  for each row execute function movimiento_efectivo_valido();

-- Nada de esto se edita ni se borra: correcciones, cancelaciones y devoluciones serán registros nuevos.
create trigger operacion_visita_inmutable before update or delete on operacion_visita
  for each row execute function impedir_modificacion();
create trigger cobro_visita_inmutable before update or delete on cobro_visita
  for each row execute function impedir_modificacion();
create trigger pase_visita_inmutable before update or delete on pase_visita
  for each row execute function impedir_modificacion();
create trigger movimiento_efectivo_inmutable before update or delete on movimiento_efectivo
  for each row execute function impedir_modificacion();
create trigger operacion_visita_sin_vaciar before truncate on operacion_visita
  for each statement execute function impedir_modificacion();
create trigger cobro_visita_sin_vaciar before truncate on cobro_visita
  for each statement execute function impedir_modificacion();
create trigger pase_visita_sin_vaciar before truncate on pase_visita
  for each statement execute function impedir_modificacion();
create trigger movimiento_efectivo_sin_vaciar before truncate on movimiento_efectivo
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Permiso PROVISIONAL: registra visitas Recepción. Además, en esta prueba solo cobra la responsable
-- vigente de la bolsa (se comprueba en el servidor al confirmar).
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values ('recepcion', 'visita.registrar');
