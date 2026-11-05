-- 0011 · Bloque 3: reporte básico de turnos abiertos y responsables (solo consulta, datos ficticios).
-- Indicado el 4 nov 2026: lo ven Encargado, Administración y Dirección en sus sucursales autorizadas.
-- Recepción sigue viendo su propio turno (turno.consultar), pero no este reporte.

insert into permiso (clave, descripcion, bloque, es_autorizacion, ambito) values
  ('reporte.turnos', 'Consultar el reporte de turnos abiertos y responsables de cada lugar de efectivo', 3, false, 'sucursal');

insert into rol_permiso (rol, permiso) values
  ('encargado',      'reporte.turnos'),
  ('administracion', 'reporte.turnos'),
  ('direccion',      'reporte.turnos');
