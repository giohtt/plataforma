-- 0047 · Bloque 6, PR 3: solicitudes de gasto (acordado el 27 nov 2026; solo datos ficticios).
--   - Solicitan Recepción, Encargados, Administración, Gestión administrativa y Dirección, dentro de sus sucursales
--     (gasto.solicitar en la sucursal beneficiada y en la que paga).
--   - Consultan los gastos de la sucursal: Encargado, Administración, Gestión administrativa y Dirección (gasto.consultar).
--     Recepción ve solo lo que ella solicitó.
--   - Clave fija por sucursal beneficiada (TEN-G1), asignada al registrar; nunca se reutiliza ni cambia, y conserva el
--     código original aunque después cambie el de la sucursal.
--   - Sucursal beneficiada (a la que se carga el gasto) y sucursal que paga, por separado.
--   - «¿Es parte de una compra ya solicitada?»: se liga a la solicitud original de la misma sucursal beneficiada.
--   - Cada corrección es una versión nueva, con motivo; las anteriores se conservan. Nada se edita ni se borra.
--   - Solicitar no mueve dinero ni autoriza nada. La autorización, el rechazo y la ruta llegan en el PR 4.
--   - Las categorías son un catálogo; en el entorno de pruebas se cargan categorías marcadas «de prueba» (la lista real
--     sigue pendiente).

insert into rol_permiso (rol, permiso) values
  ('recepcion',              'gasto.solicitar'),
  ('encargado',              'gasto.solicitar'),
  ('administracion',         'gasto.solicitar'),
  ('gestion_administrativa', 'gasto.solicitar'),
  ('direccion',              'gasto.solicitar'),
  ('encargado',              'gasto.consultar'),
  ('administracion',         'gasto.consultar'),
  ('gestion_administrativa', 'gasto.consultar'),
  ('direccion',              'gasto.consultar');

create table categoria_gasto (
  clave     text primary key check (clave ~ '^[a-z_]+$'),
  nombre    text not null unique check (char_length(btrim(nombre)) between 2 and 60),
  de_prueba boolean not null,
  activa    boolean not null default true,
  orden     integer not null default 0
);

create table gasto (
  id               uuid primary key default gen_random_uuid(),
  -- Sucursal beneficiada: a la que se carga el gasto (reportes de gastos).
  sucursal_id      uuid not null references sucursal (id),
  -- Sucursal que paga: de donde sale el dinero (caja). Puede ser la misma.
  sucursal_paga_id uuid not null references sucursal (id),
  numero           integer not null check (numero > 0),
  clave            text not null unique,
  compra_de        uuid references gasto (id),
  solicitado_por   uuid not null references usuario (id),
  solicitado_en    timestamptz not null default now(),
  clave_envio      uuid not null unique,
  unique (sucursal_id, numero),
  constraint gasto_compra_no_propia check (compra_de is distinct from id)
);

-- Clave por sucursal beneficiada; el bloqueo de la fila de la sucursal evita números repetidos. La compra original debe
-- ser de la misma sucursal beneficiada y no ser, a su vez, parte de otra (una sola compra original).
create function gasto_al_registrar() returns trigger
language plpgsql as $$
declare
  v_codigo text;
  o record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  if new.compra_de is not null then
    select sucursal_id, compra_de into o from gasto where id = new.compra_de;
    if o is null or o.sucursal_id <> new.sucursal_id or o.compra_de is not null then
      raise exception 'La compra original debe ser una solicitud de la misma sucursal beneficiada' using errcode = 'check_violation';
    end if;
  end if;
  select codigo into v_codigo from sucursal where id = new.sucursal_id for update;
  select coalesce(max(numero), 0) + 1 into new.numero from gasto where sucursal_id = new.sucursal_id;
  new.clave := v_codigo || '-G' || new.numero;
  return new;
end;
$$;
create trigger gasto_al_registrar before insert or update or delete on gasto
  for each row execute function gasto_al_registrar();
create trigger gasto_sin_vaciar before truncate on gasto
  for each statement execute function impedir_modificacion();

create table gasto_version (
  id             uuid primary key default gen_random_uuid(),
  gasto_id       uuid not null references gasto (id),
  version        integer not null check (version > 0),
  concepto       text not null check (char_length(btrim(concepto)) between 3 and 120),
  categoria      text not null references categoria_gasto (clave),
  importe        numeric(12, 2) not null check (importe > 0),
  proveedor      text check (proveedor is null or char_length(btrim(proveedor)) between 2 and 120),
  nota           text check (nota is null or char_length(btrim(nota)) between 1 and 300),
  -- Motivo de la corrección: obligatorio desde la versión 2.
  motivo         text check (motivo is null or char_length(btrim(motivo)) between 5 and 300),
  registrada_por uuid not null references usuario (id),
  en             timestamptz not null default now(),
  unique (gasto_id, version),
  constraint gasto_version_motivo check ((version = 1) = (motivo is null))
);

-- Versiones consecutivas, de quien solicitó, con categoría activa.
create function gasto_version_valida() returns trigger
language plpgsql as $$
declare
  g record;
  v_ultima integer;
begin
  if tg_op <> 'INSERT' then
    raise exception 'gasto_version: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select solicitado_por into g from gasto where id = new.gasto_id for update;
  select coalesce(max(version), 0) into v_ultima from gasto_version where gasto_id = new.gasto_id;
  if new.version <> v_ultima + 1 then
    raise exception 'La versión no es la siguiente: alguien más corrigió la solicitud' using errcode = 'serialization_failure';
  end if;
  if new.registrada_por <> g.solicitado_por then
    raise exception 'Solo quien solicitó el gasto lo corrige' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from categoria_gasto c where c.clave = new.categoria and c.activa) then
    raise exception 'La categoría no está activa' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger gasto_version_valida before insert or update or delete on gasto_version
  for each row execute function gasto_version_valida();
create trigger gasto_version_sin_vaciar before truncate on gasto_version
  for each statement execute function impedir_modificacion();

-- Toda solicitud tiene su versión 1 en la misma transacción.
create function gasto_con_version() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from gasto_version v where v.gasto_id = new.id and v.version = 1) then
    raise exception 'La solicitud de gasto registra su versión 1' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger gasto_con_version after insert on gasto
  deferrable initially deferred for each row execute function gasto_con_version();
