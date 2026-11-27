-- 0050 · Bloque 6, PR 6: anticipos para compras (acordado el 27 nov 2026; solo datos ficticios).
--   - Para un gasto autorizado, la responsable vigente de la bolsa o el cajón (turno abierto de la sucursal que paga)
--     entrega un anticipo a otra persona de la sucursal, que irá a comprar; sale de caja al entregarse
--     (salida_anticipo_gasto). Esa persona confirma desde su cuenta que lo recibió; queda a su cargo.
--   - Al regresar, comprueba: cuánto se pagó al proveedor y en qué fecha (es la fecha del gasto), y su comprobante.
--     · Si gastó menos: el gasto queda por lo real y hay cambio por devolver; lo cuenta y lo recibe la responsable
--       vigente de ese lugar (entrada_cambio_anticipo), por el importe exacto.
--     · Si necesitó más: el excedente es otra solicitud de la misma compra, con su propia autorización y su propio pago
--       (de caja o con dinero personal, que queda pendiente de reembolso). Lo autorizado y lo entregado van aparte.
--   - El pago del gasto con anticipo se registra con origen «anticipo» (sin otra salida de caja): nunca se cuenta dos
--     veces. Se conservan las fechas de entrega, de pago al proveedor y de comprobación. Nada se edita ni se borra.

alter table pago_gasto drop constraint pago_gasto_origen_check;
alter table pago_gasto add constraint pago_gasto_origen_check
  check (origen in ('bolsa_visitas', 'cajon_mensualidades', 'transferencia', 'tarjeta', 'dinero_personal', 'anticipo'));
alter table pago_gasto drop constraint pago_efectivo_de_quien_registra;
alter table pago_gasto add constraint pago_efectivo_de_quien_registra
  check (origen not in ('bolsa_visitas', 'cajon_mensualidades', 'dinero_personal', 'anticipo') or pagado_por = registrado_por);

create table anticipo_gasto (
  id            uuid primary key default gen_random_uuid(),
  gasto_id      uuid not null unique references gasto (id),
  version       integer not null,
  lugar         text not null check (lugar in ('bolsa_visitas', 'cajon_mensualidades')),
  importe       numeric(12, 2) not null check (importe > 0),
  entregado_por uuid not null references usuario (id),
  recibe        uuid not null references usuario (id),
  en            timestamptz not null default now(),
  foreign key (gasto_id, version) references gasto_version (gasto_id, version),
  constraint anticipo_a_otra_persona check (recibe <> entregado_por)
);
create table anticipo_recibido (
  anticipo_id uuid primary key references anticipo_gasto (id),
  en          timestamptz not null default now()
);
create table anticipo_comprobado (
  anticipo_id   uuid primary key references anticipo_gasto (id),
  gastado       numeric(12, 2) not null check (gastado > 0),
  cambio        numeric(12, 2) not null check (cambio >= 0),
  excedente     numeric(12, 2) not null check (excedente >= 0),
  pago_id       uuid not null unique references pago_gasto (id),
  excedente_gasto_id uuid unique references gasto (id),
  en            timestamptz not null default now(),
  constraint anticipo_cuadra check (cambio = 0 or excedente = 0),
  constraint anticipo_excedente_ligado check ((excedente > 0) = (excedente_gasto_id is not null))
);
create table anticipo_cambio (
  anticipo_id  uuid primary key references anticipo_gasto (id),
  importe      numeric(12, 2) not null check (importe > 0),
  recibido_por uuid not null references usuario (id),
  en           timestamptz not null default now()
);

alter table movimiento_efectivo add column anticipo_id uuid references anticipo_gasto (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'salida_sobre' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is not null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'salida_devolucion_cambio' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is not null and pago_gasto_id is null and anticipo_id is null)
  or (tipo = 'salida_pago_gasto' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is not null and anticipo_id is null)
  or (tipo in ('salida_anticipo_gasto', 'entrada_cambio_anticipo') and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null
      and devolucion_id is null and pago_gasto_id is null and anticipo_id is not null
      and (tipo = 'salida_anticipo_gasto') = (importe < 0) and importe <> 0));
-- Una entrega y, como máximo, un cambio por anticipo.
create unique index movimiento_anticipo_unico on movimiento_efectivo (anticipo_id, tipo) where anticipo_id is not null;

-- Entrega: gasto autorizado en su versión vigente, sin pago; por lo autorizado (propuesta); quien recibe es de la sucursal que
-- paga (gasto.pagar) y no lo autorizó (salvo Dirección); la salida, del lugar y por la responsable vigente.
create function anticipo_gasto_valido() returns trigger
language plpgsql as $$
declare
  g record;
  v record;
  d record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'anticipo_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into g from gasto where id = new.gasto_id for update;
  select version into v from gasto_version where gasto_id = new.gasto_id order by version desc limit 1;
  select * into d from decision_gasto where gasto_id = new.gasto_id and version = v.version;
  if new.version <> v.version or d is null or d.decision <> 'autorizado' or exists (select 1 from pago_gasto p where p.gasto_id = new.gasto_id) then
    raise exception 'El anticipo es para un gasto autorizado en su versión vigente y sin pagar' using errcode = 'check_violation';
  end if;
  if new.importe <> d.importe then
    raise exception 'El anticipo es por lo autorizado (para entregar otra cantidad, se corrige la solicitud y se autoriza de nuevo)' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.recibe, 'gasto.pagar', g.sucursal_paga_id) then
    raise exception 'Quien recibe el anticipo es de la sucursal que paga' using errcode = 'check_violation';
  end if;
  if new.recibe = d.por and not exists (select 1 from perfiles_en_sucursal(new.recibe, g.sucursal_paga_id) r where r = 'direccion') then
    raise exception 'Quien autorizó el gasto no recibe su anticipo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger anticipo_gasto_valido before insert or update or delete on anticipo_gasto
  for each row execute function anticipo_gasto_valido();

-- Comprueba los movimientos de caja de un anticipo: la entrega (menos el anticipo, del lugar, turno abierto, por la
-- responsable vigente que lo entregó) y, si hay, el cambio (por su importe, al mismo lugar, turno abierto, por la
-- responsable vigente que lo recibió).
create function verificar_anticipo(p_anticipo uuid, p_tipo text) returns void
language plpgsql as $$
declare
  a record;
  m record;
  c record;
begin
  select * into a from anticipo_gasto where id = p_anticipo;
  if p_tipo = 'salida_anticipo_gasto' then
  select me.*, l.tipo as lugar_tipo, l.sucursal_id, t.cerrado_en,
         exists (select 1 from responsable_lugar r where r.lugar_id = me.lugar_id and r.turno_id = me.turno_id and r.hasta is null
                 and r.usuario_id = me.registrado_por) as responsable
    into m
  from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id join turno t on t.id = me.turno_id
  where me.anticipo_id = p_anticipo and me.tipo = 'salida_anticipo_gasto';
  if a is null or m.id is null or m.lugar_tipo <> a.lugar or m.importe <> -a.importe
     or m.sucursal_id <> (select sucursal_paga_id from gasto where id = a.gasto_id)
     or m.cerrado_en is not null or not m.responsable or m.registrado_por <> a.entregado_por then
    raise exception 'El anticipo registra su salida del lugar, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
  return;
  end if;
  -- El cambio puede entrar en un turno posterior al de la entrega (el del día en que regresa).
  select * into c from anticipo_cambio where anticipo_id = p_anticipo;
  select me.*, l.tipo as lugar_tipo, l.sucursal_id, t.cerrado_en,
         exists (select 1 from responsable_lugar r where r.lugar_id = me.lugar_id and r.turno_id = me.turno_id and r.hasta is null
                 and r.usuario_id = me.registrado_por) as responsable
    into m
  from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id join turno t on t.id = me.turno_id
  where me.anticipo_id = p_anticipo and me.tipo = 'entrada_cambio_anticipo';
  if (c.anticipo_id is null) <> (m.id is null) then
    raise exception 'El cambio del anticipo y su entrada a caja van juntos' using errcode = 'check_violation';
  end if;
  if c.anticipo_id is not null and (m.lugar_tipo <> a.lugar or m.importe <> c.importe or m.sucursal_id <> (select sucursal_paga_id from gasto where id = a.gasto_id)
     or m.cerrado_en is not null or not m.responsable or m.registrado_por <> c.recibido_por) then
    raise exception 'El cambio del anticipo entra al lugar del anticipo, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
end;
$$;

create function anticipo_verificar_entrega() returns trigger language plpgsql as $$
begin perform verificar_anticipo(new.id, 'salida_anticipo_gasto'); return null; end;
$$;
create function anticipo_verificar_cambio() returns trigger language plpgsql as $$
begin perform verificar_anticipo(new.anticipo_id, 'entrada_cambio_anticipo'); return null; end;
$$;
create function anticipo_verificar_movimiento() returns trigger language plpgsql as $$
begin perform verificar_anticipo(new.anticipo_id, new.tipo); return null; end;
$$;
create constraint trigger anticipo_con_salida after insert on anticipo_gasto
  deferrable initially deferred for each row execute function anticipo_verificar_entrega();
create constraint trigger anticipo_cambio_con_entrada after insert on anticipo_cambio
  deferrable initially deferred for each row execute function anticipo_verificar_cambio();
create constraint trigger movimiento_anticipo_valido after insert on movimiento_efectivo
  deferrable initially deferred for each row when (new.anticipo_id is not null) execute function anticipo_verificar_movimiento();

-- Confirmación, comprobación y cambio, en orden y cuadrando.
create function anticipo_paso_valido() returns trigger
language plpgsql as $$
declare
  a record;
  p record;
  k record;
  x record;
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
    if k is null or k.cambio = 0 or new.importe <> k.cambio then
      raise exception 'El cambio se recibe por el importe exacto que quedó después de comprobar' using errcode = 'check_violation';
    end if;
    if new.recibido_por = a.recibe then
      raise exception 'El cambio lo recibe la responsable del lugar, no quien lo devuelve' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger anticipo_recibido_valido before insert or update or delete on anticipo_recibido
  for each row execute function anticipo_paso_valido();
create trigger anticipo_comprobado_valido before insert or update or delete on anticipo_comprobado
  for each row execute function anticipo_paso_valido();
create trigger anticipo_cambio_valido before insert or update or delete on anticipo_cambio
  for each row execute function anticipo_paso_valido();
create trigger anticipo_gasto_sin_vaciar before truncate on anticipo_gasto for each statement execute function impedir_modificacion();
create trigger anticipo_recibido_sin_vaciar before truncate on anticipo_recibido for each statement execute function impedir_modificacion();
create trigger anticipo_comprobado_sin_vaciar before truncate on anticipo_comprobado for each statement execute function impedir_modificacion();
create trigger anticipo_cambio_sin_vaciar before truncate on anticipo_cambio for each statement execute function impedir_modificacion();

-- Con anticipo, el pago es solo con origen «anticipo» y va con su comprobación; sin anticipo, nunca «anticipo».
create function pago_y_anticipo() returns trigger
language plpgsql as $$
declare
  a record;
begin
  select * into a from anticipo_gasto where gasto_id = new.gasto_id;
  if (a.id is not null) <> (new.origen = 'anticipo') then
    raise exception 'Un gasto con anticipo se paga con el anticipo (y uno sin anticipo, no)' using errcode = 'check_violation';
  end if;
  if new.origen = 'anticipo' and not exists (select 1 from anticipo_comprobado k where k.pago_id = new.id) then
    raise exception 'El pago con anticipo se registra con su comprobación' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger pago_y_anticipo after insert on pago_gasto
  deferrable initially deferred for each row execute function pago_y_anticipo();

-- Con anticipo entregado, la solicitud ya no se corrige (el dinero ya salió por lo autorizado).
create or replace function gasto_version_valida() returns trigger
language plpgsql as $$
declare
  g record;
  v_ultima integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'gasto_version: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select solicitado_por into g from gasto where id = new.gasto_id for update;
  select coalesce(max(version), 0) into v_ultima from gasto_version where gasto_id = new.gasto_id;
  if new.version <> v_ultima + 1 then
    raise exception 'La versión no es la siguiente: alguien más corrigió la solicitud' using errcode = 'serialization_failure';
  end if;
  if new.registrada_por <> g.solicitado_por then
    raise exception 'Solo quien solicitó el gasto lo corrige' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from categoria_gasto c where c.clave = new.categoria and c.activa) then
    raise exception 'La categoría no está activa' using errcode = 'check_violation';
  end if;
  if exists (select 1 from pago_gasto p where p.gasto_id = new.gasto_id) then
    raise exception 'El gasto ya se pagó: no se corrige' using errcode = 'check_violation';
  end if;
  if exists (select 1 from anticipo_gasto a where a.gasto_id = new.gasto_id) then
    raise exception 'El gasto ya tiene anticipo entregado: no se corrige' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
