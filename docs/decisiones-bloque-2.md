# Bloque 2: decisiones pendientes sobre el expediente de visitante

Fecha: 4 nov 2026. Estado: **pendientes**. Forman parte de la decisión 3 (privacidad del expediente)
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
  Administración solo busca y consulta. Corregir, fusionar e historial general no están asignados a nadie.
- **Búsqueda por teléfono:** solo con los 10 dígitos; no se aceptan pedazos, para que no se puedan adivinar números.
- **El historial de cambios no repite el teléfono:** solo registra si se capturó.
