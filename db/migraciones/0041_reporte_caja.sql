-- 0041 · Bloque 5: reporte de caja por sucursal y periodo (solo consulta, datos ficticios). Aprobado el 21 nov 2026:
--   - dos permisos individuales y separados, «Consultar el reporte de caja» y «Descargar el reporte de caja», que se dan
--     por persona en una o varias sucursales o en todas desde «Usuarios, roles y permisos». NINGÚN perfil los trae
--     (tampoco Dirección): nadie los tiene hasta que se le dan expresamente;
--   - descargar exige poder consultar esa sucursal (se comprueba al dar el permiso y otra vez al descargar);
--   - cada descarga queda en un historial que no se edita ni se borra.

insert into permiso (clave, descripcion, bloque, es_autorizacion, ambito) values
  ('reporte.caja', 'Consultar el reporte de caja: dónde está el efectivo, sus detalles e historial', 5, false, 'sucursal'),
  ('reporte.caja_descargar', 'Descargar el reporte de caja en Excel o PDF (solo donde también puede consultarlo)', 5, false, 'sucursal');

create table descarga_reporte_caja (
  id                       uuid primary key default gen_random_uuid(),
  usuario_id               uuid not null references usuario (id),
  en                       timestamptz not null default now(),
  sucursales               uuid[] not null,
  -- Sucursales que pidió («Todas mis sucursales») y no se incluyeron por no poder descargarlas.
  excluidas                uuid[] not null default '{}',
  desde                    date not null,
  hasta                    date not null,
  corte                    timestamptz not null,
  formato                  text not null,
  contenido                text not null,
  -- Llevaba sobres sin contar con el importe oculto (quien descarga puede recogerlos).
  con_ocultos              boolean not null,
  -- Llevaba importes anotados de sobres sin contar (quien descarga no los recoge): el archivo lleva la leyenda.
  con_anotados_sin_contar  boolean not null,
  constraint descarga_formato check (formato in ('xlsx', 'pdf')),
  constraint descarga_contenido check (contenido in ('resumen', 'detalle')),
  constraint descarga_sucursales check (cardinality(sucursales) > 0),
  constraint descarga_periodo check (desde <= hasta and corte <= en + interval '1 minute')
);
create index descarga_reporte_caja_en on descarga_reporte_caja (en desc);

-- Respaldo en la base: solo se registra una descarga de quien, en ese momento, puede consultar y descargar cada sucursal.
create function descarga_reporte_caja_valida() returns trigger language plpgsql as $$
begin
  if exists (select 1 from unnest(new.sucursales) s(id)
             where not tiene_permiso(new.usuario_id, 'reporte.caja', s.id)
                or not tiene_permiso(new.usuario_id, 'reporte.caja_descargar', s.id)) then
    raise exception 'Solo se descarga el reporte de caja donde se puede consultar y descargar' using errcode = 'check_violation';
  end if;
  return new;
end; $$;
create trigger descarga_reporte_caja_valida before insert on descarga_reporte_caja
  for each row execute function descarga_reporte_caja_valida();
create trigger descarga_reporte_caja_inmutable before update or delete on descarga_reporte_caja
  for each row execute function impedir_modificacion();
create trigger descarga_reporte_caja_sin_truncar before truncate on descarga_reporte_caja
  for each statement execute function impedir_modificacion();
