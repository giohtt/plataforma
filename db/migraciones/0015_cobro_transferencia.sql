-- 0015 · Bloque 4: cobro de visitas por transferencia (solo datos ficticios). Indicado el 5 nov 2026:
--   - misma pantalla para una persona o un grupo; un solo medio de pago por operación;
--   - se pide «Clave de rastreo o folio bancario» y se guarda el tipo de referencia (formato PROVISIONAL);
--   - al registrar, el cobro queda «Pendiente de verificar abono»; no hay entrada de efectivo;
--   - Administración y Dirección, con permiso en la sucursal, lo marcan «Abono verificado» (importe completo y
--     fecha del abono) o «No localizado» (con motivo); un «No localizado» se puede verificar después;
--   - nadie verifica un cobro que registró;
--   - el mismo abono no se usa en dos cobros: una referencia con su fecha de abono se verifica una sola vez;
--   - el cambio de estado es del MISMO cobro y queda en un historial que no se edita.
-- La regla de acceso con el comprobante sigue PENDIENTE: el pase se registra, pero esta migración no decide el acceso.

alter table cobro_visita drop constraint cobro_visita_forma_pago_check;
alter table cobro_visita add constraint cobro_visita_forma_pago_check
  check (forma_pago in ('efectivo', 'tarjeta', 'transferencia'));
alter table cobro_visita drop constraint cobro_visita_estado_check;
alter table cobro_visita add constraint cobro_visita_estado_check
  check (estado in ('confirmado', 'confirmado_operativamente', 'pendiente_abono', 'abono_verificado', 'no_localizado'));

alter table cobro_visita
  add column referencia text,
  add column tipo_referencia text check (tipo_referencia in ('clave_rastreo', 'folio_bancario')),
  -- Quien registró confirmó que era otra transferencia aunque la referencia ya estaba registrada.
  add column referencia_repetida_confirmada boolean not null default false,
  add column abono_fecha date,
  add column abono_importe numeric(12, 2),
  add column verificado_por uuid references usuario (id),
  add column verificado_en timestamptz,
  add column version integer not null default 1;

alter table cobro_visita drop constraint cobro_medio_coherente;
alter table cobro_visita add constraint cobro_medio_coherente check (
  (forma_pago = 'efectivo' and estado = 'confirmado' and autorizacion is null and conciliacion is null
     and not autorizacion_repetida_confirmada and referencia is null and tipo_referencia is null)
  or (forma_pago = 'tarjeta' and estado = 'confirmado_operativamente' and conciliacion is not null
     and recibido is null and cambio is null and referencia is null and tipo_referencia is null
     and autorizacion is not null and autorizacion ~ '^[A-Z0-9]{4,12}$')
  or (forma_pago = 'transferencia' and estado in ('pendiente_abono', 'abono_verificado', 'no_localizado')
     and recibido is null and cambio is null and autorizacion is null and conciliacion is null
     and not autorizacion_repetida_confirmada
     and tipo_referencia is not null and referencia is not null and referencia ~ '^[A-Z0-9]{4,30}$')
);
alter table cobro_visita add constraint cobro_sin_referencia_repetida_fuera_de_transferencia
  check (forma_pago = 'transferencia' or not referencia_repetida_confirmada);
-- Verificado: siempre con fecha, importe completo y quién; en los demás estados, sin esos datos.
alter table cobro_visita add constraint cobro_abono_coherente check (
  (estado = 'abono_verificado' and abono_fecha is not null and abono_importe = importe
     and verificado_por is not null and verificado_en is not null)
  or (estado <> 'abono_verificado' and abono_fecha is null and abono_importe is null
     and verificado_por is null and verificado_en is null)
);
create index cobro_visita_referencia on cobro_visita (tipo_referencia, referencia) where referencia is not null;

-- Un mismo abono no se usa en dos cobros: misma referencia, del mismo tipo y con la misma fecha de abono,
-- solo puede quedar verificada una vez.
create unique index cobro_abono_unico on cobro_visita (tipo_referencia, referencia, abono_fecha)
  where estado = 'abono_verificado';

-- ---------------------------------------------------------------------------
-- El cobro sigue sin editarse, salvo el cambio de estado de una transferencia, y solo por los caminos
-- permitidos: pendiente → verificado o no localizado; no localizado → verificado. Nada más cambia.
-- ---------------------------------------------------------------------------
drop trigger cobro_visita_inmutable on cobro_visita;
create function cobro_visita_cambio_permitido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cobro_visita: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if old.forma_pago <> 'transferencia'
     or not ((old.estado = 'pendiente_abono' and new.estado in ('abono_verificado', 'no_localizado'))
             or (old.estado = 'no_localizado' and new.estado = 'abono_verificado'))
     or new.version <> old.version + 1
     or (new.id, new.operacion_id, new.forma_pago, new.importe, new.recibido, new.cambio, new.creado_en,
         new.autorizacion, new.conciliacion, new.autorizacion_repetida_confirmada,
         new.referencia, new.tipo_referencia, new.referencia_repetida_confirmada)
        is distinct from
        (old.id, old.operacion_id, old.forma_pago, old.importe, old.recibido, old.cambio, old.creado_en,
         old.autorizacion, old.conciliacion, old.autorizacion_repetida_confirmada,
         old.referencia, old.tipo_referencia, old.referencia_repetida_confirmada) then
    raise exception 'cobro_visita: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger cobro_visita_inmutable
  before update or delete on cobro_visita
  for each row execute function cobro_visita_cambio_permitido();

-- Historial de cada cambio de estado: quién, cuándo, desde qué sucursal, de qué estado a cuál y por qué.
create table cobro_cambio_estado (
  id           bigint generated always as identity primary key,
  cobro_id     uuid not null references cobro_visita (id),
  de           text not null,
  a            text not null,
  abono_fecha  date,
  motivo       text check (motivo is null or length(btrim(motivo)) between 5 and 300),
  usuario_id   uuid not null references usuario (id),
  sucursal_id  uuid not null references sucursal (id),
  en           timestamptz not null default now(),
  constraint cambio_no_localizado_con_motivo check (a <> 'no_localizado' or motivo is not null),
  constraint cambio_verificado_con_fecha check (a <> 'abono_verificado' or abono_fecha is not null)
);
create index cobro_cambio_estado_cobro on cobro_cambio_estado (cobro_id, en);
create trigger cobro_cambio_estado_inmutable
  before update or delete on cobro_cambio_estado
  for each row execute function impedir_modificacion();
create trigger cobro_cambio_estado_sin_vaciar
  before truncate on cobro_cambio_estado
  for each statement execute function impedir_modificacion();

-- La operación cuadra también con transferencia: sin entrada de efectivo.
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
     or (forma in ('tarjeta', 'transferencia') and efectivo <> 0) then
    raise exception 'La operación de visita no cuadra (pases %, suma %, total %, cobro %, forma %, efectivo %)',
      pases, suma, new.total, cobro, forma, efectivo
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permiso PROVISIONAL (indicado el 5 nov 2026): verifican Administración y Dirección en sus sucursales.
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values
  ('administracion', 'cobro.verificar_abono'),
  ('direccion',      'cobro.verificar_abono');
