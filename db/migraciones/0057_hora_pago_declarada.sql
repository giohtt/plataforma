-- 0057 · Bloque 6, PR 8: hora del pago declarada (pedido el 28 nov 2026, 00:11; solo datos ficticios).
--   - En transferencia, tarjeta y dinero personal, quien registra puede declarar la hora del pago (opcional). Es la hora
--     declarada por quien registra; la fecha y hora automática del registro sigue aparte (pago_gasto.en).
--   - Con hora declarada, la autorización previa se comprueba comparando fecha y hora; solo con el día y el mismo día de
--     la autorización, queda «no comprobada».

alter table pago_gasto add column hora_declarada time;
alter table pago_gasto add constraint pago_hora_declarada_segun_origen
  check (hora_declarada is null or origen in ('transferencia', 'tarjeta', 'dinero_personal'));

-- Momento del pago en la zona de la sucursal que paga (null si no se declaró la hora).
create function momento_declarado_pago(p_pago uuid) returns timestamptz
language sql stable as $$
  select case when p.hora_declarada is null then null
              else (p.pagado_el + p.hora_declarada) at time zone s.zona_horaria end
  from pago_gasto p join gasto g on g.id = p.gasto_id join sucursal s on s.id = g.sucursal_paga_id
  where p.id = p_pago
$$;

-- La hora declarada no puede quedar en el futuro.
create function pago_hora_no_futura() returns trigger
language plpgsql as $$
declare
  v_zona text;
begin
  if new.hora_declarada is not null then
    select s.zona_horaria into v_zona from gasto g join sucursal s on s.id = g.sucursal_paga_id where g.id = new.gasto_id;
    if ((new.pagado_el + new.hora_declarada) at time zone v_zona) > now() then
      raise exception 'La fecha y hora del pago no pueden ser futuras' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger pago_hora_no_futura before insert on pago_gasto for each row execute function pago_hora_no_futura();
