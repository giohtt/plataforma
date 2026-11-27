-- 0048 · Bloque 6, PR 4: autorizar o rechazar gastos según la ruta acordada, y delegaciones temporales
-- (acordado el 27 nov 2026; solo datos ficticios). No otorga facultades ni configura montos a nadie.
--   - Decide (autoriza o rechaza) quien tenga la facultad de gasto vigente en la sucursal beneficiada y, si paga otra,
--     también en la que paga; dentro de su límite por gasto (comparado con el total de la compra, sumando sus partes)
--     y de su acumulado diario en cada una de esas sucursales. Lo que pasa de ahí lo decide quien sí tenga facultad
--     suficiente (Gestión administrativa o Dirección); si nadie más la tiene, queda por autorizar.
--   - Quien solicitó no decide su propio gasto, salvo Dirección. Los gastos que solicita Dirección solo los decide
--     Dirección.
--   - La primera persona que decide lo resuelve; una decisión por versión. Si la solicitud se corrige, la decisión
--     anterior deja de valer y se decide la versión nueva.
--   - Rechazar exige motivo. Nada se edita ni se borra.
--   - Delegación temporal: facultad de gasto con límites y sucursales fijados expresamente por quien la otorga, con
--     inicio y fin; no se hereda de nadie.

-- 1. Delegaciones temporales.
alter table facultad_otorgada add column es_delegacion boolean not null default false;
alter table facultad_otorgada add constraint facultad_delegacion_completa check (
  not es_delegacion or (permiso = 'autorizacion.gasto' and not sin_limite and vigente_hasta is not null
                        and limite_monto is not null and limite_diario is not null));

-- 2. Decisiones.
create table decision_gasto (
  id             uuid primary key default gen_random_uuid(),
  gasto_id       uuid not null references gasto (id),
  version        integer not null,
  decision       text not null check (decision in ('autorizado', 'rechazado')),
  importe        numeric(12, 2) not null check (importe > 0),
  por            uuid not null references usuario (id),
  en             timestamptz not null default now(),
  motivo         text check (motivo is null or char_length(btrim(motivo)) between 5 and 300),
  -- La facultad con la que se decidió, tal como estaba en ese momento.
  facultad_id    uuid references facultad_otorgada (id),
  sin_limite     boolean not null,
  limite_monto   numeric(12, 2),
  limite_diario  numeric(12, 2),
  unique (gasto_id, version),
  foreign key (gasto_id, version) references gasto_version (gasto_id, version),
  constraint decision_rechazo_con_motivo check (decision <> 'rechazado' or motivo is not null)
);

-- Total de la compra (la original y sus partes, cada una en su versión vigente, sin las rechazadas).
create function total_compra_gasto(p_gasto uuid) returns numeric
language sql stable as $$
  with raiz as (select coalesce(compra_de, id) as id from gasto where id = p_gasto)
  select coalesce(sum(v.importe), 0)
  from gasto g
  join lateral (select x.version, x.importe from gasto_version x where x.gasto_id = g.id order by x.version desc limit 1) v on true
  where (g.id = (select id from raiz) or g.compra_de = (select id from raiz))
    and not exists (select 1 from decision_gasto d where d.gasto_id = g.id and d.version = v.version and d.decision = 'rechazado')
$$;

-- Lo que esa persona autorizó en esa sucursal el día local de hoy (beneficiada o que paga), solo decisiones que siguen
-- valiendo (sobre la versión vigente de cada gasto).
create function autorizado_hoy(p_usuario uuid, p_sucursal uuid) returns numeric
language sql stable as $$
  select coalesce(sum(d.importe), 0)
  from decision_gasto d join gasto g on g.id = d.gasto_id
  where d.por = p_usuario and d.decision = 'autorizado'
    and (g.sucursal_id = p_sucursal or g.sucursal_paga_id = p_sucursal)
    and dia_en_sucursal(p_sucursal, d.en) = dia_en_sucursal(p_sucursal, now())
    and d.version = (select max(x.version) from gasto_version x where x.gasto_id = g.id)
$$;

-- ¿Puede esta persona decidir hoy la versión vigente del gasto? null = sí; si no, el motivo:
--   ya_decidido · propio · de_direccion · sin_facultad · limite · diario
create function impedimento_decision_gasto(p_usuario uuid, p_gasto uuid) returns text
language plpgsql stable as $$
declare
  g record;
  v record;
  x uuid;
  f record;
  v_total numeric;
begin
  select * into g from gasto where id = p_gasto;
  if g is null then
    return 'no_encontrado';
  end if;
  select version, importe into v from gasto_version where gasto_id = p_gasto order by version desc limit 1;
  if exists (select 1 from decision_gasto d where d.gasto_id = p_gasto and d.version = v.version) then
    return 'ya_decidido';
  end if;
  -- Quien solicitó no decide lo suyo, salvo Dirección (en la beneficiada y en la que paga).
  if g.solicitado_por = p_usuario then
    if not (exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_id) r where r = 'direccion')
            and exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_paga_id) r where r = 'direccion')) then
      return 'propio';
    end if;
  -- Lo que solicita Dirección solo lo decide Dirección.
  elsif exists (select 1 from perfiles_en_sucursal(g.solicitado_por, g.sucursal_id) r where r = 'direccion')
        and not exists (select 1 from perfiles_en_sucursal(p_usuario, g.sucursal_id) r where r = 'direccion') then
    return 'de_direccion';
  end if;
  v_total := total_compra_gasto(p_gasto);
  foreach x in array array[g.sucursal_id, g.sucursal_paga_id] loop
    select * into f from facultad_gasto(p_usuario, x);
    if f.facultad_id is null then
      return 'sin_facultad';
    end if;
    if not f.sin_limite then
      if v_total > f.limite_monto then
        return 'limite';
      end if;
      if autorizado_hoy(p_usuario, x) + v.importe > f.limite_diario then
        return 'diario';
      end if;
    end if;
  end loop;
  return null;
end;
$$;

create function decision_gasto_valida() returns trigger
language plpgsql as $$
declare
  v record;
  f record;
  v_imp text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'decision_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  -- Primera persona que decide: se serializa por gasto. El acumulado diario, por persona.
  perform 1 from gasto where id = new.gasto_id for update;
  perform 1 from usuario where id = new.por for update;
  select version, importe into v from gasto_version where gasto_id = new.gasto_id order by version desc limit 1;
  if new.version <> v.version or new.importe <> v.importe then
    raise exception 'La decisión es sobre la versión vigente de la solicitud' using errcode = 'serialization_failure';
  end if;
  v_imp := impedimento_decision_gasto(new.por, new.gasto_id);
  if v_imp is not null then
    raise exception 'No puede decidir este gasto: %', v_imp using errcode = 'check_violation';
  end if;
  select * into f from facultad_gasto(new.por, (select sucursal_id from gasto where id = new.gasto_id));
  if new.facultad_id is distinct from f.facultad_id or new.sin_limite <> f.sin_limite
     or new.limite_monto is distinct from f.limite_monto or new.limite_diario is distinct from f.limite_diario then
    raise exception 'La decisión registra la facultad vigente con la que se tomó' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger decision_gasto_valida before insert or update or delete on decision_gasto
  for each row execute function decision_gasto_valida();
create trigger decision_gasto_sin_vaciar before truncate on decision_gasto
  for each statement execute function impedir_modificacion();
