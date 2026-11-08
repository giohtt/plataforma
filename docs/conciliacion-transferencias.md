# Conciliación de transferencias por lote

Fecha: 5 de noviembre de 2026 (actualizado el 8 nov 2026). Estado: **propuesta, no programada; opción de respaldo**.
Requiere que una persona descargue y cargue los movimientos: **no es una confirmación completamente automática**,
que sigue pendiente (§7). Convención: **[Indicado]** lo pidió Fitnessland; **[Propuesta]** diseño sugerido; **[Pendiente]** falta
decidir.

## 1. Por qué

- **[Indicado]** La verificación manual, cobro por cobro (pantalla «Transferencias por verificar»), queda para
  pruebas y excepciones.
- **[Indicado]** Para operar con varias sucursales, Administración carga los **movimientos de cada cuenta
  bancaria** y el sistema verifica **automáticamente** los abonos que coincidan de forma **inequívoca** con un
  cobro.
- **[Indicado]** Si hay dudas o falta algún dato, el abono va a una **bandeja de revisión**.
- **[Indicado]** **Cada abono se usa una sola vez.**

## 2. Lo que ya existe y se conserva

- El cobro por transferencia queda «Pendiente de verificar abono» al registrarse. Tiene la referencia (clave de
  rastreo o folio bancario) y su tipo, y no genera entrada de efectivo.
- Verificar cambia el estado del **mismo** cobro, con historial que no se edita. Nadie verifica lo que registró.
- La base ya impide verificar dos veces el mismo abono (misma referencia, tipo y fecha de abono). Con la cuenta
  bancaria se hará más preciso (§4).

## 3. Flujo propuesto [Propuesta]

1. **Cuentas bancarias.** Catálogo de cuentas de Fitnessland, con banco, últimos dígitos de la cuenta o CLABE,
   alias y sucursales que la usan. Lo administra Dirección. No se guardan credenciales de banca en línea.
2. **Carga del lote.** Administración elige la cuenta y el periodo y sube el archivo de movimientos (estado de
   cuenta o reporte del banco, en CSV o el formato que entregue el banco).
   - El lote queda registrado: quién lo subió, cuándo, cuenta, periodo, nombre y huella del archivo.
   - Subir otra vez el mismo archivo no duplica movimientos.
3. **Movimientos.** Cada abono del archivo es un **movimiento bancario**: cuenta, fecha, importe, clave de rastreo
   o folio, concepto y la referencia propia del banco si existe.
   - Un movimiento repetido entre lotes que se traslapan (misma cuenta, fecha, importe y referencia) se reconoce
     y no se duplica.
4. **Coincidencia automática, solo si es inequívoca.** Un movimiento verifica un cobro únicamente si se cumplen
   todas estas condiciones:
   - el tipo y la referencia coinciden exactamente (normalizados igual que en el registro);
   - el importe es **exactamente** el total del cobro;
   - la fecha del abono está dentro de la ventana permitida respecto a la fecha del cobro;
   - la cuenta corresponde a la sucursal del cobro;
   - hay **un solo** cobro pendiente o no localizado que cumple, y ese movimiento no está usado ya.

   Si todo se cumple, el cobro pasa a «Abono verificado», ligado a ese movimiento. El historial dice
   «Conciliación por lote» y quién cargó el lote.
5. **Bandeja de revisión.** Todo lo que no es inequívoco va a la bandeja, con el motivo:
   - **varios cobros posibles** para un movimiento, o **varios movimientos** para un cobro;
   - **importe distinto** (de más o de menos);
   - **referencia parecida**, pero no igual (por ejemplo, un dígito);
   - **fecha fuera de ventana** o **cuenta de otra sucursal**;
   - **movimiento sin cobro**: un abono sin cobro registrado;
   - **cobro sin movimiento**: un cobro que sigue pendiente tras cubrir su periodo.

   Desde la bandeja, Administración o Dirección (con permiso en la sucursal y sin haber registrado el cobro)
   puede ligar a mano un movimiento con un cobro, marcar «No localizado» con motivo o dejarlo para después.
6. **Cada abono, una sola vez.** Un movimiento bancario se liga a **un solo** cobro, lo garantiza la base con un
   índice único sobre el movimiento. El cobro guarda qué movimiento lo verificó.

## 4. Cómo se distingue una referencia repetida de un mismo abono

| Caso | Al registrar el cobro (Recepción) | Al verificar (manual o por lote) |
|---|---|---|
| **Clave de rastreo** repetida | Se muestra el cobro previo y se pide confirmar «otra transferencia». En SPEI la clave identifica una transferencia, así que lo normal es que sea el mismo abono. | El mismo abono no verifica dos cobros. Hoy: misma referencia, tipo y fecha de abono. Con lotes: el mismo movimiento bancario. |
| **Folio bancario** repetido | Se avisa solo si el folio se registró en los **últimos 30 días** (provisional). Los folios de transferencias del mismo banco pueden repetirse con el tiempo o entre cuentas. | Con la carga por cuenta, el folio se distingue por **cuenta, fecha e importe**. Dos movimientos con el mismo folio en distinta fecha o cuenta son abonos distintos. |
| **Referencia distinta**, mismo importe y día | No hay aviso. | No coincide por referencia: va a la bandeja como «referencia parecida» o «movimiento sin cobro». |

**Datos del cobro previo:** solo los ve quien puede ver los turnos o registrar visitas en la sucursal de ese
cobro. A los demás solo se les dice que existe otro cobro con esa referencia en una sucursal a la que no tienen
acceso.

## 5. Pendientes [Pendiente]

- Formato del archivo de cada banco (Banorte y otros) y si se puede descargar en CSV.
- Ventana de fechas para la coincidencia automática (hoy, para la verificación manual: hasta 3 días antes del
  cobro y nunca una fecha futura; provisional).
- Qué hacer con abonos de más o de menos y con movimientos sin cobro.
- Quién administra el catálogo de cuentas.
- Si se puede dar acceso con el comprobante antes de verificar el abono (sigue pendiente de decisión).
- Respaldos y restauración antes de cargar movimientos reales.

## 6. Pruebas que tendrá [Propuesta]

- Un lote con un abono exacto verifica su cobro una sola vez, aunque el archivo se cargue dos veces.
- Dos cobros con la misma referencia y un solo movimiento: ninguno se verifica solo y ambos van a la bandeja.
- Un importe de $49.99 para un cobro de $50 va a la bandeja con «importe distinto».
- Un movimiento ya usado no verifica otro cobro, ni a mano.
- Un folio repetido en distinta fecha o cuenta se trata como dos abonos distintos.
- Sin permiso, o habiendo registrado el cobro: no se carga, no se liga y no se verifica, tampoco por solicitud
  directa.

## 7. Confirmación automática: opciones revisadas el 8 nov 2026

**Decisión [Indicado, 8 nov 2026]:** no contratar por ahora un procesador de pagos ni un servicio adicional de
Banorte. Se mantienen el registro de transferencias y la verificación manual. La confirmación automática queda
**pendiente** hasta encontrar una forma confiable de comprobar el abono con las cuentas actuales.

| Opción | Qué se comprobó | Estado |
|---|---|---|
| **CEP de Banxico, consulta individual** | Prueba manual con un SPEI real recibido en la cuenta de Tenango, sin guardar sus datos. La consulta del estado del pago no valida la cuenta. **Al descargar el CEP con la CLABE de la cuenta, Banxico lo entregó, y con el monto cambiado a $501 no lo entregó**: cruza cuenta receptora, clave de rastreo e importe. El CEP en XML trae sello digital, fecha de operación, clave de rastreo, cuenta beneficiaria y monto, además de datos personales que **no** se guardarían. Un SPEI hecho tarde puede tener la **fecha de operación del día hábil siguiente**. | Comprobado a mano. Falta saber cómo validar el sello. |
| **CEP de Banxico por lotes** (oficial) | Archivo TXT de hasta 500 pagos y 6 campos; devuelve un ZIP con CEP y `resumen.txt`; pide un código de seguridad al subir y al bajar. Se preparó una plantilla para probarlo con dos pagos de Tenango. El plazo de consulta no se toma como regla vigente: se confirmará al probarlo. | **Opción de respaldo, pendiente de probar. Requiere una persona**: la plataforma generaría el TXT, pero alguien lo sube a Banxico, captura el código, descarga el ZIP y lo importa. |
| **CEP consultado automáticamente por el servidor** | Hay librerías de código abierto que lo hacen. No se confirmó que sea un servicio oficial ni sus condiciones de uso. | No adoptado. |
| **Archivo de movimientos de la cuenta** (conciliación por lote) | El estado de cuenta de Banorte trae, en cada SPEI recibido, la clave de rastreo, el banco emisor, la hora, la referencia y el monto. El PDF es mensual. Los traspasos internos no traen una referencia única. La cuenta también recibe mensualidades y otros pagos. | **Opción de respaldo. Requiere una persona** que descargue y cargue el archivo; la comparación sí sería automática. Pendiente de saber si la banca en línea permite **descargar los movimientos a diario** (CSV o Excel). |
| **CLABE única por cobro con un procesador** | Comisión publicada: Conekta «desde $12.50 + IVA» por transferencia (≈ 29 % de una visita de $50); Stripe «4 % + $3» + IVA, sin confirmar que aplique a SPEI nacional. El dinero pasa por el saldo del proveedor. | **Descartado por ahora** (8 nov 2026). |
| **Servicio adicional de Banorte** (cobranza referenciada o avisos) | No se consultó. | **Descartado por ahora** (8 nov 2026). |

**Ninguna de las opciones de respaldo es completamente automática:** el CEP por lotes y la carga de movimientos
requieren que una persona intervenga. La confirmación **completamente automática** con las cuentas actuales sigue
**pendiente**.

Los traspasos que no pasan por SPEI siguen en revisión manual en cualquier opción.
