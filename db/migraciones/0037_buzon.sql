-- Bloque 5, regla 7: buzón de depósito (aprobado el 18 nov 2026, 19:10; solo datos ficticios).
--   1. Dos sobres al día (visitas y mensualidades), preparados y sellados solo al cerrar. Un lugar sin excedente sobre su
--      fondo no genera sobre. Quien cierra registra que depositó cada sobre en el buzón.
--   2. El buzón está separado del cajón de los fondos. Su llave la tiene solo Dirección (acceso exclusivo). Los fondos
--      ($300 y $300) se quedan en el cajón; su llave pasa con el turno y se sigue registrando.
--   3. Al abrir se cuentan solo los fondos; en el cambio de turno se sigue contando y confirmando todo el efectivo de cada
--      lugar. Ya no se verifican los sobres en cada turno: se muestran como «registrados como depositados».
--   4. Dirección recoge del buzón: verifica sello y folio y cuenta cada sobre a ciegas. Un sobre registrado como depositado
--      que no aparece queda «por investigar», sin atribuir el faltante a nadie. Siguen los depósitos parciales y el aviso
--      de ocho días por sobre.
-- Pendientes de decidir (no se programan): cómo se cierra una investigación y qué pasa si el sobre aparece después,
-- testigo al abrir el buzón y acceso de respaldo (llave perdida o Dirección no disponible).
-- Las configuraciones anteriores (sin buzón) siguen funcionando como antes.

-- ---------------------------------------------------------------------------
-- Configuración: buzón con llave solo de Dirección
-- ---------------------------------------------------------------------------
-- Con buzón: «lugar» es dónde está el buzón y «acceso» quién tiene su llave (solo Dirección); «custodias» son quienes
-- pueden quedarse con la llave del cajón de los fondos al cerrar.
alter table custodia_configuracion add column buzon boolean not null default false;
create function custodia_configuracion_buzon() returns trigger
language plpgsql as $$
begin
  if new.buzon and (new.custodias is null or new.acceso_cajon is null or exists (
    select 1 from unnest(new.acceso) a(u)
    where not exists (select 1 from perfiles_en_sucursal(a.u, new.sucursal_id) p where p = 'direccion')
       or not tiene_permiso(a.u, 'sobre.recoger', new.sucursal_id))) then
    raise exception 'La llave del buzón es solo de Dirección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_configuracion_buzon
  before insert on custodia_configuracion
  for each row execute function custodia_configuracion_buzon();

-- Buzón de la configuración con que se cerró (null si no fue un cierre).
create function cierre_con_buzon(p_entrega uuid) returns boolean
language sql stable as $$
  select coalesce((select k.buzon from entrega_turno e join custodia_configuracion k on k.id = e.custodia_config_id where e.id = p_entrega), false)
$$;

-- ---------------------------------------------------------------------------
-- Depósito en el buzón al cerrar
-- ---------------------------------------------------------------------------
create table sobre_depositado (
  sobre_id       uuid primary key references sobre_cierre (id),
  depositado_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);
create function sobre_depositado_valido() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from sobre_cierre s join entrega_turno e on e.id = s.entrega_id
                 where s.id = new.sobre_id and s.estado = 'usado' and s.importe is not null and e.tipo = 'cierre'
                   and e.sobres_guardados and e.entrega_por = new.depositado_por and cierre_con_buzon(e.id)) then
    raise exception 'Registra el depósito en el buzón quien cerró, de un sobre de ese cierre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger sobre_depositado_valido
  before insert on sobre_depositado
  for each row execute function sobre_depositado_valido();
create trigger sobre_depositado_inmutable
  before update or delete on sobre_depositado
  for each row execute function impedir_modificacion();
create trigger sobre_depositado_sin_vaciar
  before truncate on sobre_depositado
  for each statement execute function impedir_modificacion();

-- Con buzón, todo sobre usado en el cierre queda registrado como depositado (al terminar la transacción del cierre).
create function sobre_buzon_depositado() returns trigger
language plpgsql as $$
begin
  if new.estado = 'usado' and new.importe is not null and cierre_con_buzon(new.entrega_id)
     and not exists (select 1 from sobre_depositado d where d.sobre_id = new.id) then
    raise exception 'Con buzón, cada sobre del cierre se registra como depositado' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger sobre_buzon_depositado
  after update on sobre_cierre deferrable initially deferred
  for each row execute function sobre_buzon_depositado();

-- ---------------------------------------------------------------------------
-- Revisión de la caja: con buzón no hay llave de la caja de sobres en los turnos (solo la del cajón)
-- ---------------------------------------------------------------------------
alter table revision_caja alter column llave drop not null;
alter table revision_caja add constraint revision_llave_buzon check (
  (llave is not null or momento in ('cierre', 'apertura', 'cambio_turno')) and (llave is not null or motivo_llave is null));

-- ---------------------------------------------------------------------------
-- Recolección del buzón por Dirección (sin entrega de la responsable en turno)
-- ---------------------------------------------------------------------------
alter table recoleccion add column buzon boolean not null default false;
alter table recoleccion alter column entrega_por drop not null;
alter table recoleccion alter column turno_id drop not null;
alter table recoleccion add constraint recoleccion_buzon check (buzon = (entrega_por is null) and buzon = (turno_id is null));

create or replace function recoleccion_valida() returns trigger
language plpgsql as $$
declare
  k record;
begin
  if tg_op = 'DELETE' then
    raise exception 'recoleccion no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' then
      raise exception 'La recolección empieza pendiente' using errcode = 'check_violation';
    end if;
    if new.buzon then
      select x.buzon, x.acceso into k from custodia_configuracion x where x.sucursal_id = new.sucursal_id order by x.en desc, x.id limit 1;
      if k.buzon is not true or not (new.recibe = any(k.acceso))
         or not tiene_permiso(new.recibe, 'sobre.recoger', new.sucursal_id)
         or not exists (select 1 from perfiles_en_sucursal(new.recibe, new.sucursal_id) p where p = 'direccion') then
        raise exception 'Recoge del buzón Dirección con su llave' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if not tiene_permiso(new.entrega_por, 'sobre.entregar', new.sucursal_id)
       or not exists (select 1 from responsable_lugar r join turno t on t.id = r.turno_id
                      where r.turno_id = new.turno_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null
                        and r.hasta is null and r.usuario_id = new.entrega_por)
       or not tiene_permiso(new.recibe, 'sobre.recoger', new.sucursal_id)
       or not exists (select 1 from perfiles_en_sucursal(new.recibe, new.sucursal_id) p where p = 'direccion') then
      raise exception 'Entrega la responsable en turno y recibe Dirección de la sucursal' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.estado <> 'pendiente'
     or (new.id, new.sucursal_id, new.turno_id, new.entrega_por, new.recibe, new.creada_en, new.buzon)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.entrega_por, old.recibe, old.creada_en, old.buzon) then
    raise exception 'recoleccion: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  -- Se confirma con el conteo de cada sobre; en el buzón, un sobre que no está (verificado como «falta») no se cuenta.
  if new.estado = 'confirmada' and exists (
    select 1 from recoleccion_sobre x where x.recoleccion_id = new.id and x.contado is null
      and not (new.buzon and exists (select 1 from revision_caja r join verificacion_sobre v on v.revision_id = r.id
                                      where r.recoleccion_id = new.id and r.momento = 'recoleccion' and v.sobre_id = x.sobre_id and v.estado = 'falta'))) then
    raise exception 'Se confirma con el conteo de cada sobre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sobre registrado como depositado que no aparece al recoger: por investigar, sin responsable asignado
-- ---------------------------------------------------------------------------
create table investigacion_sobre (
  id              uuid primary key default gen_random_uuid(),
  sobre_id        uuid not null unique references sobre_cierre (id),
  recoleccion_id  uuid not null references recoleccion (id),
  verificacion_id bigint not null unique references verificacion_sobre (id),
  creada_en       timestamptz not null default now()
);
create function investigacion_sobre_valida() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from recoleccion r join revision_caja rc on rc.recoleccion_id = r.id and rc.momento = 'recoleccion'
    join verificacion_sobre v on v.revision_id = rc.id
    join recoleccion_sobre x on x.recoleccion_id = r.id and x.sobre_id = v.sobre_id
    where r.id = new.recoleccion_id and r.buzon and r.estado = 'confirmada' and v.id = new.verificacion_id
      and v.sobre_id = new.sobre_id and v.estado = 'falta' and x.contado is null) then
    raise exception 'Se investiga un sobre que no estaba en el buzón al recoger' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger investigacion_sobre_valida
  before insert on investigacion_sobre
  for each row execute function investigacion_sobre_valida();
create trigger investigacion_sobre_inmutable
  before update or delete on investigacion_sobre
  for each row execute function impedir_modificacion();
create trigger investigacion_sobre_sin_vaciar
  before truncate on investigacion_sobre
  for each statement execute function impedir_modificacion();

-- Un sobre por investigar ya no está registrado en el buzón (no se vuelve a pedir ni se suma a lo recogido).
create or replace function sobre_en_caja(p_sobre uuid) returns boolean
language sql stable as $$
  select exists (select 1 from sobre_cierre s where s.id = p_sobre and s.estado = 'usado' and s.importe is not null)
     and not exists (select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
                     where x.sobre_id = p_sobre and r.estado = 'pendiente')
     and not sobre_por_devolver(p_sobre)
     and not exists (select 1 from investigacion_sobre i where i.sobre_id = p_sobre)
$$;

-- Solo se entrega o se recoge un sobre que sigue en la caja o en el buzón.
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
    if not sobre_en_caja(new.sobre_id) then
      raise exception 'El sobre no está en la caja: está en otra entrega pendiente, por devolver o por investigar' using errcode = 'check_violation';
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

-- Lo depositado nunca pasa de lo recogido (un sobre por investigar no suma).
create or replace function deposito_recoleccion_valido() returns trigger
language plpgsql as $$
declare
  r record;
begin
  select x.estado, x.recibe into r from recoleccion x where x.id = new.recoleccion_id for update;
  if r.estado is distinct from 'confirmada' or new.registrado_por <> r.recibe then
    raise exception 'Registra los depósitos quien recogió, de una recolección confirmada' using errcode = 'check_violation';
  end if;
  if (select coalesce(sum(d.importe), 0) from deposito_recoleccion d where d.recoleccion_id = new.recoleccion_id) + new.importe
     > (select coalesce(sum(x.contado), 0) from recoleccion_sobre x where x.recoleccion_id = new.recoleccion_id) then
    raise exception 'Los depósitos no pueden pasar de lo recogido' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Participantes sin vacíos (en el buzón no hay quien entregue).
create or replace function participantes_sobre(p_sobre uuid) returns setof uuid
language sql stable as $$
  select u from (
    select e.entrega_por as u from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
    union select e.custodio_id from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
    union select v.verificado_por from verificacion_sobre v where v.sobre_id = p_sobre
    union select r.custodio_id from verificacion_sobre v join revision_caja r on r.id = v.revision_id where v.sobre_id = p_sobre
    union select x.entrega_por from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
    union select x.recibe from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
    union select d.recibida_por from devolucion_recoleccion d join recoleccion_sobre y on y.recoleccion_id = d.recoleccion_id where y.sobre_id = p_sobre
  ) p where u is not null
$$;

create or replace function participantes_recoleccion(p_recoleccion uuid) returns setof uuid
language sql stable as $$
  select u from (
    select r.entrega_por as u from recoleccion r where r.id = p_recoleccion
    union select r.recibe from recoleccion r where r.id = p_recoleccion
    union select x.por from revision_caja x where x.recoleccion_id = p_recoleccion
    union select x.custodio_id from revision_caja x where x.recoleccion_id = p_recoleccion
    union select d.recibida_por from devolucion_recoleccion d where d.recoleccion_id = p_recoleccion
    union select d.devuelve_por from devolucion_recoleccion d where d.recoleccion_id = p_recoleccion
  ) p where u is not null
$$;
