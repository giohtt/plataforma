-- 0046 · Bloque 6, PR 2: cargo «Gestión administrativa» y facultad para autorizar gastos (acordado el 27 nov 2026;
-- solo datos ficticios). No otorga facultades ni configura montos a nadie.
--   - «Gestión administrativa» es el cargo que se muestra en pantalla para quien autoriza gastos junto con Dirección.
--     Su perfil solo da consultar la sucursal: autorizar gastos se otorga aparte, a la persona, con sus límites.
--   - La facultad «autorizacion.gasto» lleva límite POR GASTO y ACUMULADO DIARIO, por persona y sucursal.
--   - «Sin límite» se otorga de forma explícita y solo a una cuenta con Dirección en esa sucursal (o en todas). Nunca por
--     omisión: un registro sin montos y sin «sin límite» sigue siendo rechazado.
--   - Las facultades de gasto anteriores sin acumulado diario se conservan tal cual (no se editan), pero quedan
--     «incompletas»: no autorizan gastos hasta que se otorgue una completa.

-- 1. Cargo «Gestión administrativa».
insert into rol (clave, nombre, descripcion, disponible_en_bloque_1) values
  ('gestion_administrativa', 'Gestión administrativa',
   'Autoriza gastos solo dentro de los límites y las sucursales que Dirección le asigne; no autoriza los gastos ni las decisiones de Dirección.', true);
insert into rol_permiso (rol, permiso) values ('gestion_administrativa', 'sucursal.consultar');

-- 2. Límite por gasto, acumulado diario y «sin límite» explícito.
alter table facultad_otorgada
  add column limite_diario numeric(12, 2) check (limite_diario is null or limite_diario > 0),
  add column sin_limite boolean not null default false;
alter table facultad_otorgada
  add constraint facultad_campos_de_gasto check (permiso = 'autorizacion.gasto' or (limite_diario is null and not sin_limite)),
  add constraint facultad_sin_limite_sin_montos check (not sin_limite or (limite_monto is null and limite_diario is null)),
  add constraint facultad_diario_cubre_gasto check (limite_diario is null or limite_monto is null or limite_diario >= limite_monto);

create or replace function facultad_autorizacion_con_limite() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from permiso p where p.clave = new.permiso and p.es_autorizacion) then
    return new;
  end if;
  if new.sin_limite then
    -- Solo al otorgarla; revocarla después no vuelve a exigir Dirección.
    if tg_op = 'INSERT' and not (
         (new.todas_las_sucursales and exists (select 1 from alcance_general g where g.usuario_id = new.usuario_id and g.rol = 'direccion'
                                               and vigente(g.vigente_desde, g.vigente_hasta, g.revocado_en)))
      or (not new.todas_las_sucursales and exists (select 1 from perfiles_en_sucursal(new.usuario_id, new.sucursal_id) r where r = 'direccion'))) then
      raise exception 'Autorizar gastos sin límite es solo para una cuenta con Dirección en esas sucursales' using errcode = 'check_violation';
    end if;
  elsif new.limite_monto is null then
    raise exception 'La facultad % requiere un límite de monto', new.permiso using errcode = 'check_violation';
  elsif tg_op = 'INSERT' and new.permiso = 'autorizacion.gasto' and new.limite_diario is null then
    raise exception 'La facultad para autorizar gastos requiere también un acumulado diario' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- 3. La facultad de gasto que aplica a una persona en una sucursal, hoy: la vigente y completa («sin límite» primero;
-- si no, la de mayor límite por gasto). «Sin límite» exige seguir teniendo Dirección ahí. Una persona inactiva o con
-- el permiso restringido no tiene ninguna. La usarán la autorización y la ruta de los gastos (PR 4).
create function facultad_gasto(p_usuario uuid, p_sucursal uuid)
returns table (facultad_id uuid, sin_limite boolean, limite_monto numeric, limite_diario numeric)
language sql stable as $$
  select f.id, f.sin_limite, f.limite_monto, f.limite_diario
  from facultad_otorgada f
  where f.usuario_id = p_usuario and f.permiso = 'autorizacion.gasto'
    and (f.sucursal_id = p_sucursal or f.todas_las_sucursales)
    and vigente(f.vigente_desde, f.vigente_hasta, f.revocada_en)
    and (f.sin_limite or f.limite_diario is not null)
    and (not f.sin_limite or exists (select 1 from perfiles_en_sucursal(p_usuario, p_sucursal) r where r = 'direccion'))
    and tiene_permiso(p_usuario, 'autorizacion.gasto', p_sucursal)
  order by f.sin_limite desc, f.limite_monto desc nulls last, f.limite_diario desc nulls last
  limit 1
$$;
