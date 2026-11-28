-- 0056 · Bloque 6, PR 8: precisiones de Dirección (27 nov 2026, 22:22; solo datos ficticios).
--   - El efectivo que ya salió de un turno abierto se registra en ese momento como «Pagado sin autorización previa»,
--     con responsable, fecha y motivo: una sola salida en ese turno, que baja el esperado una vez y queda para revisión
--     de Dirección. Registrarla no es aprobarla.
--   - La sucursal que paga y la beneficiada siguen separadas también en los gastos ya pagados (0055 ya exige el permiso
--     en ambas).

alter table pago_gasto drop constraint pago_posterior_efectivo_con_turno;

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
    if new.origen in ('bolsa_visitas', 'cajon_mensualidades') and new.turno_cerrado_id is null then
      -- Del turno abierto de la sucursal que paga: dentro del turno y hasta hoy (la salida la revisa pago_gasto_salida).
      select tu.* into t from turno tu where tu.sucursal_id = g.sucursal_paga_id and tu.cerrado_en is null;
      if t.id is null or new.pagado_el not between dia_en_sucursal(t.sucursal_id, t.abierto_en) and dia_en_sucursal(t.sucursal_id, now()) then
        raise exception 'El efectivo del turno abierto se registra con fecha dentro de ese turno' using errcode = 'check_violation';
      end if;
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
-- Efectivo ya pagado del turno abierto: una sola salida en ese turno, registrada por quien registra el gasto, con la
-- responsable vigente del lugar como responsable del movimiento.
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
     or m.cerrado_en is not null or m.registrado_por <> p.registrado_por
     or (not p.posterior and not m.responsable)
     or (p.posterior and not exists (select 1 from responsable_lugar r where r.lugar_id = m.lugar_id and r.turno_id = m.turno_id and r.hasta is null
                                     and r.usuario_id = m.responsable_id)) then
    raise exception 'El pago en efectivo registra su salida del lugar, en el turno abierto, por la responsable vigente' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
