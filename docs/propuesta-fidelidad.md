# Propuesta: programa de fidelidad de visitas (bloque 7)

Fecha: 5 de noviembre de 2026. Estado: **propuesta, no aprobada**. Nada de esto está implementado.
Convención igual que en [`requisitos-visitantes-promociones-qr.md`](requisitos-visitantes-promociones-qr.md):
**[Indicado]** lo pidió Fitnessland para esta propuesta; **[Propuesta]** diseño sugerido; **[Pendiente]** falta
decidir y la función que depende de ello no se activa.

## 1. Qué es

- **[Indicado]** Por cada **cinco visitas pagadas** que cumplan las reglas, el visitante gana **una visita gratis**.
- **[Indicado]** Va ligado a la **ficha global** del visitante (una sola para todo Fitnessland), no a una tarjeta,
  teléfono ni aplicación.
- **[Indicado]** Funciona igual para quien **no tenga Wallet**: Recepción lo busca como siempre (nombre o teléfono).
- **[Indicado]** Al registrar una visita, Recepción ve el **avance** (por ejemplo, «3 de 5») y las **cortesías
  disponibles**.
- **[Indicado, propuesta de Dirección]** Las visitas gratis por fidelidad **no acumulan**.
- **[Indicado, propuesta de Dirección]** Tarjeta y transferencia cuentan **según su estado de confirmación**:
  - efectivo y tarjeta «confirmada operativamente» acumulan al confirmarse el cobro;
  - una transferencia «pendiente de abono» **no** acumula; acumula cuando su abono se verifica.

## 2. Pendientes de aprobación [Pendiente]

| # | Decisión | Mientras no se decida |
|---|---|---|
| F1 | Sucursales participantes (dónde se acumula y dónde se canjea) | El programa no se activa |
| F2 | Fecha desde la que se acumula (las visitas anteriores cuentan o no) | El programa no se activa |
| F3 | Vigencia de las recompensas | Sin vencimiento automático; no se activa en producción |
| F4 | Qué pasa con pagos devueltos o cancelados (ver §6) | No se activa en producción |

Dudas que encontré al diseñarlo y que también conviene decidir:

- **F5. «Visita pagada» con promoción.** Una visita con descuento parcial (por ejemplo, $25), ¿cuenta? Las
  gratuitas de una promoción ($0) se proponen como no acumulables, igual que las cortesías.
- **F6. Fichas unidas.** Si dos fichas de la misma persona se unen, se propone sumar su avance en la ficha activa
  (ver §5).
- **F7. Qué ve Recepción de otras sucursales.** El avance cuenta visitas de todas las sucursales participantes.
  Ver «3 de 5» revela que la persona fue a otras sucursales, aunque no diga a cuáles. Esto se relaciona con la
  decisión pendiente sobre el historial entre sucursales (decisión 3, bloque 4).
- **F8. Pronto pago.** Los «pases de cortesía» del beneficio de pronto pago (sección 6 de los requisitos) son
  otra cosa. Se propone que tampoco acumulen y que en pantalla se distingan («Cortesía por fidelidad» y
  «Cortesía de pronto pago»).

## 3. Registro [Propuesta]

Se apoya en lo que ya existe del bloque 4: `operacion_visita`, `cobro_visita` y `pase_visita` (con tarifa,
descuento y total). Nada se edita ni se borra: los cambios de estado son registros nuevos o transiciones
controladas.

| Tabla | Para qué | Protección contra duplicados |
|---|---|---|
| `programa_fidelidad` | Versión de las reglas: visitas requeridas (5), sucursales, desde cuándo, vigencia, activo. | Cada cambio crea una versión nueva; las acumulaciones guardan la versión con la que se ganaron. |
| `fidelidad_acumulacion` | Una fila por **pase pagado** que cumplió las reglas: ficha, pase, cobro, versión, sucursal, fecha y estado (`vigente` o `anulada`). | `unique (pase_visita_id)`: un pase acumula una sola vez, aunque el cobro se reintente o se verifique dos veces. |
| `fidelidad_recompensa` | Una visita gratis ganada: ficha, versión, fecha, vence (si F3 lo define) y estado (`disponible`, `canjeada`, `vencida`, `anulada`). | Cada acumulación apunta a lo más a una recompensa (`recompensa_id`), y una recompensa se forma con exactamente 5 acumulaciones. |
| `fidelidad_canje` | El uso de una recompensa: recompensa, pase de la visita gratis, quién, dónde y cuándo. | `unique (recompensa_id)` y `unique (pase_visita_id)`: una recompensa se canjea una vez y un pase usa una sola recompensa. |

**Cuándo acumula.** En la misma transacción que confirma el cobro (efectivo o tarjeta), o que verifica el abono
de una transferencia:

1. Se bloquea la ficha activa del visitante. Así, dos cobros simultáneos de la misma persona se forman en fila.
2. Se crea la acumulación del pase, con `unique (pase_visita_id)`.
3. Si quedan 5 acumulaciones vigentes sin recompensa, se crea **una** recompensa y se le asignan esas 5.

Un doble clic o un reintento del mismo cobro ya está cubierto por la clave del cobro del bloque 4. Aunque
llegara dos veces, el `unique` del pase impide acumular de nuevo.

**Qué no acumula:** visitas gratis por fidelidad, cortesías de pronto pago, pases de $0 por promoción,
transferencias pendientes y visitas fuera de las sucursales o fechas participantes (F1, F2).

## 4. Canje en Recepción [Propuesta]

En la misma pantalla de «Registrar visita», al elegir la ficha:

> **Fidelidad:** 3 de 5 visitas pagadas · **1 visita gratis disponible** (vence 31 ene 2027)
> [Usar visita gratis]  o  [Confirmar cobro · $50.00]

- **Usar visita gratis:** se registra el pase con tarifa $50, descuento $50 y total $0, ligado a la recompensa.
  No hay cobro ni entra efectivo a la bolsa, y el pase no acumula.
- **El canje es atómico:** la recompensa pasa de `disponible` a `canjeada` solo si sigue disponible. Si dos
  recepciones intentan usarla al mismo tiempo, solo una lo logra; la otra ve «Esta visita gratis ya se usó».
- El avance y las cortesías se calculan en el servidor y se muestran a quien puede registrar visitas en esa
  sucursal. Lo que ve de otras sucursales depende de F7.

## 5. Fichas unidas [Propuesta, F6]

Las acumulaciones y recompensas siguen ligadas a su ficha original. El avance se calcula sobre el grupo de
fichas unidas, igual que el historial. Al unir dos fichas, en la misma transacción de la fusión se revisa si el
grupo ya junta 5 acumulaciones sin recompensa y, si es así, se genera una.

## 6. Pagos devueltos o cancelados [Pendiente, F4]

Opciones para decidir, sin elegir ninguna todavía:

- **A.** La acumulación de ese pase se anula. Si ya formaba parte de una recompensa **no canjeada**, la recompensa
  se anula y las otras 4 acumulaciones vuelven a quedar libres.
- **B.** Igual que A, pero si la recompensa **ya se canjeó**, se marca para revisión de Encargado o Dirección en
  lugar de cobrarla.
- **C.** Las devoluciones no afectan lo ya acumulado.

Las cancelaciones y devoluciones de cobros todavía no existen; llegan en otro paso del bloque 4. Esta decisión se
toma antes de activar el programa.

## 7. Reporte básico [Propuesta]

Recompensas generadas, canjeadas, vencidas y anuladas por sucursal y periodo, y visitas gratis pendientes de
usar. Falta definir, junto con F1, a qué sucursal se atribuye el costo de una visita gratis ganada en otra.

## 8. Pruebas que tendrá [Propuesta]

- La quinta visita pagada genera exactamente una recompensa, incluso con dos cobros simultáneos de la misma persona.
- Un doble clic o un reintento del cobro no acumula dos veces.
- Una visita gratis canjeada no acumula, y dos canjes simultáneos de la misma recompensa: solo uno gana.
- Una transferencia pendiente no acumula; al verificarse, acumula una sola vez.
- Fuera de las sucursales o fechas participantes no acumula.
- Las fichas unidas suman su avance.
- Solicitudes directas al servidor sin permiso no ven el avance ni canjean.

## 9. Apple Wallet y Google Wallet: integración posterior

- Se anotan para después del bloque 8, cuando exista el diseño de QR.
- Servirían para **mostrar la tarjeta** (avance y cortesías) y para que Recepción **encuentre la ficha leyendo un
  QR**, en lugar de buscar por nombre o teléfono.
- Nunca serán requisito: sin Wallet todo funciona igual.
- **[Propuesta]** El QR de la tarjeta identifica la ficha con un código opaco, calculado como se describe en la
  sección 7 de los requisitos. No contiene el nombre ni el teléfono, y es distinto del QR de un pase de visita.
  Leerlo solo abre la ficha a quien tiene permiso de buscar visitantes; no registra visitas ni canjea nada.
- **Costo:** Apple Wallet requiere una cuenta de desarrollador de Apple de pago y Google Wallet una cuenta de
  emisor. Antes de contratar cualquier servicio se confirmarán costos y requisitos, y se te avisará.
