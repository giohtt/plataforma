-- 0054 · Bloque 6, PR 7: precisiones de Dirección sobre reembolsos (27 nov 2026, 17:10; solo datos ficticios).
--   - Un rechazo no es definitivo: quien puso el dinero puede presentarlo de nuevo con información corregida. Cada vez es
--     una ronda nueva; el rechazo anterior se conserva y nunca hay dos pendientes del mismo pago.
--   - Si al decidir falta comprobante, queda señalado en la decisión y autorizar exige motivo expreso.
--   - Solo la cuenta de quien puso el dinero confirma que recibió el reembolso.
--   - Pagado una vez, no se vuelve a pagar aunque falte confirmar (reembolso_gasto sigue siendo único por pago).
--   - Decidir un reembolso no consume el acumulado diario (autorizado_hoy solo suma decision_gasto).

alter table decision_reembolso drop constraint decision_reembolso_pkey cascade;  -- también la referencia desde reembolso_gasto
alter table decision_reembolso add column id uuid not null default gen_random_uuid() primary key;
alter table decision_reembolso add column ronda integer not null default 1 check (ronda >= 1);
alter table decision_reembolso add column sin_comprobante boolean not null default false;
alter table decision_reembolso add constraint decision_reembolso_ronda_unica unique (pago_id, ronda);
alter table decision_reembolso add constraint autorizar_sin_comprobante_con_motivo
  check (not (decision = 'autorizado' and sin_comprobante) or motivo is not null);
alter table reembolso_gasto add constraint reembolso_gasto_pago_fk foreign key (pago_id) references pago_gasto (id);

create table reenvio_reembolso (
  pago_id uuid not null references pago_gasto (id),
  ronda   integer not null check (ronda >= 2),
  nota    text not null check (char_length(nota) between 5 and 300),
  por     uuid not null references usuario (id),
  en      timestamptz not null default now(),
  primary key (pago_id, ronda)
);

alter table reembolso_recibido add column por uuid not null references usuario (id);

-- Decide Dirección con facultad vigente, sobre la ronda pendiente, señalando si falta comprobante.
create or replace function decision_reembolso_valida() returns trigger
language plpgsql as $$
declare
  p record;
  g record;
  v_ultima record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'decision_reembolso: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into p from pago_gasto where id = new.pago_id for update;
  if p.origen <> 'dinero_personal' then
    raise exception 'Solo se reembolsa lo pagado con dinero personal' using errcode = 'check_violation';
  end if;
  select * into g from gasto where id = p.gasto_id;
  if not exists (select 1 from perfiles_en_sucursal(new.por, g.sucursal_paga_id) r where r = 'direccion')
     or not exists (select 1 from facultad_gasto(new.por, g.sucursal_id))
     or not exists (select 1 from facultad_gasto(new.por, g.sucursal_paga_id)) then
    raise exception 'El reembolso lo decide Dirección, con su facultad de gasto vigente' using errcode = 'check_violation';
  end if;
  select * into v_ultima from decision_reembolso where pago_id = new.pago_id order by ronda desc limit 1;
  if new.ronda <> coalesce(v_ultima.ronda, 0) + 1 then
    raise exception 'El reembolso ya se decidió en esa ronda' using errcode = 'unique_violation';
  end if;
  if v_ultima.ronda is not null and (v_ultima.decision <> 'rechazado'
     or not exists (select 1 from reenvio_reembolso r where r.pago_id = new.pago_id and r.ronda = new.ronda)) then
    raise exception 'Después de un rechazo, el reembolso se decide de nuevo solo si se presentó otra vez' using errcode = 'check_violation';
  end if;
  if new.sin_comprobante <> not exists (select 1 from comprobante_gasto c where c.gasto_id = p.gasto_id) then
    raise exception 'La decisión señala si falta comprobante' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Presentar de nuevo: quien puso el dinero, después de un rechazo, una vez por ronda.
create function reenvio_reembolso_valido() returns trigger
language plpgsql as $$
declare
  p record;
  v_ultima record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'reenvio_reembolso: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into p from pago_gasto where id = new.pago_id for update;
  if new.por <> p.pagado_por then
    raise exception 'Lo presenta de nuevo quien puso el dinero' using errcode = 'check_violation';
  end if;
  select * into v_ultima from decision_reembolso where pago_id = new.pago_id order by ronda desc limit 1;
  if v_ultima.decision is distinct from 'rechazado' or new.ronda <> v_ultima.ronda + 1 then
    raise exception 'Solo se presenta de nuevo un reembolso rechazado, una vez por rechazo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger reenvio_reembolso_valido before insert or update or delete on reenvio_reembolso
  for each row execute function reenvio_reembolso_valido();
create trigger reenvio_reembolso_sin_vaciar before truncate on reenvio_reembolso for each statement execute function impedir_modificacion();

-- Se paga solo si la última decisión lo autorizó.
create or replace function reembolso_gasto_valido() returns trigger
language plpgsql as $$
declare
  d record;
  p record;
  g record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'reembolso_gasto: no se edita ni se borra' using errcode = 'insufficient_privilege';
  end if;
  select * into p from pago_gasto where id = new.pago_id for update;
  select * into d from decision_reembolso where pago_id = new.pago_id order by ronda desc limit 1;
  select * into g from gasto where id = p.gasto_id;
  if d.decision is distinct from 'autorizado' then
    raise exception 'Solo se paga un reembolso autorizado' using errcode = 'check_violation';
  end if;
  if new.importe <> p.importe then
    raise exception 'El reembolso es por lo pagado con dinero personal' using errcode = 'check_violation';
  end if;
  if new.pagado_por = p.pagado_por then
    raise exception 'Quien recibe el reembolso no se lo paga a sí misma' using errcode = 'check_violation';
  end if;
  if not tiene_permiso(new.pagado_por, 'gasto.pagar', g.sucursal_paga_id) then
    raise exception 'Sin permiso para pagar en la sucursal que paga' using errcode = 'check_violation';
  end if;
  if new.origen = 'transferencia' and not exists (select 1 from perfiles_en_sucursal(new.pagado_por, g.sucursal_paga_id) r
                                                  where r in ('administracion', 'gestion_administrativa', 'direccion')) then
    raise exception 'Las transferencias las registra Administración, Gestión administrativa o Dirección' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Solo la cuenta de quien puso el dinero confirma que lo recibió.
create function reembolso_recibido_valido() returns trigger
language plpgsql as $$
begin
  if new.por <> (select p.pagado_por from reembolso_gasto r join pago_gasto p on p.id = r.pago_id where r.id = new.reembolso_id) then
    raise exception 'Solo quien puso el dinero confirma que recibió el reembolso' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger reembolso_recibido_valido before insert on reembolso_recibido
  for each row execute function reembolso_recibido_valido();
