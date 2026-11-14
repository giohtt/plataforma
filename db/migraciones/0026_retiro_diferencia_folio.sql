-- 0026 · Bloque 5: diferencia contra el esperado al retirar y verificación del folio (ajustes del 13 nov 2026 a la #51;
-- solo datos ficticios).
--   - Si al retirar de la bolsa lo contado no coincide con el esperado, la diferencia se registra en ese momento,
--     ligada al retiro. Un retiro posterior del mismo turno compara contra el esperado que ya descuenta las diferencias
--     registradas, para no volver a registrar la misma.
--   - Al confirmarse el cambio de turno, cada diferencia registrada al retirar se vincula a la entrega con la parte que
--     sigue presente en la diferencia contra el esperado de la entrega; esa diferencia de la entrega es el mismo caso y
--     no se duplica (ni se suma otra vez).
--   - Si se reportó que el folio no coincide: la Encargada de retiros registra el folio que trae el sobre, y quien
--     revisa registra el folio verificado (el de este retiro). Sin esa verificación no se habilitan los depósitos.

-- ---------------------------------------------------------------------------
-- Diferencia contra el esperado al retirar (solo la bolsa tiene esperado).
-- ---------------------------------------------------------------------------
create table diferencia_retiro (
  id            uuid primary key default gen_random_uuid(),
  retiro_id     uuid not null unique references retiro (id),
  turno_id      uuid not null references turno (id),
  lugar_id      uuid not null references lugar_efectivo (id),
  esperado      numeric(12, 2) not null,
  contado       numeric(12, 2) not null,
  importe       numeric(12, 2) not null check (importe <> 0),
  registrada_en timestamptz not null default now(),
  constraint diferencia_retiro_cuadra check (importe = contado - esperado)
);
create index diferencia_retiro_turno on diferencia_retiro (turno_id);

create function diferencia_retiro_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from retiro r where r.id = new.retiro_id and r.turno_id = new.turno_id and r.lugar_id = new.lugar_id
                   and r.contado = new.contado and r.esperado = new.esperado) then
    raise exception 'La diferencia debe corresponder al conteo y al esperado del retiro' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger diferencia_retiro_valida
  before insert on diferencia_retiro
  for each row execute function diferencia_retiro_valida();
create trigger diferencia_retiro_inmutable
  before update or delete on diferencia_retiro
  for each row execute function impedir_modificacion();
create trigger diferencia_retiro_sin_vaciar
  before truncate on diferencia_retiro
  for each statement execute function impedir_modificacion();

-- Vínculo con el cambio de turno: qué parte sigue presente en la diferencia contra el esperado de la entrega.
create table diferencia_retiro_entrega (
  diferencia_retiro_id uuid primary key references diferencia_retiro (id),
  entrega_id           uuid not null references entrega_turno (id),
  diferencia_id        uuid references diferencia_efectivo (id),
  presente             numeric(12, 2) not null,
  en                   timestamptz not null default now(),
  constraint vinculo_con_diferencia check ((presente = 0) = (diferencia_id is null))
);

create function diferencia_retiro_entrega_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  select dr.turno_id, dr.lugar_id, dr.importe into d from diferencia_retiro dr where dr.id = new.diferencia_retiro_id;
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.turno_id = d.turno_id) then
    raise exception 'La entrega debe ser del mismo turno del retiro' using errcode = 'check_violation';
  end if;
  if new.diferencia_id is not null and not exists (
       select 1 from diferencia_efectivo x where x.id = new.diferencia_id and x.entrega_id = new.entrega_id
         and x.lugar_id = d.lugar_id and x.tipo = 'contra_esperado') then
    raise exception 'El vínculo es con la diferencia contra el esperado del mismo lugar en la entrega' using errcode = 'check_violation';
  end if;
  -- La parte presente tiene el signo de la diferencia del retiro y no la excede.
  if new.presente <> 0 and (sign(new.presente) <> sign(d.importe) or abs(new.presente) > abs(d.importe)) then
    raise exception 'La parte presente no corresponde a la diferencia del retiro' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger diferencia_retiro_entrega_valida
  before insert on diferencia_retiro_entrega
  for each row execute function diferencia_retiro_entrega_valida();
create trigger diferencia_retiro_entrega_inmutable
  before update or delete on diferencia_retiro_entrega
  for each row execute function impedir_modificacion();
create trigger diferencia_retiro_entrega_sin_vaciar
  before truncate on diferencia_retiro_entrega
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Folio que no coincide: folio que trae el sobre (al reportarlo) y folio verificado (al revisar).
-- ---------------------------------------------------------------------------
alter table retiro add column folio_en_sobre text check (folio_en_sobre ~ '^[A-Z0-9][A-Z0-9-]{2,29}$');
alter table retiro add constraint retiro_folio_en_sobre check (coalesce(discrepancia = 'folio', false) = (folio_en_sobre is not null));

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
  return new;
end;
$$;

alter table retiro_revision add column folio_verificado text;

create or replace function retiro_revision_valida() returns trigger
language plpgsql as $$
declare
  x record;
begin
  select r.importe, r.sucursal_id, r.estado, r.discrepancia, r.folio into x from retiro r where r.id = new.retiro_id;
  if x.estado <> 'por_revisar' then
    raise exception 'Solo se revisa un retiro por revisar' using errcode = 'check_violation';
  end if;
  -- Con el folio en duda, se habilita solo al verificar que el efectivo corresponde al sobre de este retiro.
  if x.discrepancia = 'folio' and new.folio_verificado is distinct from x.folio then
    raise exception 'Falta verificar que el efectivo corresponde al folio de este retiro' using errcode = 'check_violation';
  end if;
  if x.discrepancia <> 'folio' and new.folio_verificado is not null then
    raise exception 'El folio verificado solo aplica cuando el folio no coincidió' using errcode = 'check_violation';
  end if;
  if new.resultado = 'faltante_confirmado' and new.monto_verificado >= x.importe then
    raise exception 'Un faltante confirmado verifica menos de lo registrado' using errcode = 'check_violation';
  end if;
  if new.revisada_por in (select participantes_retiro(new.retiro_id)) then
    raise exception 'Quien participó en el retiro no lo revisa' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_retiro(new.retiro_id)
     or not tiene_permiso(new.revisada_por, 'retiro.revisar', x.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, x.sucursal_id) r where r = new.nivel) then
    raise exception 'Este retiro lo revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
