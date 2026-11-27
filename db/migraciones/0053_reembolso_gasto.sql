-- 0053 · Bloque 6, PR 7: reembolsos (acordado el 27 nov 2026 en la maqueta, parte 2, punto 5; solo datos ficticios).
--   - Lo pagado con dinero personal queda pendiente de reembolso. Registrar ese pago no autoriza el reembolso: lo decide
--     Dirección (perfil de Dirección en la sucursal que paga y facultad de gasto vigente), desde su cuenta.
--   - Autorizado, se paga una sola vez, por lo pagado: de la bolsa o el cajón (salida «Reembolso» en el turno abierto,
--     por la responsable vigente) o por transferencia (Administración, Gestión administrativa o Dirección). Quien lo
--     recibe no se lo paga a sí misma.
--   - Quien lo recibe confirma desde su cuenta. El reembolso no es un gasto nuevo: el gasto ya contó al pagarse.
--   - Rechazar exige motivo. Nada se edita ni se borra.

create table decision_reembolso (
  pago_id   uuid primary key references pago_gasto (id),
  decision  text not null check (decision in ('autorizado', 'rechazado')),
  por       uuid not null references usuario (id),
  motivo    text check (motivo is null or char_length(motivo) between 5 and 300),
  en        timestamptz not null default now(),
  constraint rechazo_reembolso_con_motivo check (decision = 'autorizado' or motivo is not null)
);
create table reembolso_gasto (
  id             uuid primary key default gen_random_uuid(),
  pago_id        uuid not null unique references decision_reembolso (pago_id),
  origen         text not null check (origen in ('bolsa_visitas', 'cajon_mensualidades', 'transferencia')),
  importe        numeric(12, 2) not null check (importe > 0),
  pagado_por     uuid not null references usuario (id),
  cuenta         text check (cuenta is null or (char_length(cuenta) between 2 and 40 and cuenta !~ '[0-9]{4}')),
  referencia     text check (referencia is null or char_length(referencia) between 3 and 60),
  en             timestamptz not null default now(),
  constraint reembolso_cuenta_segun_origen check ((origen = 'transferencia') = (cuenta is not null))
);
create table reembolso_recibido (
  reembolso_id uuid primary key references reembolso_gasto (id),
  en           timestamptz not null default now()
);

alter table movimiento_efectivo add column reembolso_id uuid unique references reembolso_gasto (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'salida_sobre' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is not null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'salida_devolucion_cambio' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is not null and pago_gasto_id is null and anticipo_id is null and reembolso_id is null)
  or (tipo = 'salida_pago_gasto' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is not null and anticipo_id is null and reembolso_id is null)
  or (tipo in ('salida_anticipo_gasto', 'entrada_cambio_anticipo') and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null
      and devolucion_id is null and pago_gasto_id is null and anticipo_id is not null and reembolso_id is null
      and (tipo = 'salida_anticipo_gasto') = (importe < 0) and importe <> 0)
  or (tipo = 'salida_reembolso_gasto' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null and pago_gasto_id is null and anticipo_id is null and reembolso_id is not null));

-- Decide Dirección, sobre un pago con dinero personal, una vez.
create function decision_reembolso_valida() returns trigger
language plpgsql as $$
declare
  p record;
  g record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'decision_reembolso: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into p from pago_gasto where id = new.pago_id;
  if p.origen <> 'dinero_personal' then
    raise exception 'Solo se reembolsa lo pagado con dinero personal' using errcode = 'check_violation';
  end if;
  select * into g from gasto where id = p.gasto_id;
  if not exists (select 1 from perfiles_en_sucursal(new.por, g.sucursal_paga_id) r where r = 'direccion')
     or not exists (select 1 from facultad_gasto(new.por, g.sucursal_id))
     or not exists (select 1 from facultad_gasto(new.por, g.sucursal_paga_id)) then
    raise exception 'El reembolso lo decide Dirección, con su facultad de gasto vigente' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger decision_reembolso_valida before insert or update or delete on decision_reembolso
  for each row execute function decision_reembolso_valida();

-- Pago del reembolso: autorizado, por lo pagado, a otra persona; transferencia solo por quien la registra.
create function reembolso_gasto_valido() returns trigger
language plpgsql as $$
declare
  d record;
  p record;
  g record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'reembolso_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into d from decision_reembolso where pago_id = new.pago_id;
  select * into p from pago_gasto where id = new.pago_id;
  select * into g from gasto where id = p.gasto_id;
  if d.decision <> 'autorizado' then
    raise exception 'Solo se paga un reembolso autorizado' using errcode = 'check_violation';
  end if;
  if new.importe <> p.importe then
    raise exception 'El reembolso es por lo pagado con dinero personal' using errcode = 'check_violation';
  end if;
  if new.pagado_por = p.pagado_por then
    raise exception 'Quien recibe el reembolso no se lo paga a sí misma' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.pagado_por, 'gasto.pagar', g.sucursal_paga_id) then
    raise exception 'Sin permiso para pagar en la sucursal que paga' using errcode = 'check_violation';
  end if;
  if new.origen = 'transferencia' and not exists (select 1 from perfiles_en_sucursal(new.pagado_por, g.sucursal_paga_id) r
                                                  where r in ('administracion', 'gestion_administrativa', 'direccion')) then
    raise exception 'Las transferencias las registra Administración, Gestión administrativa o Dirección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger reembolso_gasto_valido before insert or update or delete on reembolso_gasto
  for each row execute function reembolso_gasto_valido();

-- En efectivo, exactamente una salida: del lugar, de la sucursal que paga, turno abierto, por la responsable vigente.
create function reembolso_salida() returns trigger
language plpgsql as $$
declare
  v_id uuid;
  r record;
  m record;
begin
  if tg_table_name = 'reembolso_gasto' then v_id := new.id; else v_id := new.reembolso_id; end if;
  select x.*, g.sucursal_paga_id into r from reembolso_gasto x join pago_gasto p on p.id = x.pago_id join gasto g on g.id = p.gasto_id where x.id = v_id;
  select me.*, l.tipo as lugar, l.sucursal_id, t.cerrado_en,
         exists (select 1 from responsable_lugar rl where rl.lugar_id = me.lugar_id and rl.turno_id = me.turno_id and rl.hasta is null
                 and rl.usuario_id = me.registrado_por) as responsable
    into m
  from movimiento_efectivo me join lugar_efectivo l on l.id = me.lugar_id join turno t on t.id = me.turno_id
  where me.reembolso_id = v_id;
  if r.origen = 'transferencia' then
    if m.id is not null then
      raise exception 'Un reembolso por transferencia no tiene salida de caja' using errcode = 'check_violation';
    end if;
    return null;
  end if;
  if m.id is null or m.lugar <> r.origen or m.importe <> -r.importe or m.sucursal_id <> r.sucursal_paga_id
     or m.cerrado_en is not null or not m.responsable or m.registrado_por <> r.pagado_por then
    raise exception 'El reembolso en efectivo registra su salida del lugar, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger reembolso_con_salida after insert on reembolso_gasto
  deferrable initially deferred for each row execute function reembolso_salida();
create constraint trigger movimiento_reembolso_valido after insert on movimiento_efectivo
  deferrable initially deferred for each row when (new.reembolso_id is not null) execute function reembolso_salida();

-- Solo quien lo recibió (quien pagó con su dinero) confirma, desde su cuenta (la aplicación lo comprueba).
create trigger reembolso_recibido_inmutable before update or delete on reembolso_recibido
  for each row execute function impedir_modificacion();
create trigger decision_reembolso_sin_vaciar before truncate on decision_reembolso for each statement execute function impedir_modificacion();
create trigger reembolso_gasto_sin_vaciar before truncate on reembolso_gasto for each statement execute function impedir_modificacion();
create trigger reembolso_recibido_sin_vaciar before truncate on reembolso_recibido for each statement execute function impedir_modificacion();
