-- 0024 · Bloque 5: resolución de Dirección sobre un faltante o sobrante confirmado (primera versión; solo datos ficticios).
-- Indicado el 11 nov 2026:
--   - Faltante confirmado: «Lo absorbe la sucursal», con motivo; cierra el seguimiento.
--   - Sobrante confirmado: «Se queda en la bolsa» (cierra), u «Origen identificado»: si queda una corrección pendiente,
--     el caso sigue abierto hasta registrar la corrección, vinculada al historial; si no requiere corrección, cierra.
--   - Todos los importes siguen la misma regla (sin umbrales). La resolución no cambia los importes registrados ni el
--     saldo de apertura del turno siguiente.
--   - Pendientes para después: reposición por una persona; retiro y depósito del sobrante (con Encargada de retiros).

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('diferencia.resolver', 'Resolver faltantes o sobrantes confirmados en las diferencias de efectivo', 5, false);
insert into rol_permiso (rol, permiso) values ('direccion', 'diferencia.resolver');

create table resolucion_diferencia (
  id                  uuid primary key default gen_random_uuid(),
  diferencia_id       uuid not null unique references diferencia_efectivo (id),
  decision            text not null check (decision in ('absorbe_sucursal', 'queda_en_bolsa', 'origen_identificado')),
  motivo              text not null check (char_length(btrim(motivo)) between 5 and 300),
  origen              text check (origen is null or char_length(btrim(origen)) between 5 and 300),
  requiere_correccion boolean not null default false,
  resuelta_por        uuid not null references usuario (id),
  en                  timestamptz not null default now(),
  -- Corrección, solo si se requiere: se registra una vez y cierra el caso.
  correccion          text check (correccion is null or char_length(btrim(correccion)) between 5 and 300),
  correccion_por      uuid references usuario (id),
  correccion_en       timestamptz,
  constraint origen_solo_identificado check ((decision = 'origen_identificado') = (origen is not null)),
  constraint correccion_solo_con_origen check (not requiere_correccion or decision = 'origen_identificado'),
  constraint correccion_completa check ((correccion is null) = (correccion_por is null) and (correccion is null) = (correccion_en is null)),
  constraint correccion_si_se_requiere check (correccion is null or requiere_correccion)
);

create function resolucion_diferencia_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  if tg_op = 'DELETE' then
    raise exception 'resolucion_diferencia: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    -- Solo se agrega la corrección pendiente, una vez.
    if old.correccion is not null or new.correccion is null or not old.requiere_correccion
       or (new.id, new.diferencia_id, new.decision, new.motivo, new.origen, new.requiere_correccion, new.resuelta_por, new.en)
          is distinct from (old.id, old.diferencia_id, old.decision, old.motivo, old.origen, old.requiere_correccion, old.resuelta_por, old.en) then
      raise exception 'resolucion_diferencia: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  select df.importe, df.entrega_id, t.sucursal_id, r.resultado
    into d
  from diferencia_efectivo df join turno t on t.id = df.turno_id
  left join revision_diferencia r on r.diferencia_id = df.id
  where df.id = new.diferencia_id;
  if d.resultado is null or d.resultado not in ('faltante_confirmado', 'sobrante_confirmado') then
    raise exception 'Solo se resuelve un faltante o sobrante confirmado' using errcode = 'check_violation';
  end if;
  if (new.decision = 'absorbe_sucursal') <> (d.resultado = 'faltante_confirmado') then
    raise exception 'La decisión no corresponde al tipo de diferencia' using errcode = 'check_violation';
  end if;
  if new.correccion is not null then
    raise exception 'La corrección se registra después de la resolución' using errcode = 'check_violation';
  end if;
  if new.resuelta_por in (select participantes_entrega(d.entrega_id)) then
    raise exception 'Quien participó en la entrega no resuelve sus diferencias' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.resuelta_por, d.sucursal_id) r where r = 'direccion') then
    raise exception 'Resuelve Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger resolucion_diferencia_valida
  before insert or update or delete on resolucion_diferencia
  for each row execute function resolucion_diferencia_valida();
create trigger resolucion_diferencia_sin_vaciar
  before truncate on resolucion_diferencia
  for each statement execute function impedir_modificacion();
