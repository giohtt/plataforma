-- 0033 · Fondo fijo (ajuste del 18 nov 2026, antes de unir):
--   1. No se confirma una entrada al fondo mientras el turno tenga un cambio de turno pendiente o en recuento: lo
--      recibido cambiaría el esperado de una entrega ya contada. El servidor bloquea primero el turno (como cobros,
--      retiros y entregas) y la base lo vuelve a exigir.
--   2. Si quien recibe declara un importe distinto del registrado, el intento se conserva (cuenta, hora e importe
--      declarado) aunque después la entrada se cancele y se registre de nuevo.

create function entrada_fondo_sin_entrega() returns trigger
language plpgsql as $$
begin
  if new.estado = 'recibida' and exists (
    select 1 from entrega_turno e where e.turno_id = new.turno_id and e.estado in ('pendiente', 'recuento')) then
    raise exception 'Con un cambio de turno pendiente o en recuento no se confirma una entrada al fondo' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger entrada_fondo_sin_entrega
  before update on entrada_fondo
  for each row execute function entrada_fondo_sin_entrega();

create table intento_entrada_fondo (
  id          bigint generated always as identity primary key,
  entrada_id  uuid not null references entrada_fondo (id),
  declarado   numeric(12, 2) not null check (declarado >= 0),
  registrado  numeric(12, 2) not null,
  por         uuid not null references usuario (id),
  en          timestamptz not null default now(),
  constraint intento_difiere check (declarado <> registrado)
);
create index intento_entrada_fondo_entrada on intento_entrada_fondo (entrada_id, en);
create function intento_entrada_fondo_valido() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from entrada_fondo x where x.id = new.entrada_id and x.estado = 'pendiente'
                   and x.importe = new.registrado and x.entrega <> new.por) then
    raise exception 'El intento es de una entrada pendiente, con su importe registrado, de quien recibe' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger intento_entrada_fondo_valido
  before insert on intento_entrada_fondo
  for each row execute function intento_entrada_fondo_valido();
create trigger intento_entrada_fondo_inmutable
  before update or delete on intento_entrada_fondo
  for each row execute function impedir_modificacion();
create trigger intento_entrada_fondo_sin_vaciar
  before truncate on intento_entrada_fondo
  for each statement execute function impedir_modificacion();
