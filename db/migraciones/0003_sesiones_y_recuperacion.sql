-- 0003 · Inicio de sesión, sesiones, recuperación de cuenta y buzón de pruebas.
-- Nunca se guardan contraseñas ni enlaces en claro: solo su huella.

-- Contraseña: huella scrypt con sal propia. Un usuario sin contraseña aún no puede entrar;
-- la establece él mismo con un enlace de un solo uso.
alter table usuario
  add column hash_contrasena          text check (hash_contrasena is null or hash_contrasena like 'scrypt$%'),
  add column contrasena_actualizada_en timestamptz;

-- Sesiones: la cookie lleva un código aleatorio; aquí se guarda solo su huella SHA-256.
create table sesion (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  usuario_id  uuid not null references usuario (id),
  creada_en   timestamptz not null default now(),
  expira_en   timestamptz not null,
  cerrada_en  timestamptz,
  motivo_cierre text check (motivo_cierre in ('cierre', 'cambio_contrasena', 'administrativo')),
  constraint sesion_vigencia check (expira_en > creada_en),
  constraint sesion_cierre check ((cerrada_en is null) = (motivo_cierre is null))
);
create unique index sesion_token_unico on sesion (token_hash);
create index sesion_usuario on sesion (usuario_id) where cerrada_en is null;

-- Enlaces de recuperación: de un solo uso, con caducidad. Solicitar uno nuevo invalida los anteriores.
create table enlace_recuperacion (
  id             uuid primary key default gen_random_uuid(),
  token_hash     text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  usuario_id     uuid not null references usuario (id),
  creado_en      timestamptz not null default now(),
  expira_en      timestamptz not null,
  usado_en       timestamptz,
  invalidado_en  timestamptz,
  constraint enlace_vigencia check (expira_en > creado_en),
  constraint enlace_un_desenlace check (usado_en is null or invalidado_en is null)
);
create unique index enlace_token_unico on enlace_recuperacion (token_hash);
create index enlace_usuario on enlace_recuperacion (usuario_id, creado_en);

-- Intentos de inicio de sesión, para limitar intentos fallidos y dejar rastro.
create table intento_acceso (
  id     bigint generated always as identity primary key,
  correo text not null,
  exito  boolean not null,
  motivo text not null check (motivo in ('ok', 'credenciales', 'bloqueado', 'sin_contrasena', 'inactivo')),
  en     timestamptz not null default now()
);
create index intento_acceso_correo on intento_acceso (correo, en);
create trigger intento_acceso_inmutable
  before update or delete on intento_acceso
  for each row execute function impedir_modificacion();

-- Buzón de pruebas: guarda los mensajes que se enviarían por correo, solo fuera de producción.
-- No se envía nada. La aplicación se niega a escribir aquí en producción.
create table buzon_prueba (
  id        bigint generated always as identity primary key,
  para      text not null,
  asunto    text not null,
  cuerpo    text not null,
  enlace    text,
  creado_en timestamptz not null default now()
);
