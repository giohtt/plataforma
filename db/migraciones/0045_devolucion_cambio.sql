-- 0045 · Cambio mal entregado: devolución a la persona visitante (aprobado el 26 nov 2026; solo datos ficticios).
--   - Origen del sobrante: al revisar un sobrante de la bolsa contra el esperado, quien revisa puede ligarlo al cobro en
--     efectivo donde se entregó mal el cambio y anotar el cambio que realmente se entregó. Primera versión: visita con
--     una sola persona visitante identificada (con ficha), con «Recibido» anotado, en esa bolsa y ese turno, sin
--     cancelar; y el cambio que faltó entregar debe coincidir EXACTAMENTE con el sobrante. Si no, el caso sigue pendiente.
--   - Dirección que NO participó en la entrega autoriza cada devolución (no aplica la autorización personal). El caso
--     queda en «Devolución pendiente»; los $ siguen en el efectivo físico, desglosados como «por devolver».
--   - Un mismo cobro no puede usarse para autorizar dos devoluciones.
--   - Recepción (la responsable vigente de la bolsa) entrega el dinero en la sucursal del cobro y registra que lo recibió
--     la persona visitante. La salida se registra una sola vez (salida_devolucion_cambio), baja el esperado de la bolsa
--     y no toca el cobro ni el ingreso. Al registrarla, el caso se cierra («Devuelta a la persona visitante»).
--   - A los 30 días de la autorización sin devolver, aparece un recordatorio para Dirección; no se cierra ni se convierte
--     en ingreso. Nada se edita ni se borra; se conservan la fecha original y la de cada registro.

-- 1. Origen «cambio mal entregado», registrado con la revisión.
create table origen_cambio_mal_entregado (
  diferencia_id      uuid primary key references diferencia_efectivo (id),
  cobro_id           uuid not null references cobro_visita (id),
  visitante_id       uuid not null references visitante (id),
  cambio_registrado  numeric(12, 2) not null,
  cambio_entregado   numeric(12, 2) not null check (cambio_entregado >= 0),
  por_devolver       numeric(12, 2) not null check (por_devolver > 0),
  registrado_por     uuid not null references usuario (id),
  en                 timestamptz not null default now(),
  constraint origen_cambio_coherente check (por_devolver = cambio_registrado - cambio_entregado)
);

create function origen_cambio_valido() returns trigger
language plpgsql as $$
declare
  d record;
  c record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'origen_cambio_mal_entregado: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select df.tipo, df.importe, df.turno_id, df.lugar_id, l.tipo as lugar, e.creada_en, r.resultado, r.revisada_por
    into d
  from diferencia_efectivo df join lugar_efectivo l on l.id = df.lugar_id join entrega_turno e on e.id = df.entrega_id
  left join revision_diferencia r on r.diferencia_id = df.id
  where df.id = new.diferencia_id;
  if d.resultado is distinct from 'sobrante_confirmado' or d.revisada_por is distinct from new.registrado_por
     or d.tipo <> 'contra_esperado' or d.lugar <> 'bolsa_visitas' then
    raise exception 'El origen se registra con la revisión de un sobrante de la bolsa contra el esperado' using errcode = 'check_violation';
  end if;
  select cv.forma_pago, cv.cambio, m.turno_id, m.lugar_id, m.en,
         (select count(*) from pase_visita p where p.operacion_id = cv.operacion_id) as personas,
         (select p.visitante_id from pase_visita p where p.operacion_id = cv.operacion_id limit 1) as visitante,
         exists (select 1 from movimiento_efectivo a where a.cobro_id = cv.id and a.tipo = 'ajuste_cancelacion_cobro') as cancelado
    into c
  from cobro_visita cv join movimiento_efectivo m on m.cobro_id = cv.id and m.tipo = 'entrada_cobro_visita'
  where cv.id = new.cobro_id;
  if c is null or c.forma_pago <> 'efectivo' or c.cambio is null or c.cancelado or c.personas <> 1
     or c.turno_id <> d.turno_id or c.lugar_id <> d.lugar_id or c.en > d.creada_en then
    raise exception 'El cobro debe ser en efectivo, de una visita identificada, con «Recibido», de esa bolsa y ese turno' using errcode = 'check_violation';
  end if;
  if new.visitante_id <> c.visitante or new.cambio_registrado <> c.cambio or new.cambio_entregado >= c.cambio
     or new.por_devolver <> d.importe then
    raise exception 'Lo que falta devolver debe coincidir exactamente con el sobrante' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger origen_cambio_valido before insert or update or delete on origen_cambio_mal_entregado
  for each row execute function origen_cambio_valido();
create trigger origen_cambio_sin_vaciar before truncate on origen_cambio_mal_entregado
  for each statement execute function impedir_modificacion();

-- 2. Decisión de Dirección «Por devolver a la persona visitante».
alter table resolucion_diferencia drop constraint resolucion_diferencia_decision_check;
alter table resolucion_diferencia add constraint resolucion_diferencia_decision_check
  check (decision in ('absorbe_sucursal', 'queda_en_bolsa', 'origen_identificado', 'devolver_visitante'));

create table devolucion_cambio (
  id             uuid primary key default gen_random_uuid(),
  diferencia_id  uuid not null unique references diferencia_efectivo (id),
  resolucion_id  uuid not null unique references resolucion_diferencia (id),
  -- Un mismo cobro no autoriza dos devoluciones.
  cobro_id       uuid not null unique references cobro_visita (id),
  visitante_id   uuid not null references visitante (id),
  sucursal_id    uuid not null references sucursal (id),
  importe        numeric(12, 2) not null check (importe > 0),
  autorizada_por uuid not null references usuario (id),
  autorizada_en  timestamptz not null default now()
);

create function devolucion_cambio_valida() returns trigger
language plpgsql as $$
declare
  o record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'devolucion_cambio: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select oc.cobro_id, oc.visitante_id, oc.por_devolver, t.sucursal_id, x.decision, x.resuelta_por, x.diferencia_id as dx, df.entrega_id
    into o
  from origen_cambio_mal_entregado oc join diferencia_efectivo df on df.id = oc.diferencia_id join turno t on t.id = df.turno_id
  join resolucion_diferencia x on x.id = new.resolucion_id
  where oc.diferencia_id = new.diferencia_id;
  if o is null or o.dx <> new.diferencia_id or o.decision <> 'devolver_visitante' or o.cobro_id <> new.cobro_id
     or o.visitante_id <> new.visitante_id or o.por_devolver <> new.importe or o.sucursal_id <> new.sucursal_id
     or o.resuelta_por <> new.autorizada_por then
    raise exception 'La devolución corresponde al origen registrado y a la decisión de Dirección' using errcode = 'check_violation';
  end if;
  -- Dirección que no participó (sin la autorización personal).
  if new.autorizada_por in (select participantes_entrega(o.entrega_id)) then
    raise exception 'Autoriza la devolución Dirección que no participó en la entrega' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger devolucion_cambio_valida before insert or update or delete on devolucion_cambio
  for each row execute function devolucion_cambio_valida();
create trigger devolucion_cambio_sin_vaciar before truncate on devolucion_cambio
  for each statement execute function impedir_modificacion();

-- La decisión «devolver_visitante» exige su devolución autorizada en la misma transacción, y solo con origen registrado.
create function resolucion_devolver_completa() returns trigger
language plpgsql as $$
begin
  if new.decision = 'devolver_visitante' and not exists (select 1 from devolucion_cambio d where d.resolucion_id = new.id) then
    raise exception 'La decisión «Por devolver» registra su devolución autorizada' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger resolucion_devolver_completa after insert on resolucion_diferencia
  deferrable initially deferred for each row execute function resolucion_devolver_completa();

-- 3. La entrega del dinero: una salida de la bolsa, una sola vez por devolución.
alter table movimiento_efectivo add column devolucion_id uuid unique references devolucion_cambio (id);
alter table movimiento_efectivo drop constraint movimiento_efectivo_tipo_signo;
alter table movimiento_efectivo add constraint movimiento_efectivo_tipo_signo check (
  (tipo = 'entrada_cobro_visita' and importe > 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null)
  or (tipo = 'ajuste_cancelacion_cobro' and importe < 0 and cobro_id is not null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null)
  or (tipo = 'salida_retiro' and importe < 0 and cobro_id is null and retiro_id is not null and entrada_fondo_id is null and sobre_id is null and devolucion_id is null)
  or (tipo = 'entrada_fondo' and importe > 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is not null and sobre_id is null and devolucion_id is null)
  or (tipo = 'salida_sobre' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is not null and devolucion_id is null)
  or (tipo = 'salida_devolucion_cambio' and importe < 0 and cobro_id is null and retiro_id is null and entrada_fondo_id is null and sobre_id is null and devolucion_id is not null));

create table devolucion_entregada (
  devolucion_id  uuid primary key references devolucion_cambio (id),
  movimiento_id  bigint not null unique references movimiento_efectivo (id),
  recibio        uuid not null references visitante (id),
  entregada_por  uuid not null references usuario (id),
  nota           text check (nota is null or char_length(btrim(nota)) between 1 and 300),
  en             timestamptz not null default now()
);

create function devolucion_entregada_valida() returns trigger
language plpgsql as $$
declare
  d record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'devolucion_entregada: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select dc.visitante_id, dc.importe, dc.sucursal_id, m.importe as salida, m.tipo, m.devolucion_id, m.registrado_por, l.sucursal_id as suc_mov, l.tipo as lugar
    into d
  from devolucion_cambio dc join movimiento_efectivo m on m.id = new.movimiento_id join lugar_efectivo l on l.id = m.lugar_id
  where dc.id = new.devolucion_id;
  if d is null or d.tipo <> 'salida_devolucion_cambio' or d.devolucion_id <> new.devolucion_id or d.salida <> -d.importe
     or d.suc_mov <> d.sucursal_id or d.lugar <> 'bolsa_visitas' or d.registrado_por <> new.entregada_por or new.recibio <> d.visitante_id then
    raise exception 'La devolución se entrega a la persona visitante, desde la bolsa de la sucursal del cobro, por lo autorizado' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger devolucion_entregada_valida before insert or update or delete on devolucion_entregada
  for each row execute function devolucion_entregada_valida();
create trigger devolucion_entregada_sin_vaciar before truncate on devolucion_entregada
  for each statement execute function impedir_modificacion();

-- La salida por devolución exige su entrega registrada en la misma transacción.
create function salida_devolucion_completa() returns trigger
language plpgsql as $$
begin
  if new.tipo = 'salida_devolucion_cambio' and not exists (select 1 from devolucion_entregada e where e.movimiento_id = new.id) then
    raise exception 'La salida por devolución registra quién la recibió' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger salida_devolucion_completa after insert on movimiento_efectivo
  deferrable initially deferred for each row execute function salida_devolucion_completa();
