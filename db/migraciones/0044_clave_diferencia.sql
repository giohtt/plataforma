-- 0044 · Clave fija y única por caso de diferencia (aprobado el 26 nov 2026; solo datos ficticios).
--   - Formato: código de la sucursal + «-D» + número (TEN-D7). Numeración por sucursal, en orden de registro.
--   - Se asigna una sola vez al registrarse el caso (cambio de turno, al retirar, retiro con diferencia de importe o
--     sobre) y nunca se reutiliza, se cambia ni se borra. Se guarda el texto completo: si después cambiara el código de
--     la sucursal, la clave conserva el código original.
--   - Los casos que ya existían reciben su clave en el mismo orden de registro. Se registra cuándo se asignó
--     (asignada_en, origen = 'casos_existentes') sin tocar la fecha original del caso ni su historial.
--   - No cambia importes, folios, revisiones ni resoluciones.

create table clave_diferencia (
  id          uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursal (id),
  numero      integer not null check (numero > 0),
  clave       text not null unique,
  clase       text not null check (clase in ('turno', 'retiro_esperado', 'retiro_importe', 'sobre')),
  caso_id     uuid not null,
  registrado  timestamptz not null,
  asignada_en timestamptz not null default now(),
  origen      text not null default 'al_registrar' check (origen in ('al_registrar', 'casos_existentes')),
  unique (clase, caso_id),
  unique (sucursal_id, numero)
);
create trigger clave_diferencia_inmutable
  before update or delete on clave_diferencia
  for each row execute function impedir_modificacion();
create trigger clave_diferencia_sin_vaciar
  before truncate on clave_diferencia
  for each statement execute function impedir_modificacion();

-- Asigna la siguiente clave de la sucursal (una sola vez por caso). El bloqueo de la fila de la sucursal evita que dos
-- casos simultáneos reciban el mismo número.
create function asignar_clave_diferencia(p_sucursal uuid, p_clase text, p_caso uuid, p_registrado timestamptz, p_origen text default 'al_registrar')
returns text language plpgsql as $$
declare
  v_codigo text;
  v_numero integer;
  v_clave  text;
begin
  select clave into v_clave from clave_diferencia where clase = p_clase and caso_id = p_caso;
  if v_clave is not null then
    return v_clave;
  end if;
  select codigo into v_codigo from sucursal where id = p_sucursal for update;
  select coalesce(max(numero), 0) + 1 into v_numero from clave_diferencia where sucursal_id = p_sucursal;
  v_clave := v_codigo || '-D' || v_numero;
  insert into clave_diferencia (sucursal_id, numero, clave, clase, caso_id, registrado, origen)
  values (p_sucursal, v_numero, v_clave, p_clase, p_caso, p_registrado, p_origen);
  return v_clave;
end;
$$;

-- Al registrarse cada caso.
create function clave_al_registrar() returns trigger
language plpgsql as $$
declare
  v_sucursal uuid;
begin
  if tg_table_name = 'diferencia_efectivo' then
    select l.sucursal_id into v_sucursal from lugar_efectivo l where l.id = new.lugar_id;
    perform asignar_clave_diferencia(v_sucursal, 'turno', new.id, new.registrada_en);
  elsif tg_table_name = 'diferencia_retiro' then
    select r.sucursal_id into v_sucursal from retiro r where r.id = new.retiro_id;
    perform asignar_clave_diferencia(v_sucursal, 'retiro_esperado', new.id, new.registrada_en);
  elsif tg_table_name = 'diferencia_sobre' then
    select s.sucursal_id into v_sucursal from sobre_cierre s where s.id = new.sobre_id;
    perform asignar_clave_diferencia(v_sucursal, 'sobre', new.id, new.creada_en);
  elsif tg_table_name = 'retiro' then
    if new.discrepancia = 'importe' and new.reportado_en is not null then
      perform asignar_clave_diferencia(new.sucursal_id, 'retiro_importe', new.id, new.reportado_en);
    end if;
  end if;
  return null;
end;
$$;
create trigger clave_diferencia_efectivo after insert on diferencia_efectivo for each row execute function clave_al_registrar();
create trigger clave_diferencia_retiro after insert on diferencia_retiro for each row execute function clave_al_registrar();
create trigger clave_diferencia_sobre after insert on diferencia_sobre for each row execute function clave_al_registrar();
create trigger clave_retiro_importe after insert or update of discrepancia, reportado_en on retiro for each row execute function clave_al_registrar();

-- Casos que ya existían: en orden de registro por sucursal.
do $$
declare
  c record;
begin
  for c in
    select * from (
      select l.sucursal_id, 'turno' as clase, d.id, d.registrada_en as registrado
      from diferencia_efectivo d join lugar_efectivo l on l.id = d.lugar_id
      union all
      select r.sucursal_id, 'retiro_esperado', x.id, x.registrada_en from diferencia_retiro x join retiro r on r.id = x.retiro_id
      union all
      select r.sucursal_id, 'retiro_importe', r.id, r.reportado_en from retiro r where r.discrepancia = 'importe' and r.reportado_en is not null
      union all
      select s.sucursal_id, 'sobre', ds.id, ds.creada_en from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id
    ) casos
    order by sucursal_id, registrado, clase, id
  loop
    perform asignar_clave_diferencia(c.sucursal_id, c.clase, c.id, c.registrado, 'casos_existentes');
  end loop;
end;
$$;
