-- 0043 · Autorización personal para resolver faltantes en los que participó (solo datos ficticios).
-- Indicado el 26 nov 2026:
--   - Es distinta de la autorización para revisar lo propio (autorrevision): una no amplía a la otra y ninguna se activa
--     sola. Se otorga expresamente por sucursal (o en todas), con vigencia de máximo 90 días, motivo e historial. Se
--     renueva a mano (termina la vigente y empieza otra); nunca se renueva sola.
--   - La otorga quien administra accesos («usuario.asignar»), también a sí misma, con vista previa, motivo e historial.
--   - Solo sirve para resolver con «Lo absorbe la sucursal» un faltante ya confirmado de un retiro o de un sobre en el que
--     la persona participó. Para usarla deben seguir vigentes su perfil de Dirección, el permiso «diferencia.resolver» y
--     esta autorización en la sucursal del caso. Al vencer o terminarla se bloquean nuevas resoluciones propias.
--   - Cada resolución hecha así queda marcada para siempre (autorresolucion_id): «Resuelta por quien participó».
--   - No cambia conteos, depósitos ni saldos, ni cobra o descuenta a ninguna persona.

create table autorresolucion (
  id                   uuid primary key default gen_random_uuid(),
  usuario_id           uuid not null references usuario (id),
  sucursal_id          uuid references sucursal (id),
  todas_las_sucursales boolean not null default false,
  vigente_desde        timestamptz not null default now(),
  vigente_hasta        timestamptz not null,
  otorgada_por         uuid not null references usuario (id),
  motivo               text not null check (length(btrim(motivo)) between 5 and 300),
  renueva_a            uuid references autorresolucion (id),
  revocada_en          timestamptz,
  revocada_por         uuid references usuario (id),
  motivo_revocacion    text,
  creado_en            timestamptz not null default now(),
  constraint autorresolucion_alcance_explicito check ((sucursal_id is null) = todas_las_sucursales),
  constraint autorresolucion_maximo_90_dias check (vigente_hasta > vigente_desde and vigente_hasta <= vigente_desde + interval '90 days'),
  constraint autorresolucion_revocacion check ((revocada_en is null) = (revocada_por is null) and (revocada_en is null) = (motivo_revocacion is null))
);

create function autorresolucion_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'autorresolucion no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if old.revocada_en is not null or new.revocada_en is null
       or (new.id, new.usuario_id, new.sucursal_id, new.todas_las_sucursales, new.vigente_desde, new.vigente_hasta, new.otorgada_por, new.motivo, new.renueva_a, new.creado_en)
          is distinct from (old.id, old.usuario_id, old.sucursal_id, old.todas_las_sucursales, old.vigente_desde, old.vigente_hasta, old.otorgada_por, old.motivo, old.renueva_a, old.creado_en) then
      raise exception 'autorresolucion: solo se puede terminar' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- Solo para una cuenta activa de Dirección (en la sucursal o con alcance en todas); la otorga quien administra accesos.
  if not exists (select 1 from usuario u where u.id = new.usuario_id and u.activo)
     or (new.todas_las_sucursales and not exists (select 1 from alcance_general g where g.usuario_id = new.usuario_id and g.rol = 'direccion'
                                                   and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en)))
     or (not new.todas_las_sucursales and not exists (select 1 from perfiles_en_sucursal(new.usuario_id, new.sucursal_id) p where p = 'direccion'))
     or not tiene_permiso(new.otorgada_por, 'usuario.asignar', null) then
    raise exception 'Se autoriza a una cuenta de Dirección, por quien administra accesos' using errcode = 'check_violation';
  end if;
  if exists (select 1 from autorresolucion a where a.usuario_id = new.usuario_id and a.revocada_en is null and a.vigente_hasta > new.vigente_desde
             and (a.todas_las_sucursales or new.todas_las_sucursales or a.sucursal_id = new.sucursal_id)) then
    raise exception 'Ya hay una autorización vigente: renuévala o termínala' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger autorresolucion_valida
  before insert or update or delete on autorresolucion
  for each row execute function autorresolucion_valida();
create trigger autorresolucion_sin_vaciar
  before truncate on autorresolucion
  for each statement execute function impedir_modificacion();

-- La autorización vigente de esta persona para resolver lo propio en esta sucursal (null si no hay). Exige seguir con
-- Dirección ahí y la cuenta activa.
create function autorresolucion_vigente(p_usuario uuid, p_sucursal uuid) returns uuid
language sql stable as $$
  select a.id from autorresolucion a
  where a.usuario_id = p_usuario and (a.todas_las_sucursales or a.sucursal_id = p_sucursal)
    and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)
    and exists (select 1 from perfiles_en_sucursal(p_usuario, p_sucursal) p where p = 'direccion')
    and exists (select 1 from usuario u where u.id = p_usuario and u.activo)
  order by a.vigente_desde desc limit 1
$$;

alter table resolucion_retiro add column autorresolucion_id uuid references autorresolucion (id);
alter table resolucion_diferencia_sobre add column autorresolucion_id uuid references autorresolucion (id);

-- Quien participó solo resuelve con su autorización vigente en esa sucursal, y queda marcado; quien no participó, sin marca.
create or replace function resolucion_retiro_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'resolucion_retiro: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select r.sucursal_id, v.resultado into d
  from retiro r left join retiro_revision v on v.retiro_id = r.id where r.id = new.retiro_id;
  if d.resultado is distinct from 'faltante_confirmado' then
    raise exception 'Solo se resuelve un faltante confirmado' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.resuelta_por, 'diferencia.resolver', d.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.resuelta_por, d.sucursal_id) p where p = 'direccion') then
    raise exception 'Resuelve Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  if new.resuelta_por in (select participantes_retiro(new.retiro_id)) then
    if new.autorresolucion_id is null or new.autorresolucion_id is distinct from autorresolucion_vigente(new.resuelta_por, d.sucursal_id) then
      raise exception 'Quien participó en el retiro no resuelve su faltante sin autorización vigente' using errcode = 'check_violation';
    end if;
  elsif new.autorresolucion_id is not null then
    raise exception 'Solo se marca como propia si participó' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function resolucion_diferencia_sobre_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'resolucion_diferencia_sobre: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select ds.sobre_id, s.sucursal_id, v.resultado into d
  from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id
  left join revision_diferencia_sobre v on v.diferencia_id = ds.id where ds.id = new.diferencia_id;
  if d.resultado is distinct from 'faltante_confirmado' then
    raise exception 'Solo se resuelve un faltante confirmado' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.resuelta_por, 'diferencia.resolver', d.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.resuelta_por, d.sucursal_id) p where p = 'direccion') then
    raise exception 'Resuelve Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  if new.resuelta_por in (select participantes_sobre(d.sobre_id)) then
    if new.autorresolucion_id is null or new.autorresolucion_id is distinct from autorresolucion_vigente(new.resuelta_por, d.sucursal_id) then
      raise exception 'Quien participó en la cadena del sobre no resuelve su faltante sin autorización vigente' using errcode = 'check_violation';
    end if;
  elsif new.autorresolucion_id is not null then
    raise exception 'Solo se marca como propia si participó' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
