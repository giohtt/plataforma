-- 0006 · Bloque 2: expediente de visitante, búsqueda y confirmación de «es otra persona».
-- Solo datos ficticios hasta aprobar la decisión 3 (privacidad del expediente). Las reglas sobre campos
-- obligatorios, enmascaramiento del teléfono y lo que se ve entre sucursales están PENDIENTES; aquí la
-- base solo exige lo indispensable (nombre) y valida el formato de lo que se capture.

create extension if not exists pg_trgm;

-- Clave de comparación de nombres: minúsculas, sin acentos, un solo espacio. Misma regla que claveNombre()
-- en la aplicación, para que «José Pérez», «jose perez» y «JOSÉ  PÉREZ» se encuentren igual.
create function clave_texto(t text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(
    translate(lower(t), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
    '\s+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- Expediente: único para toda Fitnessland. El teléfono NO es único (se comparte en familias).
-- Nunca se identifica ni se fusiona a nadie solo por el nombre.
-- ---------------------------------------------------------------------------
create table visitante (
  id                 uuid primary key default gen_random_uuid(),
  nombre             text not null check (length(btrim(nombre)) between 3 and 120),
  nombre_clave       text generated always as (clave_texto(nombre)) stored,
  telefono           text check (telefono ~ '^[0-9]{10}$'),
  estado_procedencia text check (length(btrim(estado_procedencia)) between 2 and 60),
  sucursal_alta_id   uuid not null references sucursal (id),
  creado_por         uuid references usuario (id),
  creado_en          timestamptz not null default now()
);
create index visitante_nombre_trgm on visitante using gin (nombre_clave gin_trgm_ops);
create index visitante_telefono on visitante (telefono) where telefono is not null;
create trigger visitante_sin_borrar
  before delete on visitante
  for each row execute function impedir_modificacion();

-- Cuando Recepción ve posibles coincidencias y confirma «es otra persona», queda registrado
-- contra cada expediente que se le mostró. Sirve después para no volver a sugerir la misma pareja
-- como duplicado y para revisar quién decidió.
create table visitante_distinto (
  id              bigint generated always as identity primary key,
  visitante_id    uuid not null references visitante (id),
  distinto_de_id  uuid not null references visitante (id),
  motivo          text not null,
  confirmado_por  uuid references usuario (id),
  sucursal_id     uuid references sucursal (id),
  en              timestamptz not null default now(),
  constraint visitante_distinto_no_mismo check (visitante_id <> distinto_de_id)
);
create trigger visitante_distinto_inmutable
  before update or delete on visitante_distinto
  for each row execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Permisos PROVISIONALES para el sitio de pruebas (qué ve cada perfil es parte de la decisión 3).
-- Recepción y Encargado buscan, consultan y crean; Administración busca y consulta;
-- Dirección busca, consulta y crea. Corregir, fusionar e historial general quedan sin asignar.
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values
  ('recepcion',      'visitante.buscar'),
  ('recepcion',      'visitante.consultar'),
  ('recepcion',      'visitante.crear'),
  ('encargado',      'visitante.buscar'),
  ('encargado',      'visitante.consultar'),
  ('encargado',      'visitante.crear'),
  ('administracion', 'visitante.buscar'),
  ('administracion', 'visitante.consultar'),
  ('direccion',      'visitante.buscar'),
  ('direccion',      'visitante.consultar'),
  ('direccion',      'visitante.crear');
