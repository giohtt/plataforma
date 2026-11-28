-- 0055 · Bloque 6, PR 8: gastos ya pagados y pagos de turnos cerrados (acordado el 27 nov 2026; solo datos ficticios).
--   - Gestión administrativa, Encargados, Administración y Dirección registran un gasto que ya se pagó, con quién pagó,
--     de dónde salió el dinero, importe, fecha, motivo y comprobante (o «sin comprobante» con motivo). Recepción no:
--     avisa a su Encargado. Registrar no es aprobar ni autorizar un reembolso: queda «Pagado sin autorización previa ·
--     por revisar · Dirección» y no pasa por la ruta de autorización (qué decide Dirección al revisarlo: falta decidir).
--   - Efectivo de un turno ya cerrado: se conservan los registros originales de ese turno y no se descuenta del turno
--     actual (sin salida de caja). Queda ligado a ese turno y lugar, y quien pagó fue responsable del lugar en ese turno.
--   - Efectivo del turno abierto: no se registra como ya pagado (propuesta: si hubo una salida sin autorización, aparece
--     al contar; al cerrar el turno se registra como pago de un turno cerrado).
--   - Lo pagado con dinero personal queda pendiente de reembolso de quien puso el dinero, como cualquier otro.

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('gasto.registrar_pagado', 'Registrar un gasto que ya se pagó (sin autorización previa)', 6, false);
insert into rol_permiso (rol, permiso) values
  ('encargado',              'gasto.registrar_pagado'),
  ('administracion',         'gasto.registrar_pagado'),
  ('gestion_administrativa', 'gasto.registrar_pagado'),
  ('direccion',              'gasto.registrar_pagado');

create table gasto_ya_pagado (
  gasto_id       uuid primary key references gasto (id),
  motivo         text not null check (char_length(motivo) between 5 and 300),
  registrado_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);

-- Un pago registrado después de hacerse puede ser de otra persona (quién pagó), y el efectivo, de un turno cerrado.
alter table pago_gasto add column posterior boolean not null default false;
alter table pago_gasto add column turno_cerrado_id uuid references turno (id);
alter table pago_gasto drop constraint pago_efectivo_de_quien_registra;
alter table pago_gasto add constraint pago_efectivo_de_quien_registra
  check (origen not in ('bolsa_visitas', 'cajon_mensualidades', 'dinero_personal', 'anticipo') or pagado_por = registrado_por or posterior);
alter table pago_gasto add constraint pago_turno_cerrado_solo_efectivo_posterior
  check (turno_cerrado_id is null or (posterior and origen in ('bolsa_visitas', 'cajon_mensualidades')));
alter table pago_gasto add constraint pago_posterior_efectivo_con_turno
  check (not posterior or origen not in ('bolsa_visitas', 'cajon_mensualidades') or turno_cerrado_id is not null);
alter table pago_gasto add constraint pago_posterior_sin_anticipo check (not (posterior and origen = 'anticipo'));

create function gasto_ya_pagado_valido() returns trigger
language plpgsql as $$
declare
  g record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'gasto_ya_pagado: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into g from gasto where id = new.gasto_id;
  if new.registrado_por <> g.solicitado_por
     or not tiene_permiso(new.registrado_por, 'gasto.registrar_pagado', g.sucursal_id)
     or not tiene_permiso(new.registrado_por, 'gasto.registrar_pagado', g.sucursal_paga_id) then
    raise exception 'Registran gastos ya pagados Gestión administrativa, Encargados, Administración y Dirección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger gasto_ya_pagado_valido before insert or update or delete on gasto_ya_pagado
  for each row execute function gasto_ya_pagado_valido();
create trigger gasto_ya_pagado_sin_vaciar before truncate on gasto_ya_pagado for each statement execute function impedir_modificacion();

-- Va con su pago (registrado después) desde el mismo momento.
create function gasto_ya_pagado_con_pago() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from gasto_ya_pagado y where y.gasto_id = new.gasto_id)
     <> exists (select 1 from pago_gasto p where p.gasto_id = new.gasto_id and p.posterior) then
    raise exception 'Un gasto ya pagado se registra con su pago, y un pago posterior solo con un gasto ya pagado' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger gasto_ya_pagado_con_pago after insert on gasto_ya_pagado
  deferrable initially deferred for each row execute function gasto_ya_pagado_con_pago();
create constraint trigger pago_posterior_con_gasto after insert on pago_gasto
  deferrable initially deferred for each row when (new.posterior) execute function gasto_ya_pagado_con_pago();

-- Un gasto ya pagado no pasa por la ruta de autorización (qué decide Dirección al revisarlo: falta decidir).
create or replace function impedimento_decision_gasto(p_usuario uuid, p_gasto uuid) returns text
language plpgsql stable as $$
declare
  g record;
  v record;
  x uuid;
  f record;
  v_total numeric;
begin
  select * into g from gasto where id = p_gasto;
  if g is null then
    return 'no_encontrado';
  end if;
  if exists (select 1 from gasto_ya_pagado y where y.gasto_id = p_gasto) then
    return 'ya_pagado';
  end if;
  select version, importe into v from gasto_version where gasto_id = p_gasto order by version desc limit 1;
  if exists (select 1 from decision_gasto d where d.gasto_id = p_gasto and d.version = v.version) then
    return 'ya_decidido';
  end if;
  if g.solicitado_por = p_usuario then
    if not (exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_id) r where r = 'direccion')
            and exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_paga_id) r where r = 'direccion')) then
      return 'propio';
    end if;
  elsif exists (select 1 from perfiles_en_sucursal(g.solicitado_por, g.sucursal_id) r where r = 'direccion')
        and not exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_id) r where r = 'direccion') then
    return 'de_direccion';
  end if;
  v_total := total_compra_gasto(p_gasto);
  foreach x in array array[g.sucursal_id, g.sucursal_paga_id] loop
    select * into f from facultad_gasto(p_usuario, x);
    if f.facultad_id is null then
      return 'sin_facultad';
    end if;
    if not f.sin_limite then
      if v_total > f.limite_monto then
        return 'limite';
      end if;
      if autorizado_hoy(p_usuario, x) + v.importe > f.limite_diario then
        return 'diario';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- El pago: con autorización previa (como hasta ahora) o registrado después, sin autorización.
create or replace function pago_gasto_valido() returns trigger
language plpgsql as $$
declare
  g record;
  v record;
  d record;
  k record;
  t record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'pago_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into g from gasto where id = new.gasto_id for update;
  select version, importe into v from gasto_version where gasto_id = new.gasto_id order by version desc limit 1;
  if new.posterior then
    if not exists (select 1 from gasto_ya_pagado y where y.gasto_id = new.gasto_id) then
      raise exception 'Un pago posterior solo va con un gasto registrado como ya pagado' using errcode = 'check_violation';
    end if;
    if new.version <> v.version or new.importe <> v.importe then
      raise exception 'El gasto ya pagado se registra por lo pagado' using errcode = 'check_violation';
    end if;
    if new.pagado_el > dia_en_sucursal(g.sucursal_paga_id, now()) then
      raise exception 'La fecha del pago no puede ser futura' using errcode = 'check_violation';
    end if;
    if not tiene_permiso(new.registrado_por, 'gasto.registrar_pagado', g.sucursal_paga_id) then
      raise exception 'Sin permiso para registrar gastos ya pagados en la sucursal que paga' using errcode = 'check_violation';
    end if;
    if not tiene_permiso(new.pagado_por, 'sucursal.consultar', g.sucursal_paga_id) then
      raise exception 'Quien pagó es una persona de la sucursal que paga' using errcode = 'check_violation';
    end if;
    if new.origen = 'transferencia' and not exists (select 1 from perfiles_en_sucursal(new.registrado_por, g.sucursal_paga_id) r
                                                    where r in ('administracion', 'gestion_administrativa', 'direccion')) then
      raise exception 'Las transferencias las registra Administración, Gestión administrativa o Dirección' using errcode = 'check_violation';
    end if;
    if new.turno_cerrado_id is not null then
      select tu.*, l.id as lugar_id into t
      from turno tu join lugar_efectivo l on l.sucursal_id = tu.sucursal_id and l.tipo = new.origen
      where tu.id = new.turno_cerrado_id;
      if t.id is null or t.sucursal_id <> g.sucursal_paga_id or t.cerrado_en is null then
        raise exception 'El efectivo registrado después sale de un turno ya cerrado de la sucursal que paga' using errcode = 'check_violation';
      end if;
      if new.pagado_el not between dia_en_sucursal(t.sucursal_id, t.abierto_en) and dia_en_sucursal(t.sucursal_id, t.cerrado_en) then
        raise exception 'La fecha del pago cae dentro de ese turno' using errcode = 'check_violation';
      end if;
      if not exists (select 1 from responsable_lugar r where r.turno_id = t.id and r.lugar_id = t.lugar_id and r.usuario_id = new.pagado_por) then
        raise exception 'Quien pagó en efectivo fue responsable de ese lugar en ese turno' using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  select * into d from decision_gasto where gasto_id = new.gasto_id and version = v.version;
  if new.version <> v.version or d is null or d.decision <> 'autorizado' then
    raise exception 'Solo se paga la versión vigente ya autorizada' using errcode = 'check_violation';
  end if;
  if new.importe > d.importe then
    raise exception 'El pago no puede pasar de lo autorizado: el excedente se pide aparte' using errcode = 'check_violation';
  end if;
  select kk.*, pp.pagado_el as pagado_proveedor, pp.pagado_por as cubrio into k
  from anticipo_comprobado kk join pago_gasto pp on pp.id = kk.pago_id where kk.excedente_gasto_id = new.gasto_id;
  if k.anticipo_id is not null then
    if new.origen <> 'dinero_personal' or new.pagado_el <> k.pagado_proveedor or new.pagado_por <> k.cubrio then
      raise exception 'El excedente de un anticipo ya se pagó al proveedor: se registra como dinero personal de quien recibió el anticipo, con la fecha de ese pago, y se reembolsa'
        using errcode = 'check_violation';
    end if;
  elsif new.pagado_el < dia_en_sucursal(g.sucursal_paga_id, d.en) or new.pagado_el > dia_en_sucursal(g.sucursal_paga_id, now()) then
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

-- Efectivo de un turno cerrado: sin salida (se conservan los registros de ese turno y no se descuenta del actual).
create or replace function pago_gasto_salida() returns trigger
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
  if p.origen not in ('bolsa_visitas', 'cajon_mensualidades') or p.turno_cerrado_id is not null then
    if exists (select 1 from movimiento_efectivo x where x.pago_gasto_id = p.id) then
      raise exception 'Este pago no tiene salida de caja (no fue en efectivo, o fue de un turno ya cerrado)' using errcode = 'check_violation';
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
