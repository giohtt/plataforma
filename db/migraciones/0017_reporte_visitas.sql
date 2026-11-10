-- 0017 · Bloque 4: reporte «Visitas y cobros» (solo consulta, datos ficticios). Indicado el 9 nov 2026:
-- lo ven Encargado, Administración y Dirección en sus sucursales autorizadas; Recepción no.

-- El permiso ya estaba en el catálogo (0002) sin asignar a ningún rol; aquí se precisa y se asigna.
update permiso set descripcion = 'Consultar el reporte de visitas y cobros por sucursal y periodo', ambito = 'sucursal'
where clave = 'reporte.visitas';

insert into rol_permiso (rol, permiso) values
  ('encargado',      'reporte.visitas'),
  ('administracion', 'reporte.visitas'),
  ('direccion',      'reporte.visitas');
