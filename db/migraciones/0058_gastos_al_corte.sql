-- 0058 · Bloque 6, PR 9: el estado de un gasto a un corte, para los reportes (acordado el 28 nov 2026; solo datos
-- ficticios). Solo cuenta lo registrado hasta el corte: nada posterior cambia un reporte con ese corte.

-- Autorización previa del pago al corte (null si no hay pago al corte). Se compara fecha y hora del pago con fecha y
-- hora de la autorización; solo con el día y el mismo día, «no_comprobada» (PR 8, 27-28 nov 2026).
create function autorizacion_previa_al(p_gasto uuid, p_corte timestamptz) returns text
language sql stable as $$
  with g as (select * from gasto where id = p_gasto),
       yp as (select * from gasto_ya_pagado where gasto_id = p_gasto and en <= p_corte),
       kx as (select * from anticipo_comprobado where excedente_gasto_id = p_gasto and en <= p_corte),
       pg as (select * from pago_gasto where gasto_id = p_gasto and en <= p_corte),
       d as (select d.* from decision_gasto d
             where d.gasto_id = p_gasto and d.en <= p_corte
               and d.version = (select max(v.version) from gasto_version v where v.gasto_id = p_gasto and v.en <= p_corte))
  select case
    when exists (select 1 from yp) then 'sin_autorizacion_previa'
    when exists (select 1 from kx) then
      case when not exists (select 1 from d) then 'pendiente'
           when (select en from kx) < (select en from d) then 'sin_autorizacion_previa' else 'no_comprobada' end
    when not exists (select 1 from pg) then null
    when (select decision from d) is distinct from 'autorizado' then 'pendiente'
    when (select origen from pg) in ('bolsa_visitas', 'cajon_mensualidades') and (select turno_cerrado_id from pg) is null then
      case when (select en from pg) > (select en from d) then 'comprobada' else 'sin_autorizacion_previa' end
    when (select origen from pg) = 'anticipo' then
      case when (select a.en from anticipo_gasto a where a.gasto_id = p_gasto) > (select en from d) then 'comprobada' else 'no_comprobada' end
    when (select hora_declarada from pg) is not null then
      case when momento_declarado_pago((select id from pg)) > (select en from d) then 'comprobada' else 'sin_autorizacion_previa' end
    when (select pagado_el from pg) > dia_en_sucursal((select sucursal_paga_id from g), (select en from d)) then 'comprobada'
    when (select pagado_el from pg) < dia_en_sucursal((select sucursal_paga_id from g), (select en from d)) then 'sin_autorizacion_previa'
    else 'no_comprobada' end
$$;

-- Comprobación al corte: comprobado, sin_comprobante o por_comprobar (null sin pago al corte).
create function comprobacion_al(p_gasto uuid, p_corte timestamptz) returns text
language sql stable as $$
  select case
    when not exists (select 1 from pago_gasto p where p.gasto_id = p_gasto and p.en <= p_corte) then null
    when exists (select 1 from comprobante_gasto c where c.gasto_id = p_gasto and c.en <= p_corte) then 'comprobado'
    when exists (select 1 from sin_comprobante_gasto c where c.gasto_id = p_gasto and c.en <= p_corte) then 'sin_comprobante'
    else 'por_comprobar' end
$$;

-- Reembolso al corte de un pago con dinero personal (null si no lo es o no estaba registrado al corte).
create function reembolso_estado_al(p_pago uuid, p_corte timestamptz) returns text
language sql stable as $$
  with p as (select * from pago_gasto where id = p_pago and origen = 'dinero_personal' and en <= p_corte),
       dr as (select * from decision_reembolso where pago_id = p_pago and en <= p_corte order by ronda desc limit 1),
       rg as (select * from reembolso_gasto where pago_id = p_pago and en <= p_corte)
  select case
    when not exists (select 1 from p) then null
    when not exists (select 1 from dr) then 'por_decidir'
    when (select decision from dr) = 'rechazado' then
      case when exists (select 1 from reenvio_reembolso r where r.pago_id = p_pago and r.ronda = (select ronda from dr) + 1 and r.en <= p_corte)
           then 'presentado_de_nuevo' else 'rechazado' end
    when not exists (select 1 from rg) then 'por_pagar'
    when not exists (select 1 from reembolso_recibido rr where rr.reembolso_id = (select id from rg) and rr.en <= p_corte) then 'pagado'
    else 'recibido' end
$$;

-- Descargas del reporte de gastos (Excel o PDF): quién, qué sucursales, periodo, corte, formato y contenido.
create table descarga_reporte_gastos (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references usuario (id),
  sucursales  uuid[] not null,
  desde       date not null,
  hasta       date not null,
  corte       timestamptz not null,
  formato     text not null check (formato in ('xlsx', 'pdf')),
  contenido   text not null check (contenido in ('resumen', 'detalle')),
  en          timestamptz not null default now()
);
create trigger descarga_reporte_gastos_inmutable before update or delete on descarga_reporte_gastos
  for each row execute function impedir_modificacion();
create trigger descarga_reporte_gastos_sin_vaciar before truncate on descarga_reporte_gastos
  for each statement execute function impedir_modificacion();
