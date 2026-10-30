# Plan general de implementación

Fecha: 30 de octubre de 2026. Estado: **en revisión**.
Requisitos ampliados: [`requisitos-visitantes-promociones-qr.md`](requisitos-visitantes-promociones-qr.md).
Detalle del bloque 1: [`plan-entrega-1.md`](plan-entrega-1.md).

## Alcance

**Primera versión (alcance original, se conserva):** visitas y cobros, caja y turnos, cierres, gastos y
autorizaciones, con reportes administrativos por sucursal. Open Desk sigue operando socios, membresías y accesos.

**Ampliación (se suma, no sustituye):** expediente de visitantes con historial entre sucursales, promociones
y beneficios, y pases QR individuales.

## Reglas para todo el plan

- Cada bloque incluye sus **reportes básicos y sus pruebas automáticas**. Los totales se comprueban en
  cada bloque, no al final. Los reportes avanzados pueden llegar después.
- Las pruebas de permisos incluyen **solicitudes directas al servidor**.
- **No se registran cobros reales** hasta que cada movimiento quede relacionado con caja, turno y responsable.
- El **cajón de mensualidades** se muestra **no conciliado** mientras falten los datos de Open Desk.
- Una decisión pendiente solo frena el bloque que depende de ella. Se resuelven primero las del bloque que
  sigue.
- Todo con datos ficticios hasta tener aviso de privacidad, respaldos y restauración probada.

## Orden de implementación

### Bloque 1. Usuarios, permisos y sucursales (en curso)
1. ~~Repositorio y entorno.~~ Hecho en GitHub. **Falta publicar el sitio de pruebas en Vercel.**
2. Base de datos y migraciones.
3. Inicio y cierre de sesión; recuperación con enlace de un solo uso para que el usuario fije su contraseña.
4. Permisos y asignación de sucursales. El catálogo incluye los permisos de todos los bloques, sin asignarlos a nadie.
5. Catálogo persistente de sucursales.
6. Pruebas de acceso permitido y denegado.
- **Reporte básico:** usuarios y sus asignaciones por sucursal.
- **Decisiones que necesita:** ninguna nueva.

### Bloque 2. Expedientes de visitantes y búsqueda
1. Expediente: alta, corrección con historial y motivo, búsqueda por nombre o teléfono. Pruebas con homónimos, errores de escritura y teléfono compartido.
2. Coincidencias al crear y fusión manual autorizada.
3. Vistas del expediente por perfil y cobertura del historial.
- **Reporte básico:** expedientes creados por sucursal y periodo; posibles duplicados pendientes.
- **Decisiones que necesita:** privacidad del expediente (decisión 3) antes de cualquier dato real; qué ve recepción de otras sucursales.

### Bloque 3. Apertura de turno y lugares de efectivo
1. Turno de recepción por sucursal y usuario.
2. **Bolsa de visitas** y **cajón de mensualidades** como lugares de efectivo separados, con responsable por periodo (pueden ser la misma persona o distintas).
3. Apertura con importe contado y relación con la entrega del turno anterior.
4. Cajón de mensualidades marcado **«no conciliado: faltan datos de Open Desk»**.
- **Reporte básico:** turnos abiertos y responsables de cada lugar de efectivo.
- **Decisiones que necesita:** si una misma recepcionista custodia siempre ambos lugares (el diseño admite las dos opciones).

### Bloque 4. Visitas, cobros y movimientos de efectivo
1. Operación individual y grupal: un cobro, un pase por visitante, cada uno ligado a su expediente.
2. Formas de pago con los estados acordados; el efectivo entra a la bolsa del turno; tarjeta y transferencia no aumentan el efectivo.
3. Protección contra duplicados por doble clic o reintento.
4. Apertura manual por pase, separada de las entradas confirmadas.
5. Historial del visitante entre sucursales con la marca de incompleto.
- **Reporte básico:** operaciones, pases, cobros confirmados por forma de pago, transferencias pendientes aparte y efectivo esperado de la bolsa. Pruebas: tres personas = una operación, un cobro y tres pases.
- **Decisiones que necesita:** referencias mínimas de tarjeta y transferencia; comprobante para el visitante.

### Bloque 5. Conteos, entregas, retiros, cierre y revisión
1. Conteo con diferencia conservada; entrega entre recepcionistas con confirmación de quien recibe.
2. Retiros que recoge Gloria como salida del lugar de efectivo, con seguimiento bajo su responsabilidad.
3. Cierre de turno y revisión por una persona distinta de quien cerró.
4. Cierre del cajón como conteo registrado sin conciliar mientras falten datos de Open Desk.
- **Reporte básico:** cierres con efectivo esperado, contado, diferencia y entregas; diferencias pendientes de revisión.
- **Decisiones que necesita:** quién revisa diferencias; evidencia de entrega a Gloria; responsable al final del día.

### Bloque 6. Gastos y autorizaciones
1. Solicitud, autorización, pago desde un lugar de efectivo y comprobación.
2. Bandeja de autorizaciones. Mientras no haya límites ni delegaciones configurados, todo va a Dirección.
3. Sucursal que paga y sucursal beneficiada.
- **Reporte básico:** gastos por estado, sucursal, lugar de efectivo y autorizador.
- **Decisiones que necesita:** cómo aprobará Gloria dentro del programa; límites y suplentes; comprobantes y plazos.

### Bloque 7. Promociones y beneficios
1. Catálogo de promociones con versiones, historial y permiso de administración.
2. Cálculo de elegibilidad con motivo, como función probada aparte.
3. Aplicación en el registro: tarifa original, descuento, total y versión; pases gratuitos sin cobro ficticio.
4. Pronto pago: beneficios y pases de cortesía con canje único; solo datos de prueba hasta decidir la fuente del pago.
- **Reporte básico:** pases por promoción; pases de cortesía otorgados, usados y disponibles.
- **Decisiones que necesita:** definición comercial de visitante nuevo (decisión 1); fuente del pago (decisión 2); historial anterior (decisión 4).

### Bloque 8. Pases QR e integraciones
1. Generación del código opaco, estados, vigencia, sucursales y cancelación; presentación en pantalla; reintentos sin duplicar.
2. Envío por el canal elegido.
3. Integración con el lector solo cuando el proveedor confirme compatibilidad.
- **Reporte básico:** pases por estado (generado, autorizado, utilizado, vencido, cancelado).
- **Decisiones que necesita:** canal de envío (decisión 5); respuestas del proveedor del lector; regla de acceso con transferencia sin abono verificado.

### Después
Reportes avanzados de visitantes (nuevos y recurrentes, frecuencia, comparaciones), contabilidad y los demás módulos de la visión completa.

## Las cinco decisiones pendientes

| # | Decisión | Bloque que la necesita |
|---|---|---|
| 1 | Definición comercial de «visitante nuevo» | 7 (también reportes avanzados) |
| 2 | Fuente válida del pago para el beneficio de pronto pago | 7 |
| 3 | Privacidad del expediente: aviso, campos obligatorios, conservación, qué ve cada perfil | 2 (antes de datos reales) |
| 4 | Historial anterior: libreta, Open Desk o empezar desde una fecha declarada | 7 y reportes de nuevos |
| 5 | Canal de entrega del QR | 8 |

## Cambios en el modelo de datos

| Entidad | Bloque | Para qué |
|---|---|---|
| `sucursal`, `usuario`, `rol`, `permiso`, `asignacion`, historial | 1 | Base de acceso. |
| `visitante`, `visitante_cambio`, `visitante_fusion`, `visitante_distinto`, `cobertura_historial` | 2 | Expediente único, correcciones, fusiones manuales, cobertura del historial. |
| `turno`, `lugar_efectivo`, `sesion_responsable` | 3 | Turno; bolsa y cajón con responsable por periodo. |
| `operacion_visita`, `pase_visita`, `movimiento_efectivo`, `evento_acceso` | 4 | Un cobro por operación, un pase por visitante, efectivo ligado a lugar, turno y responsable; aperturas manuales y entradas por separado. |
| `conteo`, `entrega`, `retiro`, `cierre`, `revision` | 5 | Conteos, entregas entre responsables, retiros, cierres y revisión. |
| `gasto`, `solicitud_autorizacion` | 6 | Gastos y autorizaciones. |
| `promocion`, `promocion_version`, `beneficio_pronto_pago`, `pase_cortesia` | 7 | Promociones versionadas y pases de cortesía con canje único. |
| `credencial_qr`, `envio_pase` | 8 | Código opaco sin datos personales y envíos sin duplicar. |
