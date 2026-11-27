-- 0049 · Bloque 6, PR 5: pago y comprobante de un gasto autorizado (acordado el 27 nov 2026; solo datos ficticios;
-- las fotos esperan a que se active el almacenamiento).
--   - Cinco orígenes, cada uno distinto: bolsa de visitas, cajón de mensualidades, transferencia, tarjeta y dinero
--     personal (queda pendiente de reembolso; el reembolso llega en el PR 7).
--   - Solo se paga la versión vigente ya autorizada, por lo realmente pagado y nunca más de lo autorizado (lo que pase
--     de ahí se pide como excedente, con su propia autorización). Un pago por solicitud.
--   - Efectivo (bolsa o cajón): lo registra la responsable vigente del lugar, con el turno abierto de la sucursal que
--     paga; la salida se registra una sola vez al pagar (salida_pago_gasto). La de la bolsa baja el esperado; la del
--     cajón se registra, pero su esperado sigue sin calcularse mientras falten los datos de Open Desk.
--   - Transferencia y tarjeta: solo el nombre corto de la cuenta o tarjeta (nunca números) y la referencia.
--   - Quien autorizó no paga ese gasto, salvo Dirección. La fecha del pago no es anterior a la autorización.
--   - Comprobantes: ticket, nota o factura (varios por gasto); o «sin comprobante» con motivo, para revisión de
--     Dirección. Nada se edita ni se borra.

insert into rol_permiso (rol, permiso) values
  ('recepcion',              'gasto.pagar'),
  ('encargado',              'gasto.pagar'),
  ('administracion',         'gasto.pagar'),
  ('gestion_administrativa', 'gasto.pagar'),
  ('direccion',              'gasto.pagar');

create table pago_gasto (
  id             uuid primary key default gen_random_uuid(),
  gasto_id       uuid not null unique references gasto (id),
  version        integer not null,
  origen         text not null check (origen in ('bolsa_visitas', 'cajon_mensualidades', 'transferencia', 'tarjeta', 'dinero_personal')),
  importe        numeric(12, 2) not null check (importe > 0),
  pagado_el      date not null,
  pagado_por     uuid not null references usuario (id),
  registrado_por uuid not null references usuario (id),
  a_quien        text check (a_quien is null or char_length(btrim(a_quien)) between 2 and 120),
  -- Transferencia o tarjeta: nombre corto (sin números de cuenta ni de tarjeta) y referencia de la operación.
  cuenta         text check (cuenta is null or (char_length(btrim(cuenta)) between 2 and 40 and cuenta !~ '[0-9]{4}')),
  referencia     text check (referencia is null or char_length(btrim(referencia)) between 3 and 60),
  en             timestamptz not null default now(),
  foreign key (gasto_id, version) references gasto_version (gasto_id, version),
  constraint pago_cuenta_segun_origen check (
    (origen in ('transferencia', 'tarjeta')) = (cuenta is not null)
    and (origen <> 'transferencia' or referencia is not null)),
  constraint pago_efectivo_de_quien_registra check (origen not in ('bolsa_visitas', 'cajon_mensualidades', 'dinero_personal') or pagado_por = registrado_por)
);

alter table movimiento_efectivo add column pago_gasto_id uuid unique references pago_gasto (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null and sobre_id is null and devolucion_id is null and pago_gasto_id is null)
  or (tipo = 'salida_sobre' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is not null and devolucion_id is null and pago_gasto_id is null)
  or (tipo = 'salida_devolucion_cambio' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is not null and pago_gasto_id is null)
  or (tipo = 'salida_pago_gasto' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is not null));

create function pago_gasto_valido() returns trigger
language plpgsql as $$
declare
  g record;
  v record;
  d record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'pago_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into g from gasto where id = new.gasto_id for update;
  select version into v from gasto_version where gasto_id = new.gasto_id order by version desc limit 1;
  select * into d from decision_gasto where gasto_id = new.gasto_id and version = v.version;
  if new.version <> v.version or d is null or d.decision <> 'autorizado' then
    raise exception 'Solo se paga la versión vigente ya autorizada' using errcode = 'check_violation';
  end if;
  if new.importe > d.importe then
    raise exception 'El pago no puede pasar de lo autorizado: el excedente se pide aparte' using errcode = 'check_violation';
  end if;
  if new.pagado_el < dia_en_sucursal(g.sucursal_paga_id, d.en) or new.pagado_el > dia_en_sucursal(g.sucursal_paga_id, now()) then
    raise exception 'La fecha del pago va desde la autorización hasta hoy' using errcode = 'check_violation';
  end if;
  if new.pagado_por = d.por and not exists (select 1 from perfiles_en_sucursal(new.pagado_por, g.sucursal_paga_id) r where r = 'direccion') then
    raise exception 'Quien autorizó el gasto no lo paga' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.registrado_por, 'gasto.pagar', g.sucursal_paga_id) then
    raise exception 'Sin permiso para registrar pagos en la sucursal que paga' using errcode = 'check_violation';
  end if;
  if new.origen = 'transferencia' and not exists (select 1 from perfiles_en_sucursal(new.registrado_por, g.sucursal_paga_id) r
                                                  where r in ('administracion', 'gestion_administrativa', 'direccion')) then
    raise exception 'Las transferencias las registra Administración, Gestión administrativa o Dirección' using errcode = 'check_violation';
  end if;
  if new.origen in ('bolsa_visitas', 'cajon_mensualidades') and new.pagado_el <> dia_en_sucursal(g.sucursal_paga_id, now()) then
    raise exception 'El pago en efectivo se registra al pagar' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger pago_gasto_valido before insert or update or delete on pago_gasto
  for each row execute function pago_gasto_valido();
create trigger pago_gasto_sin_vaciar before truncate on pago_gasto
  for each statement execute function impedir_modificacion();

-- El pago en efectivo tiene exactamente su salida: del lugar de su origen, de la sucursal que paga, en el turno abierto,
-- registrada por la responsable vigente de ese lugar, por menos lo pagado.
create function pago_gasto_salida() returns trigger
language plpgsql as $$
declare
  v_pago uuid;
  p record;
  m record;
begin
  if tg_table_name = 'pago_gasto' then
    v_pago := new.id;
  else
    v_pago := new.pago_gasto_id;
  end if;
  select * into p from pago_gasto where id = v_pago;
  if p is null then
    raise exception 'La salida por un gasto corresponde a un pago registrado' using errcode = 'check_violation';
  end if;
  if p.origen not in ('bolsa_visitas', 'cajon_mensualidades') then
    if exists (select 1 from movimiento_efectivo x where x.pago_gasto_id = p.id) then
      raise exception 'Un pago que no es en efectivo no tiene salida de caja' using errcode = 'check_violation';
    end if;
    return null;
  end if;
  select me.*, l.tipo as lugar, l.sucursal_id, t.cerrado_en,
         exists (select 1 from responsable_lugar r where r.lugar_id = me.lugar_id and r.turno_id = me.turno_id and r.hasta is null
                 and r.usuario_id = me.registrado_por) as responsable
    into m
  from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id join turno t on t.id = me.turno_id
  where me.pago_gasto_id = p.id;
  if m is null or m.lugar <> p.origen or m.importe <> -p.importe or m.sucursal_id <> (select sucursal_paga_id from gasto where id = p.gasto_id)
     or m.cerrado_en is not null or not m.responsable or m.registrado_por <> p.registrado_por then
    raise exception 'El pago en efectivo registra su salida del lugar, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger pago_gasto_salida after insert on pago_gasto
  deferrable initially deferred for each row execute function pago_gasto_salida();
create constraint trigger salida_pago_gasto_valida after insert on movimiento_efectivo
  deferrable initially deferred for each row when (new.tipo = 'salida_pago_gasto') execute function pago_gasto_salida();

-- Comprobantes (las fotos esperan al almacenamiento) y «sin comprobante» con motivo.
create table comprobante_gasto (
  id             uuid primary key default gen_random_uuid(),
  gasto_id       uuid not null references gasto (id),
  tipo           text not null check (tipo in ('ticket', 'nota', 'factura')),
  folio          text check (folio is null or char_length(btrim(folio)) between 1 and 60),
  registrado_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);
create table sin_comprobante_gasto (
  gasto_id       uuid primary key references gasto (id),
  motivo         text not null check (char_length(btrim(motivo)) between 5 and 300),
  registrado_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);

create function comprobante_gasto_valido() returns trigger
language plpgsql as $$
declare
  p record;
begin
  if tg_op <> 'INSERT' then
    raise exception '%: no se edita ni se borra', tg_table_name using errcode = 'insufficient_privilege';
  end if;
  select pg.registrado_por, g.solicitado_por into p from pago_gasto pg join gasto g on g.id = pg.gasto_id where pg.gasto_id = new.gasto_id;
  if p is null then
    raise exception 'El comprobante se registra después del pago' using errcode = 'check_violation';
  end if;
  if new.registrado_por not in (p.registrado_por, p.solicitado_por) then
    raise exception 'Registra el comprobante quien registró el pago o quien solicitó el gasto' using errcode = 'check_violation';
  end if;
  if tg_table_name = 'sin_comprobante_gasto' and exists (select 1 from comprobante_gasto c where c.gasto_id = new.gasto_id) then
    raise exception 'Este gasto ya tiene comprobante' using errcode = 'check_violation';
  end if;
  if tg_table_name = 'comprobante_gasto' and exists (select 1 from sin_comprobante_gasto c where c.gasto_id = new.gasto_id) then
    raise exception 'Este gasto quedó «sin comprobante» para revisión de Dirección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger comprobante_gasto_valido before insert or update or delete on comprobante_gasto
  for each row execute function comprobante_gasto_valido();
create trigger sin_comprobante_gasto_valido before insert or update or delete on sin_comprobante_gasto
  for each row execute function comprobante_gasto_valido();
create trigger comprobante_gasto_sin_vaciar before truncate on comprobante_gasto
  for each statement execute function impedir_modificacion();
create trigger sin_comprobante_gasto_sin_vaciar before truncate on sin_comprobante_gasto
  for each statement execute function impedir_modificacion();

-- Una vez pagado, la solicitud ya no se corrige (la decisión y el pago quedan sobre esa versión).
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
  return new;
end;
$$;
