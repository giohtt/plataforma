-- 0025 · Bloque 5, paso 3: retiros de efectivo a Encargada de retiros (reglas 4 a 6; solo datos ficticios).
-- Indicado el 13 nov 2026 para la primera versión en pruebas:
--   - Entrega en persona. Recepción (la responsable vigente del lugar) cuenta, captura cuánto deja para cambio la
--     Encargada de retiros y registra un folio único por sucursal. Un registro por lugar. La salida se descuenta al
--     entregar físicamente el sobre. Recepción puede seguir cobrando mientras la confirmación está pendiente.
--   - Encargada de retiros confirma desde su propia cuenta, con conteo a ciegas, y comprueba el folio. Si el importe
--     difiere, se pide un recuento en persona; si no pueden recontar, registra «No coincide» con motivo. Se conservan
--     el conteo inicial, el recuento si lo hubo y quién participó. Si el folio no coincide, «No coincide» con motivo.
--   - Con discrepancia, el retiro queda «Por revisar» y se pausan los depósitos de ESE folio. Revisa Encargado si no
--     participó; si participó, Administración; si también, Dirección. «Aclarada» (motivo y monto verificado) o
--     «Faltante confirmado» (motivo y monto verificado; el faltante pasa a Dirección). Revisar habilita los depósitos
--     por el monto verificado. La salida original y los conteos no cambian.
--   - Único destino: depósito bancario, con importe, fecha y referencia obligatoria del comprobante. Depósitos parciales
--     por folio hasta cubrir el monto habilitado; nunca más. Una corrección es un registro nuevo que reemplaza al anterior.

insert into rol (clave, nombre, descripcion, disponible_en_bloque_1) values
  ('encargada_retiros', 'Encargada de retiros',
   'Recibe en persona los retiros de efectivo de sus sucursales autorizadas, los confirma desde su cuenta y registra su depósito.', true);

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('retiro.confirmar', 'Confirmar desde su cuenta los retiros que recibe y registrar sus depósitos', 5, false),
  ('retiro.revisar',   'Revisar discrepancias en retiros de efectivo, según quién participó', 5, false),
  ('retiro.consultar', 'Consultar los retiros de efectivo de la sucursal y el saldo bajo responsabilidad de Encargada de retiros', 5, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion', 'caja.retirar'),
  ('encargada_retiros', 'sucursal.consultar'),
  ('encargada_retiros', 'retiro.confirmar'),
  ('encargado', 'retiro.revisar'),
  ('administracion', 'retiro.revisar'),
  ('direccion', 'retiro.revisar'),
  ('administracion', 'retiro.consultar'),
  ('direccion', 'retiro.consultar');

-- ---------------------------------------------------------------------------
-- Retiro: un sobre, de un lugar, entregado en persona a una Encargada de retiros.
--   pendiente   → entregado; falta su conteo (a ciegas);
--   recuento    → su conteo no coincidió con lo registrado: recuentan en persona o declara «No coincide»;
--   confirmado  → coincidió (al primer conteo o al recontar); depósitos habilitados por el importe;
--   por_revisar → «No coincide» (importe o folio): depósitos de este folio en pausa;
--   revisado    → se revisó; depósitos habilitados por el monto verificado.
-- Lo registrado al entregar no se edita ni se borra.
-- ---------------------------------------------------------------------------
create table retiro (
  id              uuid primary key default gen_random_uuid(),
  sucursal_id     uuid not null references sucursal (id),
  turno_id        uuid not null references turno (id),
  lugar_id        uuid not null references lugar_efectivo (id),
  folio           text not null check (folio ~ '^[A-Z0-9][A-Z0-9-]{2,29}$'),
  contado         numeric(12, 2) not null check (contado >= 0),
  cambio          numeric(12, 2) not null check (cambio >= 0),
  importe         numeric(12, 2) not null check (importe > 0),
  esperado        numeric(12, 2),
  entregado_por   uuid not null references usuario (id),
  encargada_id    uuid not null references usuario (id),
  entregado_en    timestamptz not null default now(),
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente', 'recuento', 'confirmado', 'por_revisar', 'revisado')),
  discrepancia    text check (discrepancia in ('importe', 'folio')),
  motivo          text check (motivo is null or char_length(btrim(motivo)) between 5 and 300),
  reportado_en    timestamptz,
  monto_habilitado numeric(12, 2) check (monto_habilitado >= 0),
  habilitado_en   timestamptz,
  version         int not null default 1,
  constraint retiro_cuadra check (contado = importe + cambio),
  constraint retiro_a_otra_persona check (entregado_por <> encargada_id),
  constraint retiro_folio_unico unique (sucursal_id, folio),
  constraint retiro_discrepancia check ((estado in ('por_revisar', 'revisado')) = (discrepancia is not null)
                                        and (discrepancia is null) = (motivo is null) and (discrepancia is null) = (reportado_en is null)),
  constraint retiro_habilitado check ((estado in ('confirmado', 'revisado')) = (monto_habilitado is not null)
                                      and (monto_habilitado is null) = (habilitado_en is null))
);
create index retiro_encargada on retiro (encargada_id);
create index retiro_turno on retiro (turno_id);

-- Del lugar y turno abierto de su sucursal; avanza solo por los estados permitidos, sin tocar lo registrado.
create function retiro_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'retiro: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' or new.version <> 1 or not exists (
      select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
      where t.id = new.turno_id and l.id = new.lugar_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'El retiro debe ser de un lugar de la sucursal de un turno abierto' using errcode = 'check_violation';
    end if;
    if not tiene_permiso(new.encargada_id, 'retiro.confirmar', new.sucursal_id) then
      raise exception 'Recibe una Encargada de retiros autorizada en la sucursal' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.version <> old.version + 1
     or not ((old.estado = 'pendiente' and new.estado in ('recuento', 'confirmado', 'por_revisar'))
          or (old.estado = 'recuento' and new.estado in ('confirmado', 'por_revisar'))
          or (old.estado = 'por_revisar' and new.estado = 'revisado'))
     or (old.discrepancia is not null and (new.discrepancia, new.motivo, new.reportado_en)
                                          is distinct from (old.discrepancia, old.motivo, old.reportado_en))
     or (new.id, new.sucursal_id, new.turno_id, new.lugar_id, new.folio, new.contado, new.cambio, new.importe, new.esperado,
         new.entregado_por, new.encargada_id, new.entregado_en)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.lugar_id, old.folio, old.contado, old.cambio, old.importe,
                          old.esperado, old.entregado_por, old.encargada_id, old.entregado_en) then
    raise exception 'retiro: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger retiro_valido
  before insert or update or delete on retiro
  for each row execute function retiro_valido();
create trigger retiro_sin_vaciar
  before truncate on retiro
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Conteos de Encargada de retiros. Se conservan todos:
--   inicial  → su primer conteo, a ciegas, y si el folio coincide;
--   recuento → el recuento en persona, con quién recontó.
-- ---------------------------------------------------------------------------
create table retiro_conteo (
  id             bigint generated always as identity primary key,
  retiro_id      uuid not null references retiro (id),
  tipo           text not null check (tipo in ('inicial', 'recuento')),
  importe        numeric(12, 2) not null check (importe >= 0),
  folio_coincide boolean not null,
  contado_por    uuid not null references usuario (id),
  recontado_con  uuid references usuario (id),
  en             timestamptz not null default now(),
  unique (retiro_id, tipo),
  constraint recuento_con_persona check ((tipo = 'recuento') = (recontado_con is not null)),
  constraint recuento_con_otra check (recontado_con is null or recontado_con <> contado_por)
);
create trigger retiro_conteo_inmutable
  before update or delete on retiro_conteo
  for each row execute function impedir_modificacion();
create trigger retiro_conteo_sin_vaciar
  before truncate on retiro_conteo
  for each statement execute function impedir_modificacion();

-- Quienes participaron en un retiro: quien entregó, la Encargada de retiros y quien recontó con ella.
create function participantes_retiro(p_retiro uuid) returns setof uuid
language sql stable as $$
  select entregado_por from retiro where id = p_retiro
  union select encargada_id from retiro where id = p_retiro
  union select recontado_con from retiro_conteo where retiro_id = p_retiro and recontado_con is not null
$$;

-- Perfil que revisa: Encargado; si participó alguien con perfil de Encargado, Administración; si también de
-- Administración, Dirección.
create function nivel_revision_retiro(p_retiro uuid) returns text
language sql stable as $$
  with p as (
    select r as rol from retiro x
    cross join lateral participantes_retiro(x.id) as quien(u)
    cross join lateral perfiles_en_sucursal(quien.u, x.sucursal_id) as r
    where x.id = p_retiro)
  select case
    when exists (select 1 from p where rol = 'administracion') then 'direccion'
    when exists (select 1 from p where rol = 'encargado') then 'administracion'
    else 'encargado' end
$$;

-- ---------------------------------------------------------------------------
-- Revisión de una discrepancia: «Aclarada» o «Faltante confirmado», con motivo y monto verificado.
-- El faltante (registrado − verificado) queda pendiente para Dirección.
-- ---------------------------------------------------------------------------
create table retiro_revision (
  id              uuid primary key default gen_random_uuid(),
  retiro_id       uuid not null unique references retiro (id),
  resultado       text not null check (resultado in ('aclarada', 'faltante_confirmado')),
  motivo          text not null check (char_length(btrim(motivo)) between 5 and 300),
  monto_verificado numeric(12, 2) not null check (monto_verificado >= 0),
  nivel           text not null check (nivel in ('encargado', 'administracion', 'direccion')),
  revisada_por    uuid not null references usuario (id),
  en              timestamptz not null default now()
);

create function retiro_revision_valida() returns trigger
language plpgsql as $$
declare
  x record;
begin
  select r.importe, r.sucursal_id, r.estado into x from retiro r where r.id = new.retiro_id;
  if x.estado <> 'por_revisar' then
    raise exception 'Solo se revisa un retiro por revisar' using errcode = 'check_violation';
  end if;
  if new.resultado = 'faltante_confirmado' and new.monto_verificado >= x.importe then
    raise exception 'Un faltante confirmado verifica menos de lo registrado' using errcode = 'check_violation';
  end if;
  if new.revisada_por in (select participantes_retiro(new.retiro_id)) then
    raise exception 'Quien participó en el retiro no lo revisa' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_retiro(new.retiro_id)
     or not tiene_permiso(new.revisada_por, 'retiro.revisar', x.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, x.sucursal_id) r where r = new.nivel) then
    raise exception 'Este retiro lo revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger retiro_revision_valida
  before insert on retiro_revision
  for each row execute function retiro_revision_valida();
create trigger retiro_revision_inmutable
  before update or delete on retiro_revision
  for each row execute function impedir_modificacion();
create trigger retiro_revision_sin_vaciar
  before truncate on retiro_revision
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Depósitos bancarios de un retiro (único destino en esta versión). Una corrección es un registro nuevo que
-- reemplaza a otro (corrige_id), con motivo; el reemplazado se conserva. Los depósitos vigentes nunca pasan del
-- monto habilitado del folio, y solo se registran con el folio habilitado (no en pausa).
-- ---------------------------------------------------------------------------
create table deposito_retiro (
  id                uuid primary key default gen_random_uuid(),
  retiro_id         uuid not null references retiro (id),
  importe           numeric(12, 2) not null check (importe >= 0),
  depositado_en     timestamptz not null,
  referencia        text not null check (char_length(btrim(referencia)) between 4 and 60),
  corrige_id        uuid unique references deposito_retiro (id),
  motivo_correccion text check (motivo_correccion is null or char_length(btrim(motivo_correccion)) between 5 and 300),
  registrado_por    uuid not null references usuario (id),
  en                timestamptz not null default now(),
  constraint correccion_con_motivo check ((corrige_id is null) = (motivo_correccion is null)),
  constraint deposito_positivo check (importe > 0 or corrige_id is not null)
);

create function deposito_retiro_valido() returns trigger
language plpgsql as $$
declare
  x record;
  vigente numeric(12, 2);
begin
  -- Mismo orden de bloqueo que el servidor: primero la fila del retiro.
  select r.encargada_id, r.monto_habilitado, r.entregado_en into x from retiro r where r.id = new.retiro_id for update;
  if x.monto_habilitado is null then
    raise exception 'Los depósitos de este folio están en pausa o sin confirmar' using errcode = 'check_violation';
  end if;
  if new.registrado_por <> x.encargada_id then
    raise exception 'Registra los depósitos la Encargada de retiros que recibió el retiro' using errcode = 'check_violation';
  end if;
  if new.depositado_en > now() + interval '5 minutes' or new.depositado_en < x.entregado_en - interval '1 day' then
    raise exception 'La fecha del depósito no corresponde' using errcode = 'check_violation';
  end if;
  if new.corrige_id is not null and not exists (
       select 1 from deposito_retiro d where d.id = new.corrige_id and d.retiro_id = new.retiro_id
         and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id)) then
    raise exception 'Solo se corrige un depósito vigente del mismo folio' using errcode = 'check_violation';
  end if;
  select coalesce(sum(d.importe), 0) into vigente from deposito_retiro d
  where d.retiro_id = new.retiro_id and d.id is distinct from new.corrige_id
    and not exists (select 1 from deposito_retiro c where c.corrige_id = d.id);
  if vigente + new.importe > x.monto_habilitado then
    raise exception 'Los depósitos superarían el monto verificado del folio' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger deposito_retiro_valido
  before insert on deposito_retiro
  for each row execute function deposito_retiro_valido();
create trigger deposito_retiro_inmutable
  before update or delete on deposito_retiro
  for each row execute function impedir_modificacion();
create trigger deposito_retiro_sin_vaciar
  before truncate on deposito_retiro
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Salida de efectivo del lugar al entregar el retiro: movimiento negativo ligado al retiro (no a un cobro).
-- ---------------------------------------------------------------------------
alter table movimiento_efectivo alter column cobro_id drop not null;
alter table movimiento_efectivo add column retiro_id uuid unique references retiro (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null));

create function salida_retiro_valida() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'salida_retiro' and not exists (
    select 1 from retiro r where r.id = new.retiro_id and r.importe = -new.importe
      and r.lugar_id = new.lugar_id and r.turno_id = new.turno_id) then
    raise exception 'La salida debe ser exactamente el importe del retiro, en su lugar y turno' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger movimiento_efectivo_salida_valida
  before insert on movimiento_efectivo
  for each row execute function salida_retiro_valida();
