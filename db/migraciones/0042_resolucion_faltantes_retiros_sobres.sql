-- 0042 · Bloque 5: Dirección resuelve el faltante confirmado de un retiro o de un sobre recogido (solo datos ficticios).
-- Indicado el 25 nov 2026:
--   - Por ahora una sola decisión: «Lo absorbe la sucursal», con motivo obligatorio. Cierra el caso y queda en el
--     historial con quién y cuándo.
--   - No cambia el efectivo contado, los depósitos ni el monto habilitado, y no descuenta nada a ninguna persona.
--   - Resuelve Dirección con asignación en la sucursal y el permiso «diferencia.resolver» (el mismo de los cambios de
--     turno), que no haya participado en el retiro o en la cadena del sobre. La autorización personal para revisar lo
--     propio no se extiende a resolver.
--   - Cada caso es aparte: el faltante de un retiro y el de un sobre son casos distintos aunque tengan el mismo importe.
--   - No se edita ni se borra.

create table resolucion_retiro (
  id           uuid primary key default gen_random_uuid(),
  retiro_id    uuid not null unique references retiro (id),
  decision     text not null check (decision = 'absorbe_sucursal'),
  motivo       text not null check (char_length(btrim(motivo)) between 5 and 300),
  resuelta_por uuid not null references usuario (id),
  en           timestamptz not null default now()
);

create function resolucion_retiro_valida() returns trigger
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
  if new.resuelta_por in (select participantes_retiro(new.retiro_id)) then
    raise exception 'Quien participó en el retiro no resuelve su faltante' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.resuelta_por, 'diferencia.resolver', d.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.resuelta_por, d.sucursal_id) p where p = 'direccion') then
    raise exception 'Resuelve Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger resolucion_retiro_valida
  before insert or update or delete on resolucion_retiro
  for each row execute function resolucion_retiro_valida();
create trigger resolucion_retiro_sin_vaciar
  before truncate on resolucion_retiro
  for each statement execute function impedir_modificacion();

create table resolucion_diferencia_sobre (
  id            uuid primary key default gen_random_uuid(),
  diferencia_id uuid not null unique references diferencia_sobre (id),
  decision      text not null check (decision = 'absorbe_sucursal'),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  resuelta_por  uuid not null references usuario (id),
  en            timestamptz not null default now()
);

create function resolucion_diferencia_sobre_valida() returns trigger
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
  if new.resuelta_por in (select participantes_sobre(d.sobre_id)) then
    raise exception 'Quien participó en la cadena del sobre no resuelve su faltante' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.resuelta_por, 'diferencia.resolver', d.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.resuelta_por, d.sucursal_id) p where p = 'direccion') then
    raise exception 'Resuelve Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger resolucion_diferencia_sobre_valida
  before insert or update or delete on resolucion_diferencia_sobre
  for each row execute function resolucion_diferencia_sobre_valida();
create trigger resolucion_diferencia_sobre_sin_vaciar
  before truncate on resolucion_diferencia_sobre
  for each statement execute function impedir_modificacion();
