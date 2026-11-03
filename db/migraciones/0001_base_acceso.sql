-- 0001 · Base de acceso: usuarios, sucursales, roles, permisos, asignaciones e historial.
-- Las migraciones no se editan una vez aplicadas: los cambios van en una migración nueva.

-- ---------------------------------------------------------------------------
-- Usuarios. Cada persona tiene su propia cuenta; nunca cuentas compartidas.
-- Las credenciales de inicio de sesión se agregan en la tarea 3.
-- Un usuario no se borra: se desactiva y conserva su historial.
-- ---------------------------------------------------------------------------
create table usuario (
  id             uuid primary key default gen_random_uuid(),
  nombre         text not null check (length(btrim(nombre)) between 2 and 120),
  correo         text not null check (correo = lower(btrim(correo)) and correo like '%_@_%._%'),
  activo         boolean not null default true,
  es_prueba      boolean not null default false,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create unique index usuario_correo_unico on usuario (correo);

-- ---------------------------------------------------------------------------
-- Sucursales. Una sucursal no se borra: se desactiva y conserva su historial.
-- Crear una sucursal no la asigna a ningún usuario.
-- "estado_operativo" es el estado de la sucursal; "estado_republica" es su ubicación.
-- ---------------------------------------------------------------------------
create table sucursal (
  id                   uuid primary key default gen_random_uuid(),
  nombre               text not null check (length(btrim(nombre)) between 2 and 80),
  codigo               text not null check (codigo ~ '^[A-Z0-9]{2,5}$'),
  color                text check (color ~ '^#[0-9a-f]{6}$'),
  direccion            text,
  estado_republica     text,
  zona_horaria         text not null default 'America/Mexico_City',
  estado_operativo     text not null default 'proxima'
                       check (estado_operativo in ('proxima', 'activa', 'inactiva')),
  id_externo_open_desk text,
  creado_por           uuid references usuario (id),
  creado_en            timestamptz not null default now(),
  actualizado_en       timestamptz not null default now()
);
create unique index sucursal_codigo_unico on sucursal (codigo);
create unique index sucursal_nombre_unico on sucursal (lower(btrim(nombre)));
create unique index sucursal_open_desk_unico on sucursal (id_externo_open_desk)
  where id_externo_open_desk is not null;

-- ---------------------------------------------------------------------------
-- Catálogo de roles y permisos.
-- Las facultades de autorización (es_autorizacion) NO pueden formar parte de un rol:
-- solo se otorgan expresamente a una persona (tabla facultad_otorgada).
-- ---------------------------------------------------------------------------
create table rol (
  clave                  text primary key check (clave ~ '^[a-z_]+$'),
  nombre                 text not null,
  descripcion            text not null,
  disponible_en_bloque_1 boolean not null default false
);

create table permiso (
  clave           text primary key check (clave ~ '^[a-z_]+\.[a-z_]+$'),
  descripcion     text not null,
  bloque          smallint not null check (bloque between 1 and 8),
  es_autorizacion boolean not null default false
);

create table rol_permiso (
  rol     text not null references rol (clave),
  permiso text not null references permiso (clave),
  primary key (rol, permiso)
);

create function rol_permiso_sin_autorizacion() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from permiso p where p.clave = new.permiso and p.es_autorizacion) then
    raise exception 'La facultad % es de autorización: se otorga expresamente a una persona, no a un rol', new.permiso
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger rol_permiso_sin_autorizacion
  before insert or update on rol_permiso
  for each row execute function rol_permiso_sin_autorizacion();

-- ---------------------------------------------------------------------------
-- Asignaciones de rol a una persona, por sucursal.
-- No hay acceso a todas las sucursales por omisión: o se indica una sucursal,
-- o se marca expresamente "todas_las_sucursales". Nunca ambas, nunca ninguna.
-- ---------------------------------------------------------------------------
create table asignacion (
  id                   uuid primary key default gen_random_uuid(),
  usuario_id           uuid not null references usuario (id),
  rol                  text not null references rol (clave),
  sucursal_id          uuid references sucursal (id),
  todas_las_sucursales boolean not null default false,
  vigente_desde        timestamptz not null default now(),
  vigente_hasta        timestamptz,
  otorgada_por         uuid references usuario (id),
  motivo               text not null check (length(btrim(motivo)) >= 3),
  revocada_en          timestamptz,
  revocada_por         uuid references usuario (id),
  creado_en            timestamptz not null default now(),
  constraint asignacion_alcance_explicito check ((sucursal_id is null) = todas_las_sucursales),
  constraint asignacion_vigencia check (vigente_hasta is null or vigente_hasta > vigente_desde)
);
create unique index asignacion_vigente_unica on asignacion
  (usuario_id, rol, coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revocada_en is null;

-- ---------------------------------------------------------------------------
-- Facultades otorgadas expresamente a una persona (por ejemplo, autorizar gastos),
-- con alcance, límite de monto opcional, vigencia, quién la otorgó y por qué.
-- ---------------------------------------------------------------------------
create table facultad_otorgada (
  id                   uuid primary key default gen_random_uuid(),
  usuario_id           uuid not null references usuario (id),
  permiso              text not null references permiso (clave),
  sucursal_id          uuid references sucursal (id),
  todas_las_sucursales boolean not null default false,
  limite_monto         numeric(12, 2) check (limite_monto is null or limite_monto >= 0),
  vigente_desde        timestamptz not null default now(),
  vigente_hasta        timestamptz,
  otorgada_por         uuid references usuario (id),
  motivo               text not null check (length(btrim(motivo)) >= 3),
  revocada_en          timestamptz,
  revocada_por         uuid references usuario (id),
  creado_en            timestamptz not null default now(),
  constraint facultad_alcance_explicito check ((sucursal_id is null) = todas_las_sucursales),
  constraint facultad_vigencia check (vigente_hasta is null or vigente_hasta > vigente_desde)
);

-- ---------------------------------------------------------------------------
-- Historial de cambios: solo se agregan registros; no se editan ni se borran.
-- ---------------------------------------------------------------------------
create table historial_cambio (
  id         bigint generated always as identity primary key,
  entidad    text not null,
  entidad_id text not null,
  accion     text not null,
  cambios    jsonb not null default '{}'::jsonb,
  motivo     text,
  usuario_id uuid references usuario (id),
  en         timestamptz not null default now()
);
create index historial_cambio_entidad on historial_cambio (entidad, entidad_id, en);

create function impedir_modificacion() returns trigger
language plpgsql as $$
begin
  raise exception '%: no se permite % en esta tabla', tg_table_name, lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger historial_cambio_inmutable
  before update or delete on historial_cambio
  for each row execute function impedir_modificacion();
create trigger historial_cambio_sin_vaciar
  before truncate on historial_cambio
  for each statement execute function impedir_modificacion();

-- Sucursales y usuarios se desactivan; nunca se borran.
create trigger sucursal_sin_borrar
  before delete on sucursal
  for each row execute function impedir_modificacion();
create trigger usuario_sin_borrar
  before delete on usuario
  for each row execute function impedir_modificacion();
