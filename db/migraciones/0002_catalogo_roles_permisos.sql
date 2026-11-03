-- 0002 · Catálogo de roles y permisos.
-- Es información de referencia, igual en todos los entornos. No asigna nada a nadie:
-- la relación rol–permiso y las asignaciones se configuran en la tarea 4.

insert into rol (clave, nombre, descripcion, disponible_en_bloque_1) values
  ('recepcion',      'Recepción',                      'Registra la operación de su turno y solicita lo que requiere aprobación.', true),
  ('encargado',      'Encargado de sucursal',          'Consulta y da seguimiento a sus sucursales. Autoriza solo con delegación expresa.', true),
  ('administracion', 'Administración',                 'Revisa movimientos, comprobantes, gastos y cierres; prepara pagos.', true),
  ('direccion',      'Dirección',                      'Consulta resultados según su alcance; autoriza según facultades otorgadas.', true),
  ('contabilidad',   'Contabilidad y fiscal',          'Registros contables y seguimiento fiscal. Etapa posterior.', false),
  ('mantenimiento',  'Mantenimiento',                  'Fallas, órdenes de trabajo y repuestos. Etapa posterior.', false),
  ('marketing',      'Marketing y atención digital',   'Mensajes e interesados. Etapa posterior.', false),
  ('soporte',        'Soporte técnico',                'Configuración técnica con acceso limitado y temporal; sin facultades financieras.', false);

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  -- Bloque 1. Usuarios, permisos y sucursales
  ('sucursal.consultar',        'Consultar sucursales dentro del alcance asignado', 1, false),
  ('sucursal.crear',            'Crear sucursales', 1, false),
  ('sucursal.editar',           'Editar datos de sucursales', 1, false),
  ('sucursal.desactivar',       'Desactivar sucursales conservando su historial', 1, false),
  ('usuario.consultar',         'Consultar usuarios dentro del alcance asignado', 1, false),
  ('usuario.crear',             'Crear usuarios', 1, false),
  ('usuario.editar',            'Editar o desactivar usuarios', 1, false),
  ('usuario.asignar',           'Asignar o revocar roles y sucursales', 1, false),
  ('usuario.restablecer',       'Generar enlace para que el usuario fije su contraseña', 1, false),
  ('historial.consultar',       'Consultar el historial de cambios', 1, false),
  -- Bloque 2. Expedientes de visitantes
  ('visitante.buscar',          'Buscar expedientes por nombre o teléfono', 2, false),
  ('visitante.consultar',       'Consultar el expediente de un visitante', 2, false),
  ('visitante.crear',           'Crear expedientes', 2, false),
  ('visitante.corregir',        'Corregir datos de un visitante con motivo', 2, false),
  ('visitante.fusionar',        'Fusionar expedientes duplicados', 2, false),
  ('visitante.historial_general','Consultar el historial general entre sucursales', 2, false),
  -- Bloque 3. Turnos y lugares de efectivo
  ('turno.abrir',               'Abrir turno y recibir un lugar de efectivo', 3, false),
  ('turno.consultar',           'Consultar turnos y responsables', 3, false),
  -- Bloque 4. Visitas, cobros y movimientos de efectivo
  ('visita.registrar',          'Registrar visitas y cobros', 4, false),
  ('visita.consultar',          'Consultar visitas y cobros', 4, false),
  ('visita.solicitar_cancelacion','Solicitar cancelación o devolución de un cobro', 4, false),
  ('acceso.registrar_apertura', 'Registrar apertura manual del acceso', 4, false),
  ('cobro.verificar_abono',     'Verificar abonos de transferencias', 4, false),
  ('reporte.visitas',           'Consultar reportes de visitas y cobros', 4, false),
  -- Bloque 5. Conteos, entregas, retiros, cierre y revisión
  ('caja.contar',               'Registrar conteos de efectivo', 5, false),
  ('caja.entregar',             'Registrar entregas entre responsables', 5, false),
  ('caja.retirar',              'Registrar retiros de efectivo', 5, false),
  ('caja.cerrar',               'Cerrar turno', 5, false),
  ('caja.revisar_cierre',       'Revisar cierres hechos por otra persona', 5, false),
  -- Bloque 6. Gastos y autorizaciones
  ('gasto.solicitar',           'Solicitar gastos', 6, false),
  ('gasto.consultar',           'Consultar gastos', 6, false),
  ('gasto.pagar',               'Registrar el pago de un gasto autorizado', 6, false),
  ('gasto.comprobar',           'Revisar comprobantes de gastos', 6, false),
  ('autorizacion.gasto',        'Autorizar gastos', 6, true),
  ('autorizacion.devolucion',   'Autorizar cancelaciones y devoluciones', 6, true),
  -- Bloque 7. Promociones y beneficios
  ('promocion.administrar',     'Crear y administrar promociones', 7, false),
  ('beneficio.registrar',       'Registrar beneficios de pronto pago', 7, false),
  -- Bloque 8. Pases QR
  ('pase.cancelar',             'Cancelar pases', 8, false),
  ('pase.reenviar',             'Reenviar pases', 8, false);
