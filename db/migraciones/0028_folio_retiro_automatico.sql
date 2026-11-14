-- 0028 · Bloque 5: folio automático de retiro (indicado el 13 nov 2026; solo datos ficticios).
--   - Recepción pulsa «Generar folio»: la plataforma reserva el siguiente folio con la sucursal, la fecha local
--     (America/Mexico_City) con año y un consecutivo del día, por ejemplo TEN-20261113-01, y lo muestra para anotarlo
--     en el sobre. Reservar no mueve efectivo.
--   - La salida se descuenta al pulsar «Confirmar entrega», cuando el sobre ya se entregó en persona: el retiro usa
--     la reserva y la marca como usada.
--   - Si se cancela la preparación, no hay salida y ese folio queda cancelado, sin reutilizarse.
--   - Los retiros anteriores conservan su folio escrito a mano (sin reserva).

create table folio_retiro_contador (
  sucursal_id uuid not null references sucursal (id),
  fecha       date not null,
  ultimo      int  not null check (ultimo > 0),
  primary key (sucursal_id, fecha)
);
create function folio_retiro_contador_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.ultimo <> old.ultimo + 1 or (new.sucursal_id, new.fecha) is distinct from (old.sucursal_id, old.fecha) then
    raise exception 'El consecutivo de folios solo avanza de uno en uno' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger folio_retiro_contador_valido
  before update or delete on folio_retiro_contador
  for each row execute function folio_retiro_contador_valido();
create trigger folio_retiro_contador_sin_vaciar
  before truncate on folio_retiro_contador
  for each statement execute function impedir_modificacion();

create table folio_retiro (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  fecha         date not null,
  consecutivo   int  not null check (consecutivo > 0),
  folio         text not null,
  turno_id      uuid not null references turno (id),
  lugar_id      uuid not null references lugar_efectivo (id),
  reservado_por uuid not null references usuario (id),
  reservado_en  timestamptz not null default now(),
  estado        text not null default 'reservado' check (estado in ('reservado', 'usado', 'cancelado')),
  resuelto_en   timestamptz,
  constraint folio_retiro_unico unique (sucursal_id, folio),
  constraint folio_retiro_consecutivo_unico unique (sucursal_id, fecha, consecutivo),
  constraint folio_retiro_resuelto check ((estado = 'reservado') = (resuelto_en is null))
);
-- Una sola preparación abierta por lugar y turno.
create unique index folio_retiro_un_reservado on folio_retiro (turno_id, lugar_id) where estado = 'reservado';

create function folio_retiro_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'folio_retiro: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'reservado'
       or new.folio <> (select s.codigo from sucursal s where s.id = new.sucursal_id) || '-' || to_char(new.fecha, 'YYYYMMDD') || '-' || lpad(new.consecutivo::text, 2, '0')
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
create trigger folio_retiro_valido
  before insert or update or delete on folio_retiro
  for each row execute function folio_retiro_valido();
create trigger folio_retiro_sin_vaciar
  before truncate on folio_retiro
  for each statement execute function impedir_modificacion();

-- El retiro usa una reserva: mismo folio, sucursal, turno, lugar y persona. Los retiros anteriores quedan sin reserva.
alter table retiro add column folio_retiro_id uuid unique references folio_retiro (id);

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
    if not exists (select 1 from folio_retiro f where f.id = new.folio_retiro_id and f.estado = 'reservado' and f.folio = new.folio
                     and f.sucursal_id = new.sucursal_id and f.turno_id = new.turno_id and f.lugar_id = new.lugar_id
                     and f.reservado_por = new.entregado_por) then
      raise exception 'El retiro usa un folio generado y reservado para este lugar y turno' using errcode = 'check_violation';
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
         new.entregado_por, new.encargada_id, new.entregado_en, new.folio_retiro_id)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.lugar_id, old.folio, old.contado, old.cambio, old.importe,
                          old.esperado, old.entregado_por, old.encargada_id, old.entregado_en, old.folio_retiro_id) then
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
