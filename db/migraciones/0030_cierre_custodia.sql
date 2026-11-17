-- 0030 · Bloque 5, regla 7: cierre del día y custodia nocturna (aprobado el 16 nov 2026; solo datos ficticios).
--   1. Dirección define por sucursal dónde se guardan los sobres y quién tiene acceso; cada cierre guarda la
--      configuración vigente. El custodio (Encargado) confirma desde su cuenta dónde los guardó y verifica el sello y
--      el folio de cada sobre; si falta, llega abierto o trae otro folio, registra la incidencia con motivo.
--   2. Cierre: folios de los sobres generados automáticamente y mostrados antes de cerrar. Se registra quién contó y
--      quién ayudó. Con un cambio de turno en curso o un retiro en preparación, primero se resuelve esa operación.
--      Si la bolsa difiere del esperado queda constancia en el cierre; al confirmarse el caso se vinculan las
--      diferencias ya registradas al retirar, sin duplicarlas. Cerrar termina el turno.
--   3. Durante la noche no hay retiros: antes del cierre o después de la siguiente apertura (flujo de retiros).
--   4. Apertura: quien abre verifica sellos y folios y cuenta a ciegas. Si no coincide, recuento con el custodio; si no
--      pueden, abre con lo contado, con motivo obligatorio y la diferencia por revisar. Se conservan los conteos.
--   5. Puede abrir la misma persona que cerró (queda en el historial). Revisa quien no participó en el cierre, la
--      custodia ni la apertura: si el custodio es Encargado, Administración; si también participó, Dirección.
--
-- El cierre reutiliza entrega_turno (tipo «cierre»): quien cierra es quien entrega, quien abre es quien recibe (se
-- conoce al abrir) y en medio está el custodio. Así las diferencias, su revisión y la resolución de Dirección son
-- las mismas que en el cambio de turno.

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('turno.cerrar',        'Cerrar el día: contar ambos lugares y entregar los sobres al custodio', 5, false),
  ('custodia.confirmar',  'Confirmar como custodio nocturno los sobres del cierre y dónde se guardaron', 5, false),
  ('custodia.configurar', 'Definir dónde se guardan los sobres del cierre y quién tiene acceso', 5, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion', 'turno.cerrar'),
  ('encargado', 'custodia.confirmar'),
  ('direccion', 'custodia.configurar');

-- ---------------------------------------------------------------------------
-- Configuración de custodia por sucursal (Dirección). Solo se agregan versiones: la vigente es la más reciente.
-- ---------------------------------------------------------------------------
create table custodia_configuracion (
  id              uuid primary key default gen_random_uuid(),
  sucursal_id     uuid not null references sucursal (id),
  lugar           text not null check (char_length(btrim(lugar)) between 5 and 120),
  acceso          uuid[] not null check (cardinality(acceso) between 1 and 10),
  configurada_por uuid not null references usuario (id),
  en              timestamptz not null default now()
);
create index custodia_configuracion_vigente on custodia_configuracion (sucursal_id, en desc);

create function custodia_configuracion_valida() returns trigger
language plpgsql as $$
begin
  if not tiene_permiso(new.configurada_por, 'custodia.configurar', new.sucursal_id)
     or not exists (select 1 from perfiles_en_sucursal(new.configurada_por, new.sucursal_id) r where r = 'direccion') then
    raise exception 'Define la custodia Dirección con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(new.acceso) a(u) where not exists (select 1 from perfiles_en_sucursal(a.u, new.sucursal_id))) then
    raise exception 'Solo tienen acceso personas con asignación en la sucursal' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_configuracion_valida
  before insert on custodia_configuracion
  for each row execute function custodia_configuracion_valida();
create trigger custodia_configuracion_inmutable
  before update or delete on custodia_configuracion
  for each row execute function impedir_modificacion();
create trigger custodia_configuracion_sin_vaciar
  before truncate on custodia_configuracion
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Cierre como entrega_turno de tipo «cierre».
-- ---------------------------------------------------------------------------
alter table entrega_turno add column tipo text not null default 'cambio_turno' check (tipo in ('cambio_turno', 'cierre'));
alter table entrega_turno add column custodio_id uuid references usuario (id);
alter table entrega_turno add column custodia_config_id uuid references custodia_configuracion (id);
-- Al abrir tras un cierre, si recontaron con el custodio.
alter table entrega_turno add column recontado_con uuid references usuario (id);
alter table entrega_turno alter column recibe drop not null;
alter table entrega_turno drop constraint entrega_a_otra_persona;
alter table entrega_turno add constraint entrega_a_otra_persona check (tipo = 'cierre' or entrega_por <> recibe);
alter table entrega_turno add constraint entrega_con_quien_recibe check (recibe is not null or (tipo = 'cierre' and estado in ('pendiente', 'cancelada')));
alter table entrega_turno add constraint cierre_con_custodio check (
  (tipo = 'cierre') = (custodio_id is not null) and (tipo = 'cierre') = (custodia_config_id is not null)
  and (custodio_id is null or custodio_id <> entrega_por));
alter table entrega_turno add constraint recuento_con_custodio check (recontado_con is null or recontado_con = custodio_id);

create or replace function entrega_turno_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'entrega_turno: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if new.version <> old.version + 1
       or not ((old.estado = 'pendiente' and new.estado in ('recuento', 'confirmada', 'cancelada'))
            or (old.estado = 'recuento' and new.estado in ('confirmada', 'cancelada'))
            -- Al empezar a abrir un cierre se registra quién abre, sin cambiar todavía el estado.
            or (old.estado = 'pendiente' and new.estado = 'pendiente' and old.tipo = 'cierre' and old.recibe is null and new.recibe is not null))
       or (old.aclaracion is not null and new.aclaracion is distinct from old.aclaracion)
       -- Quien recibe solo se fija una vez, y solo en un cierre (es quien abre).
       or (old.recibe is not null and new.recibe is distinct from old.recibe)
       or (old.recibe is null and new.recibe is not null and old.tipo <> 'cierre')
       or (old.recontado_con is not null and new.recontado_con is distinct from old.recontado_con)
       or (new.id, new.turno_id, new.entrega_por, new.creada_en, new.nota, new.tipo, new.custodio_id, new.custodia_config_id)
          is distinct from (old.id, old.turno_id, old.entrega_por, old.creada_en, old.nota, old.tipo, old.custodio_id, old.custodia_config_id) then
      raise exception 'entrega_turno: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

create function cierre_valido() returns trigger
language plpgsql as $$
declare
  s uuid;
begin
  if new.tipo <> 'cierre' then
    return new;
  end if;
  select t.sucursal_id into s from turno t where t.id = new.turno_id;
  if not exists (select 1 from perfiles_en_sucursal(new.custodio_id, s) r where r = 'encargado')
     or not tiene_permiso(new.custodio_id, 'custodia.confirmar', s) then
    raise exception 'El custodio nocturno es Encargado de la sucursal' using errcode = 'check_violation';
  end if;
  if new.custodia_config_id is distinct from (select c.id from custodia_configuracion c where c.sucursal_id = s order by c.en desc, c.id limit 1) then
    raise exception 'El cierre guarda la configuración de custodia vigente' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger cierre_valido
  before insert on entrega_turno
  for each row execute function cierre_valido();

-- Un turno nuevo en una sucursal con un cierre sin abrir solo nace de ese cierre.
create function turno_desde_cierre() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from entrega_turno e join turno t on t.id = e.turno_id
             where t.sucursal_id = new.sucursal_id and e.tipo = 'cierre' and e.estado in ('pendiente', 'recuento')
               and e.id is distinct from new.recibido_de) then
    raise exception 'Hay un cierre pendiente de apertura: el turno se abre desde ese cierre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger turno_desde_cierre
  before insert on turno
  for each row execute function turno_desde_cierre();

-- Participantes: quien cerró, quien abrió, los apoyos y el custodio.
create or replace function participantes_entrega(p_entrega uuid) returns setof uuid
language sql stable as $$
  select entrega_por from entrega_turno where id = p_entrega
  union select recibe from entrega_turno where id = p_entrega and recibe is not null
  union select custodio_id from entrega_turno where id = p_entrega and custodio_id is not null
  union select usuario_id from apoyo_conteo where entrega_id = p_entrega
$$;

-- ---------------------------------------------------------------------------
-- Sobres del cierre: folio automático (sucursal, fecha local con año y C + consecutivo del día), reservado al
-- preparar el cierre y usado al cerrar. Cancelar la preparación no reutiliza el folio.
-- ---------------------------------------------------------------------------
create table folio_cierre_contador (
  sucursal_id uuid not null references sucursal (id),
  fecha       date not null,
  ultimo      int  not null check (ultimo > 0),
  primary key (sucursal_id, fecha)
);
create trigger folio_cierre_contador_valido
  before update or delete on folio_cierre_contador
  for each row execute function folio_retiro_contador_valido();
create trigger folio_cierre_contador_sin_vaciar
  before truncate on folio_cierre_contador
  for each statement execute function impedir_modificacion();

create table sobre_cierre (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references sucursal (id),
  turno_id      uuid not null references turno (id),
  lugar_id      uuid not null references lugar_efectivo (id),
  fecha         date not null,
  consecutivo   int  not null check (consecutivo > 0),
  folio         text not null,
  reservado_por uuid not null references usuario (id),
  reservado_en  timestamptz not null default now(),
  estado        text not null default 'reservado' check (estado in ('reservado', 'usado', 'cancelado')),
  entrega_id    uuid references entrega_turno (id),
  resuelto_en   timestamptz,
  constraint sobre_cierre_folio_unico unique (sucursal_id, folio),
  constraint sobre_cierre_consecutivo_unico unique (sucursal_id, fecha, consecutivo),
  constraint sobre_cierre_resuelto check ((estado = 'reservado') = (resuelto_en is null) and (estado = 'usado') = (entrega_id is not null))
);
create unique index sobre_cierre_un_reservado on sobre_cierre (turno_id, lugar_id) where estado = 'reservado';
create unique index sobre_cierre_por_entrega on sobre_cierre (entrega_id, lugar_id) where entrega_id is not null;

create function sobre_cierre_valido() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sobre_cierre: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    if new.estado <> 'reservado' or new.entrega_id is not null
       or new.folio <> (select s.codigo from sucursal s where s.id = new.sucursal_id) || '-' || to_char(new.fecha, 'YYYYMMDD') || '-C' || new.consecutivo::text
       or not exists (select 1 from folio_cierre_contador c where c.sucursal_id = new.sucursal_id and c.fecha = new.fecha and c.ultimo >= new.consecutivo)
       or not exists (select 1 from turno t join lugar_efectivo l on l.sucursal_id = t.sucursal_id
                      where t.id = new.turno_id and l.id = new.lugar_id and t.sucursal_id = new.sucursal_id and t.cerrado_en is null) then
      raise exception 'Folio de sobre de cierre no válido' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.estado <> 'reservado' or new.estado not in ('usado', 'cancelado')
     or (new.estado = 'usado' and not exists (
           select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.turno_id = new.turno_id
             and e.entrega_por = new.reservado_por))
     or (new.id, new.sucursal_id, new.turno_id, new.lugar_id, new.fecha, new.consecutivo, new.folio, new.reservado_por, new.reservado_en)
        is distinct from (old.id, old.sucursal_id, old.turno_id, old.lugar_id, old.fecha, old.consecutivo, old.folio, old.reservado_por, old.reservado_en) then
    raise exception 'sobre_cierre: cambio no permitido' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger sobre_cierre_valido
  before insert or update or delete on sobre_cierre
  for each row execute function sobre_cierre_valido();
create trigger sobre_cierre_sin_vaciar
  before truncate on sobre_cierre
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Verificación de cada sobre: el custodio al guardarlo y quien abre al recibirlo. Sello y folio; incidencia con motivo.
-- ---------------------------------------------------------------------------
create table verificacion_sobre (
  id            bigint generated always as identity primary key,
  sobre_id      uuid not null references sobre_cierre (id),
  momento       text not null check (momento in ('custodia', 'apertura')),
  estado        text not null check (estado in ('correcto', 'falta', 'abierto', 'otro_folio')),
  folio_visto   text check (folio_visto ~ '^[A-Z0-9][A-Z0-9-]{2,29}$'),
  motivo        text check (motivo is null or char_length(btrim(motivo)) between 5 and 300),
  verificado_por uuid not null references usuario (id),
  en            timestamptz not null default now(),
  unique (sobre_id, momento),
  constraint incidencia_con_motivo check ((estado = 'correcto') = (motivo is null)),
  constraint otro_folio_con_folio check ((estado = 'otro_folio') = (folio_visto is not null))
);
create function verificacion_sobre_valida() returns trigger
language plpgsql as $$
declare
  e record;
begin
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
create trigger verificacion_sobre_valida
  before insert on verificacion_sobre
  for each row execute function verificacion_sobre_valida();
create trigger verificacion_sobre_inmutable
  before update or delete on verificacion_sobre
  for each row execute function impedir_modificacion();
create trigger verificacion_sobre_sin_vaciar
  before truncate on verificacion_sobre
  for each statement execute function impedir_modificacion();

-- Confirmación de custodia: dónde quedaron los sobres, una vez, desde la cuenta del custodio.
create table custodia_cierre (
  entrega_id    uuid primary key references entrega_turno (id),
  custodio_id   uuid not null references usuario (id),
  ubicacion     text not null check (char_length(btrim(ubicacion)) between 5 and 120),
  confirmada_en timestamptz not null default now()
);
create function custodia_cierre_valida() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from entrega_turno e where e.id = new.entrega_id and e.tipo = 'cierre' and e.custodio_id = new.custodio_id) then
    raise exception 'Confirma la custodia el custodio del cierre' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger custodia_cierre_valida
  before insert on custodia_cierre
  for each row execute function custodia_cierre_valida();
create trigger custodia_cierre_inmutable
  before update or delete on custodia_cierre
  for each row execute function impedir_modificacion();
create trigger custodia_cierre_sin_vaciar
  before truncate on custodia_cierre
  for each statement execute function impedir_modificacion();
