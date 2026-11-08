-- 0016 · Bloque 4: cancelación de un cobro duplicado en efectivo (solo datos ficticios). Indicado el 8 nov 2026:
--   - Recepción la solicita para un cobro de su turno abierto y elige el cobro correcto que se conserva;
--   - la aprueba quien tenga la facultad autorizacion.devolucion en la sucursal, con límite suficiente, y que no
--     haya registrado el cobro ni pedido la cancelación;
--   - al aprobar se conserva el historial, el cobro duplicado y su pase quedan cancelados y se registra UN solo
--     ajuste de efectivo por el importe que había entrado (negativo); el dinero físico sigue en la bolsa;
--   - la bolsa descuenta el importe una sola vez (entrada + ajuste) y las ventas dejan de contar el duplicado.
-- Quedan para otro paso: turnos cerrados, correcciones de persona o medio de pago, y devoluciones.

-- ---------------------------------------------------------------------------
-- Cobro: el efectivo confirmado puede pasar a «cancelado» (y nada más cambia).
-- ---------------------------------------------------------------------------
alter table cobro_visita drop constraint cobro_visita_estado_check;
alter table cobro_visita add constraint cobro_visita_estado_check check (estado in (
  'confirmado', 'confirmado_operativamente', 'pendiente_abono', 'abono_verificado', 'no_localizado', 'cancelado'));

alter table cobro_visita drop constraint cobro_medio_coherente;
alter table cobro_visita add constraint cobro_medio_coherente check (
  (forma_pago = 'efectivo' and estado in ('confirmado', 'cancelado') and autorizacion is null and conciliacion is null
     and not autorizacion_repetida_confirmada and referencia is null and tipo_referencia is null)
  or (forma_pago = 'tarjeta' and estado = 'confirmado_operativamente' and conciliacion is not null
     and recibido is null and cambio is null and referencia is null and tipo_referencia is null
     and autorizacion is not null and autorizacion ~ '^[A-Z0-9]{4,12}$')
  or (forma_pago = 'transferencia' and estado in ('pendiente_abono', 'abono_verificado', 'no_localizado')
     and recibido is null and cambio is null and autorizacion is null and conciliacion is null
     and not autorizacion_repetida_confirmada
     and tipo_referencia is not null and referencia is not null and referencia ~ '^[A-Z0-9]{4,30}$')
);

create or replace function cobro_visita_cambio_permitido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cobro_visita: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if not ((old.forma_pago = 'transferencia'
             and ((old.estado = 'pendiente_abono' and new.estado in ('abono_verificado', 'no_localizado'))
                  or (old.estado = 'no_localizado' and new.estado = 'abono_verificado')))
          or (old.forma_pago = 'efectivo' and old.estado = 'confirmado' and new.estado = 'cancelado'))
     or new.version <> old.version + 1
     or (new.id, new.operacion_id, new.forma_pago, new.importe, new.recibido, new.cambio, new.creado_en,
         new.autorizacion, new.conciliacion, new.autorizacion_repetida_confirmada,
         new.referencia, new.tipo_referencia, new.referencia_repetida_confirmada)
        is distinct from
        (old.id, old.operacion_id, old.forma_pago, old.importe, old.recibido, old.cambio, old.creado_en,
         old.autorizacion, old.conciliacion, old.autorizacion_repetida_confirmada,
         old.referencia, old.tipo_referencia, old.referencia_repetida_confirmada)
     or (new.estado = 'cancelado' and (new.abono_fecha, new.abono_importe, new.verificado_por, new.verificado_en)
                                       is distinct from (old.abono_fecha, old.abono_importe, old.verificado_por, old.verificado_en)) then
    raise exception 'cobro_visita: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pase: solo se puede marcar como cancelado, una vez, cuando su cobro ya está cancelado.
-- ---------------------------------------------------------------------------
alter table pase_visita add column cancelado_en timestamptz;
drop trigger pase_visita_inmutable on pase_visita;
create function pase_visita_cambio_permitido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pase_visita: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if old.cancelado_en is not null or new.cancelado_en is null
     or (new.id, new.operacion_id, new.visitante_id, new.sucursal_id, new.tarifa, new.descuento, new.total, new.creado_en, new.orden)
        is distinct from
        (old.id, old.operacion_id, old.visitante_id, old.sucursal_id, old.tarifa, old.descuento, old.total, old.creado_en, old.orden)
     or not exists (select 1 from cobro_visita c where c.operacion_id = new.operacion_id and c.estado = 'cancelado') then
    raise exception 'pase_visita: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger pase_visita_inmutable
  before update or delete on pase_visita
  for each row execute function pase_visita_cambio_permitido();

-- ---------------------------------------------------------------------------
-- Efectivo: ajuste negativo por cancelación. Un cobro tiene a lo más una entrada y un ajuste, y el ajuste es
-- exactamente la entrada con signo contrario, en el mismo lugar y turno.
-- ---------------------------------------------------------------------------
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_check;
alter table movimiento_efectivo drop constraint movimiento_efectivo_importe_check;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0) or (tipo = 'ajuste_cancelacion_cobro' and importe < 0));
alter table movimiento_efectivo drop constraint movimiento_efectivo_cobro_id_key;
alter table movimiento_efectivo add constraint movimiento_efectivo_cobro_tipo_unico unique (cobro_id, tipo);

create function ajuste_cancelacion_valido() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'ajuste_cancelacion_cobro' and not exists (
    select 1 from movimiento_efectivo e
    where e.cobro_id = new.cobro_id and e.tipo = 'entrada_cobro_visita'
      and e.importe = -new.importe and e.lugar_id = new.lugar_id and e.turno_id = new.turno_id
  ) then
    raise exception 'El ajuste debe anular exactamente la entrada de efectivo del mismo cobro, lugar y turno'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger movimiento_efectivo_ajuste_valido
  before insert on movimiento_efectivo
  for each row execute function ajuste_cancelacion_valido();

-- ---------------------------------------------------------------------------
-- Solicitud de cancelación por duplicado.
-- ---------------------------------------------------------------------------
create table cancelacion_cobro (
  id               uuid primary key default gen_random_uuid(),
  cobro_id         uuid not null references cobro_visita (id),
  conserva_cobro_id uuid not null references cobro_visita (id),
  tipo             text not null check (tipo in ('duplicado')),
  explicacion      text not null check (length(btrim(explicacion)) between 5 and 300),
  sucursal_id      uuid not null references sucursal (id),
  solicitada_por   uuid not null references usuario (id),
  solicitada_en    timestamptz not null default now(),
  estado           text not null default 'solicitada' check (estado in ('solicitada', 'aprobada', 'rechazada')),
  resuelta_por     uuid references usuario (id),
  resuelta_en      timestamptz,
  motivo_rechazo   text check (motivo_rechazo is null or length(btrim(motivo_rechazo)) between 5 and 300),
  ajuste_id        bigint references movimiento_efectivo (id),
  version          integer not null default 1,
  constraint cancelacion_no_se_conserva_a_si_mismo check (cobro_id <> conserva_cobro_id),
  constraint cancelacion_otra_persona_resuelve check (resuelta_por is null or resuelta_por <> solicitada_por),
  constraint cancelacion_estado_coherente check (
    (estado = 'solicitada' and resuelta_por is null and resuelta_en is null and motivo_rechazo is null and ajuste_id is null)
    or (estado = 'aprobada' and resuelta_por is not null and resuelta_en is not null and motivo_rechazo is null and ajuste_id is not null)
    or (estado = 'rechazada' and resuelta_por is not null and resuelta_en is not null and motivo_rechazo is not null and ajuste_id is null))
);
-- Una sola solicitud activa (pendiente o aprobada) por cobro.
create unique index cancelacion_activa_por_cobro on cancelacion_cobro (cobro_id) where estado in ('solicitada', 'aprobada');
create index cancelacion_sucursal_pendiente on cancelacion_cobro (sucursal_id) where estado = 'solicitada';

-- Solo cambia una vez: de «solicitada» a aprobada o rechazada.
create function cancelacion_cambio_permitido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cancelacion_cobro: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if old.estado <> 'solicitada' or new.estado not in ('aprobada', 'rechazada') or new.version <> old.version + 1
     or (new.id, new.cobro_id, new.conserva_cobro_id, new.tipo, new.explicacion, new.sucursal_id, new.solicitada_por, new.solicitada_en)
        is distinct from
        (old.id, old.cobro_id, old.conserva_cobro_id, old.tipo, old.explicacion, old.sucursal_id, old.solicitada_por, old.solicitada_en) then
    raise exception 'cancelacion_cobro: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger cancelacion_cobro_inmutable
  before update or delete on cancelacion_cobro
  for each row execute function cancelacion_cambio_permitido();
create trigger cancelacion_cobro_sin_vaciar
  before truncate on cancelacion_cobro
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Permiso PROVISIONAL: solicitan la cancelación quienes registran visitas (hoy, Recepción).
-- La aprobación NO se da por rol: requiere la facultad autorizacion.devolucion otorgada a una persona, con límite.
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values ('recepcion', 'visita.solicitar_cancelacion');
