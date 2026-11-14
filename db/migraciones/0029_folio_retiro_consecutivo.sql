-- 0029 · Bloque 5: el consecutivo del folio de retiro tiene como mínimo dos dígitos y conserva todos a partir de 100
-- (indicado el 13 nov 2026). En 0028, lpad(…, 2, '0') recortaba «100» a «10»; ahora: 01 … 99, 100, 101…
create or replace function folio_retiro_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'folio_retiro: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'reservado'
       or new.folio <> (select s.codigo from sucursal s where s.id = new.sucursal_id) || '-' || to_char(new.fecha, 'YYYYMMDD') || '-' || lpad(new.consecutivo::text, greatest(2, length(new.consecutivo::text)), '0')
       or not exists (select 1 from folio_retiro_contador c where c.sucursal_id = new.sucursal_id and c.fecha = new.fecha and c.ultimo >= new.consecutivo)
       or not exists (select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
                      where t.id = new.turno_id and l.id = new.lugar_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'Folio de retiro no válido' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- Solo pasa de reservado a usado (con su retiro registrado) o a cancelado; lo demás no cambia.
  if old.estado <> 'reservado' or new.estado not in ('usado', 'cancelado')
     or (new.estado = 'usado' and not exists (select 1 from retiro r where r.folio_retiro_id = new.id))
     or (new.id, new.sucursal_id, new.fecha, new.consecutivo, new.folio, new.turno_id, new.lugar_id, new.reservado_por, new.reservado_en)
        is distinct from (old.id, old.sucursal_id, old.fecha, old.consecutivo, old.folio, old.turno_id, old.lugar_id, old.reservado_por, old.reservado_en) then
    raise exception 'folio_retiro: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
