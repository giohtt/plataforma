-- 0032 · Bloque 5, regla 7: fondo fijo de caja (aprobado el 17 nov 2026; solo datos ficticios).
--   1. Cada lugar (bolsa de visitas y cajón de mensualidades) tiene un fondo fijo, provisional de $300 y $300, que se
--      queda separado e identificado dentro del cajón con llave. Solo Dirección autoriza cambios de monto, indicando
--      de dónde sale o a dónde va el dinero.
--   2. Al cerrar se cuenta cada lugar y por separado su fondo: primero se completa el fondo y solo el excedente va al
--      sobre. Fondo + sobre = lo contado. Si no alcanza, se registra lo contado y la diferencia queda por revisar.
--   3. Al abrir se cuentan por separado el fondo y el sobre de cada lugar.
--   4. Dirección y Administración registran reposiciones indicando el origen; la responsable vigente confirma desde su
--      cuenta cuánto recibe (si es la misma persona que entrega, confirma otra persona autorizada). Reponer no cierra
--      la revisión del faltante.
--   5. Se registra quién custodia la llave del cajón (el custodio nocturno) y quién tiene acceso al cajón.
--   6. Quien tiene en la sucursal los perfiles de Recepción y Encargado puede cerrar y quedar como custodio con la
--      misma cuenta; confirma la custodia en el mismo cierre y el historial lo indica.

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('fondo.autorizar', 'Autorizar cambios al monto del fondo fijo de caja, con origen o destino del dinero', 5, false),
  ('fondo.reponer',   'Registrar la reposición de un fondo fijo de caja, con el origen del dinero', 5, false);
insert into rol_permiso (rol, permiso) values
  ('direccion', 'fondo.autorizar'),
  ('direccion', 'fondo.reponer'),
  ('administracion', 'fondo.reponer');

-- ---------------------------------------------------------------------------
-- Custodia: dónde quedan los fondos y quién tiene acceso al cajón. Las configuraciones nuevas lo exigen.
-- ---------------------------------------------------------------------------
alter table custodia_configuracion add column lugar_fondos text check (lugar_fondos is null or char_length(btrim(lugar_fondos)) between 5 and 120);
alter table custodia_configuracion add column acceso_cajon uuid[] check (acceso_cajon is null or cardinality(acceso_cajon) between 1 and 10);
create function custodia_configuracion_cajon() returns trigger
language plpgsql as $$
begin
  if new.lugar_fondos is null or new.acceso_cajon is null then
    raise exception 'Indica dónde quedan los fondos y quién tiene acceso al cajón' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.acceso_cajon) a(u) where not exists (select 1 from perfiles_en_sucursal(a.u, new.sucursal_id))) then
    raise exception 'El acceso al cajón es para personas con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_configuracion_cajon
  before insert on custodia_configuracion
  for each row execute function custodia_configuracion_cajon();

-- El cierre exige una configuración con fondos y acceso al cajón.
create function cierre_con_cajon() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'cierre' and not exists (
    select 1 from custodia_configuracion c where c.id = new.custodia_config_id and c.acceso_cajon is not null) then
    raise exception 'Dirección debe indicar dónde quedan los fondos y quién tiene acceso al cajón' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger cierre_con_cajon
  before insert on entrega_turno
  for each row execute function cierre_con_cajon();

-- Misma persona: quien cierra puede ser el custodio si también es Encargado de la sucursal (cierre_valido lo exige).
alter table entrega_turno drop constraint cierre_con_custodio;
alter table entrega_turno add constraint cierre_con_custodio check (
  (tipo = 'cierre') = (custodio_id is not null) and (tipo = 'cierre') = (custodia_config_id is not null));

-- La custodia confirma también el cajón cerrado y la llave recibida; si no, incidencia con motivo.
alter table custodia_cierre add column llave text not null default 'correcta' check (llave in ('correcta', 'incidencia'));
alter table custodia_cierre add column motivo_llave text check (motivo_llave is null or char_length(btrim(motivo_llave)) between 5 and 300);
alter table custodia_cierre add constraint llave_con_motivo check ((llave = 'incidencia') = (motivo_llave is not null));

-- ---------------------------------------------------------------------------
-- Monto del fondo: solo se agregan versiones; el vigente es el más reciente (sin versiones, $0).
-- ---------------------------------------------------------------------------
create table fondo_caja (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  lugar_id      uuid not null references lugar_efectivo (id),
  monto         numeric(12, 2) not null check (monto >= 0 and monto <= 5000),
  anterior      numeric(12, 2) not null check (anterior >= 0),
  -- Aumento: de dónde sale el dinero. Reducción: a dónde va.
  origen        text check (origen in ('entrega_persona', 'excedente_cierre')),
  destino       text check (destino in ('sobre_cierre', 'retiro')),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  autorizado_por uuid not null references usuario (id),
  en            timestamptz not null default now(),
  constraint fondo_cambia check (monto <> anterior),
  constraint fondo_origen_destino check (
    (monto > anterior and origen is not null and destino is null) or (monto < anterior and destino is not null and origen is null))
);
create index fondo_caja_lugar on fondo_caja (lugar_id, en desc);
create function fondo_caja_valido() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from lugar_efectivo l where l.id = new.lugar_id and l.sucursal_id = new.sucursal_id) then
    raise exception 'El lugar debe ser de la sucursal' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.autorizado_por, 'fondo.autorizar', new.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.autorizado_por, new.sucursal_id) r where r = 'direccion') then
    raise exception 'Solo Dirección autoriza cambios al monto del fondo' using errcode = 'insufficient_privilege';
  end if;
  if new.anterior <> coalesce((select f.monto from fondo_caja f where f.lugar_id = new.lugar_id order by f.en desc, f.id limit 1), 0) then
    raise exception 'El monto anterior no es el vigente' using errcode = 'serialization_failure';
  end if;
  return new;
end;
$$;
create trigger fondo_caja_valido
  before insert on fondo_caja
  for each row execute function fondo_caja_valido();
create trigger fondo_caja_inmutable
  before update or delete on fondo_caja
  for each row execute function impedir_modificacion();
create trigger fondo_caja_sin_vaciar
  before truncate on fondo_caja
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Entrada de efectivo al fondo (aumento entregado por una persona o reposición): pendiente hasta que se confirma.
-- ---------------------------------------------------------------------------
create table entrada_fondo (
  id              uuid primary key default gen_random_uuid(),
  sucursal_id     uuid not null references sucursal (id),
  lugar_id        uuid not null references lugar_efectivo (id),
  tipo            text not null check (tipo in ('aumento', 'reposicion')),
  fondo_id        uuid unique references fondo_caja (id),
  importe         numeric(12, 2) not null check (importe > 0 and importe <= 5000),
  origen          text not null check (char_length(btrim(origen)) between 5 and 200),
  entrega         uuid not null references usuario (id),
  registrada_por  uuid not null references usuario (id),
  registrada_en   timestamptz not null default now(),
  estado          text not null default 'pendiente' check (estado in ('pendiente', 'recibida', 'cancelada')),
  recibida_por    uuid references usuario (id),
  importe_recibido numeric(12, 2),
  turno_id        uuid references turno (id),
  resuelta_en     timestamptz,
  motivo_cancelacion text check (motivo_cancelacion is null or char_length(btrim(motivo_cancelacion)) between 5 and 300),
  constraint entrada_aumento_con_fondo check ((tipo = 'aumento') = (fondo_id is not null)),
  constraint entrada_resuelta check (
    (estado = 'pendiente' and recibida_por is null and resuelta_en is null and turno_id is null and importe_recibido is null)
    or (estado = 'recibida' and recibida_por is not null and resuelta_en is not null and turno_id is not null and importe_recibido = importe)
    or (estado = 'cancelada' and recibida_por is null and resuelta_en is not null and motivo_cancelacion is not null))
);
create function entrada_fondo_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'entrada_fondo no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente' or new.entrega <> new.registrada_por then
      raise exception 'La entrada se registra pendiente, por quien entrega el dinero' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from lugar_efectivo l where l.id = new.lugar_id and l.sucursal_id = new.sucursal_id) then
      raise exception 'El lugar debe ser de la sucursal' using errcode = 'check_violation';
    end if;
    if new.tipo = 'reposicion' and not tiene_permiso(new.registrada_por, 'fondo.reponer', new.sucursal_id) then
      raise exception 'Registran reposiciones Dirección y Administración' using errcode = 'insufficient_privilege';
    end if;
    if new.tipo = 'aumento' and not exists (
      select 1 from fondo_caja f where f.id = new.fondo_id and f.lugar_id = new.lugar_id and f.origen = 'entrega_persona'
        and f.monto - f.anterior = new.importe) then
      raise exception 'La entrada del aumento debe ser la diferencia autorizada' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.estado <> 'pendiente' or new.estado = 'pendiente'
     or (new.id, new.sucursal_id, new.lugar_id, new.tipo, new.fondo_id, new.importe, new.origen, new.entrega, new.registrada_por, new.registrada_en)
        is distinct from (old.id, old.sucursal_id, old.lugar_id, old.tipo, old.fondo_id, old.importe, old.origen, old.entrega, old.registrada_por, old.registrada_en) then
    raise exception 'entrada_fondo: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  if new.estado = 'recibida' then
    -- Confirma la responsable vigente del lugar; si ella misma entregó, otra persona autorizada de la sucursal.
    if new.recibida_por = old.entrega then
      raise exception 'Quien entrega no confirma lo que recibe' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from turno t where t.id = new.turno_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'Se recibe en un turno abierto' using errcode = 'check_violation';
    end if;
    if exists (select 1 from responsable_lugar r where r.turno_id = new.turno_id and r.lugar_id = new.lugar_id and r.hasta is null and r.usuario_id = old.entrega) then
      if not exists (select 1 from perfiles_en_sucursal(new.recibida_por, new.sucursal_id) p where p in ('encargado', 'administracion', 'direccion')) then
        raise exception 'Si la responsable entregó, confirma otra persona autorizada' using errcode = 'check_violation';
      end if;
    elsif not exists (select 1 from responsable_lugar r where r.turno_id = new.turno_id and r.lugar_id = new.lugar_id and r.hasta is null and r.usuario_id = new.recibida_por) then
      raise exception 'Confirma la responsable vigente del lugar' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger entrada_fondo_valida
  before insert or update or delete on entrada_fondo
  for each row execute function entrada_fondo_valida();
create trigger entrada_fondo_sin_vaciar
  before truncate on entrada_fondo
  for each statement execute function impedir_modificacion();

-- La entrada recibida suma al efectivo del lugar en el turno (y a su esperado).
alter table movimiento_efectivo add column entrada_fondo_id uuid unique references entrada_fondo (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null));
create function entrada_fondo_movimiento_valido() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'entrada_fondo' and not exists (
    select 1 from entrada_fondo x where x.id = new.entrada_fondo_id and x.estado = 'recibida' and x.importe = new.importe
      and x.lugar_id = new.lugar_id and x.turno_id = new.turno_id) then
    raise exception 'La entrada al fondo debe ser exactamente lo recibido, en su lugar y turno' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger movimiento_efectivo_entrada_fondo
  before insert on movimiento_efectivo
  for each row execute function entrada_fondo_movimiento_valido();

-- ---------------------------------------------------------------------------
-- Conteo separado de fondo y sobre al cerrar y al abrir (el total de cada lugar sigue en entrega_conteo).
-- ---------------------------------------------------------------------------
create table conteo_fondo (
  entrega_id  uuid not null references entrega_turno (id),
  lugar_id    uuid not null references lugar_efectivo (id),
  momento     text not null check (momento in ('cierre', 'apertura_inicial', 'apertura_final')),
  fondo_monto numeric(12, 2) not null check (fondo_monto >= 0),
  fondo       numeric(12, 2) not null check (fondo >= 0),
  sobre       numeric(12, 2) not null check (sobre >= 0),
  contado_por uuid not null references usuario (id),
  en          timestamptz not null default now(),
  primary key (entrega_id, lugar_id, momento),
  -- Al cerrar: primero se completa el fondo; solo el excedente va al sobre.
  constraint fondo_primero check (momento <> 'cierre' or (fondo <= fondo_monto and (sobre = 0 or fondo = fondo_monto)))
);
create function conteo_fondo_valido() returns trigger
language plpgsql as $$
declare
  e record;
  total numeric;
begin
  select x.tipo, x.entrega_por, x.recibe into e from entrega_turno x where x.id = new.entrega_id;
  if e.tipo is distinct from 'cierre' then
    raise exception 'El conteo de fondo es de un cierre' using errcode = 'check_violation';
  end if;
  if new.contado_por <> (case when new.momento = 'cierre' then e.entrega_por else e.recibe end) then
    raise exception 'Cuenta el fondo quien cierra o quien abre' using errcode = 'check_violation';
  end if;
  select c.importe into total from entrega_conteo c where c.entrega_id = new.entrega_id and c.lugar_id = new.lugar_id
    and c.tipo = case new.momento when 'cierre' then 'entregado' when 'apertura_inicial' then 'recibido_inicial' else 'recibido_final' end;
  if total is null or total <> new.fondo + new.sobre then
    raise exception 'Fondo + sobre debe ser lo contado en el lugar' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger conteo_fondo_valido
  before insert on conteo_fondo
  for each row execute function conteo_fondo_valido();
create trigger conteo_fondo_inmutable
  before update or delete on conteo_fondo
  for each row execute function impedir_modificacion();
create trigger conteo_fondo_sin_vaciar
  before truncate on conteo_fondo
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Incidencias nuevas: fondo incompleto al cerrar y llave/cajón en la custodia. Quedan por revisar.
-- ---------------------------------------------------------------------------
alter table incidencia_cierre drop constraint incidencia_cierre_tipo_check;
alter table incidencia_cierre add constraint incidencia_cierre_tipo_check
  check (tipo in ('custodia_sin_confirmar', 'sobre_en_custodia', 'sobre_al_abrir', 'fondo_incompleto', 'llave_custodia'));
alter table incidencia_cierre drop constraint incidencia_con_verificacion;
alter table incidencia_cierre add column lugar_id uuid references lugar_efectivo (id);
alter table incidencia_cierre add constraint incidencia_con_verificacion check (
  (tipo in ('sobre_en_custodia', 'sobre_al_abrir')) = (verificacion_id is not null)
  and (tipo = 'fondo_incompleto') = (lugar_id is not null));
create unique index incidencia_fondo_unica on incidencia_cierre (entrega_id, lugar_id) where tipo = 'fondo_incompleto';
create unique index incidencia_llave_unica on incidencia_cierre (entrega_id) where tipo = 'llave_custodia';

create or replace function incidencia_cierre_valida() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.estado = 'confirmada') then
    raise exception 'Las incidencias se registran al confirmarse la apertura de un cierre' using errcode = 'check_violation';
  end if;
  if new.tipo = 'custodia_sin_confirmar' then
    if not exists (select 1 from apertura_sin_custodia a where a.entrega_id = new.entrega_id) then
      raise exception 'No hubo apertura sin custodia confirmada' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'fondo_incompleto' then
    if not exists (select 1 from conteo_fondo c where c.entrega_id = new.entrega_id and c.lugar_id = new.lugar_id
                     and c.momento = 'cierre' and c.fondo < c.fondo_monto) then
      raise exception 'El fondo no quedó incompleto al cerrar' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'llave_custodia' then
    if not exists (select 1 from custodia_cierre c where c.entrega_id = new.entrega_id and c.llave = 'incidencia') then
      raise exception 'No hubo incidencia con la llave o el cajón' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select x.momento, x.estado, s.entrega_id into v from verificacion_sobre x join sobre_cierre s on s.id = x.sobre_id where x.id = new.verificacion_id;
  if v is null or v.entrega_id <> new.entrega_id or v.estado = 'correcto'
     or v.momento <> (case new.tipo when 'sobre_en_custodia' then 'custodia' else 'apertura' end) then
    raise exception 'La incidencia corresponde a una verificación de sobre con problema' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
