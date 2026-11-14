import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import type { TipoLugar } from "@/lib/turnos";
import { ventasDelTurno, type VentasTurno } from "@/lib/ventas";
import { cobrosDelTurno } from "@/lib/visitas";

/**
 * Bloque 5, paso 2 (primera parte): diferencias de efectivo registradas en los cambios de turno.
 *
 * - Consultan quienes tienen diferencia.consultar en la sucursal (Encargado, Administración, Dirección). Sin permiso,
 *   la sucursal y sus casos no se encuentran.
 * - La lista agrupa por entrega y muestra primero las que tienen diferencias por revisar.
 * - El detalle separa el esperado, lo entregado, lo recibido y cada diferencia, y desglosa el saldo esperado con los
 *   movimientos del turno de origen hasta la entrega. No cambia ningún importe.
 * - Cada diferencia se revisa por separado (segunda parte, 0022): «Aclarada», o «Faltante/Sobrante confirmado» según su
 *   signo, con motivo obligatorio. Un faltante o sobrante confirmado queda pendiente para Dirección. Revisar no cambia
 *   ningún importe ni el saldo de apertura del turno siguiente.
 * - Quién revisa: según los perfiles de quienes participaron (nivel_revision_entrega); quien participó, nunca.
 */
type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

export type TipoDiferencia = "contra_esperado" | "entre_personas";
export type ResultadoRevision = "aclarada" | "faltante_confirmado" | "sobrante_confirmado";
/**
 * Estado de una diferencia: por revisar; aclarada; confirmada y pendiente para Dirección; resuelta por Dirección con
 * corrección pendiente; o resuelta (cerrada).
 */
export type EstadoDiferencia = "por_revisar" | ResultadoRevision | "correccion_pendiente" | "resuelta";
export type DecisionDireccion = "absorbe_sucursal" | "queda_en_bolsa" | "origen_identificado";
export type Resolucion = {
  decision: DecisionDireccion; motivo: string; origen: string | null; requiereCorreccion: boolean; resueltaPor: string; en: Date;
  correccion: { texto: string; referencia: { tipo: string; id: string }; por: string; en: Date } | null;
};
/** Horas a partir de las cuales un caso pendiente para Dirección se marca «Más de 48 horas pendiente». */
export const HORAS_AVISO_DIRECCION = 48;
export type NivelRevision = "encargado" | "administracion" | "direccion";
export type Revision = { resultado: ResultadoRevision; motivo: string; revisadaPor: string; nivel: NivelRevision; en: Date };
export type Diferencia = {
  id: string; lugar: TipoLugar; tipo: TipoDiferencia; importe: string; estado: EstadoDiferencia; registradaEn: Date;
  revision: Revision | null;
  resolucion: Resolucion | null;
  /** Desde cuándo espera a Dirección (confirmado o con corrección pendiente); null si no está pendiente para Dirección. */
  pendienteDireccionDesde: Date | null;
};

export type CasoLista = {
  entregaId: string;
  entregadaEn: Date;
  confirmadaEn: Date;
  entregaPor: string;
  recibe: string;
  diferencias: Diferencia[];
  /** Diferencias de esta entrega que siguen por revisar. */
  pendientes: number;
  /** Faltantes o sobrantes confirmados, pendientes para Dirección. */
  paraDireccion: number;
  /** Suma de las diferencias de la bolsa contra el esperado y en la entrega. Solo referencia: cada una se revisa aparte. */
  neto: string;
};

async function sucursalConsultable(sql: Sql, usuarioId: string, codigo: string) {
  if (!/^[A-Z0-9]{2,5}$/.test(codigo)) return null;
  const [s] = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sucursal where codigo = ${codigo} and tiene_permiso(${usuarioId}, 'diferencia.consultar', id)`;
  return s ?? null;
}

type FilaDiferencia = {
  id: string; entrega_id: string; lugar: TipoLugar; tipo: TipoDiferencia; importe: string; registrada_en: Date;
  resultado: ResultadoRevision | null; motivo: string | null; revisor: string | null; nivel: NivelRevision | null; revisada_en: Date | null;
  decision: DecisionDireccion | null; motivo_dir: string | null; origen: string | null; requiere_correccion: boolean | null;
  resolutor: string | null; resuelta_en: Date | null; correccion: string | null; corrector: string | null; correccion_en: Date | null;
  correccion_ref_tipo: string | null; correccion_ref_id: string | null;
};
const DIFERENCIAS = (sql: Sql | Tx, entregaIds: string[]) => sql<FilaDiferencia[]>`
  select d.id, d.entrega_id, l.tipo as lugar, d.tipo, d.importe::text as importe, d.registrada_en,
         r.resultado, r.motivo, u.nombre as revisor, r.nivel, r.en as revisada_en,
         x.decision, x.motivo as motivo_dir, x.origen, x.requiere_correccion, ux.nombre as resolutor, x.en as resuelta_en,
         x.correccion, uc.nombre as corrector, x.correccion_en, x.correccion_ref_tipo, x.correccion_ref_id
  from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
  left join revision_diferencia r on r.diferencia_id = d.id left join usuario u on u.id = r.revisada_por
  left join resolucion_diferencia x on x.diferencia_id = d.id left join usuario ux on ux.id = x.resuelta_por
  left join usuario uc on uc.id = x.correccion_por
  where d.entrega_id in ${sql(entregaIds)}
  order by case l.tipo when 'bolsa_visitas' then 0 else 1 end, d.tipo`;
const aDiferencia = (d: FilaDiferencia): Diferencia => {
  const resolucion: Resolucion | null = d.decision ? {
    decision: d.decision, motivo: d.motivo_dir!, origen: d.origen, requiereCorreccion: !!d.requiere_correccion, resueltaPor: d.resolutor!,
    en: d.resuelta_en!, correccion: d.correccion ? { texto: d.correccion, referencia: { tipo: d.correccion_ref_tipo!, id: d.correccion_ref_id! }, por: d.corrector!, en: d.correccion_en! } : null,
  } : null;
  const estado: EstadoDiferencia = !d.resultado ? "por_revisar"
    : !resolucion ? d.resultado
    : resolucion.requiereCorreccion && !resolucion.correccion ? "correccion_pendiente" : "resuelta";
  return {
    id: d.id, lugar: d.lugar, tipo: d.tipo, importe: d.importe, registradaEn: d.registrada_en, estado, resolucion,
    revision: d.resultado ? { resultado: d.resultado, motivo: d.motivo!, revisadaPor: d.revisor!, nivel: d.nivel!, en: d.revisada_en! } : null,
    pendienteDireccionDesde: estado === "faltante_confirmado" || estado === "sobrante_confirmado" || estado === "correccion_pendiente" ? d.revisada_en : null,
  };
};

/** Entregas confirmadas de la sucursal: primero las que tienen diferencias por revisar; después, las más recientes. */
export async function listaDiferencias(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; casos: CasoLista[] } | null> {
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const entregas = await sql<{ id: string; creada_en: Date; resuelta_en: Date; entrega_por: string; recibe: string }[]>`
    select e.id, e.creada_en, e.resuelta_en, a.nombre as entrega_por, b.nombre as recibe
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where t.sucursal_id = ${s.id} and e.estado = 'confirmada'
    order by e.resuelta_en desc
    limit 200`;
  const difs = entregas.length ? await DIFERENCIAS(sql, entregas.map((e) => e.id)) : [];
  const casos = entregas.map((e): CasoLista => {
    const diferencias = difs.filter((d) => d.entrega_id === e.id).map(aDiferencia);
    const neto = diferencias.filter((d) => d.lugar === "bolsa_visitas").reduce((suma, d) => suma + Math.round(Number(d.importe) * 100), 0);
    return {
      entregaId: e.id, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en, entregaPor: e.entrega_por, recibe: e.recibe,
      diferencias, pendientes: diferencias.filter((d) => d.estado === "por_revisar").length,
      paraDireccion: diferencias.filter((d) => d.pendienteDireccionDesde).length,
      neto: (neto / 100).toFixed(2),
    };
  });
  // Primero las que siguen por revisar; después las pendientes para Dirección; después el resto; cada grupo, la más reciente primero.
  const grupo = (c: CasoLista) => (c.pendientes ? 0 : c.paraDireccion ? 1 : 2);
  casos.sort((a, b) => grupo(a) - grupo(b) || b.confirmadaEn.getTime() - a.confirmadaEn.getTime());
  return { sucursal: s.nombre, casos };
}

export type Cifras = { esperado: string | null; entregado: string; inicial: string; confirmado: string };

export type Desglose = {
  abiertoEn: Date;
  abiertoPor: string;
  contadoAlAbrir: string;
  cobros: { cuantos: number; visitas: number; importe: string };
  cancelaciones: { cuantas: number; importe: string };
  /** Salidas por retiros a Encargada de retiros (negativo). */
  retiros: { cuantos: number; importe: string };
  /** Calculado aquí con los movimientos hasta la entrega. Debe coincidir con el esperado guardado al entregar. */
  calculado: string;
};

export type EventoCaso = { en: Date; que: string; cuenta: string };
export type EtapaApoyo = "conteo_entrega" | "conteo_recepcion" | "recuento";
/** Apoyo declarado en una etapa: sin registro (entregas anteriores), nadie más participó, o las personas declaradas. */
export type ApoyoEtapa = {
  etapa: EtapaApoyo;
  estado: "sin_registro" | "nadie" | "con_apoyo";
  declaradoPor: string | null;
  declaradoEn: Date | null;
  personas: { nombre: string; confirmadoEn: Date | null }[];
};

export type DetalleDiferencias = {
  sucursal: string;
  entregaId: string;
  entregaPor: string;
  recibe: string;
  entregadaEn: Date;
  confirmadaEn: Date;
  nota: string | null;
  aclaracion: string | null;
  /** La cuenta que consulta contó, entregó o recibió en esta entrega. */
  participaste: boolean;
  /** Perfil al que le toca revisar estas diferencias, y si la cuenta que consulta puede hacerlo. */
  nivel: NivelRevision;
  puedeRevisar: boolean;
  /** La cuenta puede resolver como Dirección (permiso y perfil de Dirección en la sucursal, sin haber participado). */
  puedeResolver: boolean;
  /** Apoyo en cada etapa del conteo. El recuento solo aparece si lo hubo. */
  apoyos: ApoyoEtapa[];
  historial: EventoCaso[];
  lugares: Record<TipoLugar, Cifras>;
  diferencias: Diferencia[];
  desglose: Desglose;
  fueraDeLaBolsa: VentasTurno;
};

export async function detalleDiferencias(sql: Sql, usuarioId: string, codigo: string, entregaId: string): Promise<DetalleDiferencias | null> {
  if (!esIdentificadorValido(entregaId)) return null;
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const [e] = await sql<{ id: string; turno_id: string; creada_en: Date; resuelta_en: Date; nota: string | null; aclaracion: string | null;
                          entrega_por: string; entrega_por_id: string; recibe: string; recibe_id: string }[]>`
    select e.id, e.turno_id, e.creada_en, e.resuelta_en, e.nota, e.aclaracion,
           a.nombre as entrega_por, a.id as entrega_por_id, b.nombre as recibe, b.id as recibe_id
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where e.id = ${entregaId} and t.sucursal_id = ${s.id} and e.estado = 'confirmada'`;
  if (!e) return null;

  const conteos = await sql<{ lugar: TipoLugar; tipo: string; importe: string; esperado: string | null }[]>`
    select l.tipo as lugar, c.tipo, c.importe::text as importe, c.esperado::text as esperado
    from entrega_conteo c join lugar_efectivo l on l.id = c.lugar_id where c.entrega_id = ${e.id}`;
  const de = (lugar: TipoLugar, tipo: string) => conteos.find((c) => c.lugar === lugar && c.tipo === tipo)!;
  const cifras = (lugar: TipoLugar): Cifras => ({
    esperado: de(lugar, "entregado").esperado, entregado: de(lugar, "entregado").importe,
    inicial: de(lugar, "recibido_inicial").importe, confirmado: de(lugar, "recibido_final").importe,
  });

  // Desglose de la bolsa: lo contado al abrir y los movimientos del turno registrados antes de la entrega.
  const [d] = await sql<{ abierto_en: Date; abierto_por: string; contado: string; cobros: number; visitas: number; importe_cobros: string;
                          cancelaciones: number; importe_cancelaciones: string; retiros: number; importe_retiros: string }[]>`
    select t.abierto_en, u.nombre as abierto_por, c.importe::text as contado,
           (count(m.id) filter (where m.tipo = 'entrada_cobro_visita'))::int as cobros,
           coalesce(sum((select count(*) from pase_visita p join cobro_visita cv on cv.operacion_id = p.operacion_id where cv.id = m.cobro_id))
                    filter (where m.tipo = 'entrada_cobro_visita'), 0)::int as visitas,
           coalesce(sum(m.importe) filter (where m.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2)::text as importe_cobros,
           (count(m.id) filter (where m.tipo = 'ajuste_cancelacion_cobro'))::int as cancelaciones,
           coalesce(sum(m.importe) filter (where m.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2)::text as importe_cancelaciones,
           (count(m.id) filter (where m.tipo = 'salida_retiro'))::int as retiros,
           coalesce(sum(m.importe) filter (where m.tipo = 'salida_retiro'), 0)::numeric(12, 2)::text as importe_retiros
    from turno t join usuario u on u.id = t.abierto_por
    join lugar_efectivo l on l.sucursal_id = t.sucursal_id and l.tipo = 'bolsa_visitas'
    join conteo_efectivo c on c.turno_id = t.id and c.lugar_id = l.id and c.momento = 'apertura'
    left join movimiento_efectivo m on m.turno_id = t.id and m.lugar_id = l.id and m.en <= ${e.creada_en}
    where t.id = ${e.turno_id}
    group by t.abierto_en, u.nombre, c.importe`;
  const centavos = (v: string) => Math.round(Number(v) * 100);
  const calculado = ((centavos(d.contado) + centavos(d.importe_cobros) + centavos(d.importe_cancelaciones) + centavos(d.importe_retiros)) / 100).toFixed(2);

  const difs = (await DIFERENCIAS(sql, [e.id])).map(aDiferencia);
  const [n] = await sql<{ nivel: NivelRevision; puede: boolean; resuelve: boolean }[]>`
    select nivel_revision_entrega(${e.id}) as nivel,
           tiene_permiso(${usuarioId}, 'diferencia.revisar', ${s.id})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${s.id}) r where r = nivel_revision_entrega(${e.id})) as puede,
           tiene_permiso(${usuarioId}, 'diferencia.resolver', ${s.id})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${s.id}) r where r = 'direccion') as resuelve`;
  const [{ participaste }] = await sql<{ participaste: boolean }[]>`
    select ${usuarioId}::uuid in (select participantes_entrega(${e.id})) as participaste`;
  const recuento = await sql<{ en: Date }[]>`
    select en from historial_cambio where entidad = 'entrega_turno' and entidad_id = ${e.id} and accion = 'conteo_no_coincide'`;
  const declaraciones = await sql<{ etapa: EtapaApoyo; hubo: boolean; por: string; en: Date }[]>`
    select d.etapa, d.hubo_apoyo as hubo, u.nombre as por, d.en from declaracion_apoyo d join usuario u on u.id = d.declarado_por
    where d.entrega_id = ${e.id}`;
  const personasApoyo = await sql<{ etapa: EtapaApoyo; nombre: string; declarado_en: Date; confirmado_en: Date | null; por: string }[]>`
    select a.etapa, u.nombre, a.declarado_en, a.confirmado_en, d.nombre as por
    from apoyo_conteo a join usuario u on u.id = a.usuario_id join usuario d on d.id = a.declarado_por
    where a.entrega_id = ${e.id} order by a.declarado_en, u.nombre`;
  const etapas: EtapaApoyo[] = ["conteo_entrega", "conteo_recepcion", ...(recuento.length ? (["recuento"] as const) : [])];
  const apoyos: ApoyoEtapa[] = etapas.map((etapa) => {
    const d = declaraciones.find((x) => x.etapa === etapa);
    return {
      etapa, estado: !d ? "sin_registro" : d.hubo ? "con_apoyo" : "nadie", declaradoPor: d?.por ?? null, declaradoEn: d?.en ?? null,
      personas: personasApoyo.filter((p) => p.etapa === etapa).map((p) => ({ nombre: p.nombre, confirmadoEn: p.confirmado_en })),
    };
  });
  const ETAPA = { conteo_entrega: "conteo de quien entregó", conteo_recepcion: "conteo de quien recibió", recuento: "recuento" } as const;
  const LUGAR = { bolsa_visitas: "bolsa", cajon_mensualidades: "cajón" } as const;
  const cual = (d: Diferencia) => `${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : "en la entrega"}`;
  const DECISION = { absorbe_sucursal: "Lo absorbe la sucursal", queda_en_bolsa: "Se queda en la bolsa", origen_identificado: "Origen identificado" } as const;
  const RESULTADO = { aclarada: "Aclarada", faltante_confirmado: "Faltante confirmado", sobrante_confirmado: "Sobrante confirmado" } as const;
  const dinero = (v: string) => (Number(v) < 0 ? "−" : "+") + "$" + Math.abs(Number(v)).toLocaleString("es-MX", { minimumFractionDigits: 2 });
  const historial: EventoCaso[] = [
    { en: e.creada_en, que: "Entrega registrada (conteo de quien entrega)", cuenta: e.entrega_por },
    ...recuento.map((r) => ({ en: r.en, que: "El primer conteo de quien recibe no coincidió: recuento", cuenta: e.recibe })),
    { en: e.resuelta_en, que: "Recepción confirmada desde su propia cuenta", cuenta: e.recibe },
    ...declaraciones.filter((d) => !d.hubo).map((d) => ({ en: d.en, que: `Apoyo en el ${ETAPA[d.etapa]}: nadie más participó`, cuenta: d.por })),
    ...personasApoyo.map((p) => ({ en: p.declarado_en, que: `Apoyo declarado en el ${ETAPA[p.etapa]}: ${p.nombre}`, cuenta: p.por })),
    ...personasApoyo.filter((p) => p.confirmado_en).map((p) => ({ en: p.confirmado_en!, que: `Apoyo confirmado en el ${ETAPA[p.etapa]}`, cuenta: p.nombre })),
    ...difs.map((d) => ({ en: d.registradaEn, que: `Diferencia registrada (${LUGAR[d.lugar]}): ${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : "en la entrega"}`, cuenta: "La plataforma, al confirmar" })),
    ...difs.filter((d) => d.revision).map((d) => ({
      en: d.revision!.en,
      que: `Revisión (${LUGAR[d.lugar]}, ${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : "en la entrega"}): ${RESULTADO[d.revision!.resultado]}. Motivo: «${d.revision!.motivo}»`,
      cuenta: d.revision!.revisadaPor,
    })),
    ...difs.filter((d) => d.resolucion).map((d) => ({
      en: d.resolucion!.en,
      que: `Resolución de Dirección (${LUGAR[d.lugar]}, ${cual(d)}): ${DECISION[d.resolucion!.decision]}${d.resolucion!.origen ? `. Origen: «${d.resolucion!.origen}»` : ""}${d.resolucion!.requiereCorreccion ? " · corrección pendiente" : ""}. Motivo: «${d.resolucion!.motivo}»`,
      cuenta: d.resolucion!.resueltaPor,
    })),
    ...difs.filter((d) => d.resolucion?.correccion).map((d) => ({
      en: d.resolucion!.correccion!.en,
      que: `Corrección registrada (${LUGAR[d.lugar]}, ${cual(d)}): «${d.resolucion!.correccion!.texto}» · referencia ${d.resolucion!.correccion!.referencia.tipo} ${d.resolucion!.correccion!.referencia.id}`,
      cuenta: d.resolucion!.correccion!.por,
    })),
    ...difs.filter((d) => d.estado === "resuelta").map((d) => ({
      en: d.resolucion!.correccion?.en ?? d.resolucion!.en,
      que: `Seguimiento cerrado (${LUGAR[d.lugar]}, ${cual(d)})`,
      cuenta: "La plataforma",
    })),
  ].sort((a, b) => a.en.getTime() - b.en.getTime());
  return {
    sucursal: s.nombre, entregaId: e.id, entregaPor: e.entrega_por, recibe: e.recibe, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en,
    nota: e.nota, aclaracion: e.aclaracion, participaste, nivel: n.nivel, puedeRevisar: n.puede && !participaste, puedeResolver: n.resuelve && !participaste, historial, apoyos,
    lugares: { bolsa_visitas: cifras("bolsa_visitas"), cajon_mensualidades: cifras("cajon_mensualidades") },
    diferencias: difs,
    desglose: {
      abiertoEn: d.abierto_en, abiertoPor: d.abierto_por, contadoAlAbrir: d.contado,
      cobros: { cuantos: d.cobros, visitas: d.visitas, importe: d.importe_cobros },
      cancelaciones: { cuantas: d.cancelaciones, importe: d.importe_cancelaciones },
      retiros: { cuantos: d.retiros, importe: d.importe_retiros }, calculado,
    },
    fueraDeLaBolsa: ventasDelTurno(await cobrosDelTurno(sql, e.turno_id)),
  };
}

/** Cuántas diferencias siguen por revisar en la sucursal (para el botón de la sucursal). null sin permiso. */
export async function pendientesDeRevision(sql: Sql, usuarioId: string, sucursalId: string): Promise<number | null> {
  // Por revisar; y, para quien resuelve como Dirección, también lo que espera su resolución o una corrección.
  const [r] = await sql<{ puede: boolean; n: number }[]>`
    select tiene_permiso(${usuarioId}, 'diferencia.consultar', ${sucursalId}) as puede,
           (select count(*)::int from diferencia_efectivo d join turno t on t.id = d.turno_id
            left join revision_diferencia rv on rv.diferencia_id = d.id left join resolucion_diferencia x on x.diferencia_id = d.id
            where t.sucursal_id = ${sucursalId}
              and (rv.id is null
                   or (tiene_permiso(${usuarioId}, 'diferencia.resolver', ${sucursalId})
                       and rv.resultado in ('faltante_confirmado', 'sobrante_confirmado')
                       and (x.id is null or (x.requiere_correccion and x.correccion is null))))) as n`;
  return r.puede ? r.n : null;
}

export type ErrorRevision =
  | "no_encontrada" | "sin_permiso" | "participaste" | "otro_nivel" | "ya_revisada" | "resultado" | "motivo" | "bloqueado_produccion";

/**
 * Registra el resultado de UNA diferencia. Comprueba en el servidor (y la base lo respalda) que el resultado
 * corresponde al signo, que quien revisa tiene el perfil que toca según la participación y que no participó.
 * Solo agrega la revisión y su historial: no cambia ningún importe.
 */
export async function revisarDiferencia(
  sql: Sql,
  usuarioId: string,
  codigo: string,
  datos: { diferenciaId: string; resultado: string; motivo: string },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string } | { ok: false; error: ErrorRevision }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(datos.diferenciaId)) return { ok: false, error: "no_encontrada" };
  const motivo = datos.motivo.trim().replace(/\s+/g, " ");
  if (!["aclarada", "faltante_confirmado", "sobrante_confirmado"].includes(datos.resultado)) return { ok: false, error: "resultado" };
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  try {
    return await sql.begin(async (tx) => {
      const [d] = await tx<{ entrega_id: string; importe: string; sucursal_id: string; entrega_por: string; recibe: string;
                             consulta: boolean; revisa: boolean; nivel: NivelRevision; tiene_nivel: boolean; revisada: boolean; participo: boolean }[]>`
        select df.entrega_id, df.importe::text as importe, t.sucursal_id, e.entrega_por, e.recibe,
               tiene_permiso(${usuarioId}, 'diferencia.consultar', t.sucursal_id) as consulta,
               tiene_permiso(${usuarioId}, 'diferencia.revisar', t.sucursal_id) as revisa,
               nivel_revision_entrega(e.id) as nivel,
               exists (select 1 from perfiles_en_sucursal(${usuarioId}, t.sucursal_id) r where r = nivel_revision_entrega(e.id)) as tiene_nivel,
               exists (select 1 from revision_diferencia r where r.diferencia_id = df.id) as revisada,
               ${usuarioId}::uuid in (select participantes_entrega(e.id)) as participo
        from diferencia_efectivo df join entrega_turno e on e.id = df.entrega_id join turno t on t.id = e.turno_id
        join sucursal s on s.id = t.sucursal_id
        where df.id = ${datos.diferenciaId} and s.codigo = ${codigo}
        for update of df`;
      if (!d || !d.consulta) return { ok: false as const, error: "no_encontrada" as const };
      if (!d.revisa) return { ok: false as const, error: "sin_permiso" as const };
      // Participó quien entregó, quien recibió o quien fue declarado como apoyo (aunque todavía no confirme).
      if (d.participo) return { ok: false as const, error: "participaste" as const };
      if (!d.tiene_nivel) return { ok: false as const, error: "otro_nivel" as const };
      if (d.revisada) return { ok: false as const, error: "ya_revisada" as const };
      const negativo = Number(d.importe) < 0;
      if ((datos.resultado === "faltante_confirmado" && !negativo) || (datos.resultado === "sobrante_confirmado" && negativo)) {
        return { ok: false as const, error: "resultado" as const };
      }
      const [r] = await tx<{ id: string }[]>`
        insert into revision_diferencia (diferencia_id, resultado, motivo, nivel, revisada_por)
        values (${datos.diferenciaId}, ${datos.resultado}, ${motivo}, ${d.nivel}, ${usuarioId}) returning id`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values ('diferencia_efectivo', ${datos.diferenciaId}, 'revisar',
                       ${tx.json({ revision: r.id, resultado: datos.resultado, nivel: d.nivel, importe: d.importe })}, ${motivo}, ${usuarioId})`;
      return { ok: true as const, entregaId: d.entrega_id };
    });
  } catch (error) {
    // Dos revisiones simultáneas de la misma diferencia: la base deja pasar solo una.
    if ((error as { code?: string })?.code === "23505") return { ok: false, error: "ya_revisada" };
    throw error;
  }
}

export type ErrorResolucion =
  | "no_encontrada" | "sin_permiso" | "participaste" | "no_pendiente" | "ya_resuelta" | "decision" | "motivo" | "origen" | "correccion"
  | "referencia" | "referencia_no_verificable" | "bloqueado_produccion";

/**
 * Tipos de registro que pueden servir como corrección de un sobrante. Hoy ninguno: la plataforma no tiene todavía un
 * flujo para registrar esa corrección (por ejemplo, regularizar un cobro sin volver a sumar el efectivo). Mientras
 * tanto ninguna referencia es verificable y el caso sigue pendiente. La base aplica la misma regla.
 */
export const TIPOS_REFERENCIA_CORRECCION: readonly string[] = [];

const texto = (v: string) => v.trim().replace(/\s+/g, " ");

async function diferenciaParaDireccion(tx: Tx, usuarioId: string, codigo: string, diferenciaId: string) {
  const [d] = await tx<{ entrega_id: string; resultado: string | null; consulta: boolean; resuelve: boolean; participo: boolean;
                         resolucion: string | null; requiere: boolean | null; corregida: boolean | null }[]>`
    select df.entrega_id, rv.resultado,
           tiene_permiso(${usuarioId}, 'diferencia.consultar', t.sucursal_id) as consulta,
           tiene_permiso(${usuarioId}, 'diferencia.resolver', t.sucursal_id)
             and exists (select 1 from perfiles_en_sucursal(${usuarioId}, t.sucursal_id) r where r = 'direccion') as resuelve,
           ${usuarioId}::uuid in (select participantes_entrega(df.entrega_id)) as participo,
           x.id as resolucion, x.requiere_correccion as requiere, x.correccion is not null as corregida
    from diferencia_efectivo df join turno t on t.id = df.turno_id join sucursal s on s.id = t.sucursal_id
    left join revision_diferencia rv on rv.diferencia_id = df.id left join resolucion_diferencia x on x.diferencia_id = df.id
    where df.id = ${diferenciaId} and s.codigo = ${codigo}
    for update of df`;
  if (!d || !d.consulta) return { ok: false as const, error: "no_encontrada" as const };
  if (!d.resuelve) return { ok: false as const, error: "sin_permiso" as const };
  if (d.participo) return { ok: false as const, error: "participaste" as const };
  return { ok: true as const, d };
}

/**
 * Dirección resuelve un faltante o sobrante confirmado. Faltante: «Lo absorbe la sucursal» (cierra). Sobrante: «Se queda
 * en la bolsa» (cierra) u «Origen identificado», con o sin corrección pendiente. Motivo obligatorio. No cambia importes.
 */
export async function resolverDiferencia(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { diferenciaId: string; decision: string; motivo: string; origen?: string; requiereCorreccion?: boolean },
  { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string } | { ok: false; error: ErrorResolucion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(datos.diferenciaId)) return { ok: false, error: "no_encontrada" };
  if (!["absorbe_sucursal", "queda_en_bolsa", "origen_identificado"].includes(datos.decision)) return { ok: false, error: "decision" };
  const motivo = texto(datos.motivo);
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  const origen = datos.decision === "origen_identificado" ? texto(datos.origen ?? "") : null;
  if (origen !== null && (origen.length < 5 || origen.length > 300)) return { ok: false, error: "origen" };
  const requiere = datos.decision === "origen_identificado" && !!datos.requiereCorreccion;
  try {
    return await sql.begin(async (tx) => {
      const c = await diferenciaParaDireccion(tx, usuarioId, codigo, datos.diferenciaId);
      if (!c.ok) return c;
      if (c.d.resolucion) return { ok: false as const, error: "ya_resuelta" as const };
      if (c.d.resultado !== "faltante_confirmado" && c.d.resultado !== "sobrante_confirmado") return { ok: false as const, error: "no_pendiente" as const };
      if ((datos.decision === "absorbe_sucursal") !== (c.d.resultado === "faltante_confirmado")) return { ok: false as const, error: "decision" as const };
      const [x] = await tx<{ id: string }[]>`
        insert into resolucion_diferencia (diferencia_id, decision, motivo, origen, requiere_correccion, resuelta_por)
        values (${datos.diferenciaId}, ${datos.decision}, ${motivo}, ${origen}, ${requiere}, ${usuarioId}) returning id`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values ('diferencia_efectivo', ${datos.diferenciaId}, 'resolver',
                       ${tx.json({ resolucion: x.id, decision: datos.decision, origen, requiere_correccion: requiere })}, ${motivo}, ${usuarioId})`;
      return { ok: true as const, entregaId: c.d.entrega_id };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return { ok: false, error: "ya_resuelta" };
    throw error;
  }
}

/**
 * Cierra un sobrante con corrección pendiente. Pide una descripción y una referencia verificable al registro de la
 * corrección (tipo y folio de un registro existente); ambas quedan en el historial. Una nota sola no cierra. Si la
 * referencia no se puede verificar (hoy, ningún tipo existe), el caso sigue pendiente.
 */
export async function registrarCorreccion(
  sql: Sql, usuarioId: string, codigo: string,
  datos: { diferenciaId: string; correccion: string; referenciaTipo: string; referenciaId: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string } | { ok: false; error: ErrorResolucion }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(datos.diferenciaId)) return { ok: false, error: "no_encontrada" };
  const correccion = texto(datos.correccion);
  if (correccion.length < 5 || correccion.length > 300) return { ok: false, error: "correccion" };
  const referenciaId = texto(datos.referenciaId);
  if (!datos.referenciaTipo || !referenciaId) return { ok: false, error: "referencia" };

  return sql.begin(async (tx) => {
    const c = await diferenciaParaDireccion(tx, usuarioId, codigo, datos.diferenciaId);
    if (!c.ok) return c;
    if (!c.d.resolucion || !c.d.requiere || c.d.corregida) return { ok: false as const, error: "no_pendiente" as const };
    if (!TIPOS_REFERENCIA_CORRECCION.includes(datos.referenciaTipo) || referenciaId.length > 80) {
      return { ok: false as const, error: "referencia_no_verificable" as const };
    }
    const [{ valida }] = await tx<{ valida: boolean }[]>`
      select referencia_correccion_valida(${datos.referenciaTipo}, ${referenciaId}, ${datos.diferenciaId}) as valida`;
    if (!valida) return { ok: false as const, error: "referencia_no_verificable" as const };
    await tx`update resolucion_diferencia set correccion = ${correccion}, correccion_ref_tipo = ${datos.referenciaTipo},
             correccion_ref_id = ${referenciaId}, correccion_por = ${usuarioId}, correccion_en = now()
             where diferencia_id = ${datos.diferenciaId}`;
    await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, usuario_id)
             values ('diferencia_efectivo', ${datos.diferenciaId}, 'registrar_correccion',
                     ${tx.json({ correccion, referencia_tipo: datos.referenciaTipo, referencia_id: referenciaId })}, ${usuarioId})`;
    return { ok: true as const, entregaId: c.d.entrega_id };
  });
}
