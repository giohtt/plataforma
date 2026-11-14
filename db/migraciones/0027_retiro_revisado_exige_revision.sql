-- 0027 · Bloque 5: la base exige una revisión válida para pasar un retiro de «Por revisar» a «Revisado»
-- (indicado el 13 nov 2026, antes de unir la #51; solo datos ficticios).
--   - por_revisar → revisado solo si existe la revisión del retiro; el monto habilitado es exactamente el monto
--     verificado en esa revisión y, si la discrepancia fue de folio, la revisión tiene el folio del retiro.
--   - pendiente o recuento → confirmado: el monto habilitado es exactamente el importe registrado.
create or replace function retiro_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'retiro: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' or new.version <> 1 or new.folio_en_sobre is not null or not exists (
      select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
      where t.id = new.turno_id and l.id = new.lugar_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'El retiro debe ser de un lugar de la sucursal de un turno abierto' using errcode = 'check_violation';
    end if;
    if not tiene_permiso(new.encargada_id, 'retiro.confirmar', new.sucursal_id) then
      raise exception 'Recibe una Encargada de retiros autorizada en la sucursal' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.version <> old.version + 1
     or not ((old.estado = 'pendiente' and new.estado in ('recuento', 'confirmado', 'por_revisar'))
          or (old.estado = 'recuento' and new.estado in ('confirmado', 'por_revisar'))
          or (old.estado = 'por_revisar' and new.estado = 'revisado'))
     or (old.discrepancia is not null and (new.discrepancia, new.motivo, new.reportado_en, new.folio_en_sobre)
                                          is distinct from (old.discrepancia, old.motivo, old.reportado_en, old.folio_en_sobre))
     or (new.id, new.sucursal_id, new.turno_id, new.lugar_id, new.folio, new.contado, new.cambio, new.importe, new.esperado,
         new.entregado_por, new.encargada_id, new.entregado_en)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.lugar_id, old.folio, old.contado, old.cambio, old.importe,
                          old.esperado, old.entregado_por, old.encargada_id, old.entregado_en) then
    raise exception 'retiro: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  if new.estado = 'confirmado' and new.monto_habilitado is distinct from new.importe then
    raise exception 'Al confirmar, el monto habilitado es el importe registrado' using errcode = 'check_violation';
  end if;
  if new.estado = 'revisado' and not exists (
       select 1 from retiro_revision rv
       where rv.retiro_id = new.id
         and rv.monto_verificado = new.monto_habilitado
         and (new.discrepancia <> 'folio' or rv.folio_verificado = new.folio)) then
    raise exception 'Para pasar a revisado se necesita su revisión, con el monto habilitado igual al verificado y, si el folio no coincidió, el folio verificado'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
