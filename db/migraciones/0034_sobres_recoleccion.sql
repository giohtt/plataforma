-- 0034 · Bloque 5, regla 7: sobres guardados y recolección semanal por Dirección (aprobado el 18 nov 2026; solo datos
-- ficticios).
--   1. Dirección nombra en «Custodia de sobres» a quiénes pueden quedar como custodias (las recepcionistas), sin darles
--      el perfil de Encargado. La custodia guarda la llave de la caja.
--   2. Al cerrar, el excedente va a su sobre sellado y sale del lugar (movimiento «salida_sobre»): el sobre ya no se
--      abre al día siguiente; se queda en la caja hasta que Dirección lo recoge. Pasa al siguiente turno solo el fondo.
--   3. En cada cierre, apertura y cambio de turno, quien recibe la llave verifica todos los sobres de la caja (cadena de
--      custodia). Un sobre que falta, llega abierto o trae otro folio, o un problema con la llave, es incidencia.
--   4. Dirección recoge una vez por semana (sin día fijo): la custodia en turno entrega los sobres elegidos y Dirección
--      confirma desde su cuenta, contando cada sobre a ciegas. La diferencia por sobre queda por revisar; la revisa
--      Administración si no participó. Lo recogido se sigue hasta su depósito, con depósitos parciales.
--   5. Aviso por sobre a los ocho días de guardado.
-- Los cierres anteriores (sobres que se abren al día siguiente) siguen funcionando como antes.

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('sobre.entregar', 'Entregar sobres de la caja a Dirección para su recolección', 5, false),
  ('sobre.recoger',  'Recoger sobres de la caja, contarlos y registrar sus depósitos', 5, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion', 'sobre.entregar'),
  ('direccion', 'sobre.recoger');

-- ---------------------------------------------------------------------------
-- Custodias nombradas por Dirección
-- ---------------------------------------------------------------------------
alter table custodia_configuracion add column custodias uuid[] check (custodias is null or cardinality(custodias) between 1 and 10);
create function custodia_configuracion_custodias() returns trigger
language plpgsql as $$
begin
  if new.custodias is not null and exists (
    select 1 from unnest(new.custodias) a(u) where not exists (select 1 from perfiles_en_sucursal(a.u, new.sucursal_id))) then
    raise exception 'Las custodias son personas con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_configuracion_custodias
  before insert on custodia_configuracion
  for each row execute function custodia_configuracion_custodias();

-- El custodio es una custodia nombrada en la configuración vigente (o, en configuraciones sin custodias, un Encargado).
create or replace function cierre_valido() returns trigger
language plpgsql as $$
declare
  s uuid;
  c record;
begin
  if new.tipo <> 'cierre' then
    return new;
  end if;
  select t.sucursal_id into s from turno t where t.id = new.turno_id;
  select x.id, x.custodias into c from custodia_configuracion x where x.sucursal_id = s order by x.en desc, x.id limit 1;
  if new.custodia_config_id is distinct from c.id then
    raise exception 'El cierre guarda la configuración de custodia vigente' using errcode = 'check_violation';
  end if;
  if c.custodias is not null then
    if not (new.custodio_id = any(c.custodias)) or not exists (select 1 from perfiles_en_sucursal(new.custodio_id, s)) then
      raise exception 'El custodio es una de las custodias que nombró Dirección' using errcode = 'check_violation';
    end if;
  elsif not exists (select 1 from perfiles_en_sucursal(new.custodio_id, s) r where r = 'encargado')
        or not tiene_permiso(new.custodio_id, 'custodia.confirmar', s) then
    raise exception 'El custodio nocturno es Encargado de la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cierre con sobres guardados: el sobre sale del lugar y pasa a la caja con su importe.
-- ---------------------------------------------------------------------------
alter table entrega_turno add column sobres_guardados boolean not null default false;
alter table sobre_cierre add column importe numeric(12, 2) check (importe is null or importe > 0);
alter table sobre_cierre drop constraint sobre_cierre_estado_check;
alter table sobre_cierre add constraint sobre_cierre_estado_check check (estado in ('reservado', 'usado', 'cancelado', 'recogido'));
alter table sobre_cierre drop constraint sobre_cierre_resuelto;
alter table sobre_cierre add column recoleccion_id uuid;
alter table sobre_cierre add constraint sobre_cierre_resuelto check (
  (estado = 'reservado') = (resuelto_en is null) and (estado in ('usado', 'recogido')) = (entrega_id is not null)
  and (estado = 'recogido') = (recoleccion_id is not null));

create or replace function sobre_cierre_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sobre_cierre: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'reservado' or new.entrega_id is not null or new.importe is not null or new.recoleccion_id is not null
       or new.folio <> (select s.codigo from sucursal s where s.id = new.sucursal_id) || '-' || to_char(new.fecha, 'YYYYMMDD') || '-C' || new.consecutivo::text
       or not exists (select 1 from folio_cierre_contador c where c.sucursal_id = new.sucursal_id and c.fecha = new.fecha and c.ultimo >= new.consecutivo)
       or not exists (select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
                      where t.id = new.turno_id and l.id = new.lugar_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'Folio de sobre de cierre no válido' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.id, new.sucursal_id, new.turno_id, new.lugar_id, new.fecha, new.consecutivo, new.folio, new.reservado_por, new.reservado_en)
     is distinct from (old.id, old.sucursal_id, old.turno_id, old.lugar_id, old.fecha, old.consecutivo, old.folio, old.reservado_por, old.reservado_en) then
    raise exception 'sobre_cierre: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  -- reservado → usado (en el cierre de la misma persona) o cancelado; usado → recogido (en una recolección confirmada).
  if old.estado = 'reservado' and new.estado = 'usado' and new.recoleccion_id is null and exists (
       select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.turno_id = new.turno_id
         and e.entrega_por = new.reservado_por)
     and (new.importe is not null) = (select e.sobres_guardados from entrega_turno e where e.id = new.entrega_id) then
    return new;
  end if;
  if old.estado = 'reservado' and new.estado = 'cancelado' and new.importe is null and new.entrega_id is null then
    return new;
  end if;
  if old.estado = 'usado' and new.estado = 'recogido' and old.importe is not null and new.importe = old.importe
     and new.entrega_id = old.entrega_id and exists (select 1 from recoleccion r where r.id = new.recoleccion_id and r.estado = 'confirmada')
     and exists (select 1 from recoleccion_sobre x where x.recoleccion_id = new.recoleccion_id and x.sobre_id = new.id and x.contado is not null) then
    return new;
  end if;
  raise exception 'sobre_cierre: cambio no permitido' using errcode = 'insufficient_privilege';
end;
$$;

alter table movimiento_efectivo add column sobre_id uuid unique references sobre_cierre (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null and sobre_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null and sobre_id is null)
  or (tipo = 'salida_sobre' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is not null));
create function salida_sobre_valida() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'salida_sobre' and not exists (
    select 1 from sobre_cierre s join entrega_turno e on e.id = s.entrega_id
    where s.id = new.sobre_id and s.estado = 'usado' and s.importe = -new.importe and s.lugar_id = new.lugar_id
      and s.turno_id = new.turno_id and e.sobres_guardados) then
    raise exception 'La salida al sobre es exactamente su importe, en su lugar y turno' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger movimiento_efectivo_salida_sobre
  before insert on movimiento_efectivo
  for each row execute function salida_sobre_valida();

-- El conteo de fondo en un cierre con sobres guardados: lo entregado al siguiente turno es solo el fondo.
create or replace function conteo_fondo_valido() returns trigger
language plpgsql as $$
declare
  e record;
  total numeric;
begin
  select x.tipo, x.entrega_por, x.recibe, x.sobres_guardados into e from entrega_turno x where x.id = new.entrega_id;
  if e.tipo is distinct from 'cierre' then
    raise exception 'El conteo de fondo es de un cierre' using errcode = 'check_violation';
  end if;
  if new.contado_por <> (case when new.momento = 'cierre' then e.entrega_por else e.recibe end) then
    raise exception 'Cuenta el fondo quien cierra o quien abre' using errcode = 'check_violation';
  end if;
  select c.importe into total from entrega_conteo c where c.entrega_id = new.entrega_id and c.lugar_id = new.lugar_id
    and c.tipo = case new.momento when 'cierre' then 'entregado' when 'apertura_inicial' then 'recibido_inicial' else 'recibido_final' end;
  if total is null then
    raise exception 'Falta el conteo del lugar' using errcode = 'check_violation';
  end if;
  if e.sobres_guardados then
    if total <> new.fondo or (new.momento <> 'cierre' and new.sobre <> 0) then
      raise exception 'Con sobres guardados, lo que pasa al siguiente turno es solo el fondo' using errcode = 'check_violation';
    end if;
  elsif total <> new.fondo + new.sobre then
    raise exception 'Fondo + sobre debe ser lo contado en el lugar' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cadena de custodia de la caja: cada vez que alguien recibe la llave verifica los sobres guardados.
-- ---------------------------------------------------------------------------
create table revision_caja (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  momento       text not null check (momento in ('cierre', 'apertura', 'cambio_turno', 'recoleccion')),
  entrega_id    uuid references entrega_turno (id),
  recoleccion_id uuid,
  -- Quien verifica y desde ahora guarda la llave (en la recolección, Dirección verifica y la llave sigue con la custodia).
  por           uuid not null references usuario (id),
  custodio_id   uuid not null references usuario (id),
  llave         text not null check (llave in ('correcta', 'incidencia')),
  motivo_llave  text check (motivo_llave is null or char_length(btrim(motivo_llave)) between 5 and 300),
  en            timestamptz not null default now(),
  constraint revision_llave_con_motivo check ((llave = 'incidencia') = (motivo_llave is not null)),
  constraint revision_origen check ((momento = 'recoleccion') = (recoleccion_id is not null) and (momento <> 'recoleccion') = (entrega_id is not null))
);
create index revision_caja_sucursal on revision_caja (sucursal_id, en desc);
create unique index revision_caja_por_entrega on revision_caja (entrega_id, momento) where entrega_id is not null;
create trigger revision_caja_inmutable
  before update or delete on revision_caja
  for each row execute function impedir_modificacion();
create trigger revision_caja_sin_vaciar
  before truncate on revision_caja
  for each statement execute function impedir_modificacion();

-- La verificación de sobres guardados usa verificacion_sobre con momento «caja» y su revisión.
alter table verificacion_sobre add column revision_id uuid references revision_caja (id);
alter table verificacion_sobre drop constraint verificacion_sobre_momento_check;
alter table verificacion_sobre add constraint verificacion_sobre_momento_check check (momento in ('custodia', 'apertura', 'caja'));
alter table verificacion_sobre drop constraint verificacion_sobre_sobre_id_momento_key;
create unique index verificacion_sobre_unica on verificacion_sobre (sobre_id, momento) where momento in ('custodia', 'apertura');
create unique index verificacion_sobre_por_revision on verificacion_sobre (sobre_id, revision_id) where revision_id is not null;
alter table verificacion_sobre add constraint verificacion_caja_con_revision check ((momento = 'caja') = (revision_id is not null));

create or replace function verificacion_sobre_valida() returns trigger
language plpgsql as $$
declare
  e record;
  r record;
begin
  if new.momento = 'caja' then
    select x.por, x.sucursal_id into r from revision_caja x where x.id = new.revision_id;
    if r is null or new.verificado_por <> r.por or not exists (
      select 1 from sobre_cierre s where s.id = new.sobre_id and s.sucursal_id = r.sucursal_id and s.estado = 'usado' and s.importe is not null) then
      raise exception 'En la caja verifica quien recibe la llave, sobres guardados de la sucursal' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  select x.custodio_id, x.recibe, x.estado into e
  from sobre_cierre s join entrega_turno x on x.id = s.entrega_id where s.id = new.sobre_id;
  if e is null then
    raise exception 'Solo se verifican sobres de un cierre' using errcode = 'check_violation';
  end if;
  if new.momento = 'custodia' and new.verificado_por <> e.custodio_id then
    raise exception 'Verifica en la custodia el custodio nocturno' using errcode = 'check_violation';
  end if;
  if new.momento = 'apertura' and new.verificado_por is distinct from e.recibe then
    raise exception 'Verifica en la apertura quien abre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Incidencias de la caja (sobre guardado con problema o llave) en cualquier entrega confirmada: cierre, apertura o cambio
-- de turno. Se revisan como las demás incidencias de esa entrega.
alter table incidencia_cierre drop constraint incidencia_cierre_tipo_check;
alter table incidencia_cierre add constraint incidencia_cierre_tipo_check
  check (tipo in ('custodia_sin_confirmar', 'sobre_en_custodia', 'sobre_al_abrir', 'fondo_incompleto', 'llave_custodia', 'sobre_caja', 'llave_caja'));
alter table incidencia_cierre drop constraint incidencia_con_verificacion;
alter table incidencia_cierre add column revision_id uuid references revision_caja (id);
alter table incidencia_cierre add constraint incidencia_con_verificacion check (
  (tipo in ('sobre_en_custodia', 'sobre_al_abrir', 'sobre_caja')) = (verificacion_id is not null)
  and (tipo = 'fondo_incompleto') = (lugar_id is not null)
  and (tipo = 'llave_caja') = (revision_id is not null));
create unique index incidencia_llave_caja_unica on incidencia_cierre (revision_id) where tipo = 'llave_caja';

create or replace function incidencia_cierre_valida() returns trigger
language plpgsql as $$
declare
  v record;
begin
  if new.tipo in ('sobre_caja', 'llave_caja') then
    if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.estado = 'confirmada') then
      raise exception 'Las incidencias de la caja se registran al confirmarse la entrega' using errcode = 'check_violation';
    end if;
    if new.tipo = 'llave_caja' then
      if not exists (select 1 from revision_caja r where r.id = new.revision_id and r.entrega_id = new.entrega_id and r.llave = 'incidencia') then
        raise exception 'No hubo incidencia con la llave en esta entrega' using errcode = 'check_violation';
      end if;
      return new;
    end if;
    if not exists (select 1 from verificacion_sobre x join revision_caja r on r.id = x.revision_id
                   where x.id = new.verificacion_id and x.momento = 'caja' and x.estado <> 'correcto' and r.entrega_id = new.entrega_id) then
      raise exception 'La incidencia corresponde a un sobre de la caja con problema en esta entrega' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.estado = 'confirmada') then
    raise exception 'Las incidencias se registran al confirmarse la apertura de un cierre' using errcode = 'check_violation';
  end if;
  if new.tipo = 'custodia_sin_confirmar' then
    if not exists (select 1 from apertura_sin_custodia a where a.entrega_id = new.entrega_id) then
      raise exception 'No hubo apertura sin custodia confirmada' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'fondo_incompleto' then
    if not exists (select 1 from conteo_fondo c where c.entrega_id = new.entrega_id and c.lugar_id = new.lugar_id
                     and c.momento = 'cierre' and c.fondo < c.fondo_monto) then
      raise exception 'El fondo no quedó incompleto al cerrar' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.tipo = 'llave_custodia' then
    if not exists (select 1 from custodia_cierre c where c.entrega_id = new.entrega_id and c.llave = 'incidencia') then
      raise exception 'No hubo incidencia con la llave o el cajón' using errcode = 'check_violation';
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

-- ---------------------------------------------------------------------------
-- Recolección por Dirección
-- ---------------------------------------------------------------------------
create table recoleccion (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  turno_id      uuid not null references turno (id),
  entrega_por   uuid not null references usuario (id),
  recibe        uuid not null references usuario (id),
  estado        text not null default 'pendiente' check (estado in ('pendiente', 'confirmada', 'cancelada')),
  creada_en     timestamptz not null default now(),
  resuelta_en   timestamptz,
  motivo_cancelacion text check (motivo_cancelacion is null or char_length(btrim(motivo_cancelacion)) between 5 and 300),
  version       int not null default 1,
  constraint recoleccion_otra_persona check (entrega_por <> recibe),
  constraint recoleccion_resuelta check ((estado = 'pendiente') = (resuelta_en is null) and (estado = 'cancelada') = (motivo_cancelacion is not null))
);
create unique index recoleccion_una_pendiente on recoleccion (sucursal_id) where estado = 'pendiente';
alter table sobre_cierre add constraint sobre_cierre_recoleccion_fk foreign key (recoleccion_id) references recoleccion (id);
alter table revision_caja add constraint revision_caja_recoleccion_fk foreign key (recoleccion_id) references recoleccion (id);

create table recoleccion_sobre (
  recoleccion_id uuid not null references recoleccion (id),
  sobre_id       uuid not null references sobre_cierre (id),
  -- Conteo a ciegas de Dirección al confirmar.
  contado        numeric(12, 2) check (contado is null or contado >= 0),
  primary key (recoleccion_id, sobre_id)
);
create function recoleccion_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'recoleccion no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'pendiente'
       or not tiene_permiso(new.entrega_por, 'sobre.entregar', new.sucursal_id)
       or not exists (select 1 from responsable_lugar r join turno t on t.id = r.turno_id
                      where r.turno_id = new.turno_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null
                        and r.hasta is null and r.usuario_id = new.entrega_por)
       or not tiene_permiso(new.recibe, 'sobre.recoger', new.sucursal_id)
       or not exists (select 1 from perfiles_en_sucursal(new.recibe, new.sucursal_id) p where p = 'direccion') then
      raise exception 'Entrega la responsable en turno y recibe Dirección de la sucursal' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.estado <> 'pendiente'
     or (new.id, new.sucursal_id, new.turno_id, new.entrega_por, new.recibe, new.creada_en)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.entrega_por, old.recibe, old.creada_en) then
    raise exception 'recoleccion: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  if new.estado = 'confirmada' and exists (select 1 from recoleccion_sobre x where x.recoleccion_id = new.id and x.contado is null) then
    raise exception 'Se confirma con el conteo de cada sobre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger recoleccion_valida
  before insert or update or delete on recoleccion
  for each row execute function recoleccion_valida();
create trigger recoleccion_sin_vaciar
  before truncate on recoleccion
  for each statement execute function impedir_modificacion();

create function recoleccion_sobre_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'recoleccion_sobre no se borra' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.contado is not null or not exists (
      select 1 from recoleccion r join sobre_cierre s on s.sucursal_id = r.sucursal_id
      where r.id = new.recoleccion_id and r.estado = 'pendiente' and s.id = new.sobre_id and s.estado = 'usado' and s.importe is not null) then
      raise exception 'Se entregan sobres guardados de la sucursal' using errcode = 'check_violation';
    end if;
    if exists (select 1 from recoleccion_sobre x join recoleccion r on r.id = x.recoleccion_id
               where x.sobre_id = new.sobre_id and r.estado = 'pendiente' and r.id <> new.recoleccion_id) then
      raise exception 'El sobre ya está en otra entrega pendiente' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.contado is not null or new.contado is null or (new.recoleccion_id, new.sobre_id) is distinct from (old.recoleccion_id, old.sobre_id)
     or not exists (select 1 from recoleccion r where r.id = new.recoleccion_id and r.estado = 'pendiente') then
    raise exception 'recoleccion_sobre: el conteo se registra una vez, antes de confirmar' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger recoleccion_sobre_valido
  before insert or update or delete on recoleccion_sobre
  for each row execute function recoleccion_sobre_valido();
create trigger recoleccion_sobre_sin_vaciar
  before truncate on recoleccion_sobre
  for each statement execute function impedir_modificacion();

-- Diferencia por sobre (contado por Dirección − anotado al cerrar), por revisar. Un sobre que Dirección recibe abierto,
-- con otro folio o que no está también queda por revisar aunque el importe coincida (con su verificación).
create table diferencia_sobre (
  id            uuid primary key default gen_random_uuid(),
  recoleccion_id uuid not null references recoleccion (id),
  sobre_id      uuid not null unique references sobre_cierre (id),
  importe       numeric(12, 2) not null,
  verificacion_id bigint references verificacion_sobre (id),
  creada_en     timestamptz not null default now(),
  constraint diferencia_sobre_con_motivo check (importe <> 0 or verificacion_id is not null)
);
create function diferencia_sobre_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from recoleccion_sobre x join sobre_cierre s on s.id = x.sobre_id join recoleccion r on r.id = x.recoleccion_id
                 where x.recoleccion_id = new.recoleccion_id and x.sobre_id = new.sobre_id and r.estado = 'confirmada'
                   and x.contado - s.importe = new.importe) then
    raise exception 'La diferencia es lo contado menos lo anotado, en una recolección confirmada' using errcode = 'check_violation';
  end if;
  if new.verificacion_id is not null and not exists (
    select 1 from verificacion_sobre v join revision_caja r on r.id = v.revision_id
    where v.id = new.verificacion_id and v.sobre_id = new.sobre_id and v.estado <> 'correcto' and r.recoleccion_id = new.recoleccion_id) then
    raise exception 'La verificación es del sobre, con problema, en esta recolección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger diferencia_sobre_valida
  before insert on diferencia_sobre
  for each row execute function diferencia_sobre_valida();
create trigger diferencia_sobre_inmutable
  before update or delete on diferencia_sobre
  for each row execute function impedir_modificacion();
create trigger diferencia_sobre_sin_vaciar
  before truncate on diferencia_sobre
  for each statement execute function impedir_modificacion();

-- Quién participó en la cadena de un sobre: quien cerró, quien verificó la caja mientras estuvo guardado (y quien tuvo la
-- llave), quien lo entregó y quien lo recogió.
create function participantes_sobre(p_sobre uuid) returns setof uuid
language sql stable as $$
  select e.entrega_por from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
  union select e.custodio_id from sobre_cierre s join entrega_turno e on e.id = s.entrega_id where s.id = p_sobre
  union select v.verificado_por from verificacion_sobre v where v.sobre_id = p_sobre
  union select r.custodio_id from verificacion_sobre v join revision_caja r on r.id = v.revision_id where v.sobre_id = p_sobre
  union select x.entrega_por from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado = 'confirmada'
  union select x.recibe from recoleccion x join recoleccion_sobre y on y.recoleccion_id = x.id where y.sobre_id = p_sobre and x.estado = 'confirmada'
$$;

create table revision_diferencia_sobre (
  id            uuid primary key default gen_random_uuid(),
  diferencia_id uuid not null unique references diferencia_sobre (id),
  resultado     text not null check (resultado in ('aclarada', 'faltante_confirmado', 'sobrante_confirmado', 'incidencia_confirmada')),
  motivo        text not null check (char_length(btrim(motivo)) between 5 and 300),
  revisada_por  uuid not null references usuario (id),
  en            timestamptz not null default now()
);
-- Revisa Administración si no participó en la cadena del sobre.
create function revision_diferencia_sobre_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  select ds.sobre_id, ds.importe, s.sucursal_id into d from diferencia_sobre ds join sobre_cierre s on s.id = ds.sobre_id where ds.id = new.diferencia_id;
  if new.revisada_por in (select participantes_sobre(d.sobre_id)) then
    raise exception 'Quien participó en la cadena del sobre no revisa su diferencia' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from perfiles_en_sucursal(new.revisada_por, d.sucursal_id) p where p = 'administracion')
     or not tiene_permiso(new.revisada_por, 'diferencia.revisar', d.sucursal_id) then
    raise exception 'Revisa Administración' using errcode = 'check_violation';
  end if;
  if (new.resultado = 'faltante_confirmado' and d.importe >= 0) or (new.resultado = 'sobrante_confirmado' and d.importe <= 0)
     or (new.resultado = 'incidencia_confirmada' and d.importe <> 0) then
    raise exception 'El resultado no corresponde al signo de la diferencia' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger revision_diferencia_sobre_valida
  before insert on revision_diferencia_sobre
  for each row execute function revision_diferencia_sobre_valida();
create trigger revision_diferencia_sobre_inmutable
  before update or delete on revision_diferencia_sobre
  for each row execute function impedir_modificacion();
create trigger revision_diferencia_sobre_sin_vaciar
  before truncate on revision_diferencia_sobre
  for each statement execute function impedir_modificacion();

-- Depósitos de lo recogido (parciales); nunca más de lo contado.
create table deposito_recoleccion (
  id            uuid primary key default gen_random_uuid(),
  recoleccion_id uuid not null references recoleccion (id),
  importe       numeric(12, 2) not null check (importe > 0),
  fecha         date not null,
  referencia    text not null check (char_length(btrim(referencia)) between 3 and 60),
  registrado_por uuid not null references usuario (id),
  en            timestamptz not null default now()
);
create function deposito_recoleccion_valido() returns trigger
language plpgsql as $$
declare
  r record;
begin
  select x.estado, x.recibe into r from recoleccion x where x.id = new.recoleccion_id for update;
  if r.estado is distinct from 'confirmada' or new.registrado_por <> r.recibe then
    raise exception 'Registra los depósitos quien recogió, de una recolección confirmada' using errcode = 'check_violation';
  end if;
  if (select coalesce(sum(d.importe), 0) from deposito_recoleccion d where d.recoleccion_id = new.recoleccion_id) + new.importe
     > (select sum(x.contado) from recoleccion_sobre x where x.recoleccion_id = new.recoleccion_id) then
    raise exception 'Los depósitos no pueden pasar de lo recogido' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger deposito_recoleccion_valido
  before insert on deposito_recoleccion
  for each row execute function deposito_recoleccion_valido();
create trigger deposito_recoleccion_inmutable
  before update or delete on deposito_recoleccion
  for each row execute function impedir_modificacion();
create trigger deposito_recoleccion_sin_vaciar
  before truncate on deposito_recoleccion
  for each statement execute function impedir_modificacion();
