-- 0022 · Bloque 5, paso 2 (segunda parte): resultado de la revisión de cada diferencia de efectivo (solo datos ficticios).
-- Reglas aprobadas el 11 nov 2026:
--   - Cada diferencia se revisa por separado, con su propio estado, motivo obligatorio e historial.
--   - Faltante (importe negativo): «Aclarada» o «Faltante confirmado». Sobrante (positivo): «Aclarada» (se documenta el
--     origen) o «Sobrante confirmado». Un faltante o sobrante confirmado queda pendiente para Dirección.
--   - Quién revisa, según su participación: Encargado; si un Encargado participó en el conteo, la entrega o la recepción,
--     Administración con permiso en la sucursal; si también participó Administración, Dirección. Quien participó no revisa.
--   - Revisar no cambia ningún importe: se conservan el esperado, lo entregado, lo recibido, las diferencias y el saldo
--     de apertura del turno siguiente.

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('diferencia.revisar', 'Revisar diferencias de efectivo (Aclarada, Faltante o Sobrante confirmado), según quién participó', 5, false);
insert into rol_permiso (rol, permiso) values
  ('encargado', 'diferencia.revisar'),
  ('administracion', 'diferencia.revisar'),
  ('direccion', 'diferencia.revisar');

-- Perfil que debe revisar las diferencias de una entrega, según los perfiles en la sucursal de quienes participaron
-- (quien contó y entregó, y quien contó y recibió).
create function nivel_revision_entrega(p_entrega uuid) returns text
language sql stable as $$
  with p as (
    select r as rol from entrega_turno e join turno t on t.id = e.turno_id
    cross join lateral unnest(array[e.entrega_por, e.recibe]) as quien(u)
    cross join lateral perfiles_en_sucursal(quien.u, t.sucursal_id) as r
    where e.id = p_entrega)
  select case
    when exists (select 1 from p where rol = 'administracion') then 'direccion'
    when exists (select 1 from p where rol = 'encargado') then 'administracion'
    else 'encargado' end
$$;

create table revision_diferencia (
  id            uuid primary key default gen_random_uuid(),
  diferencia_id uuid not null unique references diferencia_efectivo (id),
  resultado     text not null check (resultado in ('aclarada', 'faltante_confirmado', 'sobrante_confirmado')),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  nivel         text not null check (nivel in ('encargado', 'administracion', 'direccion')),
  revisada_por  uuid not null references usuario (id),
  en            timestamptz not null default now()
);

-- Respaldo en la base de las reglas que el servidor comprueba antes: resultado acorde al signo, nivel correcto,
-- perfil de quien revisa y que no haya participado.
create function revision_diferencia_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  select df.importe, e.id as entrega_id, e.entrega_por, e.recibe, t.sucursal_id
    into d
  from diferencia_efectivo df join entrega_turno e on e.id = df.entrega_id join turno t on t.id = e.turno_id
  where df.id = new.diferencia_id;
  if (new.resultado = 'faltante_confirmado' and d.importe >= 0) or (new.resultado = 'sobrante_confirmado' and d.importe <= 0) then
    raise exception 'El resultado no corresponde al signo de la diferencia' using errcode = 'check_violation';
  end if;
  if new.revisada_por in (d.entrega_por, d.recibe) then
    raise exception 'Quien participó en la entrega no revisa sus diferencias' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_entrega(d.entrega_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) r where r = new.nivel) then
    raise exception 'Esta diferencia la revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger revision_diferencia_valida
  before insert on revision_diferencia
  for each row execute function revision_diferencia_valida();
create trigger revision_diferencia_inmutable
  before update or delete on revision_diferencia
  for each row execute function impedir_modificacion();
create trigger revision_diferencia_sin_vaciar
  before truncate on revision_diferencia
  for each statement execute function impedir_modificacion();
