-- Bloque 5, regla 7: ajustes del 18 nov 2026 (13:33) a la recolección, antes de unir (solo datos ficticios).
--   1. La devolución de una entrega cancelada es por sobre: solo los sobres recibidos físicamente vuelven a la caja. Un
--      sobre que no regresa sigue pendiente de devolución, con su incidencia y su cadena de custodia; puede devolverse
--      después en otra devolución.
--   2. Un problema con la llave de la caja de sobres al recoger o al devolver queda por revisar: lo revisa Administración
--      si no participó en esa operación.
--   Las dos llaves (caja de sobres y cajón de fondos) siguen registrándose por separado.

-- ---------------------------------------------------------------------------
-- Devolución por sobre
-- ---------------------------------------------------------------------------
-- Una entrega cancelada puede tener varias devoluciones (una por cada vez que regresan sobres).
alter table devolucion_recoleccion drop constraint devolucion_recoleccion_recoleccion_id_key;
create index devolucion_recoleccion_por_entrega on devolucion_recoleccion (recoleccion_id);
-- La revisión de la caja de cada devolución.
alter table devolucion_recoleccion add column revision_id uuid references revision_caja (id);
drop index revision_caja_por_recoleccion;
create unique index revision_caja_por_recoleccion on revision_caja (recoleccion_id) where momento = 'recoleccion';

-- Sobres recibidos físicamente en cada devolución.
create table devolucion_sobre (
  devolucion_id  uuid not null references devolucion_recoleccion (id),
  recoleccion_id uuid not null references recoleccion (id),
  sobre_id       uuid not null references sobre_cierre (id),
  primary key (recoleccion_id, sobre_id)
);
-- Las devoluciones registradas antes de este ajuste devolvieron todos los sobres de la entrega.
insert into devolucion_sobre (devolucion_id, recoleccion_id, sobre_id)
select d.id, d.recoleccion_id, x.sobre_id from devolucion_recoleccion d join recoleccion_sobre x on x.recoleccion_id = d.recoleccion_id;

create function devolucion_sobre_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from devolucion_recoleccion d join recoleccion_sobre x on x.recoleccion_id = d.recoleccion_id
                 where d.id = new.devolucion_id and d.recoleccion_id = new.recoleccion_id and x.sobre_id = new.sobre_id) then
    raise exception 'Se devuelve un sobre de esa entrega cancelada' using errcode = 'check_violation';
  end if;
  -- Recibido físicamente: la verificación de esa devolución no dice que falta.
  if not exists (select 1 from devolucion_recoleccion d join verificacion_sobre v on v.revision_id = d.revision_id
                 where d.id = new.devolucion_id and v.sobre_id = new.sobre_id and v.estado <> 'falta') then
    raise exception 'Solo vuelve a la caja un sobre recibido y verificado en la devolución' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger devolucion_sobre_valida
  before insert on devolucion_sobre
  for each row execute function devolucion_sobre_valida();
create trigger devolucion_sobre_inmutable
  before update or delete on devolucion_sobre
  for each row execute function impedir_modificacion();
create trigger devolucion_sobre_sin_vaciar
  before truncate on devolucion_sobre
  for each statement execute function impedir_modificacion();

-- Pendiente de devolución: está en una entrega cancelada y no se ha recibido de vuelta.
create or replace function sobre_por_devolver(p_sobre uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
    where x.sobre_id = p_sobre and r.estado = 'cancelada'
      and not exists (select 1 from devolucion_sobre d where d.recoleccion_id = r.id and d.sobre_id = p_sobre))
$$;

create or replace function sobre_en_caja(p_sobre uuid) returns boolean
language sql stable as $$
  select exists (select 1 from sobre_cierre s where s.id = p_sobre and s.estado = 'usado' and s.importe is not null)
     and not exists (select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
                     where x.sobre_id = p_sobre and r.estado = 'pendiente')
     and not sobre_por_devolver(p_sobre)
$$;

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
               where x.sobre_id = new.sobre_id and r.id <> new.recoleccion_id and r.estado = 'pendiente')
       or sobre_por_devolver(new.sobre_id) then
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

-- En una devolución solo se verifican los sobres de esa entrega que siguen pendientes de devolver.
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
      if r.momento = 'devolucion' and exists (select 1 from devolucion_sobre d where d.recoleccion_id = r.recoleccion_id and d.sobre_id = new.sobre_id) then
        raise exception 'Ese sobre ya se devolvió a la caja' using errcode = 'check_violation';
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

-- Un sobre puede tener varias incidencias en devoluciones de la misma entrega (por ejemplo, no regresa y después
-- regresa abierto): una por verificación. En la recolección confirmada, una por sobre.
drop index diferencia_sobre_por_entrega;
create unique index diferencia_sobre_por_verificacion on diferencia_sobre (verificacion_id) where verificacion_id is not null;
create unique index diferencia_sobre_por_conteo on diferencia_sobre (recoleccion_id, sobre_id) where verificacion_id is null;

-- ---------------------------------------------------------------------------
-- Llave de la caja de sobres con problema al recoger o al devolver
-- ---------------------------------------------------------------------------
-- Quién participó en una recolección o devolución: quien entregó, Dirección que recibió (y devuelve), y quien verificó o
-- recibió la llave en cada revisión de esa entrega.
create function participantes_recoleccion(p_recoleccion uuid) returns setof uuid
language sql stable as $$
  select r.entrega_por from recoleccion r where r.id = p_recoleccion
  union select r.recibe from recoleccion r where r.id = p_recoleccion
  union select x.por from revision_caja x where x.recoleccion_id = p_recoleccion
  union select x.custodio_id from revision_caja x where x.recoleccion_id = p_recoleccion
  union select d.recibida_por from devolucion_recoleccion d where d.recoleccion_id = p_recoleccion
  union select d.devuelve_por from devolucion_recoleccion d where d.recoleccion_id = p_recoleccion
$$;

create table incidencia_llave_recoleccion (
  id             uuid primary key default gen_random_uuid(),
  recoleccion_id uuid not null references recoleccion (id),
  revision_id    uuid not null unique references revision_caja (id),
  creada_en      timestamptz not null default now()
);
create function incidencia_llave_recoleccion_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from revision_caja r where r.id = new.revision_id and r.recoleccion_id = new.recoleccion_id
                   and r.momento in ('recoleccion', 'devolucion') and r.llave = 'incidencia') then
    raise exception 'No hubo problema con la llave de la caja de sobres en esa recolección o devolución' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger incidencia_llave_recoleccion_valida
  before insert on incidencia_llave_recoleccion
  for each row execute function incidencia_llave_recoleccion_valida();
create trigger incidencia_llave_recoleccion_inmutable
  before update or delete on incidencia_llave_recoleccion
  for each row execute function impedir_modificacion();
create trigger incidencia_llave_recoleccion_sin_vaciar
  before truncate on incidencia_llave_recoleccion
  for each statement execute function impedir_modificacion();
-- Las que ya hubiera (en pruebas) quedan por revisar.
insert into incidencia_llave_recoleccion (recoleccion_id, revision_id)
select r.recoleccion_id, r.id from revision_caja r where r.momento in ('recoleccion', 'devolucion') and r.llave = 'incidencia';

create table revision_incidencia_llave (
  id            uuid primary key default gen_random_uuid(),
  incidencia_id uuid not null unique references incidencia_llave_recoleccion (id),
  resultado     text not null check (resultado in ('aclarada', 'incidencia_confirmada')),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  revisada_por  uuid not null references usuario (id),
  en            timestamptz not null default now()
);
-- Revisa Administración si no participó en esa recolección o devolución.
create function revision_incidencia_llave_valida() returns trigger
language plpgsql as $$
declare
  i record;
begin
  select x.recoleccion_id, r.sucursal_id into i
  from incidencia_llave_recoleccion x join recoleccion r on r.id = x.recoleccion_id where x.id = new.incidencia_id;
  if new.revisada_por in (select participantes_recoleccion(i.recoleccion_id)) then
    raise exception 'Quien participó en la recolección o devolución no revisa su incidencia' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.revisada_por, i.sucursal_id) p where p = 'administracion')
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', i.sucursal_id) then
    raise exception 'Revisa Administración' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger revision_incidencia_llave_valida
  before insert on revision_incidencia_llave
  for each row execute function revision_incidencia_llave_valida();
create trigger revision_incidencia_llave_inmutable
  before update or delete on revision_incidencia_llave
  for each row execute function impedir_modificacion();
create trigger revision_incidencia_llave_sin_vaciar
  before truncate on revision_incidencia_llave
  for each statement execute function impedir_modificacion();
