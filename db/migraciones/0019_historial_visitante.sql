-- 0019 · Bloque 4: historial del visitante entre sucursales (solo datos ficticios). Indicado el 10 nov 2026:
--   - Recepción y Encargado ven el detalle de sus sucursales asignadas; de las demás, solo el conteo y la fecha y
--     sucursal de la última visita registrada. La primera visita, importes, formas de pago, cobros y accesos solo
--     dentro de las sucursales autorizadas.
--   - Administración y Dirección ven el historial solo de sus sucursales asignadas (vista y totales).
--   - Dirección registra desde cuándo hay datos confiables por sucursal; el primer turno no lo fija solo.
--     Si falta cobertura de alguna sucursal o periodo del alcance, el historial se marca «incompleto».

-- Detalle de visitas en la sucursal: el permiso ya existía en el catálogo (0002) sin asignar.
insert into rol_permiso (rol, permiso) values
  ('recepcion',      'visita.consultar'),
  ('encargado',      'visita.consultar'),
  ('administracion', 'visita.consultar'),
  ('direccion',      'visita.consultar');

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('visita.resumen_otras', 'Ver el conteo y la última visita registrada del visitante en otras sucursales', 4, false),
  ('historial.cobertura',  'Registrar desde cuándo hay datos confiables de visitas en la sucursal', 4, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion', 'visita.resumen_otras'),
  ('encargado', 'visita.resumen_otras'),
  ('direccion', 'historial.cobertura');

-- Cobertura del historial por sucursal. Solo se agregan registros; vale el más reciente de cada sucursal.
create table cobertura_historial (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  desde         date not null,
  desde_inicio  boolean not null,   -- los datos cubren desde que la sucursal empezó a operar
  nota          text check (nota is null or length(btrim(nota)) between 5 and 300),
  registrada_por uuid not null references usuario (id),
  registrada_en timestamptz not null default now()
);
create index cobertura_historial_sucursal on cobertura_historial (sucursal_id, registrada_en desc);
create trigger cobertura_historial_inmutable
  before update or delete on cobertura_historial
  for each row execute function impedir_modificacion();
create trigger cobertura_historial_sin_vaciar
  before truncate on cobertura_historial
  for each statement execute function impedir_modificacion();
