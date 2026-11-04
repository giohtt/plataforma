# Bloque 1: usuarios, permisos y sucursales

Base: los tres manuales de Fitnessland y las aclaraciones acordadas después.
Solo datos ficticios. Sitio de pruebas privado, separado de producción.

| # | Tarea | Terminada cuando… |
|---|---|---|
| 1 | Repositorio y entorno ✅ | Proyecto base, prototipo guardado, pruebas automáticas en GitHub y sitio de pruebas protegido que muestra «Entorno de pruebas» sin datos. **Hecho:** publicado en Vercel (Hobby) y protegido para todas las versiones. |
| 2 | Base de datos y migraciones ✅ | Tablas creadas por migraciones versionadas: sucursales, usuarios, roles, permisos, asignaciones e historial. Comando de datos ficticios. **Hecho:** Neon (plan gratuito, proyecto `fitnessland-pruebas`, separado de producción); `DATABASE_URL` solo en Vercel, secreta y solo para Production. Verificado el 3 nov 2026: `/api/estado` muestra `baseDatos: conectada` y `migracionesAplicadas: 2`. |
| 3 | Inicio y cierre de sesión ✅ | Usuarios individuales de prueba. Recuperación con enlace de un solo uso con el que el propio usuario establece su contraseña. Mientras no haya servicio de correo, el enlace se entrega en el buzón de pruebas (solo fuera de producción y solo para usuarios ficticios). **Hecho:** probado en el sitio de pruebas el 3 nov 2026 (enlace, contraseña, inicio y cierre de sesión), con pruebas de concurrencia. |
| 4 | Permisos y asignación de sucursales ✅ | Modelo con todos los perfiles de los manuales; activos solo los necesarios. Tres concesiones separadas: perfil por sucursal, alcance general (todas las sucursales) y facultades de autorización (por persona y con límite obligatorio). Sin acceso global ni facultades por omisión. Dirección con lista explícita de permisos. El catálogo incluye los permisos de todos los bloques del [plan general](plan-general.md); los perfiles solo tienen los del bloque 1. **Hecho:** probado en el sitio de pruebas el 3 nov 2026 con Recepción Tenango: solo ve Tenango; `/sucursales/STG` responde 404 con la página «No encontrada», igual que una sucursal inexistente. |
| 5 | Catálogo persistente de sucursales (en revisión) | Crear, editar y desactivar; nombre y código únicos; historial; crear no asigna a nadie. Permiso comprobado en el servidor en la misma transacción que guarda el cambio; si dos personas editan a la vez, la segunda recibe aviso en vez de sobrescribir. |
| 6 | Pruebas de acceso permitido y denegado | Solicitudes directas al servidor: recepción no crea sucursales ni consulta otra sucursal. |

## Propuestas de la tarea 5 (pendientes de aprobación)
Implementadas así para poder probarlas; ninguna es política aprobada y todas se pueden cambiar.
- **El código no cambia después de crear la sucursal.** Aparece en las direcciones de las páginas y servirá para relacionarla con otros datos. Solo se aplica en la plataforma, no en la base, para poder cambiar la regla si se decide otra cosa.
- **Nombres únicos sin contar mayúsculas, acentos ni espacios repetidos** («Rayon» y «Rayón» cuentan como el mismo).
- **Desactivar no quita accesos.** Las personas asignadas la siguen viendo, marcada como inactiva. Qué operaciones se bloquean en una sucursal inactiva se decide cuando existan (bloques 3 a 6).
- **Se puede reactivar**, con el mismo permiso que desactivar, eligiendo si vuelve como «Próxima apertura» o «Activa».
- **Motivo obligatorio** al editar, desactivar y reactivar; opcional al crear.
- **El historial de la sucursal lo ve quien tiene el permiso general de consultar historial** (hoy, solo Dirección con alcance general). Dirección de una sola sucursal puede editarla, pero no ve su historial.
- **No se editan desde aquí:** el identificador de Open Desk (falta la información de su API) ni la zona horaria (todas usan la del centro de México).

## Reglas que no cambian
- Cuentas individuales; nada de usuarios compartidos.
- Los permisos se comprueban en el servidor; ocultar botones es solo comodidad.
- Nadie recibe acceso a todas las sucursales ni facultades de autorización por omisión.
- Respaldos y restauración probada antes de cualquier dato real.
- El ingeniero de Open Desk no tiene acceso al repositorio ni a la plataforma.

## Pendiente de consultar al ingeniero de Open Desk (no bloquea este bloque)
- Si su API exige IP fija.
- Método de autenticación de la API y si envía avisos automáticos (webhooks).
- Identificadores de sucursales, socios y cobros; zona horaria de las fechas.
- Límites de uso y restricciones sobre dónde guardar datos de socios.
