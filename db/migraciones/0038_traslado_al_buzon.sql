-- Bloque 5, regla 7: ajustes del 18 nov 2026 (20:34) al buzón, antes de unir (solo datos ficticios).
--   1. Los sobres guardados antes del buzón (en la caja con llave) no se dan por trasladados al guardar la configuración:
--      se registra explícitamente su traslado físico al buzón, con quién lo hizo, cuándo y qué folios trasladó. Hasta
--      entonces siguen en la caja anterior, «por trasladar», y Dirección no los recoge del buzón.
--   2. (En la aplicación) Dirección cuenta a ciegas aunque su cuenta también pueda entregar sobres.

create table traslado_buzon (
  id          uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursal (id),
  -- Quien abrió la caja anterior y depositó los sobres en el buzón: la responsable en turno (tiene la llave de la caja).
  por         uuid not null references usuario (id),
  turno_id    uuid not null references turno (id),
  en          timestamptz not null default now()
);
create function traslado_buzon_valido() returns trigger
language plpgsql as $$
begin
  if not coalesce((select k.buzon from custodia_configuracion k where k.sucursal_id = new.sucursal_id order by k.en desc, k.id limit 1), false)
     or not tiene_permiso(new.por, 'sobre.entregar', new.sucursal_id)
     or not exists (select 1 from turno t join responsable_lugar r on r.turno_id = t.id
                    where t.id = new.turno_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null
                      and r.hasta is null and r.usuario_id = new.por) then
    raise exception 'Traslada al buzón la responsable en turno, con el buzón configurado' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger traslado_buzon_valido
  before insert on traslado_buzon
  for each row execute function traslado_buzon_valido();
create trigger traslado_buzon_inmutable
  before update or delete on traslado_buzon
  for each row execute function impedir_modificacion();
create trigger traslado_buzon_sin_vaciar
  before truncate on traslado_buzon
  for each statement execute function impedir_modificacion();

create table traslado_sobre (
  traslado_id uuid not null references traslado_buzon (id),
  sobre_id    uuid primary key references sobre_cierre (id)
);
create function traslado_sobre_valido() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from traslado_buzon t join sobre_cierre s on s.sucursal_id = t.sucursal_id
                 where t.id = new.traslado_id and s.id = new.sobre_id)
     or not sobre_en_caja(new.sobre_id)
     or exists (select 1 from sobre_depositado d where d.sobre_id = new.sobre_id) then
    raise exception 'Se traslada un sobre guardado en la caja anterior de la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger traslado_sobre_valido
  before insert on traslado_sobre
  for each row execute function traslado_sobre_valido();
create trigger traslado_sobre_inmutable
  before update or delete on traslado_sobre
  for each row execute function impedir_modificacion();
create trigger traslado_sobre_sin_vaciar
  before truncate on traslado_sobre
  for each statement execute function impedir_modificacion();

-- En el buzón: depositado al cerrar o trasladado de la caja anterior (y sigue sin recoger ni investigar).
create function sobre_en_buzon(p_sobre uuid) returns boolean
language sql stable as $$
  select sobre_en_caja(p_sobre)
     and (exists (select 1 from sobre_depositado d where d.sobre_id = p_sobre)
          or exists (select 1 from traslado_sobre t where t.sobre_id = p_sobre))
$$;

-- De una recolección del buzón solo salen sobres que están en el buzón.
create function recoleccion_sobre_buzon() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from recoleccion r where r.id = new.recoleccion_id and r.buzon) and not sobre_en_buzon(new.sobre_id) then
    raise exception 'El sobre no está en el buzón: falta registrar su traslado desde la caja anterior' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger recoleccion_sobre_buzon
  before insert on recoleccion_sobre
  for each row execute function recoleccion_sobre_buzon();

-- Quien trasladó el sobre también participó en su cadena.
create or replace function participantes_sobre(p_sobre uuid) returns setof uuid
language sql stable as $$
  select u from (
    select e.entrega_por as u from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
    union select e.custodio_id from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
    union select v.verificado_por from verificacion_sobre v where v.sobre_id = p_sobre
    union select r.custodio_id from verificacion_sobre v join revision_caja r on r.id = v.revision_id where v.sobre_id = p_sobre
    union select x.entrega_por from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
    union select x.recibe from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado <> 'pendiente'
    union select d.recibida_por from devolucion_recoleccion d join recoleccion_sobre y on y.recoleccion_id = d.recoleccion_id where y.sobre_id = p_sobre
    union select t.por from traslado_sobre x join traslado_buzon t on t.id = x.traslado_id where x.sobre_id = p_sobre
  ) p where u is not null
$$;
