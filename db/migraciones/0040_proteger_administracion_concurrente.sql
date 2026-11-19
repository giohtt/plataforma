-- Bloque 1 (ajuste del 19 nov 2026, 17:14): la protección de la última cuenta que administra accesos también vale
-- ante dos cambios simultáneos. Cada cambio que puede quitar ese acceso toma el mismo candado antes de comprobar; el
-- segundo espera a que el primero termine y comprueba ya con lo que el primero guardó.
create or replace function proteger_administracion() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('proteger_administracion'));
  -- Después del candado, cada consulta ve lo ya confirmado por la otra transacción.
  if not administracion_permanente() and (
       exists (select 1 from alcance_general g join rol_permiso rp on rp.rol = g.rol and rp.permiso = 'usuario.asignar')
       or exists (select 1 from facultad_otorgada f where f.permiso = 'usuario.asignar' and f.todas_las_sucursales)) then
    raise exception 'Debe quedar al menos una cuenta activa que administre accesos sin vencimiento' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
