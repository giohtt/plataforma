-- 0004 · Permisos efectivos, alcance general separado y facultades con límite.
--
-- Tres cosas distintas, que se otorgan por separado y nunca por omisión:
--   1. Perfil en una sucursal         → asignacion (siempre con sucursal).
--   2. Alcance general de un perfil   → alcance_general (todas las sucursales, incluidas las futuras).
--   3. Facultad expresa a una persona → facultad_otorgada (por ejemplo, autorizar gastos; con límite).

-- ---------------------------------------------------------------------------
-- 1. Las asignaciones de perfil son siempre por sucursal. "Todas" se otorga aparte.
-- ---------------------------------------------------------------------------
alter table asignacion
  add constraint asignacion_siempre_por_sucursal check (sucursal_id is not null and not todas_las_sucursales);

-- ---------------------------------------------------------------------------
-- 2. Alcance general: el perfil vale en todas las sucursales. Requiere motivo y quién lo otorgó.
-- ---------------------------------------------------------------------------
create table alcance_general (
  id            uuid primary key default gen_random_uuid(),
  usuario_id    uuid not null references usuario (id),
  rol           text not null references rol (clave),
  vigente_desde timestamptz not null default now(),
  vigente_hasta timestamptz,
  otorgado_por  uuid references usuario (id),
  motivo        text not null check (length(btrim(motivo)) >= 3),
  revocado_en   timestamptz,
  revocado_por  uuid references usuario (id),
  creado_en     timestamptz not null default now(),
  constraint alcance_vigencia check (vigente_hasta is null or vigente_hasta > vigente_desde)
);
create unique index alcance_general_vigente_unico on alcance_general (usuario_id, rol) where revocado_en is null;

-- ---------------------------------------------------------------------------
-- 3. Facultades de autorización: siempre con límite de monto. Nunca ilimitadas por omisión.
-- ---------------------------------------------------------------------------
create function facultad_autorizacion_con_limite() returns trigger
language plpgsql as $$
begin
  if new.limite_monto is null and exists (select 1 from permiso p where p.clave = new.permiso and p.es_autorizacion) then
    raise exception 'La facultad % requiere un límite de monto', new.permiso using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger facultad_autorizacion_con_limite
  before insert or update on facultad_otorgada
  for each row execute function facultad_autorizacion_con_limite();

-- ---------------------------------------------------------------------------
-- Ámbito de cada permiso: "sucursal" (se ejerce en una sucursal) o "general" (no depende de una
-- sucursal, como crear sucursales o usuarios). Los generales solo se obtienen con alcance general
-- o con una facultad otorgada para todas las sucursales.
-- ---------------------------------------------------------------------------
alter table permiso add column ambito text not null default 'sucursal' check (ambito in ('sucursal', 'general'));
update permiso set ambito = 'general' where clave in (
  'sucursal.crear', 'usuario.crear', 'usuario.editar', 'usuario.asignar', 'usuario.restablecer',
  'historial.consultar', 'promocion.administrar');

-- ---------------------------------------------------------------------------
-- Permisos de cada perfil para el bloque 1 (los demás bloques agregan los suyos cuando se construyan).
-- Dirección queda con una lista explícita, no con "todo".
-- ---------------------------------------------------------------------------
insert into rol_permiso (rol, permiso) values
  ('recepcion',      'sucursal.consultar'),
  ('encargado',      'sucursal.consultar'),
  ('encargado',      'usuario.consultar'),
  ('administracion', 'sucursal.consultar'),
  ('administracion', 'usuario.consultar'),
  ('direccion',      'sucursal.consultar'),
  ('direccion',      'sucursal.editar'),
  ('direccion',      'sucursal.desactivar'),
  ('direccion',      'usuario.consultar'),
  ('direccion',      'sucursal.crear'),
  ('direccion',      'usuario.crear'),
  ('direccion',      'usuario.editar'),
  ('direccion',      'usuario.asignar'),
  ('direccion',      'usuario.restablecer'),
  ('direccion',      'historial.consultar');

-- ---------------------------------------------------------------------------
-- Funciones de consulta: una sola definición de "vigente" y de "tiene permiso" para toda la aplicación.
-- ---------------------------------------------------------------------------
create function vigente(desde timestamptz, hasta timestamptz, revocado timestamptz) returns boolean
language sql stable as $$
  select revocado is null and desde <= now() and (hasta is null or hasta > now())
$$;

-- Perfiles vigentes de un usuario en una sucursal (por asignación directa o por alcance general).
create function perfiles_en_sucursal(p_usuario uuid, p_sucursal uuid) returns setof text
language sql stable as $$
  select a.rol from asignacion a
  where a.usuario_id = p_usuario and a.sucursal_id = p_sucursal
    and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)
  union
  select g.rol from alcance_general g
  where g.usuario_id = p_usuario and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en)
$$;

-- ¿Tiene el usuario este permiso? p_sucursal es obligatoria para permisos de ámbito "sucursal"
-- y se ignora para los de ámbito "general". Un usuario inactivo no tiene ningún permiso.
create function tiene_permiso(p_usuario uuid, p_permiso text, p_sucursal uuid) returns boolean
language sql stable as $$
  with p as (select ambito from permiso where clave = p_permiso),
       u as (select 1 from usuario where id = p_usuario and activo)
  select exists (select 1 from u) and coalesce((
    select case p.ambito
      when 'sucursal' then
        p_sucursal is not null and exists (select 1 from sucursal where id = p_sucursal) and (
          exists (select 1 from perfiles_en_sucursal(p_usuario, p_sucursal) r
                  join rol_permiso rp on rp.rol = r and rp.permiso = p_permiso)
          or exists (select 1 from facultad_otorgada f
                     where f.usuario_id = p_usuario and f.permiso = p_permiso
                       and (f.sucursal_id = p_sucursal or f.todas_las_sucursales)
                       and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)))
      else
        exists (select 1 from alcance_general g join rol_permiso rp on rp.rol = g.rol and rp.permiso = p_permiso
                where g.usuario_id = p_usuario and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en))
        or exists (select 1 from facultad_otorgada f
                   where f.usuario_id = p_usuario and f.permiso = p_permiso and f.todas_las_sucursales
                     and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en))
    end
    from p), false)
$$;
