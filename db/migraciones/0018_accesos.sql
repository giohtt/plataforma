-- 0018 · Bloque 4: registro de accesos (apertura manual) para el piloto de Tenango. Solo datos ficticios.
-- Indicado el 9 y 10 nov 2026 (propuesta para el piloto):
--   - el pase vale el día del cobro y en esa sucursal; volver el mismo día a la misma sucursal es un REINGRESO
--     con el mismo pase, sin cobrar; en otra sucursal se necesita un pase nuevo;
--   - una transferencia con abono pendiente solo entra con autorización de Encargado (o de quien tenga el
--     permiso), que responde desde su sesión; el cobro sigue pendiente hasta verificar el abono;
--   - la apertura sin pase se registra aparte, con motivo, para revisión; si es una visita que normalmente se
--     cobra, pide autorización; en una emergencia se registra la apertura y el motivo puede completarse después;
--   - una entrada por persona (también en cobros grupales); el cobro y la apertura se consultan por separado;
--   - la plataforma REGISTRA la apertura manual (hora, turno y quién la hizo); no controla la puerta.

-- ---------------------------------------------------------------------------
-- Permisos. Registrar: Recepción. Autorizar: Encargado por rol; Dirección solo con permiso explícito en la
-- sucursal (facultad otorgada). Revisar: Encargado, Administración y Dirección.
-- ---------------------------------------------------------------------------
insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('acceso.autorizar', 'Autorizar accesos de transferencias pendientes y visitas sin cobro', 4, false),
  ('acceso.consultar', 'Revisar el registro de accesos y las aperturas sin pase', 4, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion',      'acceso.registrar_apertura'),
  ('encargado',      'acceso.autorizar'),
  ('encargado',      'acceso.consultar'),
  ('administracion', 'acceso.consultar'),
  ('direccion',      'acceso.consultar');

-- Día de un instante en la zona horaria de la sucursal.
create function dia_en_sucursal(p_sucursal uuid, p_momento timestamptz) returns date
language sql stable as $$
  select (p_momento at time zone s.zona_horaria)::date from sucursal s where s.id = p_sucursal
$$;

-- ---------------------------------------------------------------------------
-- Autorización de acceso: la pide Recepción, la responde otra persona con acceso.autorizar desde su sesión.
-- ---------------------------------------------------------------------------
create table autorizacion_acceso (
  id                uuid primary key default gen_random_uuid(),
  sucursal_id       uuid not null references sucursal (id),
  turno_id          uuid not null references turno (id),
  tipo              text not null check (tipo in ('transferencia_pendiente', 'visita_sin_cobro')),
  pase_id           uuid references pase_visita (id),
  nota              text not null check (length(btrim(nota)) between 5 and 300),
  solicitada_por    uuid not null references usuario (id),
  solicitada_en     timestamptz not null default now(),
  estado            text not null default 'solicitada' check (estado in ('solicitada', 'aprobada', 'rechazada')),
  resuelta_por      uuid references usuario (id),
  resuelta_en       timestamptz,
  motivo_resolucion text check (motivo_resolucion is null or length(btrim(motivo_resolucion)) between 5 and 300),
  version           integer not null default 1,
  constraint autorizacion_pase_segun_tipo check ((tipo = 'transferencia_pendiente') = (pase_id is not null)),
  constraint autorizacion_otra_persona check (resuelta_por is null or resuelta_por <> solicitada_por),
  constraint autorizacion_estado_coherente check (
    (estado = 'solicitada' and resuelta_por is null and resuelta_en is null and motivo_resolucion is null)
    or (estado in ('aprobada', 'rechazada') and resuelta_por is not null and resuelta_en is not null and motivo_resolucion is not null))
);
-- Una sola solicitud activa (pendiente o aprobada) por pase. Tras un rechazo se puede pedir otra.
create unique index autorizacion_activa_por_pase on autorizacion_acceso (pase_id) where estado in ('solicitada', 'aprobada');
create index autorizacion_pendiente_sucursal on autorizacion_acceso (sucursal_id) where estado = 'solicitada';

create function autorizacion_acceso_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'autorizacion_acceso: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if old.estado <> 'solicitada' or new.estado not in ('aprobada', 'rechazada') or new.version <> old.version + 1
       or (new.id, new.sucursal_id, new.turno_id, new.tipo, new.pase_id, new.nota, new.solicitada_por, new.solicitada_en)
          is distinct from
          (old.id, old.sucursal_id, old.turno_id, old.tipo, old.pase_id, old.nota, old.solicitada_por, old.solicitada_en) then
      raise exception 'autorizacion_acceso: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
    -- Quien registró el cobro tampoco la resuelve.
    if new.pase_id is not null and exists (
      select 1 from pase_visita p join operacion_visita o on o.id = p.operacion_id
      where p.id = new.pase_id and o.registrada_por = new.resuelta_por) then
      raise exception 'Quien registró el cobro no puede resolver su autorización de acceso' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger autorizacion_acceso_valida
  before update or delete on autorizacion_acceso
  for each row execute function autorizacion_acceso_valida();
create trigger autorizacion_acceso_sin_vaciar
  before truncate on autorizacion_acceso
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Acceso: cada apertura manual registrada.
-- ---------------------------------------------------------------------------
create table acceso (
  id               uuid primary key default gen_random_uuid(),
  clave            uuid not null unique,                 -- doble envío: la misma clave no registra dos veces
  sucursal_id      uuid not null references sucursal (id),
  turno_id         uuid not null references turno (id),
  tipo             text not null check (tipo in ('entrada', 'reingreso', 'sin_pase')),
  pase_id          uuid references pase_visita (id),
  autorizacion_id  uuid unique references autorizacion_acceso (id),
  motivo           text check (motivo in ('socio_open_desk', 'proveedor_mantenimiento', 'visita_cobrable', 'emergencia', 'otro')),
  detalle          text check (detalle is null or length(btrim(detalle)) between 5 and 300),
  registrado_por   uuid not null references usuario (id),
  registrado_en    timestamptz not null default now(),
  detalle_por      uuid references usuario (id),          -- emergencia: quién completó el motivo después
  detalle_en       timestamptz,
  constraint acceso_pase_segun_tipo check ((tipo = 'sin_pase') = (pase_id is null)),
  constraint acceso_motivo_segun_tipo check ((tipo = 'sin_pase') = (motivo is not null)),
  constraint acceso_detalle_requerido check (motivo not in ('otro', 'visita_cobrable') or detalle is not null),
  constraint acceso_visita_cobrable_autorizada check (motivo is distinct from 'visita_cobrable' or autorizacion_id is not null),
  constraint acceso_detalle_posterior check ((detalle_por is null) = (detalle_en is null) and (detalle_por is null or motivo = 'emergencia'))
);
-- Una sola entrada por pase; los reingresos usan el mismo pase.
create unique index acceso_una_entrada_por_pase on acceso (pase_id) where tipo = 'entrada';
create index acceso_turno on acceso (turno_id);
create index acceso_emergencia_sin_motivo on acceso (sucursal_id) where motivo = 'emergencia' and detalle is null;

create function acceso_valido() returns trigger
language plpgsql as $$
declare
  v_pase record;
  v_aut record;
begin
  if tg_op = 'DELETE' then
    raise exception 'acceso: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    -- Solo se completa una vez el motivo de una emergencia.
    if old.motivo is distinct from 'emergencia' or old.detalle is not null or new.detalle is null or new.detalle_por is null
       or (new.id, new.clave, new.sucursal_id, new.turno_id, new.tipo, new.pase_id, new.autorizacion_id, new.motivo,
           new.registrado_por, new.registrado_en)
          is distinct from
          (old.id, old.clave, old.sucursal_id, old.turno_id, old.tipo, old.pase_id, old.autorizacion_id, old.motivo,
           old.registrado_por, old.registrado_en) then
      raise exception 'acceso: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- Durante el turno abierto de la misma sucursal.
  if not exists (select 1 from turno t where t.id = new.turno_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
    raise exception 'El acceso se registra durante el turno abierto de la sucursal' using errcode = 'check_violation';
  end if;
  if new.autorizacion_id is not null then
    select * into v_aut from autorizacion_acceso a where a.id = new.autorizacion_id;
    if v_aut.estado <> 'aprobada' or v_aut.sucursal_id <> new.sucursal_id
       or (new.tipo = 'sin_pase' and (v_aut.tipo <> 'visita_sin_cobro' or new.motivo <> 'visita_cobrable'))
       or (new.tipo <> 'sin_pase' and (v_aut.tipo <> 'transferencia_pendiente' or v_aut.pase_id <> new.pase_id)) then
      raise exception 'La autorización no corresponde a este acceso' using errcode = 'check_violation';
    end if;
  end if;
  if new.tipo = 'sin_pase' then
    return new;
  end if;

  -- Con pase: de esta sucursal, del día de hoy (en la zona de la sucursal) y no cancelado.
  select p.sucursal_id, p.creado_en, p.cancelado_en, c.estado, c.forma_pago
    into v_pase
    from pase_visita p join cobro_visita c on c.operacion_id = p.operacion_id
    where p.id = new.pase_id;
  if v_pase.sucursal_id <> new.sucursal_id then
    raise exception 'El pase es de otra sucursal: necesita un pase nuevo' using errcode = 'check_violation';
  end if;
  if dia_en_sucursal(new.sucursal_id, v_pase.creado_en) <> dia_en_sucursal(new.sucursal_id, now()) then
    raise exception 'El pase solo vale el día del cobro' using errcode = 'check_violation';
  end if;
  if v_pase.cancelado_en is not null or v_pase.estado in ('cancelado', 'no_localizado') then
    raise exception 'El pase no está vigente' using errcode = 'check_violation';
  end if;
  if new.tipo = 'entrada' and v_pase.estado = 'pendiente_abono' and new.autorizacion_id is null then
    raise exception 'Una transferencia pendiente necesita autorización para entrar' using errcode = 'check_violation';
  end if;
  if new.tipo = 'reingreso' and not exists (select 1 from acceso a where a.pase_id = new.pase_id and a.tipo = 'entrada') then
    raise exception 'El reingreso necesita una entrada previa con el mismo pase' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger acceso_valido
  before insert or update or delete on acceso
  for each row execute function acceso_valido();
create trigger acceso_sin_vaciar
  before truncate on acceso
  for each statement execute function impedir_modificacion();
