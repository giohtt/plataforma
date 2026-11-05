-- 0009 · Bloque 2: reporte básico de expedientes (solo datos ficticios). Indicado el 4 nov 2026:
--   - lo ven Encargado, Administración y Dirección, según sus sucursales autorizadas; Recepción no;
--   - «Expedientes creados» por sucursal (donde se creó la ficha) y periodo;
--   - posibles duplicados pendientes: pares de fichas activas con el mismo teléfono o nombre muy parecido,
--     sin los ya confirmados como personas distintas ni las fichas unidas a otra. Un par de fichas creadas en
--     sucursales distintas solo se muestra a quien tiene el reporte en ambas.

insert into permiso (clave, descripcion, bloque, es_autorizacion, ambito) values
  ('reporte.expedientes', 'Consultar el reporte de expedientes creados y posibles duplicados', 2, false, 'sucursal');

insert into rol_permiso (rol, permiso) values
  ('encargado',      'reporte.expedientes'),
  ('administracion', 'reporte.expedientes'),
  ('direccion',      'reporte.expedientes');
