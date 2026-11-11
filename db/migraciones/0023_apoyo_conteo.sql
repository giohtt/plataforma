-- 0023 · Bloque 5: apoyo en el conteo y el recuento (opción B, aprobada el 11 nov 2026; solo datos ficticios).
--   - Quien captura un conteo (la saliente al entregar, la entrante al recibir y al recontar) declara si alguien le ayudó
--     y, si sí, a qué personas de la sucursal. Cada persona confirma después desde su propia cuenta.
--   - Desde que se declara a una persona, cuenta como participante: no revisa las diferencias de esa entrega y su perfil
--     se toma en cuenta para el nivel de revisión, aunque todavía no confirme. La confirmación puede quedar pendiente
--     sin detener la entrega ni la apertura del turno siguiente.
--   - Entregas anteriores a este cambio: no tienen declaración («sin registro de apoyo»), distinto de declarar que
--     nadie más participó.

-- Una declaración por etapa de la entrega: si hubo apoyo o no, quién lo declaró y cuándo.
create table declaracion_apoyo (
  id            uuid primary key default gen_random_uuid(),
  entrega_id    uuid not null references entrega_turno (id),
  etapa         text not null check (etapa in ('conteo_entrega', 'conteo_recepcion', 'recuento')),
  hubo_apoyo    boolean not null,
  declarado_por uuid not null references usuario (id),
  en            timestamptz not null default now(),
  unique (entrega_id, etapa)
);
create trigger declaracion_apoyo_inmutable
  before update or delete on declaracion_apoyo
  for each row execute function impedir_modificacion();
create trigger declaracion_apoyo_sin_vaciar
  before truncate on declaracion_apoyo
  for each statement execute function impedir_modificacion();

-- Cada persona declarada como apoyo. Solo cambia una vez: cuando ella confirma (confirmado_en).
create table apoyo_conteo (
  id             uuid primary key default gen_random_uuid(),
  declaracion_id uuid not null references declaracion_apoyo (id),
  entrega_id     uuid not null references entrega_turno (id),
  etapa          text not null check (etapa in ('conteo_entrega', 'conteo_recepcion', 'recuento')),
  usuario_id     uuid not null references usuario (id),
  declarado_por  uuid not null references usuario (id),
  declarado_en   timestamptz not null default now(),
  confirmado_en  timestamptz,
  unique (entrega_id, etapa, usuario_id)
);
create index apoyo_conteo_pendiente on apoyo_conteo (usuario_id) where confirmado_en is null;

create function apoyo_conteo_valido() returns trigger
language plpgsql as $$
declare
  e record;
begin
  if tg_op = 'DELETE' then
    raise exception 'apoyo_conteo: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if old.confirmado_en is not null or new.confirmado_en is null
       or (new.id, new.declaracion_id, new.entrega_id, new.etapa, new.usuario_id, new.declarado_por, new.declarado_en)
          is distinct from (old.id, old.declaracion_id, old.entrega_id, old.etapa, old.usuario_id, old.declarado_por, old.declarado_en) then
      raise exception 'apoyo_conteo: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  select en.entrega_por, en.recibe, t.sucursal_id, d.hubo_apoyo, d.entrega_id as d_entrega, d.etapa as d_etapa, d.declarado_por as d_por
    into e
  from entrega_turno en join turno t on t.id = en.turno_id join declaracion_apoyo d on d.id = new.declaracion_id
  where en.id = new.entrega_id;
  if not e.hubo_apoyo or e.d_entrega <> new.entrega_id or e.d_etapa <> new.etapa or e.d_por <> new.declarado_por then
    raise exception 'El apoyo no corresponde a su declaración' using errcode = 'check_violation';
  end if;
  if new.usuario_id in (e.entrega_por, e.recibe) then
    raise exception 'Quien entrega o recibe no se declara como apoyo' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.usuario_id, e.sucursal_id)) then
    raise exception 'El apoyo debe ser una persona de la sucursal' using errcode = 'check_violation';
  end if;
  if new.confirmado_en is not null then
    raise exception 'El apoyo se confirma después, desde la cuenta de esa persona' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger apoyo_conteo_valido
  before insert or update or delete on apoyo_conteo
  for each row execute function apoyo_conteo_valido();
create trigger apoyo_conteo_sin_vaciar
  before truncate on apoyo_conteo
  for each statement execute function impedir_modificacion();

-- Quienes participaron en una entrega: quien entregó, quien recibió y cada apoyo declarado (confirmado o no).
create function participantes_entrega(p_entrega uuid) returns setof uuid
language sql stable as $$
  select entrega_por from entrega_turno where id = p_entrega
  union select recibe from entrega_turno where id = p_entrega
  union select usuario_id from apoyo_conteo where entrega_id = p_entrega
$$;

-- El nivel de revisión considera ahora a todos los participantes, incluidos los apoyos declarados.
create or replace function nivel_revision_entrega(p_entrega uuid) returns text
language sql stable as $$
  with p as (
    select r as rol from entrega_turno e join turno t on t.id = e.turno_id
    cross join lateral participantes_entrega(e.id) as quien(u)
    cross join lateral perfiles_en_sucursal(quien.u, t.sucursal_id) as r
    where e.id = p_entrega)
  select case
    when exists (select 1 from p where rol = 'administracion') then 'direccion'
    when exists (select 1 from p where rol = 'encargado') then 'administracion'
    else 'encargado' end
$$;

-- La revisión rechaza también a quien fue declarado como apoyo.
create or replace function revision_diferencia_valida() returns trigger
language plpgsql as $$
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
    raise exception 'Quien participó en la entrega no revisa sus diferencias' using errcode = 'check_violation';
  end if;
  if new.nivel <> nivel_revision_entrega(d.entrega_id)
     or not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) r where r = new.nivel) then
    raise exception 'Esta diferencia la revisa otro perfil' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
