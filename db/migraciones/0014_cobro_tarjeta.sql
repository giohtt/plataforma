-- 0014 · Bloque 4: cobro de visitas con tarjeta (solo datos ficticios). Indicado el 5 nov 2026:
--   - misma pantalla para una persona o un grupo; un solo medio de pago por operación;
--   - Recepción cobra primero en la terminal y, al ver «Aprobado», registra el cobro con la autorización;
--   - el cobro queda «confirmado operativamente» y la liquidación bancaria «pendiente de conciliar»;
--   - la tarjeta no genera entrada de efectivo ni cambia la bolsa;
--   - si la autorización ya aparece en esa sucursal ese día, se pide confirmar que es otra venta.
-- El formato de la autorización es PROVISIONAL (4 a 12 letras o números) hasta confirmar el comprobante.

alter table cobro_visita drop constraint cobro_visita_forma_pago_check;
alter table cobro_visita add constraint cobro_visita_forma_pago_check check (forma_pago in ('efectivo', 'tarjeta'));
alter table cobro_visita drop constraint cobro_visita_estado_check;
alter table cobro_visita add constraint cobro_visita_estado_check check (estado in ('confirmado', 'confirmado_operativamente'));

alter table cobro_visita
  add column autorizacion text,
  add column conciliacion text check (conciliacion in ('pendiente')),
  -- Quien registró confirmó que era otra venta aunque la autorización ya estaba ese día en la sucursal.
  add column autorizacion_repetida_confirmada boolean not null default false;

-- Cada medio de pago con sus datos, y solo los suyos:
--   efectivo: confirmado, sin autorización ni conciliación (lo recibido y el cambio son opcionales);
--   tarjeta: confirmado operativamente, con autorización, liquidación pendiente y sin recibido ni cambio.
alter table cobro_visita add constraint cobro_medio_coherente check (
  (forma_pago = 'efectivo' and estado = 'confirmado' and autorizacion is null and conciliacion is null
     and not autorizacion_repetida_confirmada)
  or (forma_pago = 'tarjeta' and estado = 'confirmado_operativamente' and conciliacion is not null
     and recibido is null and cambio is null
     and autorizacion is not null and autorizacion ~ '^[A-Z0-9]{4,12}$')
);
create index cobro_visita_autorizacion on cobro_visita (autorizacion) where autorizacion is not null;

-- La operación cuadra también con tarjeta: los pases suman el total y no hay entrada de efectivo.
create or replace function operacion_visita_cuadra() returns trigger
language plpgsql as $$
declare
  pases int;
  suma numeric(12, 2);
  cobro numeric(12, 2);
  forma text;
  efectivo numeric(12, 2);
begin
  select count(*), coalesce(sum(total), 0) into pases, suma from pase_visita where operacion_id = new.id;
  select c.importe, c.forma_pago into cobro, forma from cobro_visita c where c.operacion_id = new.id;
  select coalesce(sum(m.importe), 0) into efectivo
    from movimiento_efectivo m join cobro_visita c on c.id = m.cobro_id where c.operacion_id = new.id;
  if pases not between 1 and 20 or suma <> new.total or cobro is distinct from new.total
     or (forma = 'efectivo' and efectivo <> new.total)
     or (forma = 'tarjeta' and efectivo <> 0) then
    raise exception 'La operación de visita no cuadra (pases %, suma %, total %, cobro %, forma %, efectivo %)',
      pases, suma, new.total, cobro, forma, efectivo
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
