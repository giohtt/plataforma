-- 0007 · Bloque 2: corrección de expedientes con motivo, dato anterior, dato nuevo, quién y cuándo.
-- Solo datos ficticios. Indicado para esta primera entrega (4 nov 2026):
--   - corrigen Encargado y Dirección, según sus sucursales autorizadas;
--   - solo expedientes creados en una sucursal donde la persona tenga el permiso;
--   - Recepción y Administración no editan.

insert into rol_permiso (rol, permiso) values
  ('encargado', 'visitante.corregir'),
  ('direccion', 'visitante.corregir');

-- Versión de la fila: si otra persona corrigió mientras tanto, el cambio se rechaza en vez de sobrescribir.
alter table visitante add column version integer not null default 1 check (version >= 1);

-- Una fila por campo cambiado. Guarda el valor completo (es el «dato anterior» que se conserva);
-- al mostrarse, el teléfono se enmascara igual que en el expediente.
create table visitante_cambio (
  id             bigint generated always as identity primary key,
  visitante_id   uuid not null references visitante (id),
  campo          text not null check (campo in ('nombre', 'telefono', 'estado_procedencia')),
  valor_anterior text,
  valor_nuevo    text,
  motivo         text not null check (length(btrim(motivo)) between 5 and 300),
  usuario_id     uuid not null references usuario (id),
  sucursal_id    uuid not null references sucursal (id),
  en             timestamptz not null default now(),
  constraint visitante_cambio_distinto check (valor_anterior is distinct from valor_nuevo)
);
create index visitante_cambio_por_visitante on visitante_cambio (visitante_id, en);
create trigger visitante_cambio_inmutable
  before update or delete on visitante_cambio
  for each row execute function impedir_modificacion();
create trigger visitante_cambio_sin_vaciar
  before truncate on visitante_cambio
  for each statement execute function impedir_modificacion();
