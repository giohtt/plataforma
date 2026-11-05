# Bloque 2: decisiones pendientes sobre el expediente de visitante

Fecha: 4 nov 2026. Estado: **pendientes**. El bloque 2 se cerró para el entorno de pruebas el 4 nov 2026 con estas reglas provisionales. Forman parte de la decisión 3 (privacidad del expediente)
del [plan general](plan-general.md) y del [documento de requisitos](requisitos-visitantes-promociones-qr.md).

Mientras no se decidan, el sitio de pruebas usa la **opción A** de cada una, solo con datos ficticios. Las
tres están en un único lugar del código (`REGLAS_PROVISIONALES`, en `src/lib/datos-visitante.ts`), de modo
que cambiar de opción no obliga a rehacer el flujo. **En producción el alta de expedientes está bloqueada**
hasta aprobar el aviso de privacidad.

Ya confirmado y aplicado: el expediente es único para toda Fitnessland; el teléfono no es único (se comparte en
familias); nunca se identifica ni se fusiona a nadie solo por el nombre; buscar y consultar requiere permiso.

---

## 1. Campos obligatorios

El expediente guarda nombre completo, teléfono y estado de procedencia. El nombre siempre es obligatorio.

| Opción | Obligatorios | A favor | En contra |
|---|---|---|---|
| **A (provisional)** | Solo nombre completo | Nunca detiene a recepción; quien no quiere dar teléfono igual se registra. | Sin teléfono es más difícil distinguir homónimos; habrá más coincidencias que revisar a mano. |
| B | Nombre y teléfono | Mejor identificación y menos duplicados. | Quien no da teléfono no puede registrarse, o recepción inventa uno. Se guarda más dato personal. |
| C | Nombre, teléfono y estado | Datos completos para reportes de procedencia. | Más tiempo en recepción; mismos inconvenientes que B. |

**Pregunta relacionada:** hoy solo se aceptan teléfonos de 10 dígitos (México). ¿Se aceptan números de otros países?

---

## 2. Enmascaramiento del teléfono

| Opción | Qué se ve | A favor | En contra |
|---|---|---|---|
| **A (provisional)** | Para todos los perfiles, solo los últimos 4 dígitos (`•• •••• 5678`). Completo solo si quien busca escribió el número completo y coincide. | Se expone lo mínimo. Recepción puede verificar preguntando el número al visitante. El número completo no llega al navegador. | Nadie ve el número completo desde la plataforma; para corregirlo hará falta otro permiso (bloque 2, tarea de correcciones). |
| B | Completo para quien trabaja en la sucursal donde se creó el expediente; enmascarado en las demás. | La sucursal de origen conserva su dato de contacto. | Una misma persona se ve distinta según la sucursal; más difícil de explicar. |
| C | Enmascarado para Recepción; completo para Encargado, Administración y Dirección, dentro de su alcance. | Es la tabla propuesta en los requisitos. | Más personas ven el dato completo. |
| D | Completo para todos los que pueden buscar. | Lo más simple. | Mayor exposición; contradice la propuesta de privacidad. |

---

## 3. Lo que Recepción ve de otras sucursales

La búsqueda cubre todas las sucursales (el expediente es único). La pregunta es qué se muestra del expediente
cuando viene de otra sucursal. Mientras no existan visitas (llegan en el bloque 4), solo hay datos del expediente.

| Opción | Qué se ve | A favor | En contra |
|---|---|---|---|
| **A (provisional)** | Datos del expediente (con el teléfono según la decisión 2) y en qué sucursal y fecha se creó. Nada de visitas de otras sucursales. | Lo mínimo para reconocer a la persona y evitar duplicados. | Al llegar las promociones, recepción no sabrá si alguien ya visitó otra sucursal. |
| B | Lo de A, más el número total de visitas, la fecha y sucursal de la última, y el resultado de elegibilidad de una promoción con su motivo. Sin importes, formas de pago ni operaciones. | Es la propuesta del documento de requisitos. Basta para aplicar promociones sin exponer cobros. | Revela en qué sucursales ha estado la persona. |
| C | Historial completo de visitas de todas las sucursales (fecha, hora, sucursal, promoción, pagada o gratuita), sin importes. | Recepción entiende el contexto completo del visitante. | Mayor exposición; más de lo necesario para registrar una visita. |

En cualquier opción, si faltan registros el historial se marca **incompleto**: que no aparezcan visitas no
significa que la persona nunca haya asistido.

---

## Otras reglas provisionales del sitio de pruebas (también pendientes)

- **Quién puede buscar, consultar y crear:** Recepción, Encargado y Dirección buscan, consultan y crean;
  Administración solo busca y consulta. Fusionar e historial general no están asignados a nadie.

## Indicado para la primera entrega de correcciones (4 nov 2026)

- **Corrigen Encargado y Dirección**, según sus sucursales autorizadas. Recepción y Administración no editan.
- **Solo expedientes creados en una sucursal donde la persona tenga el permiso de corregir.**
- Se corrigen nombre, teléfono y estado de procedencia, con **motivo obligatorio**. Se conserva el dato anterior,
  el nuevo, quién, desde qué sucursal y cuándo; el teléfono se muestra enmascarado.
- Si la corrección produce coincidencias, se avisa y las fichas siguen separadas (unirlas será la fusión).
- **El historial de correcciones (datos anteriores y motivos) solo lo ve quien puede corregir ese expediente**,
  según la sucursal donde se creó. Recepción, Administración y quien no tiene el permiso en esa sucursal ven
  solo la ficha actual; el servidor no les envía el historial.
- El formulario pide que el motivo describa la corrección **sin incluir teléfonos completos**.
- **Búsqueda por teléfono:** solo con los 10 dígitos; no se aceptan pedazos, para que no se puedan adivinar números.
- **El historial de cambios no repite el teléfono:** solo registra si se capturó.

## Indicado para la fusión de duplicados (4 nov 2026)

- **Una sola ficha por visitante para todo Fitnessland.** En otra sucursal, Recepción busca y usa esa misma ficha.
  En el bloque 4, cada visita guardará la sucursal donde ocurrió, aunque la ficha se haya creado en otra.
- La fusión se usa **únicamente cuando por error se crearon dos fichas de la misma persona**.
- **Solo Dirección con el permiso específico de fusión** (`visitante.fusionar`). Si las fichas se crearon en
  sucursales distintas, debe tenerlo en ambas. Se comprueba en el servidor al guardar.
- **Dirección elige la ficha activa y de cuál ficha se toma** el nombre, el teléfono y el estado de procedencia.
  Teléfonos enmascarados, vista previa antes de confirmar y motivo obligatorio. Se registra quién, cuándo y qué fichas unió.
- **La otra ficha se conserva** con su historial y un vínculo a la ficha activa; sale de la búsqueda normal. Un
  enlace anterior lleva a la ficha activa solo si la persona tiene permiso para consultarla.
- **Personas confirmadas como distintas:** la fusión se bloquea y se explica el motivo (también si la confirmación
  está en una ficha que ya se había unido a alguna de las dos).
- **Deshacer: pendiente para otra entrega.** Antes de confirmar se avisa que la fusión no se puede deshacer desde la pantalla.

### Casos ficticios cargados para probar
- **Se pueden unir:** «Valeria Gómez Pineda» y «Valeria Gomes Pineda», ambas creadas en Tenango con el teléfono
  terminado en 0401 (la segunda con falta de ortografía y sin procedencia).
- **Se debe bloquear:** «Ana Martínez Ruiz» y «Luis Martínez Ruiz», que comparten el teléfono terminado en 0201 y ya
  están confirmados como personas distintas.

## Indicado para el reporte básico (4 nov 2026)

- **Lo ven Encargado, Administración y Dirección**, según sus sucursales autorizadas (permiso `reporte.expedientes`).
  Recepción no. El permiso se valida en el servidor.
- **«Expedientes creados»** por sucursal y periodo, contando por la sucursal donde se creó cada ficha. Las visitas por
  sucursal se cuentan en el bloque 4.
- **Posibles duplicados:** cada par una sola vez; fichas activas con el mismo teléfono registrado o un nombre muy
  parecido; sin pares confirmados como personas distintas ni fichas ya unidas. Un par de fichas creadas en sucursales
  distintas solo se muestra y cuenta para quien tiene el reporte en ambas.

Provisional (decidido al construir): «nombre muy parecido» es una similitud de al menos **70 %**. Con ese valor entran
errores de escritura como «Valeria Gómez / Gomes Pineda» (83 %) y quedan fuera hermanos que solo comparten apellidos,
como «Ana / Luis Martínez Ruiz» (61 %). Las fichas que después se unieron a otra siguen contando como expedientes creados
y se muestran aparte.

## Estado al cerrar el bloque 2 para el entorno de pruebas (4 nov 2026)

- **Se deciden antes de capturar datos reales:** campos obligatorios (decisión 1 de este documento) y quién puede ver
  el teléfono completo (decisión 2). Mientras tanto siguen las opciones A provisionales.
- **Se retoma en el bloque 4:** lo que Recepción ve del historial de otras sucursales (decisión 3 de este documento),
  cuando existan visitas.
- El reporte básico se probó en el sitio el 4 nov 2026 con Encargado Tenango, Administración y Recepción Tenango.
