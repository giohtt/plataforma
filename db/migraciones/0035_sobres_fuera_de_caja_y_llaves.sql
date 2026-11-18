-- Bloque 5, regla 7: ajustes del 18 nov 2026 antes de unir la recolección (solo datos ficticios).
--   1. Un sobre entregado a Dirección y pendiente de confirmar ya no está físicamente en la caja: se muestra aparte, con
--      quién lo entregó y quién debe confirmar su recepción, y no se verifica en los cambios de custodia.
--   2. Si se cancela la entrega, los sobres vuelven a la caja solo cuando se registra su devolución física: la
--      responsable en turno los recibe de vuelta y verifica cada uno. Hasta entonces quedan «por devolver».
--   3. La llave de la caja de sobres y la del cajón de los fondos se registran por separado (todavía no se confirma que
--      sean una sola).

-- ---------------------------------------------------------------------------
-- Devolución física de una entrega cancelada
-- ---------------------------------------------------------------------------
create table devolucion_recoleccion (
  id             uuid primary key default gen_random_uuid(),
  recoleccion_id uuid not null unique references recoleccion (id),
  -- Quien devuelve: la persona de Dirección que tenía los sobres. Quien recibe: la responsable en turno.
  devuelve_por   uuid not null references usuario (id),
  recibida_por   uuid not null references usuario (id),
  turno_id       uuid not null references turno (id),
  en             timestamptz not null default now(),
  constraint devolucion_otra_persona check (devuelve_por <> recibida_por)
);
create function devolucion_recoleccion_valida() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from recoleccion r join turno t on t.id = new.turno_id
    where r.id = new.recoleccion_id and r.estado = 'cancelada' and r.recibe = new.devuelve_por
      and t.sucursal_id = r.sucursal_id and t.cerrado_en is null
      and tiene_permiso(new.recibida_por, 'sobre.entregar', r.sucursal_id)
      and exists (select 1 from responsable_lugar x where x.turno_id = t.id and x.hasta is null and x.usuario_id = new.recibida_por)) then
    raise exception 'Recibe la devolución la responsable en turno, de una entrega cancelada' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger devolucion_recoleccion_valida
  before insert on devolucion_recoleccion
  for each row execute function devolucion_recoleccion_valida();
create trigger devolucion_recoleccion_inmutable
  before update or delete on devolucion_recoleccion
  for each row execute function impedir_modificacion();
create trigger devolucion_recoleccion_sin_vaciar
  before truncate on devolucion_recoleccion
  for each statement execute function impedir_modificacion();

-- Un sobre está físicamente en la caja si está guardado (sin recoger), no está en una entrega pendiente y, si estuvo en una
-- entrega cancelada, ya se registró su devolución.
create function sobre_en_caja(p_sobre uuid) returns boolean
language sql stable as $$
  select exists (select 1 from sobre_cierre s where s.id = p_sobre and s.estado = 'usado' and s.importe is not null)
     and not exists (
       select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
       where x.sobre_id = p_sobre
         and (r.estado = 'pendiente'
              or (r.estado = 'cancelada' and not exists (select 1 from devolucion_recoleccion d where d.recoleccion_id = r.id))))
$$;

-- Solo se entregan sobres que están en la caja.
create or replace function recoleccion_sobre_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'recoleccion_sobre no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.contado is not null or not exists (
      select 1 from recoleccion r join sobre_cierre s on s.sucursal_id = r.sucursal_id
      where r.id = new.recoleccion_id and r.estado = 'pendiente' and s.id = new.sobre_id and s.estado = 'usado' and s.importe is not null) then
      raise exception 'Se entregan sobres guardados de la sucursal' using errcode = 'check_violation';
    end if;
    if exists (select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
               where x.sobre_id = new.sobre_id and r.id <> new.recoleccion_id
                 and (r.estado = 'pendiente'
                      or (r.estado = 'cancelada' and not exists (select 1 from devolucion_recoleccion d where d.recoleccion_id = r.id)))) then
      raise exception 'El sobre no está en la caja: está en otra entrega pendiente o por devolver' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.contado is not null or new.contado is null or (new.recoleccion_id, new.sobre_id) is distinct from (old.recoleccion_id, old.sobre_id)
     or not exists (select 1 from recoleccion r where r.id = new.recoleccion_id and r.estado = 'pendiente') then
    raise exception 'recoleccion_sobre: el conteo se registra una vez, antes de confirmar' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revisión de la caja: devolución y llaves por separado
-- ---------------------------------------------------------------------------
alter table revision_caja drop constraint revision_caja_momento_check;
alter table revision_caja add constraint revision_caja_momento_check
  check (momento in ('cierre', 'apertura', 'cambio_turno', 'recoleccion', 'devolucion'));
alter table revision_caja drop constraint revision_origen;
alter table revision_caja add constraint revision_origen check (
  (momento in ('recoleccion', 'devolucion')) = (recoleccion_id is not null)
  and (momento in ('recoleccion', 'devolucion')) = (entrega_id is null));
create unique index revision_caja_por_recoleccion on revision_caja (recoleccion_id, momento) where recoleccion_id is not null;
comment on column revision_caja.llave is 'Llave de la caja de sobres';
-- Llave del cajón de los fondos, aparte: la recibe quien recibe la custodia (cierre, apertura y cambio de turno).
alter table revision_caja add column llave_cajon text check (llave_cajon in ('correcta', 'incidencia'));
alter table revision_caja add column motivo_llave_cajon text
  check (motivo_llave_cajon is null or char_length(btrim(motivo_llave_cajon)) between 5 and 300);
alter table revision_caja add constraint revision_llave_cajon check (
  (momento in ('cierre', 'apertura', 'cambio_turno')) = (llave_cajon is not null)
  and (llave_cajon is not distinct from 'incidencia') = (motivo_llave_cajon is not null)) not valid;

-- Verificación de la caja: en la custodia, solo lo que está físicamente en la caja; en la recolección y en la devolución,
-- los sobres de esa entrega.
create or replace function verificacion_sobre_valida() returns trigger
language plpgsql as $$
declare
  e record;
  r record;
begin
  if new.momento = 'caja' then
    select x.por, x.sucursal_id, x.momento, x.recoleccion_id into r from revision_caja x where x.id = new.revision_id;
    if r is null or new.verificado_por <> r.por or not exists (
      select 1 from sobre_cierre s where s.id = new.sobre_id and s.sucursal_id = r.sucursal_id and s.estado = 'usado' and s.importe is not null) then
      raise exception 'En la caja verifica quien recibe la llave, sobres guardados de la sucursal' using errcode = 'check_violation';
    end if;
    if r.momento in ('recoleccion', 'devolucion') then
      if not exists (select 1 from recoleccion_sobre y where y.recoleccion_id = r.recoleccion_id and y.sobre_id = new.sobre_id) then
        raise exception 'Se verifican los sobres de esa entrega' using errcode = 'check_violation';
      end if;
    elsif not sobre_en_caja(new.sobre_id) then
      raise exception 'El sobre no está en la caja: está entregado a Dirección o por devolver' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select x.custodio_id, x.recibe, x.estado into e
  from sobre_cierre s join entrega_turno x on x.id = s.entrega_id where s.id = new.sobre_id;
  if e is null then
    raise exception 'Solo se verifican sobres de un cierre' using errcode = 'check_violation';
  end if;
  if new.momento = 'custodia' and new.verificado_por <> e.custodio_id then
    raise exception 'Verifica en la custodia el custodio nocturno' using errcode = 'check_violation';
  end if;
  if new.momento = 'apertura' and new.verificado_por is distinct from e.recibe then
    raise exception 'Verifica en la apertura quien abre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Incidencia de la llave del cajón de los fondos al recibir la custodia (apertura o cambio de turno; al cerrar, la
-- incidencia del cajón ya es «llave_custodia»).
alter table incidencia_cierre drop constraint incidencia_cierre_tipo_check;
alter table incidencia_cierre add constraint incidencia_cierre_tipo_check
  check (tipo in ('custodia_sin_confirmar', 'sobre_en_custodia', 'sobre_al_abrir', 'fondo_incompleto', 'llave_custodia', 'sobre_caja', 'llave_caja',
                  'llave_cajon'));
alter table incidencia_cierre drop constraint incidencia_con_verificacion;
alter table incidencia_cierre add constraint incidencia_con_verificacion check (
  (tipo in ('sobre_en_custodia', 'sobre_al_abrir', 'sobre_caja')) = (verificacion_id is not null)
  and (tipo = 'fondo_incompleto') = (lugar_id is not null)
  and (tipo in ('llave_caja', 'llave_cajon')) = (revision_id is not null));
create unique index incidencia_llave_cajon_unica on incidencia_cierre (revision_id) where tipo = 'llave_cajon';

create or replace function incidencia_cierre_valida() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if new.tipo in ('sobre_caja', 'llave_caja', 'llave_cajon') then
    if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.estado = 'confirmada') then
      raise exception 'Las incidencias de la caja se registran al confirmarse la entrega' using errcode = 'check_violation';
    end if;
    if new.tipo = 'llave_caja' then
      if not exists (select 1 from revision_caja r where r.id = new.revision_id and r.entrega_id = new.entrega_id and r.llave = 'incidencia') then
        raise exception 'No hubo incidencia con la llave de la caja de sobres en esta entrega' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if new.tipo = 'llave_cajon' then
      if not exists (select 1 from revision_caja r where r.id = new.revision_id and r.entrega_id = new.entrega_id
                       and r.momento in ('apertura', 'cambio_turno') and r.llave_cajon = 'incidencia') then
        raise exception 'No hubo incidencia con la llave del cajón de fondos en esta entrega' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if not exists (select 1 from verificacion_sobre x join revision_caja r on r.id = x.revision_id
                   where x.id = new.verificacion_id and x.momento = 'caja' and x.estado <> 'correcto' and r.entrega_id = new.entrega_id) then
      raise exception 'La incidencia corresponde a un sobre de la caja con problema en esta entrega' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.estado = 'confirmada') then
    raise exception 'Las incidencias se registran al confirmarse la apertura de un cierre' using errcode = 'check_violation';
  end if;
  if new.tipo = 'custodia_sin_confirmar' then
    if not exists (select 1 from apertura_sin_custodia a where a.entrega_id = new.entrega_id) then
      raise exception 'No hubo apertura sin custodia confirmada' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'fondo_incompleto' then
    if not exists (select 1 from conteo_fondo c where c.entrega_id = new.entrega_id and c.lugar_id = new.lugar_id
                     and c.momento = 'cierre' and c.fondo < c.fondo_monto) then
      raise exception 'El fondo no quedó incompleto al cerrar' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'llave_custodia' then
    if not exists (select 1 from custodia_cierre c where c.entrega_id = new.entrega_id and c.llave = 'incidencia') then
      raise exception 'No hubo incidencia con la llave o el cajón' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select x.momento, x.estado, s.entrega_id into v from verificacion_sobre x join sobre_cierre s on s.id = x.sobre_id where x.id = new.verificacion_id;
  if v is null or v.entrega_id <> new.entrega_id or v.estado = 'correcto'
     or v.momento <> (case new.tipo when 'sobre_en_custodia' then 'custodia' else 'apertura' end) then
    raise exception 'La incidencia corresponde a una verificación de sobre con problema' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Diferencias por sobre también en la devolución (sobre que vuelve abierto, con otro folio o que no vuelve)
-- ---------------------------------------------------------------------------
alter table diferencia_sobre drop constraint diferencia_sobre_sobre_id_key;
create unique index diferencia_sobre_por_entrega on diferencia_sobre (recoleccion_id, sobre_id);

create or replace function diferencia_sobre_valida() returns trigger
language plpgsql as $$
declare
  r record;
begin
  select x.estado into r from recoleccion x where x.id = new.recoleccion_id;
  if r.estado = 'cancelada' then
    -- Devolución: sin conteo; queda por revisar el sobre que no volvió cerrado y con su folio.
    if new.importe <> 0 or new.verificacion_id is null or not exists (
      select 1 from verificacion_sobre v join revision_caja rc on rc.id = v.revision_id
      where v.id = new.verificacion_id and v.sobre_id = new.sobre_id and v.estado <> 'correcto'
        and rc.recoleccion_id = new.recoleccion_id and rc.momento = 'devolucion') then
      raise exception 'En la devolución queda por revisar un sobre con problema al verificarlo' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not exists (select 1 from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id join recoleccion y on y.id = x.recoleccion_id
                 where x.recoleccion_id = new.recoleccion_id and x.sobre_id = new.sobre_id and y.estado = 'confirmada'
                   and x.contado - s.importe = new.importe) then
    raise exception 'La diferencia es lo contado menos lo anotado, en una recolección confirmada' using errcode = 'check_violation';
  end if;
  if new.verificacion_id is not null and not exists (
    select 1 from verificacion_sobre v join revision_caja rc on rc.id = v.revision_id
    where v.id = new.verificacion_id and v.sobre_id = new.sobre_id and v.estado <> 'correcto'
      and rc.recoleccion_id = new.recoleccion_id and rc.momento = 'recoleccion') then
    raise exception 'La verificación es del sobre, con problema, en esta recolección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Participan en la cadena también quienes tuvieron el sobre en una entrega cancelada (quien entregó y quien lo tuvo en
-- Dirección) y quien recibió la devolución.
create or replace function participantes_sobre(p_sobre uuid) returns setof uuid
language sql stable as $$
  select e.entrega_por from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
  union select e.custodio_id from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
  union select v.verificado_por from verificacion_sobre v where v.sobre_id = p_sobre
  union select r.custodio_id from verificacion_sobre v join revision_caja r on r.id = v.revision_id where v.sobre_id = p_sobre
  union select x.entrega_por from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
  union select x.recibe from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
  union select d.recibida_por from devolucion_recoleccion d join recoleccion_sobre y on y.recoleccion_id = d.recoleccion_id where y.sobre_id = p_sobre
$$;
