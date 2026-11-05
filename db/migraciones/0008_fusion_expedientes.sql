-- 0008 · Bloque 2: fusión manual de fichas duplicadas (solo datos ficticios).
-- Indicado el 4 nov 2026:
--   - una sola ficha por visitante para todo Fitnessland; la fusión solo corrige duplicados creados por error;
--   - solo Dirección, con el permiso específico visitante.fusionar, en la sucursal de cada ficha;
--   - la ficha unida se conserva con su historial y un vínculo a la ficha activa;
--   - no se unen personas confirmadas como distintas;
--   - deshacer queda pendiente para otra entrega.

insert into rol_permiso (rol, permiso) values ('direccion', 'visitante.fusionar');

-- Vínculo de la ficha unida a la ficha activa. Una ficha unida no vuelve a aparecer en la búsqueda.
alter table visitante add column fusionado_en timestamptz;
alter table visitante add column fusionado_en_id uuid references visitante (id);
alter table visitante add constraint visitante_fusion_coherente
  check ((fusionado_en is null) = (fusionado_en_id is null) and fusionado_en_id is distinct from id);
create index visitante_activos on visitante (id) where fusionado_en_id is null;
create index visitante_unidas on visitante (fusionado_en_id) where fusionado_en_id is not null;

-- Registro de cada fusión. Guarda los datos de ambas fichas tal como estaban y de cuál se tomó cada campo.
-- Se muestra con el teléfono enmascarado.
create table visitante_fusion (
  id                bigint generated always as identity primary key,
  activo_id         uuid not null references visitante (id),
  absorbido_id      uuid not null references visitante (id) unique,
  datos_activo      jsonb not null,
  datos_absorbido   jsonb not null,
  campos_tomados    jsonb not null,
  motivo            text not null check (length(btrim(motivo)) between 5 and 300),
  usuario_id        uuid not null references usuario (id),
  sucursal_id       uuid not null references sucursal (id),
  en                timestamptz not null default now(),
  constraint visitante_fusion_distintos check (activo_id <> absorbido_id)
);
create index visitante_fusion_activo on visitante_fusion (activo_id, en);
create trigger visitante_fusion_inmutable
  before update or delete on visitante_fusion
  for each row execute function impedir_modificacion();
create trigger visitante_fusion_sin_vaciar
  before truncate on visitante_fusion
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Integridad de los vínculos. Garantiza que las fusiones forman árboles sin ciclos, de modo que
-- seguir los vínculos siempre termina, sin importar cuántas fusiones encadenadas haya:
--   - una ficha solo se puede unir a una ficha activa (que no esté unida a otra);
--   - una ficha que ya tiene a otras unidas puede unirse después (la cadena crece hacia arriba);
--   - el vínculo, una vez puesto, no se cambia ni se quita (deshacer queda para otra entrega).
-- ---------------------------------------------------------------------------
create function visitante_vinculo_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.fusionado_en_id is not null
     and new.fusionado_en_id is distinct from old.fusionado_en_id then
    raise exception 'El vínculo de una ficha unida no se cambia ni se quita'
      using errcode = 'check_violation';
  end if;
  if new.fusionado_en_id is not null and (tg_op = 'INSERT' or old.fusionado_en_id is null) then
    if not exists (select 1 from visitante where id = new.fusionado_en_id and fusionado_en_id is null) then
      raise exception 'Una ficha solo se puede unir a una ficha activa'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
create trigger visitante_vinculo_valido
  before insert or update of fusionado_en_id on visitante
  for each row execute function visitante_vinculo_valido();

-- Ficha activa a la que lleva una ficha: sigue los vínculos hasta la ficha que no está unida a otra.
-- Sin límite de pasos: UNION descarta filas repetidas, así que la consulta termina siempre.
create function visitante_activo(p_id uuid) returns uuid
language sql stable as $$
  with recursive cadena(id, siguiente) as (
    select id, fusionado_en_id from visitante where id = p_id
    union
    select v.id, v.fusionado_en_id from visitante v join cadena c on v.id = c.siguiente
  )
  select id from cadena where siguiente is null limit 1
$$;

-- Una ficha y todas las que se le unieron, directa o indirectamente, sin límite de niveles.
-- Se usa para no perder confirmaciones de «personas distintas» ni historial al encadenar fusiones.
create function visitante_grupo(p_id uuid) returns setof uuid
language sql stable as $$
  with recursive grupo(id) as (
    select p_id
    union
    select v.id from visitante v join grupo g on v.fusionado_en_id = g.id
  )
  select id from grupo
$$;
