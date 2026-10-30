# Plan general de implementación

Fecha: 30 de octubre de 2026. Estado: **en revisión**.
Requisitos de detalle: [`requisitos-visitantes-promociones-qr.md`](requisitos-visitantes-promociones-qr.md).
Primera entrega: [`plan-entrega-1.md`](plan-entrega-1.md).

Cada tarea se da por terminada solo con pruebas automáticas que la demuestren, incluidas solicitudes
directas al servidor para los permisos. Todo con datos ficticios hasta tener aviso de privacidad,
respaldos y restauración probada.

## Cambios en el modelo de datos

| Entidad | Para qué | Notas clave |
|---|---|---|
| `visitante` | Expediente único para toda Fitnessland | Nombre completo, nombre normalizado para buscar, teléfono normalizado (no único), estado de procedencia, sucursal y usuario de alta, estado (activo o fusionado en otro). |
| `visitante_cambio` | Historial de correcciones | Campo, valor anterior, valor nuevo, motivo, quién y cuándo. |
| `visitante_fusion` | Fusiones manuales autorizadas | Origen, destino, motivo, quién autorizó. Nunca automáticas. |
| `visitante_distinto` | «Es otra persona» confirmado por recepción | Evita volver a sugerir la misma coincidencia. |
| `operacion_visita` | Una operación con uno o varios visitantes | Folio, sucursal, turno, usuario, forma de pago, estado del cobro, total, recibido y cambio, identificador de solicitud (contra duplicados). Total $0 sin forma de pago ni movimiento de caja. |
| `pase_visita` | Derecho a una visita de una persona | Operación, visitante, tarifa original, descuento, total, versión de promoción o pase de cortesía aplicado, estado (generado, autorizado, utilizado, vencido, cancelado), vigencia, sucursales permitidas. |
| `credencial_qr` | Código del pase | Huella del código opaco, versión, revocada sí/no. Sin datos personales. |
| `envio_pase` | Intentos de envío | Canal, destino, estado (pendiente, enviado, fallido). Ligado al pase: reenviar no crea otro pase. |
| `evento_acceso` | Lo que pasó en la puerta | Tipo (apertura manual, entrada confirmada, intento rechazado), fuente (recepción, lector, Open Desk), confiable sí/no, pase y visitante si se conocen. |
| `promocion` y `promocion_version` | Promociones configurables | Cada cambio es una versión nueva e inmutable. Vigencia, sucursales, reglas, combinable, activa, responsable. |
| `beneficio_pronto_pago` | Beneficio generado por un pago | Fuente y número del pago (únicos juntos), socio (referencia externa), fecha efectiva, día, pases otorgados, estado. |
| `pase_cortesia` | Cada pase de cortesía | Disponible, canjeado, vencido o anulado; ligado como máximo a un `pase_visita`. |
| `cobertura_historial` | De dónde y desde cuándo hay datos | Sucursal, fuente (plataforma, libreta, Open Desk), desde, hasta, completo sí/no. |
| Permisos nuevos | Catálogo | `visitante.buscar`, `visitante.ver`, `visitante.corregir`, `visitante.fusionar`, `visitante.historial_general`, `promocion.administrar`, `beneficio.registrar`, `pase.cancelar`, `reporte.visitantes`. |

Base ya planeada en la entrega 1: `sucursal`, `usuario`, `rol`, `permiso`, `asignacion`, historial de cambios.

## Cambios en pantallas

- **Registrar visita**: en cada visitante, buscar expediente por nombre o teléfono, elegir o crear; aviso de posibles coincidencias. Por visitante, promoción aplicable con motivo y total. Si el total es $0, no se pide forma de pago.
- **Resultado**: pase por visitante con su estado y QR para mostrar en pantalla. Envío deshabilitado hasta elegir canal.
- **Expediente del visitante**: datos, primera y última visita, visitas por sucursal y total, lista de visitas con promoción y estados; registros de visita, aperturas manuales y entradas confirmadas por separado; aviso de historial incompleto. Lo que se ve depende del perfil.
- **Promociones** (Dirección o autorizado): lista, crear, nueva versión, activar o desactivar, historial.
- **Beneficios de pronto pago**: por socio, pases otorgados, usados y disponibles; origen del pago; canjes.
- **Reportes de visitantes**: filtros de sucursal y fechas; día, semana, mes; cobertura visible.
- **Configuración**: cobertura del historial por sucursal.

## Qué se puede construir sin Open Desk ni el lector

| Sin dependencias externas | Depende de Open Desk | Depende del lector o su proveedor | Depende de un canal de envío |
|---|---|---|---|
| Expedientes, búsqueda, coincidencias y fusión manual | Pagos de mensualidad como fuente del beneficio de pronto pago | Validar el QR en el torniquete | WhatsApp, correo o SMS |
| Historial entre sucursales dentro de la plataforma, con cobertura | Saber si una persona es o fue socio | Revocar pases en el lector | |
| Promociones, versiones y cálculo de elegibilidad con motivo | Historial previo de visitas o accesos | Eventos de entrada confirmada e intentos rechazados | |
| Pases gratuitos sin cobro ficticio | Entradas confirmadas, si llegan por Open Desk | Comportamiento sin conexión | |
| Libro de pases de cortesía y canje único (con datos de prueba) | | | |
| Generación del QR opaco, estados y presentación en pantalla | | | |
| Apertura manual por pase | | | |
| Reportes de visitantes con la cobertura de la plataforma | | | |

## Orden de implementación

### Entrega 1. Usuarios, permisos y sucursales (en curso)
1. ~~Repositorio y entorno~~ (hecho; falta confirmar el sitio en Vercel).
2. Base de datos y migraciones.
3. Inicio y cierre de sesión; recuperación con enlace de un solo uso.
4. Permisos y asignación de sucursales. El catálogo incluye desde ahora los permisos nuevos, sin asignarlos a nadie.
5. Catálogo persistente de sucursales.
6. Pruebas de acceso permitido y denegado.

### Entrega 2. Expediente de visitantes y visitas
1. Expediente: alta, corrección con historial, búsqueda por nombre o teléfono. Pruebas con homónimos, errores de escritura y teléfono compartido.
2. Coincidencias y fusión manual autorizada.
3. Turno mínimo de recepción para registrar operaciones (requiere decidir fondo y entrega entre turnos, ya descritos).
4. Operación de visita individual y grupal: cobro único, pase por visitante, protección contra duplicados.
5. Historial entre sucursales con cobertura e «incompleto»; vistas por perfil. Prueba: recepción no recibe datos financieros de otra sucursal por solicitud directa.
6. Apertura manual por pase, separada de entradas confirmadas.

### Entrega 3. Promociones
1. Catálogo de promociones con versiones, historial y permiso de administración.
2. Cálculo de elegibilidad con motivo, como función probada aparte. Incluye «visitante nuevo» cuando se confirme la definición.
3. Aplicación en el registro: tarifa original, descuento, total y versión; pases gratuitos sin cobro.
4. Pronto pago: libro de beneficios y pases de cortesía, tabla de días, unicidad por pago, canje único. Solo con datos de prueba hasta decidir la fuente del pago.

### Entrega 4. Pases QR
1. Generación del código opaco, estados, vigencia, sucursales y cancelación; presentación en pantalla; reintentos sin duplicar.
2. Envío por el canal elegido.
3. Integración con el lector, cuando el proveedor confirme compatibilidad.

### Entrega 5. Reportes de visitantes
1. Personas únicas, nuevos y recurrentes, visitas, frecuencia, pases pagados y gratuitos, promociones.
2. Cobros por forma de pago con transferencias pendientes separadas.

Antes de cualquier dato real: aviso de privacidad, respaldos y restauración probada.
