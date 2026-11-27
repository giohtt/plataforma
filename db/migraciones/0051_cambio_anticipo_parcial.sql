-- 0051 · Bloque 6, PR 6: devoluciones parciales del cambio de un anticipo (pedido el 27 nov 2026; solo datos ficticios).
--   - El cambio puede devolverse en varias partes. Cada devolución la cuenta y la recibe la responsable vigente del lugar
--     del anticipo (no quien lo devuelve), entra a caja una vez y nunca pasa de lo que falta por devolver.
--   - Mientras falte cambio por devolver, el anticipo sigue abierto por lo pendiente.

alter table anticipo_cambio drop constraint anticipo_cambio_pkey;
alter table anticipo_cambio add column id uuid not null default gen_random_uuid();
alter table anticipo_cambio add primary key (id);
create index anticipo_cambio_de on anticipo_cambio (anticipo_id);

-- Cada entrada de cambio corresponde a una devolución; la entrega sigue siendo una sola salida por anticipo.
alter table movimiento_efectivo add column cambio_anticipo_id uuid unique references anticipo_cambio (id);
alter table movimiento_efectivo add constraint movimiento_cambio_anticipo
  check ((tipo = 'entrada_cambio_anticipo') = (cambio_anticipo_id is not null));
drop index movimiento_anticipo_unico;
create unique index movimiento_anticipo_salida_unica on movimiento_efectivo (anticipo_id) where tipo = 'salida_anticipo_gasto';

-- Una devolución y su entrada a caja van juntas: mismo importe, al lugar del anticipo, en el turno abierto de la
-- sucursal que paga, por la responsable vigente que la recibió.
create function verificar_cambio_anticipo(p_cambio uuid) returns void
language plpgsql as $$
declare
  c record;
  a record;
  m record;
begin
  select * into c from anticipo_cambio where id = p_cambio;
  select * into a from anticipo_gasto where id = c.anticipo_id;
  select me.*, l.tipo as lugar_tipo, l.sucursal_id, t.cerrado_en,
         exists (select 1 from responsable_lugar r where r.lugar_id = me.lugar_id and r.turno_id = me.turno_id and r.hasta is null
                 and r.usuario_id = me.registrado_por) as responsable
    into m
  from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id join turno t on t.id = me.turno_id
  where me.cambio_anticipo_id = p_cambio;
  if c.id is null or m.id is null or m.anticipo_id <> c.anticipo_id or m.lugar_tipo <> a.lugar or m.importe <> c.importe
     or m.sucursal_id <> (select sucursal_paga_id from gasto where id = a.gasto_id)
     or m.cerrado_en is not null or not m.responsable or m.registrado_por <> c.recibido_por then
    raise exception 'El cambio del anticipo entra al lugar del anticipo, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
end;
$$;

create or replace function anticipo_verificar_cambio() returns trigger language plpgsql as $$
begin perform verificar_cambio_anticipo(new.id); return null; end;
$$;
create or replace function anticipo_verificar_movimiento() returns trigger language plpgsql as $$
begin
  if new.tipo = 'salida_anticipo_gasto' then
    perform verificar_anticipo(new.anticipo_id, new.tipo);
  else
    perform verificar_cambio_anticipo(new.cambio_anticipo_id);
  end if;
  return null;
end;
$$;

-- Confirmación, comprobación y devoluciones del cambio, en orden y cuadrando.
create or replace function anticipo_paso_valido() returns trigger
language plpgsql as $$
declare
  a record;
  p record;
  k record;
  x record;
  v_devuelto numeric(12, 2);
begin
  if tg_op <> 'INSERT' then
    raise exception '%: no se edita ni se borra', tg_table_name using errcode = 'insufficient_privilege';
  end if;
  select * into a from anticipo_gasto where id = new.anticipo_id for update;
  if tg_table_name = 'anticipo_comprobado' then
    if not exists (select 1 from anticipo_recibido r where r.anticipo_id = a.id) then
      raise exception 'Primero, quien recibe el anticipo confirma que lo recibió' using errcode = 'check_violation';
    end if;
    select * into p from pago_gasto where id = new.pago_id;
    if p is null or p.gasto_id <> a.gasto_id or p.origen <> 'anticipo' or p.pagado_por <> a.recibe or p.importe <> least(new.gastado, a.importe)
       or new.cambio <> greatest(a.importe - new.gastado, 0) or new.excedente <> greatest(new.gastado - a.importe, 0) then
      raise exception 'La comprobación cuadra: lo pagado con el anticipo, el cambio y el excedente' using errcode = 'check_violation';
    end if;
    if new.excedente_gasto_id is not null then
      select g.sucursal_id, g.compra_de, v.importe into x
      from gasto g join gasto_version v on v.gasto_id = g.id and v.version = 1 where g.id = new.excedente_gasto_id;
      if x.compra_de is distinct from (select coalesce(compra_de, id) from gasto where id = a.gasto_id) or x.importe <> new.excedente
         or x.sucursal_id <> (select sucursal_id from gasto where id = a.gasto_id) then
        raise exception 'El excedente es otra solicitud de la misma compra, por la diferencia' using errcode = 'check_violation';
      end if;
    end if;
  elsif tg_table_name = 'anticipo_cambio' then
    select * into k from anticipo_comprobado where anticipo_id = a.id;
    select coalesce(sum(importe), 0) into v_devuelto from anticipo_cambio where anticipo_id = a.id;
    if k is null or k.cambio = 0 or v_devuelto + new.importe > k.cambio then
      raise exception 'Lo devuelto del cambio no pasa de lo que quedó después de comprobar' using errcode = 'check_violation';
    end if;
    if new.recibido_por = a.recibe then
      raise exception 'El cambio lo recibe la responsable del lugar, no quien lo devuelve' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
