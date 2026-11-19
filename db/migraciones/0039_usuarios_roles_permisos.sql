-- Bloque 1 (ampliación), aprobado el 19 nov 2026 (16:22): sección «Usuarios, roles y permisos» (solo datos ficticios).
--   1. Puesto de cada cuenta (el nombre del cargo; no da permisos).
--   2. Restricciones individuales: quitan a una persona un permiso aunque se lo den sus perfiles o una facultad. Una
--      restricción prevalece siempre (tiene_permiso devuelve falso).
--   3. Invitaciones de un solo uso por 48 horas, generadas por quien administra; generar otra invalida la anterior. La
--      recuperación sigue en 30 minutos.
--   4. Autorización personal y temporal (máximo 90 días, renovable, con motivo) para que una cuenta de Dirección revise
--      diferencias e incidencias en las que participó. Cada revisión así queda marcada (autorrevision_id). Sin esa
--      autorización expresa, quien participó no revisa, aunque reúna varios perfiles.
--   5. Nunca queda la plataforma sin una cuenta activa que pueda administrar accesos de forma permanente (usuario.asignar
--      y usuario.editar sin vencimiento ni restricción): se protege frente a desactivación, retiro y vencimiento.

-- ---------------------------------------------------------------------------
-- 1. Puesto
-- ---------------------------------------------------------------------------
alter table usuario add column puesto text check (puesto is null or length(btrim(puesto)) between 2 and 80);

-- ---------------------------------------------------------------------------
-- 2. Restricciones individuales
-- ---------------------------------------------------------------------------
create table restriccion_permiso (
  id                   uuid primary key default gen_random_uuid(),
  usuario_id           uuid not null references usuario (id),
  permiso              text not null references permiso (clave),
  sucursal_id          uuid references sucursal (id),
  todas_las_sucursales boolean not null default false,
  vigente_desde        timestamptz not null default now(),
  vigente_hasta        timestamptz,
  otorgada_por         uuid not null references usuario (id),
  motivo               text not null check (length(btrim(motivo)) >= 3),
  revocada_en          timestamptz,
  revocada_por         uuid references usuario (id),
  creado_en            timestamptz not null default now(),
  constraint restriccion_alcance_explicito check ((sucursal_id is null) = todas_las_sucursales),
  constraint restriccion_vigencia check (vigente_hasta is null or vigente_hasta > vigente_desde),
  constraint restriccion_revocacion check ((revocada_en is null) = (revocada_por is null))
);
create unique index restriccion_vigente_unica on restriccion_permiso
  (usuario_id, permiso, coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid)) where revocada_en is null;
create function restriccion_permiso_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    -- Un permiso general (crear usuarios, por ejemplo) solo se restringe en todas las sucursales.
    if not new.todas_las_sucursales and exists (select 1 from permiso p where p.clave = new.permiso and p.ambito = 'general') then
      raise exception 'Un permiso general se restringe en todas las sucursales' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'restriccion_permiso no se borra' using errcode = 'insufficient_privilege';
  end if;
  -- Solo se quita (una vez); lo demás no cambia.
  if old.revocada_en is not null or new.revocada_en is null
     or (new.id, new.usuario_id, new.permiso, new.sucursal_id, new.todas_las_sucursales, new.vigente_desde, new.vigente_hasta, new.otorgada_por, new.motivo, new.creado_en)
        is distinct from (old.id, old.usuario_id, old.permiso, old.sucursal_id, old.todas_las_sucursales, old.vigente_desde, old.vigente_hasta, old.otorgada_por, old.motivo, old.creado_en) then
    raise exception 'restriccion_permiso: solo se puede quitar' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger restriccion_permiso_valida
  before insert or update or delete on restriccion_permiso
  for each row execute function restriccion_permiso_valida();

create function permiso_restringido(p_usuario uuid, p_permiso text, p_sucursal uuid) returns boolean
language sql stable as $$
  select exists (select 1 from restriccion_permiso r
                 where r.usuario_id = p_usuario and r.permiso = p_permiso
                   and (r.todas_las_sucursales or r.sucursal_id = p_sucursal)
                   and vigente(r.vigente_desde, r.vigente_hasta, r.revocada_en))
$$;

-- Misma definición de 0004, más la restricción individual, que prevalece sobre perfiles y facultades.
create or replace function tiene_permiso(p_usuario uuid, p_permiso text, p_sucursal uuid) returns boolean
language sql stable as $$
  with p as (select ambito from permiso where clave = p_permiso),
       u as (select 1 from usuario where id = p_usuario and activo)
  select exists (select 1 from u) and not permiso_restringido(p_usuario, p_permiso, p_sucursal) and coalesce((
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

-- ---------------------------------------------------------------------------
-- 3. Invitaciones de 48 horas
-- ---------------------------------------------------------------------------
alter table enlace_recuperacion
  add column tipo text not null default 'recuperacion' check (tipo in ('recuperacion', 'invitacion')),
  add column generado_por uuid references usuario (id);
alter table enlace_recuperacion add constraint enlace_tipo_duracion check (
  case tipo when 'invitacion' then generado_por is not null and expira_en <= creado_en + interval '48 hours'
            else expira_en <= creado_en + interval '30 minutes' end) not valid;

-- ---------------------------------------------------------------------------
-- 4. Autorización personal para revisar lo propio (máximo 90 días)
-- ---------------------------------------------------------------------------
create table autorrevision (
  id                   uuid primary key default gen_random_uuid(),
  usuario_id           uuid not null references usuario (id),
  sucursal_id          uuid references sucursal (id),
  todas_las_sucursales boolean not null default false,
  vigente_desde        timestamptz not null default now(),
  vigente_hasta        timestamptz not null,
  otorgada_por         uuid not null references usuario (id),
  motivo               text not null check (length(btrim(motivo)) between 5 and 300),
  -- Si renueva otra, cuál (la anterior se termina en la misma operación).
  renueva_a            uuid references autorrevision (id),
  revocada_en          timestamptz,
  revocada_por         uuid references usuario (id),
  motivo_revocacion    text,
  creado_en            timestamptz not null default now(),
  constraint autorrevision_alcance_explicito check ((sucursal_id is null) = todas_las_sucursales),
  constraint autorrevision_maximo_90_dias check (vigente_hasta > vigente_desde and vigente_hasta <= vigente_desde + interval '90 days'),
  constraint autorrevision_revocacion check ((revocada_en is null) = (revocada_por is null) and (revocada_en is null) = (motivo_revocacion is null))
);
create function autorrevision_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'autorrevision no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if old.revocada_en is not null or new.revocada_en is null
       or (new.id, new.usuario_id, new.sucursal_id, new.todas_las_sucursales, new.vigente_desde, new.vigente_hasta, new.otorgada_por, new.motivo, new.renueva_a, new.creado_en)
          is distinct from (old.id, old.usuario_id, old.sucursal_id, old.todas_las_sucursales, old.vigente_desde, old.vigente_hasta, old.otorgada_por, old.motivo, old.renueva_a, old.creado_en) then
      raise exception 'autorrevision: solo se puede terminar' using errcode = 'insufficient_privilege';
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
  if exists (select 1 from autorrevision a where a.usuario_id = new.usuario_id and a.revocada_en is null and a.vigente_hasta > new.vigente_desde
             and (a.todas_las_sucursales or new.todas_las_sucursales or a.sucursal_id = new.sucursal_id)) then
    raise exception 'Ya hay una autorización vigente: renuévala o termínala' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger autorrevision_valida
  before insert or update or delete on autorrevision
  for each row execute function autorrevision_valida();

-- La autorización vigente de esta persona para esta sucursal (null si no hay). Exige seguir con Dirección ahí.
create function autorrevision_vigente(p_usuario uuid, p_sucursal uuid) returns uuid
language sql stable as $$
  select a.id from autorrevision a
  where a.usuario_id = p_usuario and (a.todas_las_sucursales or a.sucursal_id = p_sucursal)
    and vigente(a.vigente_desde, a.vigente_hasta, a.revocada_en)
    and exists (select 1 from perfiles_en_sucursal(p_usuario, p_sucursal) p where p = 'direccion')
    and exists (select 1 from usuario u where u.id = p_usuario and u.activo)
  order by a.vigente_desde desc limit 1
$$;

alter table revision_diferencia add column autorrevision_id uuid references autorrevision (id);
alter table revision_incidencia add column autorrevision_id uuid references autorrevision (id);
alter table revision_diferencia_sobre add column autorrevision_id uuid references autorrevision (id);
alter table revision_incidencia_llave add column autorrevision_id uuid references autorrevision (id);
alter table retiro_revision add column autorrevision_id uuid references autorrevision (id);

-- Las mismas reglas de antes; quien participó solo revisa con su autorización vigente, que queda en la revisión.
create or replace function revision_diferencia_valida()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  d record;
begin
  select df.importe, e.id as entrega_id, t.sucursal_id
    into d
  from diferencia_efectivo df join entrega_turno e on e.id = df.entrega_id join turno t on t.id = e.turno_id
  where df.id = new.diferencia_id;
  if (new.resultado = 'faltante_confirmado' and d.importe >= 0) or (new.resultado = 'sobrante_confirmado' and d.importe <= 0) then
    raise exception 'El resultado no corresponde al signo de la diferencia' using errcode = 'check_violation';
  end if;
  if new.revisada_por in (select participantes_entrega(d.entrega_id)) then
    if new.autorrevision_id is null or new.autorrevision_id is distinct from autorrevision_vigente(new.revisada_por, d.sucursal_id) then
      raise exception 'Quien participó en la entrega no revisa sus diferencias' using errcode = 'check_violation';
    end if;
  elsif new.autorrevision_id is not null then
    raise exception 'La autorización para revisar lo propio solo se usa en lo que participaste' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_entrega(d.entrega_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) r where r = new.nivel) then
    raise exception 'Esta diferencia la revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create or replace function revision_diferencia_sobre_valida()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  d record;
begin
  select ds.sobre_id, ds.importe, s.sucursal_id into d from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id where ds.id = new.diferencia_id;
  if new.revisada_por in (select participantes_sobre(d.sobre_id)) then
    if new.autorrevision_id is null or new.autorrevision_id is distinct from autorrevision_vigente(new.revisada_por, d.sucursal_id) then
      raise exception 'Quien participó en la cadena del sobre no revisa su diferencia' using errcode = 'check_violation';
    end if;
  elsif new.autorrevision_id is not null then
    raise exception 'La autorización para revisar lo propio solo se usa en lo que participaste' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) p where p = 'administracion')
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', d.sucursal_id) then
    raise exception 'Revisa Administración' using errcode = 'check_violation';
  end if;
  if (new.resultado = 'faltante_confirmado' and d.importe >= 0) or (new.resultado = 'sobrante_confirmado' and d.importe <= 0)
     or (new.resultado = 'incidencia_confirmada' and d.importe <> 0) then
    raise exception 'El resultado no corresponde al signo de la diferencia' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create or replace function revision_incidencia_valida()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  d record;
begin
  select i.entrega_id, t.sucursal_id into d
  from incidencia_cierre i join entrega_turno e on e.id = i.entrega_id join turno t on t.id = e.turno_id where i.id = new.incidencia_id;
  if new.revisada_por in (select participantes_entrega(d.entrega_id)) then
    if new.autorrevision_id is null or new.autorrevision_id is distinct from autorrevision_vigente(new.revisada_por, d.sucursal_id) then
      raise exception 'Quien participó en el cierre no revisa sus incidencias' using errcode = 'check_violation';
    end if;
  elsif new.autorrevision_id is not null then
    raise exception 'La autorización para revisar lo propio solo se usa en lo que participaste' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_entrega(d.entrega_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) r where r = new.nivel)
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', d.sucursal_id) then
    raise exception 'Esta incidencia la revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create or replace function revision_incidencia_llave_valida()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  i record;
begin
  select x.recoleccion_id, r.sucursal_id into i
  from incidencia_llave_recoleccion x join recoleccion r on r.id = x.recoleccion_id where x.id = new.incidencia_id;
  if new.revisada_por in (select participantes_recoleccion(i.recoleccion_id)) then
    if new.autorrevision_id is null or new.autorrevision_id is distinct from autorrevision_vigente(new.revisada_por, i.sucursal_id) then
      raise exception 'Quien participó en la recolección o devolución no revisa su incidencia' using errcode = 'check_violation';
    end if;
  elsif new.autorrevision_id is not null then
    raise exception 'La autorización para revisar lo propio solo se usa en lo que participaste' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.revisada_por, i.sucursal_id) p where p = 'administracion')
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', i.sucursal_id) then
    raise exception 'Revisa Administración' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

create or replace function retiro_revision_valida()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  x record;
begin
  select r.importe, r.sucursal_id, r.estado, r.discrepancia, r.folio into x from retiro r where r.id = new.retiro_id;
  if x.estado <> 'por_revisar' then
    raise exception 'Solo se revisa un retiro por revisar' using errcode = 'check_violation';
  end if;
  -- Con el folio en duda, se habilita solo al verificar que el efectivo corresponde al sobre de este retiro.
  if x.discrepancia = 'folio' and new.folio_verificado is distinct from x.folio then
    raise exception 'Falta verificar que el efectivo corresponde al folio de este retiro' using errcode = 'check_violation';
  end if;
  if x.discrepancia <> 'folio' and new.folio_verificado is not null then
    raise exception 'El folio verificado solo aplica cuando el folio no coincidió' using errcode = 'check_violation';
  end if;
  if new.resultado = 'faltante_confirmado' and new.monto_verificado >= x.importe then
    raise exception 'Un faltante confirmado verifica menos de lo registrado' using errcode = 'check_violation';
  end if;
  if new.revisada_por in (select participantes_retiro(new.retiro_id)) then
    if new.autorrevision_id is null or new.autorrevision_id is distinct from autorrevision_vigente(new.revisada_por, x.sucursal_id) then
      raise exception 'Quien participó en el retiro no lo revisa' using errcode = 'check_violation';
    end if;
  elsif new.autorrevision_id is not null then
    raise exception 'La autorización para revisar lo propio solo se usa en lo que participaste' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_retiro(new.retiro_id)
     or not tiene_permiso(new.revisada_por, 'retiro.revisar', x.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, x.sucursal_id) r where r = new.nivel) then
    raise exception 'Este retiro lo revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Siempre una cuenta activa que administre accesos de forma permanente
-- ---------------------------------------------------------------------------
create function permiso_general_permanente(p_usuario uuid, p_permiso text) returns boolean
language sql stable as $$
  select exists (select 1 from usuario u where u.id = p_usuario and u.activo)
     and (exists (select 1 from alcance_general g join rol_permiso rp on rp.rol = g.rol and rp.permiso = p_permiso
                  where g.usuario_id = p_usuario and g.revocado_en is null and g.vigente_hasta is null and g.vigente_desde <= now())
          or exists (select 1 from facultad_otorgada f
                     where f.usuario_id = p_usuario and f.permiso = p_permiso and f.todas_las_sucursales
                       and f.revocada_en is null and f.vigente_hasta is null and f.vigente_desde <= now()))
     -- Una restricción vigente o programada también cuenta.
     and not exists (select 1 from restriccion_permiso r where r.usuario_id = p_usuario and r.permiso = p_permiso
                     and r.revocada_en is null and (r.vigente_hasta is null or r.vigente_hasta > now()))
$$;
create function administracion_permanente() returns boolean
language sql stable as $$
  select exists (select 1 from usuario u where u.activo
                 and permiso_general_permanente(u.id, 'usuario.asignar') and permiso_general_permanente(u.id, 'usuario.editar'))
$$;
-- Solo se exige donde alguna vez hubo quien administre (una base vacía de pruebas no se bloquea).
create function proteger_administracion() returns trigger
language plpgsql as $$
begin
  if not administracion_permanente() and (
       exists (select 1 from alcance_general g join rol_permiso rp on rp.rol = g.rol and rp.permiso = 'usuario.asignar')
       or exists (select 1 from facultad_otorgada f where f.permiso = 'usuario.asignar' and f.todas_las_sucursales)) then
    raise exception 'Debe quedar al menos una cuenta activa que administre accesos sin vencimiento' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger proteger_administracion_usuario
  after update of activo on usuario deferrable initially deferred
  for each row when (old.activo and not new.activo) execute function proteger_administracion();
create constraint trigger proteger_administracion_alcance
  after update on alcance_general deferrable initially deferred
  for each row execute function proteger_administracion();
create constraint trigger proteger_administracion_facultad
  after update on facultad_otorgada deferrable initially deferred
  for each row execute function proteger_administracion();
create constraint trigger proteger_administracion_restriccion
  after insert on restriccion_permiso deferrable initially deferred
  for each row execute function proteger_administracion();
