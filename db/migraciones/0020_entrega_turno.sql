-- 0020 · Bloque 5, primer paso: cambio de turno con confirmación de quien recibe (solo datos ficticios).
-- Reglas aprobadas el 11 nov 2026 para el piloto de Tenango:
--   1. Variante A: la misma recepcionista responde por la bolsa y el cajón, con registros y conteos separados.
--      La entrega se completa cuando la entrante cuenta y confirma lo recibido desde su propia cuenta.
--   2. La entrante captura su conteo antes de ver el de la saliente. Si difieren, recuentan juntas y se conservan
--      los conteos originales y la aclaración. Si persiste el desacuerdo, queda por revisar y la entrante empieza con
--      el importe que confirmó. Se registran por separado la diferencia contra el esperado y la diferencia entre
--      ambas personas.
-- La revisión de las diferencias (regla 3) llega en el siguiente paso; aquí quedan «por revisar».

insert into permiso (clave, descripcion, bloque, es_autorizacion) values
  ('turno.entregar', 'Entregar la bolsa de visitas y el cajón de mensualidades en el cambio de turno', 5, false),
  ('turno.recibir',  'Recibir y confirmar la bolsa de visitas y el cajón de mensualidades en el cambio de turno', 5, false);
insert into rol_permiso (rol, permiso) values
  ('recepcion', 'turno.entregar'),
  ('recepcion', 'turno.recibir');

-- ---------------------------------------------------------------------------
-- Entrega del turno: de la responsable vigente (saliente) a otra recepcionista (entrante).
--   pendiente  → la entrante todavía no captura su conteo;
--   recuento   → su primer conteo no coincidió: deben recontar juntas y escribir la aclaración;
--   confirmada → la entrante confirmó; se cerró el turno de origen y se abrió el suyo;
--   cancelada  → la saliente la canceló antes de la confirmación (con motivo).
-- Solo cambian el estado y los datos de su resolución; lo demás no se edita ni se borra.
-- ---------------------------------------------------------------------------
create table entrega_turno (
  id                 uuid primary key default gen_random_uuid(),
  turno_id           uuid not null references turno (id),
  entrega_por        uuid not null references usuario (id),
  recibe             uuid not null references usuario (id),
  creada_en          timestamptz not null default now(),
  nota               text check (nota is null or char_length(nota) between 5 and 300),
  estado             text not null default 'pendiente' check (estado in ('pendiente', 'recuento', 'confirmada', 'cancelada')),
  aclaracion         text check (aclaracion is null or char_length(aclaracion) between 5 and 300),
  motivo_cancelacion text check (motivo_cancelacion is null or char_length(motivo_cancelacion) between 5 and 300),
  resuelta_en        timestamptz,
  turno_nuevo_id     uuid references turno (id),
  version            int not null default 1,
  constraint entrega_a_otra_persona check (entrega_por <> recibe),
  constraint entrega_confirmada_con_turno check ((estado = 'confirmada') = (turno_nuevo_id is not null)),
  constraint entrega_cancelada_con_motivo check ((estado = 'cancelada') = (motivo_cancelacion is not null))
);
-- Una sola entrega en curso por turno, y una sola confirmada.
create unique index entrega_en_curso_por_turno on entrega_turno (turno_id) where estado in ('pendiente', 'recuento');
create unique index entrega_confirmada_por_turno on entrega_turno (turno_id) where estado = 'confirmada';
create index entrega_turno_recibe on entrega_turno (recibe) where estado in ('pendiente', 'recuento');

create function entrega_turno_valida() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'entrega_turno: no se permite delete en esta tabla' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' then
    if new.version <> old.version + 1
       or not ((old.estado = 'pendiente' and new.estado in ('recuento', 'confirmada', 'cancelada'))
            or (old.estado = 'recuento' and new.estado in ('confirmada', 'cancelada')))
       or (old.aclaracion is not null and new.aclaracion is distinct from old.aclaracion)
       or (new.id, new.turno_id, new.entrega_por, new.recibe, new.creada_en, new.nota)
          is distinct from (old.id, old.turno_id, old.entrega_por, old.recibe, old.creada_en, old.nota) then
      raise exception 'entrega_turno: cambio no permitido' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;
create trigger entrega_turno_valida
  before update or delete on entrega_turno
  for each row execute function entrega_turno_valida();
create trigger entrega_turno_sin_vaciar
  before truncate on entrega_turno
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Conteos de la entrega, por lugar. Se conservan todos:
--   entregado        → lo que contó y entregó la saliente (con el esperado de la bolsa en ese momento);
--   recibido_inicial → el primer conteo de la entrante, capturado sin ver el de la saliente;
--   recibido_final   → lo que la entrante confirma (igual al inicial si coincidió; si no, tras recontar).
-- ---------------------------------------------------------------------------
create table entrega_conteo (
  id          bigint generated always as identity primary key,
  entrega_id  uuid not null references entrega_turno (id),
  lugar_id    uuid not null references lugar_efectivo (id),
  tipo        text not null check (tipo in ('entregado', 'recibido_inicial', 'recibido_final')),
  importe     numeric(12, 2) not null check (importe >= 0),
  esperado    numeric(12, 2),
  contado_por uuid not null references usuario (id),
  en          timestamptz not null default now(),
  unique (entrega_id, lugar_id, tipo),
  constraint esperado_solo_al_entregar check (esperado is null or tipo = 'entregado')
);
create trigger entrega_conteo_inmutable
  before update or delete on entrega_conteo
  for each row execute function impedir_modificacion();
create trigger entrega_conteo_sin_vaciar
  before truncate on entrega_conteo
  for each statement execute function impedir_modificacion();

-- ---------------------------------------------------------------------------
-- Diferencias registradas en una entrega. Nunca se ajusta el esperado ni el conteo: la diferencia queda aquí.
--   contra_esperado → entregado − esperado (solo bolsa; el cajón no tiene esperado sin Open Desk);
--   entre_personas  → recibido_final − entregado.
-- Quedan «por revisar»; la revisión se registra aparte (siguiente paso del bloque 5).
-- ---------------------------------------------------------------------------
create table diferencia_efectivo (
  id            uuid primary key default gen_random_uuid(),
  entrega_id    uuid not null references entrega_turno (id),
  turno_id      uuid not null references turno (id),
  lugar_id      uuid not null references lugar_efectivo (id),
  tipo          text not null check (tipo in ('contra_esperado', 'entre_personas')),
  importe       numeric(12, 2) not null check (importe <> 0),
  registrada_en timestamptz not null default now(),
  unique (entrega_id, lugar_id, tipo)
);
create trigger diferencia_efectivo_inmutable
  before update or delete on diferencia_efectivo
  for each row execute function impedir_modificacion();
create trigger diferencia_efectivo_sin_vaciar
  before truncate on diferencia_efectivo
  for each statement execute function impedir_modificacion();

-- El turno de la entrante queda ligado a la entrega de la que salió.
alter table turno add column recibido_de uuid unique references entrega_turno (id);
