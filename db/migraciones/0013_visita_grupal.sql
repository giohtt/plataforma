-- 0013 · Bloque 4: registro grupal en efectivo (solo datos ficticios). Indicado el 5 nov 2026:
--   - una operación, un cobro y un pase por persona; la entrada a la bolsa es el total del grupo;
--   - de 1 a 20 personas por cobro (máximo PROVISIONAL), sin repetir a nadie (ya lo impide
--     unique (operacion_id, visitante_id) de pase_visita);
--   - el cobro individual es el mismo flujo con una sola persona.

-- Orden en que se agregó cada persona, para mostrarlas igual en el comprobante y el detalle.
alter table pase_visita add column orden smallint not null default 1 check (orden between 1 and 20);
alter table pase_visita alter column orden drop default;
alter table pase_visita add constraint pase_orden_unico unique (operacion_id, orden);

-- Al terminar la transacción, una operación debe cuadrar: de 1 a 20 pases, la suma de los pases igual
-- al total, un cobro por ese total y, si es en efectivo, una entrada a la bolsa por ese mismo total.
create function operacion_visita_cuadra() returns trigger
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
     or (forma = 'efectivo' and efectivo <> new.total) then
    raise exception 'La operación de visita no cuadra (pases %, suma %, total %, cobro %, efectivo %)',
      pases, suma, new.total, cobro, efectivo
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger operacion_visita_cuadra
  after insert on operacion_visita
  deferrable initially deferred
  for each row execute function operacion_visita_cuadra();
