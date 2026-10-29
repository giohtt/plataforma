# Plataforma administrativa de Fitnessland

Aplicación web para la operación y administración de las sucursales de Fitnessland.
Se construye por etapas. Open Desk sigue gestionando socios, membresías y accesos.

**Estado actual:** tarea 1 de la primera entrega (base técnica). Todavía no hay usuarios,
sucursales ni datos. Ver [`docs/plan-entrega-1.md`](docs/plan-entrega-1.md).

## Entornos

| Entorno | Dónde | Datos |
|---|---|---|
| `desarrollo` | Computadora o espacio de trabajo de quien programa | Ficticios |
| `pruebas` | Sitio privado de pruebas | Ficticios |
| `produccion` | Operación real | Reales, sin usuarios de prueba |

Cada entorno tiene su propia base de datos y sus propias contraseñas técnicas.
El entorno se define con la variable `APP_ENV`. Fuera de producción se muestra una franja
visible y el sitio pide no aparecer en buscadores.

## Herramientas

- Next.js 16 con TypeScript (interfaz y servidor).
- PostgreSQL (a partir de la tarea 2).
- Vitest (pruebas unitarias) y Playwright (pruebas de extremo a extremo).

## Uso local

Requiere Node 22.

```bash
npm ci
cp .env.example .env.local
npm run dev            # http://localhost:3000
```

Verificaciones (las mismas que corren en GitHub en cada cambio):

```bash
npm run lint
npm run typecheck
npm test
npm run build && npm run test:e2e
```

PostgreSQL local para desarrollo y pruebas: `scripts/db-local.sh iniciar | detener | estado`.

## Estructura

```
src/app/          pantallas y rutas del servidor
src/components/   componentes de interfaz
src/lib/          lógica compartida
tests/unit/       pruebas unitarias
tests/e2e/        pruebas de extremo a extremo
prototipo/        prototipo visual de demostración (no se conecta a nada)
docs/             plan de entregas y archivos de marca
```

## Reglas del repositorio

- Nunca guardar contraseñas, claves ni datos reales en el repositorio.
- Los permisos se comprueban en el servidor.
- Cada cambio pasa por las verificaciones automáticas antes de publicarse.
