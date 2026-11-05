# Plan general de implementación

Fecha: 30 de octubre de 2026. Estado: **en revisión**.
Requisitos ampliados: [`requisitos-visitantes-promociones-qr.md`](requisitos-visitantes-promociones-qr.md).
Detalle del bloque 1: [`plan-entrega-1.md`](plan-entrega-1.md).

## Alcance

**Primera versión (alcance original, se conserva):** visitas y cobros, caja y turnos, cierres, gastos y
autorizaciones, con reportes administrativos por sucursal. Open Desk sigue operando socios, membresías y accesos.

**Ampliación (se suma, no sustituye):** expediente de visitantes con historial entre sucursales, promociones
y beneficios, y pases QR individuales.

## Datos de negocio confirmados
Confirmados el 4 nov 2026.
- **Visita:** $50 por persona, igual en todas las sucursales. Es la tarifa base; una promoción aprobada
  puede reducirla (por ejemplo, un pase gratuito queda en $0 y conserva la tarifa original y el descuento).
- **Mensualidades:** el precio puede variar por zona, sucursal y promoción, tanto en sucursales Black como
  en las de color. Se siguen cobrando en **Open Desk**. Los precios exactos se definen al llegar a ese módulo;
  mientras tanto la plataforma no guarda ni calcula precios de mensualidad.
- **Membresía:** permite entrar a cualquier sucursal Fitnessland. El acceso lo sigue controlando Open Desk.
- **Sucursales Black:** San Andrés y San Cristóbal. «Black» es por ahora solo una **etiqueta de marca**
  (las dos usan el color negro); no cambia precios, permisos ni operación en la plataforma.

## Reglas para todo el plan

- Cada bloque incluye sus **reportes básicos y sus pruebas automáticas**. Los totales se comprueban en
  cada bloque, no al final. Los reportes avanzados pueden llegar después.
- Las pruebas de permisos incluyen **solicitudes directas al servidor**.
- **No se registran cobros reales** hasta que cada movimiento quede relacionado con caja, turno y responsable.
- El **cajón de mensualidades** se muestra **no conciliado** mientras falten los datos de Open Desk.
- Una decisión pendiente solo frena el bloque que depende de ella. Se resuelven primero las del bloque que
  sigue.
- Todo con datos ficticios hasta tener aviso de privacidad, respaldos y restauración probada.
- Una **sucursal inactiva** se puede consultar (incluidos su historial y reportes), pero el servidor rechaza
  en ella **nuevos cobros y aperturas de turno**.

## Orden de implementación

### Bloque 1. Usuarios, permisos y sucursales (cerrado el 4 nov 2026)
1. ~~Repositorio y entorno.~~ Hecho. Sitio de pruebas publicado en Vercel (proyecto `plataforma-pruebas`, plan Hobby, `APP_ENV=pruebas`), protegido con Vercel Authentication para todas las versiones, incluida la dirección principal. Verificado el 3 nov 2026: sin sesión, el sitio redirige al inicio de sesión de Vercel.
2. ~~Base de datos y migraciones.~~ Hecho. Neon (plan gratuito) conectado al sitio de pruebas; tablas iniciales y datos ficticios cargados al publicar. Sin respaldos programados: suficiente solo para datos ficticios.
3. ~~Inicio y cierre de sesión; recuperación con enlace de un solo uso.~~ Hecho y probado en el sitio de pruebas. Envío por correo pendiente de elegir servicio.
4. ~~Permisos y asignación de sucursales.~~ Hecho. Perfil por sucursal, alcance general y facultades con límite, otorgados por separado. Probado en el sitio de pruebas el 3 nov 2026: Recepción Tenango ve solo Tenango y al abrir `/sucursales/STG` recibe «No encontrada».
5. ~~Catálogo persistente de sucursales.~~ Hecho. Crear, editar, desactivar y reactivar, con historial. Probado en el sitio de pruebas el 3 y 4 nov 2026 con Dirección general (sucursal ficticia Santa Ana, SAA), incluido el rechazo de un nombre repetido.
6. ~~Pruebas de acceso permitido y denegado.~~ Hecho. Cobertura en el [plan del bloque 1](plan-entrega-1.md); comprobado en el sitio de pruebas el 4 nov 2026.
7. ~~Reporte básico: usuarios y sus asignaciones por sucursal.~~ Hecho (`/reportes/usuarios`). Probado en el sitio de pruebas el 4 nov 2026.
- **Decisiones que necesita:** ninguna nueva.

### Bloque 2. Expedientes de visitantes y búsqueda (cerrado para el entorno de pruebas el 4 nov 2026)
1. Expediente: alta, corrección con historial y motivo, búsqueda por nombre o teléfono. Pruebas con homónimos, errores de escritura y teléfono compartido.
   - ~~Primer flujo: búsqueda, elección entre coincidencias y alta.~~ Hecho con reglas provisionales (opciones en [`decisiones-bloque-2.md`](decisiones-bloque-2.md)). La búsqueda y el alta se envían por POST: el nombre y el teléfono nunca quedan en la dirección. **Probado en el sitio el 4 nov 2026 con Recepción Tenango:** búsqueda «maria hernandez» con 2 coincidencias distinguidas por teléfono enmascarado (0101 Tenango, 0102 Santiago); elección de la de Santiago; alta de Diego Martínez Ruiz con el teléfono compartido de Luis y Ana, confirmando que es otra persona.
   - ~~Corrección de expedientes.~~ Hecha. Corrigen Encargado y Dirección, solo expedientes creados en una sucursal donde tengan el permiso; motivo obligatorio; se conserva dato anterior, nuevo, quién, desde qué sucursal y cuándo; el historial de correcciones solo lo ve quien puede corregir ese expediente, con el teléfono enmascarado. **Probada en el sitio el 4 nov 2026:** Encargado Tenango corrigió la procedencia de Diego Martínez Ruiz (Estado de México → Querétaro) y el cambio apareció en el historial con motivo, quién y desde Tenango; Recepción Tenango vio la ficha actualizada sin el historial ni el botón «Corregir datos».
2. Coincidencias al crear y fusión manual autorizada.
   - ~~Coincidencias al crear.~~ Hecho con el alta (confirmación «es otra persona» registrada).
   - ~~Fusión manual.~~ Hecha. Solo para dos fichas de la misma persona creadas por error. Solo Dirección con el permiso `visitante.fusionar` en la sucursal de cada ficha; elige la ficha activa y de cuál se toma cada dato, con teléfonos enmascarados, vista previa, motivo obligatorio y aviso de que no se deshace desde la pantalla. La otra ficha se conserva con su historial y un vínculo a la activa; sale de la búsqueda; un enlace anterior lleva a la activa solo con permiso de consulta. Bloqueada si ya se confirmaron como personas distintas. Deshacer queda pendiente. **Probada en el sitio el 4 nov 2026 con Dirección de Tenango:** se unieron las fichas ficticias de Valeria (Gómez y Gomes Pineda) y en la búsqueda quedó una sola; la fusión de Ana y Luis Martínez Ruiz, que comparten teléfono y estaban confirmados como distintos, quedó bloqueada con la explicación.
3. Vistas del expediente por perfil y cobertura del historial.
- **Reporte básico:** expedientes creados por sucursal y periodo; posibles duplicados pendientes. Hecho (`/reportes/expedientes`): lo ven Encargado, Administración y Dirección según sus sucursales (permiso `reporte.expedientes`), Recepción no. «Expedientes creados» cuenta por la sucursal donde se creó la ficha. Los posibles duplicados son pares de fichas activas con el mismo teléfono o un nombre muy parecido (similitud de al menos 70 %, provisional), contados una vez, sin los confirmados como distintos ni fichas unidas; un par de dos sucursales solo lo ve quien tiene el reporte en ambas. **Probado en el sitio el 4 nov 2026:** Encargado Tenango vio 7 expedientes creados, 1 unido después y 0 posibles duplicados; Administración (Tenango y Santiago) vio Santiago 1, Tenango 7, total 8 y el par de las dos María una sola vez; Recepción Tenango recibió «No encontrada» también por enlace directo.
- **Cierre para el entorno de pruebas:** funciona con reglas provisionales y solo con datos ficticios.
- **Pendiente antes de capturar datos reales:** campos obligatorios y quién puede ver el teléfono completo (hoy, opción A provisional: solo el nombre es obligatorio y el teléfono se enmascara para todos), además del aviso de privacidad y la conservación de datos (decisión 3). El umbral de «nombre muy parecido» (70 %) también es provisional.
- **Se retoma en el bloque 4:** qué historial de otras sucursales ve Recepción.

### Bloque 3. Apertura de turno y lugares de efectivo (cerrado para el entorno de pruebas el 4 nov 2026)
1. Turno de recepción por sucursal y usuario.
2. **Bolsa de visitas** y **cajón de mensualidades** como lugares de efectivo separados, con responsable por periodo (pueden ser la misma persona o distintas).
3. Apertura con importe contado. ~~Relación con la entrega del turno anterior~~: pasa al bloque 5, junto con la entrega entre turnos y el cierre.
4. Cajón de mensualidades marcado **«no conciliado: faltan datos de Open Desk»**.
5. No se abre turno en una sucursal inactiva (comprobado en el servidor, también por solicitud directa). Hecho, con prueba automática.
   - **~~Primer paso: apertura de turno.~~ Hecho. Probado en el sitio el 4 nov 2026 con Recepción Tenango:** sin escribir nada pidió llenar ambos totales; se abrió el turno con $0 en la bolsa y $1,200 en el cajón (cantidades ficticias), mostrados por separado, con la misma recepcionista como responsable de ambos y el cajón «No conciliado: faltan datos de Open Desk». El turno ficticio de Tenango queda abierto hasta que exista el cierre (bloque 5). Detalle: un solo turno de Recepción abierto a la vez por sucursal, validado en el servidor y por la base (también con dos aperturas simultáneas). Al abrir se registra solo el total contado de la bolsa de visitas y del cajón de mensualidades, por separado, sin fondo fijo ni desglose; $0 es válido y un campo vacío no. Se registra por separado quién es responsable de cada lugar. El cajón muestra «No conciliado: faltan datos de Open Desk». Abrir no registra cobros ni movimientos. La entrega entre turnos es del bloque 5.
   - **Provisional:** quien abre queda como responsable de la bolsa y del cajón (falta confirmar si siempre es la misma persona). Abre turno solo Recepción; consultan Recepción, Encargado, Administración y Dirección.
- **Reporte básico:** turnos abiertos y responsables de cada lugar de efectivo. Hecho (`/reportes/turnos`): por sucursal, fecha y hora de apertura, quién abrió y responsable de la bolsa y del cajón por separado; solo consulta para Encargado, Administración y Dirección en sus sucursales (permiso `reporte.turnos`). Recepción sigue viendo su turno, pero no el reporte. **Probado en el sitio el 4 nov 2026 con el turno ficticio de Tenango:** Encargado Tenango vio 1 turno abierto (Tenango, 4 nov 2026, 7:58 p.m., abierto por Recepción Tenango, responsable de la bolsa y del cajón en columnas separadas); Administración (Tenango y Santiago) vio además Santiago «Sin turno abierto»; Recepción Tenango vio su turno ($0.00 en la bolsa, $1,200.00 en el cajón, «No conciliado: faltan datos de Open Desk») y recibió «No encontrada» al abrir el reporte por enlace directo.
- **Cierre para el entorno de pruebas:** funciona con reglas provisionales y solo con datos ficticios.
- **Siguen provisionales:** que la misma recepcionista sea responsable de la bolsa y del cajón; que solo Recepción abra turnos; el horario real de los turnos (sin confirmar).
- **Pasan al bloque 5:** la entrega entre turnos (y su relación con la apertura) y el cierre de turno. El turno ficticio de Tenango sigue abierto hasta entonces.
- **Decisiones que necesita:** si una misma recepcionista custodia siempre ambos lugares (el diseño admite las dos opciones).

### Bloque 4. Visitas, cobros y movimientos de efectivo (en curso, solo datos ficticios)
1. Operación individual y grupal: un cobro, un pase por visitante, cada uno ligado a su expediente. En el registro grupal, un pase por persona y un total para el grupo. Primero se revisa el ejemplo individual.
   - Una sola ficha por visitante para todo Fitnessland: en otra sucursal, Recepción busca y usa esa misma ficha. Cada visita guarda la **sucursal donde ocurrió**, aunque la ficha se haya creado en otra.
   - Las visitas de una ficha unida se muestran en la ficha activa.
   - **Primer flujo: visita individual de $50 en efectivo.** En revisión (`/sucursales/[codigo]/turno/visita`). Una sola pantalla: Recepción busca y elige la ficha existente y ve al visitante, la sucursal, el total de $50, el campo opcional «Recibido» y el cambio ahí mismo; si lo recibido es menor que el total, el error aparece junto al campo y no deja confirmar. Un solo botón «Confirmar cobro · $50.00». Al confirmar, el servidor comprueba en la misma transacción que sigue abierto el mismo turno que mostró la pantalla, que la persona sigue siendo la responsable vigente de la bolsa, que la ficha sigue activa y que lo recibido cubre el total; guarda una operación, un cobro en efectivo confirmado, un pase con la sucursal donde ocurrió la visita y una entrada de $50 a la bolsa ligada a turno, lugar y responsable. Al guardar muestra «Cobro registrado» y «Nueva visita». A la bolsa entra solo el total de la visita, nunca lo recibido. Cada cobro lleva una clave que la pantalla conserva hasta que se guarda: un doble clic, o un reintento después de perder la conexión, no crea otra visita ni otra entrada de efectivo. En el turno, la bolsa muestra contado al abrir, visitas cobradas y efectivo esperado; el cajón muestra lo contado al abrir y «No calculado: faltan datos de Open Desk» como efectivo esperado. Los registros no se editan ni se borran.
   - **Provisional:** registra visitas solo Recepción (permiso `visita.registrar`) y, en esta prueba, solo la responsable de la bolsa. Por ahora la única forma de pago es efectivo y no hay promociones (tarifa $50, descuento $0).
   - **Para otro paso:** corrección, cancelación y devolución de un cobro; tarjeta y transferencia; registro grupal (un pase por persona y un total para el grupo).
2. Formas de pago con los estados acordados; el efectivo entra a la bolsa del turno; tarjeta y transferencia no aumentan el efectivo.
3. Protección contra duplicados por doble clic o reintento.
4. Apertura manual por pase, separada de las entradas confirmadas.
5. Historial del visitante entre sucursales con la marca de incompleto.
6. No se registran cobros nuevos en una sucursal inactiva (comprobado en el servidor, también por solicitud directa).
- **Reporte básico:** operaciones, pases, cobros confirmados por forma de pago (incluidas las transferencias con abono verificado), transferencias pendientes aparte y efectivo esperado de la bolsa. Pruebas: tres personas = una operación, un cobro y tres pases; una transferencia que pasa de pendiente a verificada cambia de línea sin duplicar el importe.
- **Decisiones que necesita:** referencias mínimas de tarjeta y transferencia; comprobante para el visitante; qué historial de otras sucursales ve Recepción (pendiente desde el bloque 2).

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
4. **Regla obligatoria para autorizar un gasto**, comprobada en el servidor en el momento de aprobar,
   dentro de la misma transacción que registra la aprobación (no basta con ocultar el botón):
   - **Sucursal:** la facultad `autorizacion.gasto` de quien aprueba cubre la sucursal del gasto
     (otorgada para esa sucursal o para todas).
   - **Vigencia:** la facultad está vigente en ese momento (no vencida, no futura, no revocada) y la
     persona sigue activa.
   - **Importe:** el importe del gasto es menor o igual que el `limite_monto` de esa facultad. Si supera
     el límite, la solicitud se escala; nunca se aprueba parcialmente.
   - **Separación:** quien solicita o paga un gasto no lo aprueba.
   - Si el importe u otra condición cambia después de aprobar, la aprobación deja de valer y se pide de nuevo.
   - `tiene_permiso` solo responde si la persona tiene la facultad en la sucursal; **no compara importes**.
     La comparación con el límite se agrega en el bloque 6, con pruebas de importe igual al límite,
     superior al límite, facultad vencida, facultad de otra sucursal y solicitud directa al servidor.
- **Reporte básico:** gastos por estado, sucursal, lugar de efectivo y autorizador.
- **Decisiones que necesita:** cómo aprobará Gloria dentro del programa; límites y suplentes; comprobantes y plazos.

### Bloque 7. Promociones y beneficios
1. Catálogo de promociones con versiones, historial y permiso de administración.
2. Cálculo de elegibilidad con motivo, como función probada aparte.
3. Aplicación en el registro: tarifa original, descuento, total y versión; pases gratuitos sin cobro ficticio.
4. Pronto pago: beneficios y pases de cortesía con canje único; solo datos de prueba hasta decidir la fuente del pago.
5. **[Propuesta, no aprobada]** Programa de fidelidad: por cada cinco visitas pagadas que cumplan las reglas, una visita gratis, ligada a la ficha global y sin depender de Wallet. Recepción ve el avance y las cortesías al registrar una visita. Las cortesías no acumulan; tarjeta y transferencia cuentan según su estado de confirmación. Diseño y pendientes en [`propuesta-fidelidad.md`](propuesta-fidelidad.md).
- **Reporte básico:** pases por promoción; pases de cortesía otorgados, usados y disponibles; recompensas de fidelidad generadas, canjeadas y vencidas (si se aprueba).
- **Decisiones que necesita:** definición comercial de visitante nuevo (decisión 1); fuente del pago (decisión 2); historial anterior (decisión 4). Para fidelidad: sucursales participantes, fecha desde la que acumula, vigencia de las recompensas y pagos devueltos o cancelados (F1 a F4 de la propuesta).

### Bloque 8. Pases QR e integraciones
1. Generación del código opaco, estados, vigencia, sucursales y cancelación; presentación en pantalla; reintentos sin duplicar.
2. Envío por el canal elegido.
3. Integración con el lector solo cuando el proveedor confirme compatibilidad.
- **Reporte básico:** pases por estado (generado, autorizado, utilizado, vencido, cancelado).
- **Decisiones que necesita:** canal de envío (decisión 5); respuestas del proveedor del lector; regla de acceso con transferencia sin abono verificado.

### Después
- **Apple Wallet y Google Wallet** (integración posterior al bloque 8): mostrar la tarjeta de fidelidad y encontrar la ficha del visitante con un QR. No será requisito para acumular ni canjear. Puede tener costo: se avisará antes de contratar.
Reportes avanzados de visitantes (nuevos y recurrentes, frecuencia, comparaciones), contabilidad y los demás módulos de la visión completa.

## Las cinco decisiones pendientes

| # | Decisión | Bloque que la necesita |
|---|---|---|
| 1 | Definición comercial de «visitante nuevo» | 7 (también reportes avanzados) |
| 2 | Fuente válida del pago para el beneficio de pronto pago | 7 |
| 3 | Privacidad del expediente: aviso, campos obligatorios, conservación, quién ve el teléfono completo; qué historial de otras sucursales ve Recepción | Antes de datos reales; el historial entre sucursales, en el bloque 4 |
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
| `credencial_qr`, `envio_pase` | 8 | Solo huella, versión y clave usada; el código se recalcula con la clave secreta del entorno para reenviarlo. Envíos sin duplicar. |
