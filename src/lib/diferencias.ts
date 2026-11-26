import type postgres from "postgres";
import type { Entorno } from "@/lib/entorno";
import { esIdentificadorValido } from "@/lib/permisos";
import { conteoSeparado, sobresDelCierre, type ConteoSeparado } from "@/lib/cierres";
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
/** propia: la revisó quien participó, con su autorización personal (queda marcada para siempre). */
export type Revision = { resultado: ResultadoRevision; motivo: string; revisadaPor: string; nivel: NivelRevision; en: Date; propia: boolean };
export type Diferencia = {
  id: string; lugar: TipoLugar; tipo: TipoDiferencia; importe: string; estado: EstadoDiferencia; registradaEn: Date;
  /** Clave fija del caso (TEN-D7) y cuándo se asignó. */
  clave: string | null; claveAsignadaEn: Date | null; claveCasoExistente: boolean;
  revision: Revision | null;
  resolucion: Resolucion | null;
  /** Desde cuándo espera a Dirección (confirmado o con corrección pendiente); null si no está pendiente para Dirección. */
  pendienteDireccionDesde: Date | null;
};

/** Incidencia de un cierre (custodia sin confirmar o sobre con problema): queda por revisar aunque el efectivo cuadre. */
export type IncidenciaCierre = {
  id: string;
  tipo: "custodia_sin_confirmar" | "sobre_en_custodia" | "sobre_al_abrir" | "fondo_incompleto" | "llave_custodia" | "sobre_caja" | "llave_caja" | "llave_cajon";
  /** Texto de la incidencia: el motivo de abrir sin custodia, o el sobre, cómo llegó y el motivo. */
  detalle: string;
  registradaEn: Date;
  revision: { motivo: string; revisadaPor: string; nivel: NivelRevision; en: Date; propia: boolean } | null;
};

const INCIDENCIAS = (sql: Sql | Tx, entregaIds: string[]) => sql<{
  id: string; entrega_id: string; tipo: IncidenciaCierre["tipo"]; registrada_en: Date; motivo_sin_custodia: string | null;
  folio: string | null; estado: string | null; folio_visto: string | null; motivo_sobre: string | null; por: string | null;
  r_motivo: string | null; r_por: string | null; r_nivel: NivelRevision | null; r_en: Date | null; r_propia: boolean | null;
  lugar: TipoLugar | null; fondo: string | null; fondo_monto: string | null; motivo_llave: string | null; custodio: string | null;
  rc_motivo: string | null; rc_motivo_cajon: string | null; rc_por: string | null }[]>`
  select i.id, i.entrega_id, i.tipo, i.registrada_en, a.motivo as motivo_sin_custodia,
         li.tipo as lugar, cf.fondo::text as fondo, cf.fondo_monto::text as fondo_monto, cc.motivo_llave, uc.nombre as custodio,
         s.folio, v.estado, v.folio_visto, v.motivo as motivo_sobre, u.nombre as por,
         r.motivo as r_motivo, ru.nombre as r_por, r.nivel as r_nivel, r.en as r_en, r.autorrevision_id is not null as r_propia, rc.motivo_llave as rc_motivo, rc.motivo_llave_cajon as rc_motivo_cajon, rcu.nombre as rc_por
  from incidencia_cierre i
  left join revision_caja rc on rc.id = i.revision_id left join usuario rcu on rcu.id = rc.por
  left join apertura_sin_custodia a on a.entrega_id = i.entrega_id and i.tipo = 'custodia_sin_confirmar'
  left join verificacion_sobre v on v.id = i.verificacion_id left join sobre_cierre s on s.id = v.sobre_id
  left join usuario u on u.id = v.verificado_por
  left join lugar_efectivo li on li.id = i.lugar_id
  left join conteo_fondo cf on cf.entrega_id = i.entrega_id and cf.lugar_id = i.lugar_id and cf.momento = 'cierre'
  left join custodia_cierre cc on cc.entrega_id = i.entrega_id and i.tipo = 'llave_custodia'
  left join usuario uc on uc.id = cc.custodio_id
  left join revision_incidencia r on r.incidencia_id = i.id left join usuario ru on ru.id = r.revisada_por
  where i.entrega_id in ${sql(entregaIds)}
  order by i.registrada_en, case i.tipo when 'custodia_sin_confirmar' then 0 when 'llave_custodia' then 1 when 'sobre_en_custodia' then 2
                                         when 'sobre_al_abrir' then 3 else 4 end, s.folio, li.tipo`;
const pesosMx = (v: string) => "$" + Number(v).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COMO = { falta: "no está", abierto: "abierto o con el sello roto", otro_folio: "con otro folio" } as Record<string, string>;
function aIncidencia(f: Awaited<ReturnType<typeof INCIDENCIAS>>[number]): IncidenciaCierre {
  const detalle = f.tipo === "custodia_sin_confirmar"
    ? `Se abrió sin la confirmación del custodio. Motivo: «${f.motivo_sin_custodia}»`
    : f.tipo === "fondo_incompleto"
    ? `Fondo ${f.lugar === "bolsa_visitas" ? "de la bolsa de visitas" : "del cajón de mensualidades"} incompleto al cerrar: ${pesosMx(f.fondo!)} contados de ${pesosMx(f.fondo_monto!)}`
    : f.tipo === "llave_custodia"
    ? `Llave o cajón en la custodia (${f.custodio}). Motivo: «${f.motivo_llave}»`
    : f.tipo === "llave_caja"
    ? `Llave de la caja de sobres (${f.rc_por}). Motivo: «${f.rc_motivo}»`
    : f.tipo === "llave_cajon"
    ? `Llave del cajón de los fondos al recibir la custodia (${f.rc_por}). Motivo: «${f.rc_motivo_cajon}»`
    : `${f.tipo === "sobre_en_custodia" ? "Custodia" : f.tipo === "sobre_caja" ? "Caja de sobres" : "Al abrir"} (${f.por}): sobre ${f.folio} ${COMO[f.estado!]}${f.folio_visto ? ` (${f.folio_visto})` : ""}. Motivo: «${f.motivo_sobre}»`;
  return {
    id: f.id, tipo: f.tipo, detalle, registradaEn: f.registrada_en,
    revision: f.r_motivo ? { motivo: f.r_motivo, revisadaPor: f.r_por!, nivel: f.r_nivel!, en: f.r_en!, propia: Boolean(f.r_propia) } : null,
  };
}

export type CasoLista = {
  entregaId: string;
  /** «cierre»: diferencia entre el cierre del día y la apertura siguiente (entregaPor cerró, recibe abrió). */
  tipo: "cambio_turno" | "cierre";
  entregadaEn: Date;
  confirmadaEn: Date;
  entregaPor: string;
  recibe: string;
  diferencias: Diferencia[];
  /** Incidencias del cierre (vacío en un cambio de turno). */
  incidencias: IncidenciaCierre[];
  /** Diferencias e incidencias de esta entrega que siguen por revisar. */
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
  resultado: ResultadoRevision | null; motivo: string | null; revisor: string | null; nivel: NivelRevision | null; revisada_en: Date | null; propia: boolean | null;
  decision: DecisionDireccion | null; motivo_dir: string | null; origen: string | null; requiere_correccion: boolean | null;
  resolutor: string | null; resuelta_en: Date | null; correccion: string | null; corrector: string | null; correccion_en: Date | null;
  correccion_ref_tipo: string | null; correccion_ref_id: string | null;
  clave: string | null; clave_en: Date | null; clave_existente: boolean | null;
};
const DIFERENCIAS = (sql: Sql | Tx, entregaIds: string[]) => sql<FilaDiferencia[]>`
  select d.id, d.entrega_id, l.tipo as lugar, d.tipo, d.importe::text as importe, d.registrada_en,
         r.resultado, r.motivo, u.nombre as revisor, r.nivel, r.en as revisada_en, r.autorrevision_id is not null as propia,
         x.decision, x.motivo as motivo_dir, x.origen, x.requiere_correccion, ux.nombre as resolutor, x.en as resuelta_en,
         x.correccion, uc.nombre as corrector, x.correccion_en, x.correccion_ref_tipo, x.correccion_ref_id,
         k.clave, k.asignada_en as clave_en, k.origen = 'casos_existentes' as clave_existente
  from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
  left join clave_diferencia k on k.clase = 'turno' and k.caso_id = d.id
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
    clave: d.clave, claveAsignadaEn: d.clave_en, claveCasoExistente: Boolean(d.clave_existente),
    revision: d.resultado ? { resultado: d.resultado, motivo: d.motivo!, revisadaPor: d.revisor!, nivel: d.nivel!, en: d.revisada_en!, propia: Boolean(d.propia) } : null,
    pendienteDireccionDesde: estado === "faltante_confirmado" || estado === "sobrante_confirmado" || estado === "correccion_pendiente" ? d.revisada_en : null,
  };
};

/** Entregas confirmadas de la sucursal: primero las que tienen diferencias por revisar; después, las más recientes. */
export async function listaDiferencias(sql: Sql, usuarioId: string, codigo: string): Promise<{ sucursal: string; casos: CasoLista[] } | null> {
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const entregas = await sql<{ id: string; tipo: CasoLista["tipo"]; creada_en: Date; resuelta_en: Date; entrega_por: string; recibe: string }[]>`
    select e.id, e.tipo, e.creada_en, e.resuelta_en, a.nombre as entrega_por, b.nombre as recibe
    from entrega_turno e join turno t on t.id = e.turno_id
    join usuario a on a.id = e.entrega_por join usuario b on b.id = e.recibe
    where t.sucursal_id = ${s.id} and e.estado = 'confirmada'
    order by e.resuelta_en desc
    limit 200`;
  const difs = entregas.length ? await DIFERENCIAS(sql, entregas.map((e) => e.id)) : [];
  const incs = entregas.length ? await INCIDENCIAS(sql, entregas.map((e) => e.id)) : [];
  const casos = entregas.map((e): CasoLista => {
    const diferencias = difs.filter((d) => d.entrega_id === e.id).map(aDiferencia);
    const neto = diferencias.filter((d) => d.lugar === "bolsa_visitas").reduce((suma, d) => suma + Math.round(Number(d.importe) * 100), 0);
    return {
      entregaId: e.id, tipo: e.tipo, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en, entregaPor: e.entrega_por, recibe: e.recibe,
      diferencias, incidencias: incs.filter((i) => i.entrega_id === e.id).map(aIncidencia),
      pendientes: diferencias.filter((d) => d.estado === "por_revisar").length + incs.filter((i) => i.entrega_id === e.id && !i.r_motivo).length,
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
  /** Entradas al fondo fijo recibidas (aumentos y reposiciones). */
  fondos: { cuantas: number; importe: string };
  /** Salida al sobre guardado en la caja al cerrar (negativo; solo con sobres guardados). */
  sobres: { cuantos: number; importe: string };
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

export type VerificacionSobre = { estado: "correcto" | "falta" | "abierto" | "otro_folio"; folioVisto: string | null; motivo: string | null; por: string; en: Date };
/** Lo propio de un cierre del día: custodio, configuración copiada al cerrar, custodia y verificación de cada sobre. */
export type DatosCierre = {
  custodio: string;
  configuracion: { lugar: string; acceso: string[]; configuradaPor: string; en: Date };
  custodia: { ubicacion: string; en: Date } | null;
  sobres: { lugar: TipoLugar; folio: string; custodia: VerificacionSobre | null; apertura: VerificacionSobre | null }[];
  /** Quien cerró también abrió. */
  mismaPersona: boolean;
  /** Quien cerró quedó como custodio (una sola cuenta con Recepción y Encargado). */
  cerroYCustodio: boolean;
  /** El custodio abrió. */
  custodioAbrio: boolean;
  recontadoConCustodio: boolean;
  /** Dónde quedaron los fondos, quién tenía acceso al cajón y cómo quedó la llave al confirmar la custodia. */
  cajon: { lugarFondos: string | null; acceso: string[]; llave: "correcta" | "incidencia" | null; motivoLlave: string | null };
  /** Fondo y sobre contados por separado (cierre, primer conteo y recuento al abrir). */
  fondos: ConteoSeparado;
};

export type DetalleDiferencias = {
  sucursal: string;
  entregaId: string;
  tipo: "cambio_turno" | "cierre";
  cierre: DatosCierre | null;
  entregaPor: string;
  recibe: string;
  entregadaEn: Date;
  confirmadaEn: Date;
  nota: string | null;
  aclaracion: string | null;
  /** La cuenta que consulta contó, entregó o recibió en esta entrega. */
  participaste: boolean;
  /** Participó, pero tiene autorización personal vigente para revisar lo propio (la revisión queda marcada). */
  revisarasPropia: boolean;
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
  incidencias: IncidenciaCierre[];
  desglose: Desglose;
  fueraDeLaBolsa: VentasTurno;
  /**
   * Diferencias contra el esperado registradas al retirar en el turno, vinculadas a esta entrega: la parte que sigue
   * presente forma parte de la diferencia contra el esperado de la entrega (el mismo caso, no otro).
   */
  deRetiros: { retiroId: string; folio: string; importe: string; presente: string; en: Date }[];
};

export async function detalleDiferencias(sql: Sql, usuarioId: string, codigo: string, entregaId: string): Promise<DetalleDiferencias | null> {
  if (!esIdentificadorValido(entregaId)) return null;
  const s = await sucursalConsultable(sql, usuarioId, codigo);
  if (!s) return null;
  const [e] = await sql<{ id: string; turno_id: string; creada_en: Date; resuelta_en: Date; nota: string | null; aclaracion: string | null;
                          entrega_por: string; entrega_por_id: string; recibe: string; recibe_id: string; tipo: "cambio_turno" | "cierre";
                          recontado_con: string | null }[]>`
    select e.id, e.turno_id, e.creada_en, e.resuelta_en, e.nota, e.aclaracion, e.tipo, e.recontado_con,
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
                          cancelaciones: number; importe_cancelaciones: string; retiros: number; importe_retiros: string;
                          fondos: number; importe_fondos: string; sobres: number; importe_sobres: string }[]>`
    select t.abierto_en, u.nombre as abierto_por, c.importe::text as contado,
           (count(m.id) filter (where m.tipo = 'entrada_cobro_visita'))::int as cobros,
           coalesce(sum((select count(*) from pase_visita p join cobro_visita cv on cv.operacion_id = p.operacion_id where cv.id = m.cobro_id))
                    filter (where m.tipo = 'entrada_cobro_visita'), 0)::int as visitas,
           coalesce(sum(m.importe) filter (where m.tipo = 'entrada_cobro_visita'), 0)::numeric(12, 2)::text as importe_cobros,
           (count(m.id) filter (where m.tipo = 'ajuste_cancelacion_cobro'))::int as cancelaciones,
           coalesce(sum(m.importe) filter (where m.tipo = 'ajuste_cancelacion_cobro'), 0)::numeric(12, 2)::text as importe_cancelaciones,
           (count(m.id) filter (where m.tipo = 'salida_retiro'))::int as retiros,
           coalesce(sum(m.importe) filter (where m.tipo = 'salida_retiro'), 0)::numeric(12, 2)::text as importe_retiros,
           (count(m.id) filter (where m.tipo = 'entrada_fondo'))::int as fondos,
           coalesce(sum(m.importe) filter (where m.tipo = 'entrada_fondo'), 0)::numeric(12, 2)::text as importe_fondos,
           (count(m.id) filter (where m.tipo = 'salida_sobre'))::int as sobres,
           coalesce(sum(m.importe) filter (where m.tipo = 'salida_sobre'), 0)::numeric(12, 2)::text as importe_sobres
    from turno t join usuario u on u.id = t.abierto_por
    join lugar_efectivo l on l.sucursal_id = t.sucursal_id and l.tipo = 'bolsa_visitas'
    join conteo_efectivo c on c.turno_id = t.id and c.lugar_id = l.id and c.momento = 'apertura'
    left join movimiento_efectivo m on m.turno_id = t.id and m.lugar_id = l.id and m.en <= ${e.creada_en}
    where t.id = ${e.turno_id}
    group by t.abierto_en, u.nombre, c.importe`;
  const centavos = (v: string) => Math.round(Number(v) * 100);
  const calculado = ((centavos(d.contado) + centavos(d.importe_cobros) + centavos(d.importe_cancelaciones) + centavos(d.importe_retiros) + centavos(d.importe_fondos)
                     + centavos(d.importe_sobres)) / 100).toFixed(2);

  const difs = (await DIFERENCIAS(sql, [e.id])).map(aDiferencia);
  const incidencias = (await INCIDENCIAS(sql, [e.id])).map(aIncidencia);
  const [n] = await sql<{ nivel: NivelRevision; puede: boolean; resuelve: boolean }[]>`
    select nivel_revision_entrega(${e.id}) as nivel,
           tiene_permiso(${usuarioId}, 'diferencia.revisar', ${s.id})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${s.id}) r where r = nivel_revision_entrega(${e.id})) as puede,
           tiene_permiso(${usuarioId}, 'diferencia.resolver', ${s.id})
           and exists (select 1 from perfiles_en_sucursal(${usuarioId}, ${s.id}) r where r = 'direccion') as resuelve`;
  const [{ participaste, autorrevision }] = await sql<{ participaste: boolean; autorrevision: string | null }[]>`
    select ${usuarioId}::uuid in (select participantes_entrega(${e.id})) as participaste, autorrevision_vigente(${usuarioId}, ${s.id}) as autorrevision`;
  const revisaPropia = participaste && autorrevision !== null;
  const recuento = await sql<{ en: Date }[]>`
    select en from historial_cambio where entidad = 'entrega_turno' and entidad_id = ${e.id} and accion = 'conteo_no_coincide'`;
  const declaraciones = await sql<{ etapa: EtapaApoyo; hubo: boolean; por: string; en: Date }[]>`
    select d.etapa, d.hubo_apoyo as hubo, u.nombre as por, d.en from declaracion_apoyo d join usuario u on u.id = d.declarado_por
    where d.entrega_id = ${e.id}`;
  const personasApoyo = await sql<{ etapa: EtapaApoyo; nombre: string; declarado_en: Date; confirmado_en: Date | null; por: string }[]>`
    select a.etapa, u.nombre, a.declarado_en, a.confirmado_en, d.nombre as por
    from apoyo_conteo a join usuario u on u.id = a.usuario_id join usuario d on d.id = a.declarado_por
    where a.entrega_id = ${e.id} order by a.declarado_en, u.nombre`;
  // En un cierre, el recuento es con el custodio (queda en recontado_con); no lleva declaración de apoyo aparte.
  const etapas: EtapaApoyo[] = ["conteo_entrega", "conteo_recepcion", ...(recuento.length && e.tipo !== "cierre" ? (["recuento"] as const) : [])];
  const apoyos: ApoyoEtapa[] = etapas.map((etapa) => {
    const d = declaraciones.find((x) => x.etapa === etapa);
    return {
      etapa, estado: !d ? "sin_registro" : d.hubo ? "con_apoyo" : "nadie", declaradoPor: d?.por ?? null, declaradoEn: d?.en ?? null,
      personas: personasApoyo.filter((p) => p.etapa === etapa).map((p) => ({ nombre: p.nombre, confirmadoEn: p.confirmado_en })),
    };
  });
  let cierre: DatosCierre | null = null;
  if (e.tipo === "cierre") {
    const [c] = await sql<{ custodio: string; custodio_id: string; lugar: string; acceso: string[]; por: string; en: Date; ubicacion: string | null;
                            confirmada_en: Date | null; lugar_fondos: string | null; acceso_cajon: string[]; llave: "correcta" | "incidencia" | null;
                            motivo_llave: string | null }[]>`
      select u.nombre as custodio, u.id as custodio_id, k.lugar, array(select x.nombre from usuario x where x.id = any(k.acceso) order by x.nombre) as acceso,
             d.nombre as por, k.en, cc.ubicacion, cc.confirmada_en, k.lugar_fondos,
             array(select x.nombre from usuario x where x.id = any(k.acceso_cajon) order by x.nombre) as acceso_cajon, cc.llave, cc.motivo_llave
      from entrega_turno e join usuario u on u.id = e.custodio_id join custodia_configuracion k on k.id = e.custodia_config_id
      join usuario d on d.id = k.configurada_por left join custodia_cierre cc on cc.entrega_id = e.id where e.id = ${e.id}`;
    cierre = {
      custodio: c.custodio, configuracion: { lugar: c.lugar, acceso: c.acceso, configuradaPor: c.por, en: c.en },
      custodia: c.ubicacion ? { ubicacion: c.ubicacion, en: c.confirmada_en! } : null,
      sobres: (await sobresDelCierre(sql, e.id)).map((x) => ({ lugar: x.lugar, folio: x.folio, custodia: x.custodia, apertura: x.apertura })),
      mismaPersona: e.entrega_por_id === e.recibe_id, cerroYCustodio: e.entrega_por_id === c.custodio_id, custodioAbrio: e.recibe_id === c.custodio_id,
      recontadoConCustodio: e.recontado_con !== null,
      cajon: { lugarFondos: c.lugar_fondos, acceso: c.acceso_cajon, llave: c.llave, motivoLlave: c.motivo_llave },
      fondos: await conteoSeparado(sql, e.id),
    };
  }
  const ETAPA = e.tipo === "cierre"
    ? { conteo_entrega: "conteo de quien cerró", conteo_recepcion: "conteo de quien abrió", recuento: "recuento" } as const
    : { conteo_entrega: "conteo de quien entregó", conteo_recepcion: "conteo de quien recibió", recuento: "recuento" } as const;
  const VERIF = { correcto: "cerrado y con su folio", abierto: "abierto o con el sello roto", otro_folio: "con otro folio", falta: "no está" } as const;
  const verif = (v: VerificacionSobre, folio: string) =>
    `sobre ${folio} ${VERIF[v.estado]}${v.folioVisto ? ` (${v.folioVisto})` : ""}${v.motivo ? `. Motivo: «${v.motivo}»` : ""}`;
  const eventosCierre: EventoCaso[] = !cierre ? [] : [
    ...(cierre.custodia ? [{
      en: cierre.custodia.en,
      que: `Custodia confirmada: ${cierre.custodia.ubicacion} · ${cierre.sobres.map((x) => verif(x.custodia!, x.folio)).join(" · ")}`,
      cuenta: cierre.custodio,
    }] : []),
    ...cierre.sobres.filter((x) => x.apertura).map((x) => ({ en: x.apertura!.en, que: `Al abrir: ${verif(x.apertura!, x.folio)}`, cuenta: x.apertura!.por })),
  ];
  const LUGAR = { bolsa_visitas: "bolsa", cajon_mensualidades: "cajón" } as const;
  const cual = (d: Diferencia) => `${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : (cierre ? "entre cierre y apertura" : "en la entrega")}`;
  const DECISION = { absorbe_sucursal: "Lo absorbe la sucursal", queda_en_bolsa: "Se queda en la bolsa", origen_identificado: "Origen identificado" } as const;
  const RESULTADO = { aclarada: "Aclarada", faltante_confirmado: "Faltante confirmado", sobrante_confirmado: "Sobrante confirmado" } as const;
  const dinero = (v: string) => (Number(v) < 0 ? "−" : "+") + "$" + Math.abs(Number(v)).toLocaleString("es-MX", { minimumFractionDigits: 2 });
  const historial: EventoCaso[] = (cierre ? [
    {
      en: e.creada_en,
      que: `Cierre del día (conteo de quien cerró) · ${cierre.sobres.length ? `sobres ${cierre.sobres.map((x) => x.folio).join(" y ")}` : "sin sobres"}`
        + `${cierre.fondos.some((f) => f.cerrado && Number(f.cerrado.fondo)) ? ` · fondos ${cierre.fondos.filter((f) => f.cerrado).map((f) => `${LUGAR[f.lugar]} ${pesosMx(f.cerrado!.fondo)} + sobre ${pesosMx(f.cerrado!.sobre)}`).join(", ")}` : ""}`
        + ` · custodio ${cierre.custodio}${cierre.cerroYCustodio ? " (cerró y custodió la misma persona)" : ""} · custodia: ${cierre.configuracion.lugar}`,
      cuenta: e.entrega_por,
    },
    ...eventosCierre,
    ...recuento.map((r) => ({ en: r.en, que: "El conteo de quien abre no coincidió con el cierre", cuenta: e.recibe })),
    {
      en: e.resuelta_en,
      que: `Turno abierto desde el cierre${cierre.mismaPersona && cierre.cerroYCustodio ? " · la misma persona cerró, custodió y abrió" : cierre.mismaPersona ? " por la misma persona que cerró" : cierre.custodioAbrio ? " por el custodio" : ""}${recuento.length ? (cierre.recontadoConCustodio ? ` tras recontar con ${cierre.custodio}` : " sin recuento con el custodio") : ""}${e.aclaracion ? `. Motivo: «${e.aclaracion}»` : ""}`,
      cuenta: e.recibe,
    },
  ] : [
    { en: e.creada_en, que: "Entrega registrada (conteo de quien entrega)", cuenta: e.entrega_por },
    ...recuento.map((r) => ({ en: r.en, que: "El primer conteo de quien recibe no coincidió: recuento", cuenta: e.recibe })),
    { en: e.resuelta_en, que: "Recepción confirmada desde su propia cuenta", cuenta: e.recibe },
  ]).concat([
    ...declaraciones.filter((d) => !d.hubo).map((d) => ({ en: d.en, que: `Apoyo en el ${ETAPA[d.etapa]}: nadie más participó`, cuenta: d.por })),
    ...personasApoyo.map((p) => ({ en: p.declarado_en, que: `Apoyo declarado en el ${ETAPA[p.etapa]}: ${p.nombre}`, cuenta: p.por })),
    ...personasApoyo.filter((p) => p.confirmado_en).map((p) => ({ en: p.confirmado_en!, que: `Apoyo confirmado en el ${ETAPA[p.etapa]}`, cuenta: p.nombre })),
    ...difs.map((d) => ({ en: d.registradaEn, que: `Diferencia registrada (${LUGAR[d.lugar]}): ${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : (cierre ? "entre cierre y apertura" : "en la entrega")}`, cuenta: "La plataforma, al confirmar" })),
    ...difs.filter((d) => d.clave).map((d) => ({ en: d.claveAsignadaEn!, que: `Clave asignada (${LUGAR[d.lugar]}, ${dinero(d.importe)}): ${d.clave}${d.claveCasoExistente ? " · caso registrado antes de las claves fijas; su fecha original no cambia" : ""}`, cuenta: "La plataforma" })),
    ...incidencias.map((i) => ({ en: i.registradaEn, que: `Incidencia por revisar: ${i.detalle}`, cuenta: "La plataforma, al abrir" })),
    ...incidencias.filter((i) => i.revision).map((i) => ({
      en: i.revision!.en, que: `Revisión de la incidencia (${i.detalle}). Motivo: «${i.revision!.motivo}»`, cuenta: i.revision!.revisadaPor,
    })),
    ...difs.filter((d) => d.revision).map((d) => ({
      en: d.revision!.en,
      que: `Revisión (${LUGAR[d.lugar]}, ${dinero(d.importe)} ${d.tipo === "contra_esperado" ? "contra el esperado" : (cierre ? "entre cierre y apertura" : "en la entrega")}): ${RESULTADO[d.revision!.resultado]}. Motivo: «${d.revision!.motivo}»`,
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
  ]).sort((a, b) => a.en.getTime() - b.en.getTime());
  return {
    sucursal: s.nombre, entregaId: e.id, tipo: e.tipo, cierre, entregaPor: e.entrega_por, recibe: e.recibe, entregadaEn: e.creada_en, confirmadaEn: e.resuelta_en,
    nota: e.nota, aclaracion: e.aclaracion, participaste, revisarasPropia: n.puede && revisaPropia, nivel: n.nivel, puedeRevisar: n.puede && (!participaste || revisaPropia), puedeResolver: n.resuelve && !participaste, historial, apoyos,
    lugares: { bolsa_visitas: cifras("bolsa_visitas"), cajon_mensualidades: cifras("cajon_mensualidades") },
    diferencias: difs,
    incidencias,
    desglose: {
      abiertoEn: d.abierto_en, abiertoPor: d.abierto_por, contadoAlAbrir: d.contado,
      cobros: { cuantos: d.cobros, visitas: d.visitas, importe: d.importe_cobros },
      cancelaciones: { cuantas: d.cancelaciones, importe: d.importe_cancelaciones },
      retiros: { cuantos: d.retiros, importe: d.importe_retiros }, fondos: { cuantas: d.fondos, importe: d.importe_fondos },
      sobres: { cuantos: d.sobres, importe: d.importe_sobres }, calculado,
    },
    fueraDeLaBolsa: ventasDelTurno(await cobrosDelTurno(sql, e.turno_id)),
    deRetiros: [...(await sql<DetalleDiferencias["deRetiros"]>`
      select r.id as "retiroId", r.folio, dr.importe::text, v.presente::text, dr.registrada_en as en
      from diferencia_retiro_entrega v join diferencia_retiro dr on dr.id = v.diferencia_retiro_id join retiro r on r.id = dr.retiro_id
      where v.entrega_id = ${e.id} order by dr.registrada_en`)],
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
                       and (x.id is null or (x.requiere_correccion and x.correccion is null)))))
           + (select count(*)::int from incidencia_cierre i join entrega_turno e on e.id = i.entrega_id join turno t on t.id = e.turno_id
              where t.sucursal_id = ${sucursalId} and not exists (select 1 from revision_incidencia r where r.incidencia_id = i.id)) as n`;
  return r.puede ? r.n : null;
}

/**
 * Revisión de UNA incidencia del cierre: quien revisa (el perfil que toca según la participación, sin haber
 * participado) deja constancia con motivo. No cambia importes. La base lo respalda.
 */
export async function revisarIncidencia(
  sql: Sql, usuarioId: string, codigo: string, datos: { incidenciaId: string; motivo: string }, { entorno }: { entorno: Entorno },
): Promise<{ ok: true; entregaId: string } | { ok: false; error: ErrorRevision }> {
  if (entorno === "produccion") return { ok: false, error: "bloqueado_produccion" };
  if (!/^[A-Z0-9]{2,5}$/.test(codigo) || !esIdentificadorValido(datos.incidenciaId)) return { ok: false, error: "no_encontrada" };
  const motivo = datos.motivo.trim().replace(/\s+/g, " ");
  if (motivo.length < 5 || motivo.length > 300) return { ok: false, error: "motivo" };
  try {
    return await sql.begin(async (tx) => {
      const [d] = await tx<{ entrega_id: string; consulta: boolean; revisa: boolean; nivel: NivelRevision; tiene_nivel: boolean; revisada: boolean; participo: boolean;
                             autorrevision: string | null }[]>`
        select i.entrega_id, autorrevision_vigente(${usuarioId}, t.sucursal_id) as autorrevision,
               tiene_permiso(${usuarioId}, 'diferencia.consultar', t.sucursal_id) as consulta,
               tiene_permiso(${usuarioId}, 'diferencia.revisar', t.sucursal_id) as revisa,
               nivel_revision_entrega(e.id) as nivel,
               exists (select 1 from perfiles_en_sucursal(${usuarioId}, t.sucursal_id) r where r = nivel_revision_entrega(e.id)) as tiene_nivel,
               exists (select 1 from revision_incidencia r where r.incidencia_id = i.id) as revisada,
               ${usuarioId}::uuid in (select participantes_entrega(e.id)) as participo
        from incidencia_cierre i join entrega_turno e on e.id = i.entrega_id join turno t on t.id = e.turno_id
        join sucursal s on s.id = t.sucursal_id
        where i.id = ${datos.incidenciaId} and s.codigo = ${codigo}
        for update of i`;
      if (!d || !d.consulta) return { ok: false as const, error: "no_encontrada" as const };
      if (!d.revisa) return { ok: false as const, error: "sin_permiso" as const };
      // Quien participó solo revisa con su autorización personal vigente (la revisión queda marcada).
      if (d.participo && !d.autorrevision) return { ok: false as const, error: "participaste" as const };
      if (!d.tiene_nivel) return { ok: false as const, error: "otro_nivel" as const };
      if (d.revisada) return { ok: false as const, error: "ya_revisada" as const };
      const autorrevision = d.participo ? d.autorrevision : null;
      await tx`insert into revision_incidencia (incidencia_id, motivo, nivel, revisada_por, autorrevision_id)
               values (${datos.incidenciaId}, ${motivo}, ${d.nivel}, ${usuarioId}, ${autorrevision})`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values ('incidencia_cierre', ${datos.incidenciaId}, 'revisar',
                       ${tx.json({ entrega: d.entrega_id, nivel: d.nivel, revisada_por_quien_participo: autorrevision !== null })}, ${motivo}, ${usuarioId})`;
      return { ok: true as const, entregaId: d.entrega_id };
    });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") return { ok: false, error: "ya_revisada" };
    throw error;
  }
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
                             consulta: boolean; revisa: boolean; nivel: NivelRevision; tiene_nivel: boolean; revisada: boolean; participo: boolean;
                             autorrevision: string | null }[]>`
        select df.entrega_id, df.importe::text as importe, t.sucursal_id, e.entrega_por, e.recibe,
               autorrevision_vigente(${usuarioId}, t.sucursal_id) as autorrevision,
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
      // Con autorización personal vigente sí revisa, y la revisión queda marcada «Revisada por quien participó».
      if (d.participo && !d.autorrevision) return { ok: false as const, error: "participaste" as const };
      if (!d.tiene_nivel) return { ok: false as const, error: "otro_nivel" as const };
      if (d.revisada) return { ok: false as const, error: "ya_revisada" as const };
      const autorrevision = d.participo ? d.autorrevision : null;
      const negativo = Number(d.importe) < 0;
      if ((datos.resultado === "faltante_confirmado" && !negativo) || (datos.resultado === "sobrante_confirmado" && negativo)) {
        return { ok: false as const, error: "resultado" as const };
      }
      const [r] = await tx<{ id: string }[]>`
        insert into revision_diferencia (diferencia_id, resultado, motivo, nivel, revisada_por, autorrevision_id)
        values (${datos.diferenciaId}, ${datos.resultado}, ${motivo}, ${d.nivel}, ${usuarioId}, ${autorrevision}) returning id`;
      await tx`insert into historial_cambio (entidad, entidad_id, accion, cambios, motivo, usuario_id)
               values ('diferencia_efectivo', ${datos.diferenciaId}, 'revisar',
                       ${tx.json({ revision: r.id, resultado: datos.resultado, nivel: d.nivel, importe: d.importe, revisada_por_quien_participo: autorrevision !== null })}, ${motivo}, ${usuarioId})`;
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
