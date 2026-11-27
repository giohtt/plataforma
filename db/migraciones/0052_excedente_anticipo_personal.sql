-- 0052 · Bloque 6, PR 6: el excedente de un anticipo ya se pagó al proveedor con dinero de alguien (acordado: «lo que
-- alguien cubra con su dinero queda como reembolso pendiente, no como salida de caja»; 27 nov 2026; solo datos ficticios).
--   - El excedente que nace al comprobar un anticipo se registra solo como «dinero personal» de quien recibió el anticipo
--     (lo cubrió al comprar), con la fecha del pago al proveedor, aunque se autorice después. Queda pendiente de reembolso.
--   - Así no se puede pagar otra vez desde la bolsa, el cajón, una transferencia o una tarjeta: lo que salga de caja
--     para devolvérselo a quien lo cubrió es su reembolso (PR 7), ligado a ese pago.

create or replace function pago_gasto_valido() returns trigger
language plpgsql as $$
declare
  g record;
  v record;
  d record;
  k record;
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

-- El excedente de un anticipo ya se pagó al proveedor: no lleva su propio anticipo.
create function anticipo_no_para_excedente() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from anticipo_comprobado k where k.excedente_gasto_id = new.gasto_id) then
    raise exception 'El excedente de un anticipo ya se pagó al proveedor: no lleva anticipo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger anticipo_no_para_excedente before insert on anticipo_gasto
  for each row execute function anticipo_no_para_excedente();

-- El importe del excedente lo fija la comprobación del anticipo: no se corrige.
create function excedente_anticipo_sin_correccion() returns trigger
language plpgsql as $$
begin
  if new.version > 1 and exists (select 1 from anticipo_comprobado k where k.excedente_gasto_id = new.gasto_id) then
    raise exception 'El excedente de un anticipo no se corrige: su importe lo fija la comprobación' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger excedente_anticipo_sin_correccion before insert on gasto_version
  for each row execute function excedente_anticipo_sin_correccion();
