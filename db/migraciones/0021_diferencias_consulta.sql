-- 0021 · Bloque 5, paso 2 (primera parte): lista de diferencias de efectivo y desglose del saldo esperado (solo
-- datos ficticios). Consultan Encargado, Administración y Dirección en sus sucursales. Recepción no.
-- Los resultados de la revisión («Aclarada», «Faltante confirmado») se agregan en otra migración, una vez aprobados.
insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('diferencia.consultar', 'Consultar las diferencias de efectivo de entregas y cierres, con el desglose del saldo esperado', 5, false);
insert into rol_permiso (rol, permiso) values
  ('encargado', 'diferencia.consultar'),
  ('administracion', 'diferencia.consultar'),
  ('direccion', 'diferencia.consultar');
