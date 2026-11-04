-- 0005 · Catálogo persistente de sucursales (tarea 5).
-- Las altas, cambios y desactivaciones se hacen desde la plataforma y quedan en historial_cambio.

-- Versión de la fila: cada cambio la incrementa. Quien guarda envía la versión que vio; si otra
-- persona guardó antes, el cambio se rechaza en lugar de sobrescribir sin aviso.
alter table sucursal add column version integer not null default 1 check (version >= 1);

-- Fecha de desactivación: se llena al desactivar y se vacía al reactivar. Debe coincidir con el estado.
alter table sucursal add column desactivada_en timestamptz;
update sucursal set desactivada_en = actualizado_en where estado_operativo = 'inactiva';
alter table sucursal add constraint sucursal_desactivacion_coherente
  check ((estado_operativo = 'inactiva') = (desactivada_en is not null));
