# Bloque 1: usuarios, permisos y sucursales

Base: los tres manuales de Fitnessland y las aclaraciones acordadas después.
Solo datos ficticios. Sitio de pruebas privado, separado de producción.

| # | Tarea | Terminada cuando… |
|---|---|---|
| 1 | Repositorio y entorno | Proyecto base, prototipo guardado, pruebas automáticas en GitHub y sitio de pruebas protegido que muestra «Entorno de pruebas» sin datos. |
| 2 | Base de datos y migraciones | Tablas creadas por migraciones versionadas: sucursales, usuarios, roles, permisos, asignaciones e historial. Comando de datos ficticios. |
| 3 | Inicio y cierre de sesión | Usuarios individuales de prueba. Recuperación con enlace de un solo uso con el que el propio usuario establece su contraseña. |
| 4 | Permisos y asignación de sucursales | Modelo con todos los perfiles de los manuales; activos solo los necesarios. Sin acceso global ni facultades de autorización por omisión. Dirección se configura de forma explícita. El catálogo incluye los permisos de visitantes, promociones y pases ([plan general](plan-general.md)), sin asignarlos a nadie. |
| 5 | Catálogo persistente de sucursales | Crear, editar y desactivar; nombre y código únicos; historial; crear no asigna a nadie. |
| 6 | Pruebas de acceso permitido y denegado | Solicitudes directas al servidor: recepción no crea sucursales ni consulta otra sucursal. |

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
