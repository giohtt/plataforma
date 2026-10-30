# Requisitos ampliados: expediente de visitantes, promociones y pases QR

Fecha: 30 de octubre de 2026. Estado: **en revisión**. Nada de esto está implementado.

Convención:
- **[Confirmado]** regla indicada por Fitnessland.
- **[Propuesta]** diseño sugerido; requiere aprobación antes de construirse como regla.
- **[Pendiente]** decisión que falta tomar; la función que depende de ella no se activa hasta resolverla.

Siguen vigentes los tres manuales y los acuerdos previos: visitas de $50; efectivo en la bolsa de visitas;
tarjeta «confirmada operativamente»; transferencia «pendiente de abono» que no suma como cobro confirmado;
apertura manual desde recepción; Open Desk opera socios, membresías y accesos.

---

## 1. Expediente de visitante

### Reglas
- [Confirmado] Cada visitante tiene un expediente persistente con **nombre completo, teléfono y estado de procedencia**, que se reutiliza cuando regresa.
- [Confirmado] El expediente es **único para toda Fitnessland** y relaciona sus visitas en todas las sucursales.
- [Confirmado] Una persona puede tener muchas visitas.
- [Confirmado] Recepción busca por nombre completo o teléfono, elige una coincidencia y completa datos.
- [Confirmado] No se identifica ni se fusiona a nadie solo por el nombre. Hay homónimos, errores de escritura y teléfonos compartidos.
- [Confirmado] Búsqueda y consulta solo para usuarios autorizados.
- [Confirmado] En una operación grupal cada visitante conserva su propio expediente, aunque compartan contacto o cobro.
- [Confirmado] Registrar una visita no crea una membresía.
- [Pendiente] Obligatoriedad de cada campo (se decide por campo).
- [Pendiente] Aviso de privacidad y conservación de datos. **Es requisito antes de guardar datos reales**, porque ahora los datos se conservan y se comparten entre sucursales.

### Búsqueda e identificación [Propuesta]
- La búsqueda ignora acentos, mayúsculas y espacios dobles; el teléfono se guarda normalizado (solo dígitos, 10 dígitos para México).
- El teléfono **no es único**: varias personas pueden compartirlo.
- Al crear un expediente, el sistema muestra posibles coincidencias (mismo teléfono, nombre parecido). Recepción elige una o confirma «es otra persona»; esa confirmación queda registrada.
- **Fusión de expedientes**: nunca automática. Solo un usuario autorizado, con motivo; se conserva el historial de ambos y se puede consultar cuál absorbió a cuál.
- Correcciones de datos: con motivo y valor anterior conservado. No modifican cobros ni pases.

### Qué ve cada perfil [Propuesta]
| Perfil | Datos del visitante | Historial de otras sucursales |
|---|---|---|
| Recepción | Nombre completo, procedencia, teléfono **enmascarado** (últimos 4 dígitos) salvo que lo capture completo y coincida | Número total de visitas, fecha y sucursal de la última visita, y el **resultado de elegibilidad con su motivo**. **Sin** importes, formas de pago ni operaciones de otras sucursales. |
| Encargado | Igual que recepción | Detalle de su(s) sucursal(es) asignada(s); de las demás, lo mismo que recepción |
| Administración | Según alcance asignado | Detalle financiero solo de sucursales asignadas |
| Dirección | Completo, según alcance | Historial general con detalle, según alcance asignado |

---

## 2. Historial del visitante entre sucursales

### Debe mostrar [Confirmado]
- Primera y última visita registrada.
- Sucursales con visitas registradas.
- Visitas por sucursal y total general.
- De cada visita: fecha, hora, sucursal, promoción, pagada o gratuita, estado del cobro y estado del pase.
- **Por separado**: registros de visita, aperturas manuales y entradas confirmadas (estas solo con fuente confiable).

### Historial incompleto [Confirmado + Propuesta]
- [Confirmado] Si faltan registros históricos o datos de alguna sucursal, el historial se marca **incompleto**. La ausencia de datos no prueba que la persona nunca asistió.
- [Propuesta] Se registra la **cobertura del historial** por sucursal y fuente: «Plataforma, Tenango, desde 15 nov 2026». El expediente muestra, por ejemplo: «Historial completo en la plataforma desde 15 nov 2026. Sin datos de libreta ni de Open Desk.»
- [Confirmado] No se supone que los registros de libreta u Open Desk estén disponibles.

---

## 3. Visitante nuevo

### Requiere confirmación de Dirección [Propuesta]
Una persona es **«visitante nuevo para Fitnessland»** cuando, al momento de evaluar:
1. No tiene ninguna visita previa registrada (pagada o gratuita, como visitante o invitado) en **ninguna sucursal**, dentro de la cobertura del historial; y
2. La cobertura del historial abarca el periodo que exija la regla (por ejemplo, «sin visitas en los últimos 12 meses» exige 12 meses de cobertura en todas las sucursales); y
3. [Pendiente] No es ni ha sido socio. Esto depende de datos de Open Desk.

El sistema distingue tres resultados, nunca solo «sí/no»:
- **No es nuevo**: tiene visita previa (se indica fecha y sucursal).
- **Nuevo dentro del historial disponible**: sin visitas previas y con cobertura suficiente.
- **Sin historial suficiente para decidir**: hay huecos de cobertura. Qué hacer en este caso es [Pendiente]: negar, permitir con marca, o requerir autorización.

- [Confirmado] Cambiar de sucursal **no** hace a nadie «nuevo».
- [Pendiente] Ventana de tiempo: «nunca ha visitado» o «sin visitas en los últimos N meses».

### En reportes [Propuesta]
- **Nuevo para Fitnessland en el periodo**: su primera visita registrada en cualquier sucursal ocurre dentro del periodo.
- **Primera vez en esta sucursal**: indicador aparte, para no confundirlo con el anterior.
- **Recurrente en el periodo**: visitó en el periodo y ya tenía una visita registrada antes.
- Todo reporte indica su cobertura y si el historial está incompleto.

---

## 4. Indicadores y reportes de visitantes

Filtros: sucursal, rango de fechas; vistas por día, semana y mes. [Propuesta] Semana de lunes a domingo, en la zona horaria de cada sucursal.

| Indicador | Definición propuesta |
|---|---|
| Personas únicas | Expedientes distintos con al menos un pase de visita no cancelado en el periodo. |
| Visitantes nuevos / recurrentes | Según la sección 3. |
| Cantidad de visitas | Pases de visita no cancelados. Separados en pagados y gratuitos. |
| Frecuencia | Visitas ÷ personas únicas en el periodo, y distribución (1, 2, 3+ visitas). |
| Promoción utilizada | Pases por promoción y versión aplicada. |
| Cobros por forma de pago | Efectivo y tarjeta confirmados; **transferencias pendientes de abono en línea aparte**. |
| Entradas confirmadas | Solo con fuente confiable; separadas de aperturas manuales y de visitas registradas. |

[Confirmado] No se confunden personas, operaciones, pases y entradas: una operación para tres personas es un cobro y tres pases.

---

## 5. Promociones

### Reglas
- [Confirmado] Las administra Dirección o una persona expresamente autorizada.
- [Confirmado] Campos: nombre, descripción, vigencia, sucursales participantes, condiciones de elegibilidad, cantidad de pases y límites de uso, si se combina con otras, activa/inactiva, historial de cambios y responsable.
- [Confirmado] Recepción ve si aplica, el motivo y el total: pase gratuito $0, o tarifa vigente ($50).
- [Confirmado] La decisión usa el expediente y las reglas de la promoción, no solo si el nombre existe en la base.
- [Confirmado] Se conserva tarifa original, descuento, total y versión de la promoción. Ejemplo: $50, descuento $50, total $0.
- [Confirmado] Un pase gratuito válido no requiere pago ficticio ni suma dinero a caja; queda relacionado con la promoción o beneficio que lo justifica.
- [Confirmado] Las campañas generales (por ejemplo, Halloween) pueden tener reglas distintas; no todas exigen visitante nuevo.

### Diseño [Propuesta]
- Cada cambio a una promoción crea una **versión nueva**; los pases ya registrados conservan la versión con la que se aplicaron.
- Condiciones disponibles al inicio: vigencia, sucursales, «requiere visitante nuevo» (sí/no), usos por visitante (total y por periodo), pases totales de la campaña, combinable (sí/no). Se agregan más tipos solo cuando se necesiten.
- El cálculo de elegibilidad devuelve siempre **resultado + motivo**: «Aplica: primera visita a Fitnessland», «No aplica: visita previa el 12 oct en Santiago», «No aplica: promoción vigente solo en Tenango».
- Una operación de total $0 no pide forma de pago y no genera movimiento de caja.
- [Pendiente] Si varias promociones aplican a la vez y no se combinan, cuál se elige (propuesta: recepción elige entre las aplicables; nunca se suman si no son combinables).

---

## 6. Beneficio por pronto pago de mensualidad

### Reglas [Confirmado]
| Día de pago | Pases de cortesía |
|---|---|
| 1 | 5 |
| 2 | 4 |
| 3 | 3 |
| 4 | 2 |
| 5 | 1 |
| 6 en adelante | 0 por esta promoción |

- Los pases son para **invitados nuevos**, según la definición que se acuerde.
- Se relaciona al socio beneficiario con el pago que originó el beneficio.
- Se usa la **fecha efectiva del pago**, no la fecha de importación.
- Se muestran pases otorgados, utilizados y disponibles.
- Cada canje se relaciona con el invitado y su pase individual.
- Un pase de cortesía no se canjea dos veces.
- Consultar, importar o reprocesar el mismo pago no vuelve a otorgar beneficios.
- El sistema explica por qué un invitado puede o no usar el beneficio.
- No se inventa la integración con Open Desk ni se otorgan beneficios sin una fuente de pago validada.

### Diseño [Propuesta]
- Cada pago fuente se identifica por **(fuente, identificador del pago)** y solo puede generar un beneficio. Reprocesarlo no crea otro.
- El beneficio crea **N pases de cortesía individuales** (uno por fila), cada uno disponible, canjeado, vencido o anulado.
- El canje es una operación atómica: el pase de cortesía pasa a canjeado y queda ligado al pase de visita del invitado. Dos canjes simultáneos del mismo pase: solo uno gana.
- El «día de pago» se calcula en la zona horaria de la sucursal donde se pagó.
- [Pendiente] Fuente válida del pago mientras no exista integración con Open Desk.
- [Pendiente] Caducidad de los pases.
- [Pendiente] Sucursales donde pueden usarse.
- [Pendiente] Definición de invitado nuevo y tratamiento del historial anterior.
- [Pendiente] Si un mismo invitado puede volver a usar el beneficio en meses posteriores.
- [Pendiente] Pagos cancelados, devueltos o corregidos. Propuesta: los pases no usados se anulan; los ya usados se conservan y se marcan para revisión.
- [Pendiente] Si participan todos los planes y tipos de pago de mensualidad.

---

## 7. Pase QR individual

### Reglas [Confirmado]
- Un pase QR por visitante, también en operaciones grupales.
- Se genera y entrega al completar el registro y cumplir las condiciones de pago o promoción.
- Procesos separados: generación, autorización de uso, presentación o envío, validación en el lector, registro del uso.
- El QR no contiene nombre, teléfono ni datos personales.
- Contempla vigencia, sucursales permitidas, cancelación y protección contra reutilización.
- Estados distintos: generado, autorizado, vencido, cancelado, utilizado.
- Generar o enviar el QR no confirma una entrada.
- Reintentar el envío no crea otro pase ni otro cobro.
- Un pase gratuito válido también puede tener QR.
- [Pendiente] Autorizar acceso con transferencia sin abono verificado.
- No se afirma compatibilidad con los lectores hasta confirmarla. Mientras tanto se conserva la apertura manual.

### Diseño [Propuesta]
- El QR contiene solo un **código aleatorio opaco** (sin significado) que la plataforma o el lector consultan. La base guarda una huella del código, no el código en claro.
- Si el lector exige otro formato (por ejemplo, firmado o con datos del pase), se ajusta cuando el proveedor lo confirme.
- **Envío idempotente**: cada envío se liga al pase; reenviar repite el mismo QR.
- Antes de existir un canal real, el QR solo se **muestra en pantalla** en recepción. No se simula un envío exitoso.

### Canales de envío [Pendiente]
| Canal | Qué requiere |
|---|---|
| Mostrar en pantalla o imprimir | Nada externo. Impresora si se imprime. |
| WhatsApp | Cuenta de WhatsApp Business Platform (directa con Meta o mediante un proveedor), negocio verificado, número dedicado, plantillas de mensaje aprobadas, consentimiento del destinatario y costo por conversación o mensaje. |
| Correo | Servicio de envío, dominio propio con registros SPF/DKIM/DMARC, y **capturar el correo del visitante**, que hoy no se pide. |
| SMS | Proveedor de SMS, costo por mensaje y, según el país, registro del remitente. |

---

## 8. Preguntas para el proveedor del lector o el ingeniero

Se piden por escrito, sin acceso a la plataforma ni al repositorio.

**Lector y QR**
1. Marca, modelo y versión de firmware de cada lector, por sucursal.
2. ¿Qué formato de QR admite (texto libre, URL, código firmado, longitud máxima)?
3. ¿El lector valida el QR por sí mismo, consulta a Open Desk o puede consultar a un servidor externo?
4. ¿Cómo se emite, autoriza y revoca un pase desde un sistema externo? ¿Hay API?
5. ¿Cómo se valida la vigencia y la sucursal permitida?
6. ¿Cómo se impide usar el mismo QR más de una vez?
7. ¿Qué eventos entrega (entrada, salida, rechazo, apertura manual) y cómo se reciben (webhook, consulta periódica, archivo)? ¿Distingue intentos rechazados de entradas?
8. ¿Qué pasa si no hay internet o Open Desk no responde?
9. ¿Funciona igual en todas las sucursales?

**Open Desk (para pronto pago e historial)**
1. ¿La API entrega pagos de mensualidad con identificador único, fecha efectiva de pago y sucursal?
2. ¿Cómo informa cancelaciones, devoluciones y correcciones de un pago?
3. ¿Qué identificador tiene cada socio? ¿Se puede saber si una persona es o fue socio?
4. ¿Hay historial de visitas o accesos exportable, y desde qué fecha?
5. ¿En qué zona horaria entrega las fechas?
6. ¿Exige IP fija, cómo se autentica y qué límites de uso tiene?
