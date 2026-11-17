-- Bloque 5, regla 7 (ajuste del 16 nov 2026, antes de unir el cierre):
-- 1. Apertura con la custodia sin confirmar: si el custodio está disponible, confirma primero. Si no, quien abre
--    puede abrir con motivo obligatorio; la falta de confirmación queda por revisar.
-- 2. Cualquier incidencia de sello o folio (del custodio o al abrir) queda por revisar, aunque el efectivo cuadre.
-- Las incidencias se revisan con las mismas reglas de quién revisa que las diferencias del cierre.

-- ---------------------------------------------------------------------------
-- Apertura sin confirmación del custodio.
-- ---------------------------------------------------------------------------
create table apertura_sin_custodia (
  entrega_id     uuid primary key references entrega_turno (id),
  motivo         text not null check (char_length(btrim(motivo)) between 5 and 300),
  registrada_por uuid not null references usuario (id),
  en             timestamptz not null default now()
);
create function apertura_sin_custodia_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.recibe = new.registrada_por)
     or exists (select 1 from custodia_cierre c where c.entrega_id = new.entrega_id) then
    raise exception 'Solo quien abre registra la apertura sin custodia confirmada' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger apertura_sin_custodia_valida
  before insert on apertura_sin_custodia
  for each row execute function apertura_sin_custodia_valida();
create trigger apertura_sin_custodia_inmutable
  before update or delete on apertura_sin_custodia
  for each row execute function impedir_modificacion();
create trigger apertura_sin_custodia_sin_vaciar
  before truncate on apertura_sin_custodia
  for each statement execute function impedir_modificacion();

-- La custodia se confirma antes de que alguien empiece a abrir.
create function custodia_antes_de_abrir() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from entrega_turno e where e.id = new.entrega_id and (e.recibe is not null or e.estado <> 'pendiente')) then
    raise exception 'La custodia se confirma antes de abrir' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_antes_de_abrir
  before insert on custodia_cierre
  for each row execute function custodia_antes_de_abrir();

-- ---------------------------------------------------------------------------
-- Incidencias del cierre: se registran al confirmarse la apertura y quedan por revisar.
-- ---------------------------------------------------------------------------
create table incidencia_cierre (
  id              uuid primary key default gen_random_uuid(),
  entrega_id      uuid not null references entrega_turno (id),
  tipo            text not null check (tipo in ('custodia_sin_confirmar', 'sobre_en_custodia', 'sobre_al_abrir')),
  verificacion_id bigint unique references verificacion_sobre (id),
  registrada_en   timestamptz not null default now(),
  constraint incidencia_con_verificacion check ((tipo = 'custodia_sin_confirmar') = (verificacion_id is null))
);
create unique index incidencia_sin_custodia_unica on incidencia_cierre (entrega_id) where tipo = 'custodia_sin_confirmar';
create function incidencia_cierre_valida() returns trigger
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
  select x.momento, x.estado, s.entrega_id into v from verificacion_sobre x join sobre_cierre s on s.id = x.sobre_id where x.id = new.verificacion_id;
  if v is null or v.entrega_id <> new.entrega_id or v.estado = 'correcto'
     or v.momento <> (case new.tipo when 'sobre_en_custodia' then 'custodia' else 'apertura' end) then
    raise exception 'La incidencia corresponde a una verificación de sobre con problema' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger incidencia_cierre_valida
  before insert on incidencia_cierre
  for each row execute function incidencia_cierre_valida();
create trigger incidencia_cierre_inmutable
  before update or delete on incidencia_cierre
  for each row execute function impedir_modificacion();
create trigger incidencia_cierre_sin_vaciar
  before truncate on incidencia_cierre
  for each statement execute function impedir_modificacion();

create table revision_incidencia (
  id            uuid primary key default gen_random_uuid(),
  incidencia_id uuid not null unique references incidencia_cierre (id),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  nivel         text not null check (nivel in ('encargado', 'administracion', 'direccion')),
  revisada_por  uuid not null references usuario (id),
  en            timestamptz not null default now()
);
-- Revisa quien no participó (cerró, custodió, abrió o ayudó), con el perfil que toca y el permiso de revisar.
create function revision_incidencia_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  select i.entrega_id, t.sucursal_id into d
  from incidencia_cierre i join entrega_turno e on e.id = i.entrega_id join turno t on t.id = e.turno_id where i.id = new.incidencia_id;
  if new.revisada_por in (select participantes_entrega(d.entrega_id)) then
    raise exception 'Quien participó en el cierre no revisa sus incidencias' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_entrega(d.entrega_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) r where r = new.nivel)
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', d.sucursal_id) then
    raise exception 'Esta incidencia la revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger revision_incidencia_valida
  before insert on revision_incidencia
  for each row execute function revision_incidencia_valida();
create trigger revision_incidencia_inmutable
  before update or delete on revision_incidencia
  for each row execute function impedir_modificacion();
create trigger revision_incidencia_sin_vaciar
  before truncate on revision_incidencia
  for each statement execute function impedir_modificacion();
