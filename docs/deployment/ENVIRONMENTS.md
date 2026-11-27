# Tres entornos: producción, pilot y dev

Decidido el 2026-11-25 y el 2026-11-27 (DN-14 §5). Hay una rama permanente por entorno en los dos repos.

| | Producción | Pilot | Dev |
|---|---|---|---|
| Rama | `main` (protegida) | `pilot` | `dev` |
| Modo | production | live-debug | demo (front) / mock (back local) |
| Front | arcacover.com | pilot.arcacover.com, con contraseña | dev.arcacover.com, con contraseña |
| API | api.arcacover.com | api-pilot.arcacover.com, con token | ninguna: el front responde desde una grabación |
| Datos | Supabase "Arca-base" | Postgres local en el EC2 | ninguno |
| Cuentas y cobro | Supabase Auth y Stripe en test | simulados en memoria | simulados (grabación) |
| Escaneos | reales | reales, con tope de Apify de 5 USD | grabados |

## Pilot

Corre en el mismo EC2 que producción, como un proyecto de Compose aparte (`arca-pilot`, `deploy/pilot/compose.pilot.yaml`).

**Contenedores**

| Contenedor | Qué es | Memoria máxima |
|---|---|---|
| `api-pilot` | La API, en live-debug | 1.2 GB |
| `db` | Postgres 16 | 384 MB |
| `rest` | PostgREST 12 | 96 MB |
| `rest-proxy` | Caddy: sirve PostgREST bajo `/rest/v1`, como Supabase | 48 MB |

**Base de datos**

- MySQL no sirve, porque la API habla PostgREST y usa funciones plpgsql. Con Postgres y PostgREST locales la API funciona
  igual que con Supabase y nunca escribe en la base de producción.
- La primera vez, `db/00-roles.sh` crea los roles de Supabase (`anon`, `authenticated`, `service_role`) y el rol de
  conexión de PostgREST.
- Después, `db/migrate.sh` aplica las migraciones de `supabase/migrations`. Vuelve a correr en cada despliegue y aplica
  solo las nuevas; lleva la cuenta en la tabla `_pilot_migrations`.

**Seguridad**

- La API solo arranca en live-debug con `ARCA_DEPLOYMENT=aws-pilot` y un `PILOT_ACCESS_TOKEN` de 32 caracteres o más.
- Rechaza toda petición sin la cabecera `X-Arca-Pilot-Token`, salvo `/health`.
- Cualquier otro despliegue en modo de depuración sigue sin arrancar.

**Red y despliegue**

- El Caddy de producción atiende `api-pilot.arcacover.com` y llega a la API de pilot por la red Docker `arca-edge`.
- Un push a `pilot` lanza el workflow "Deploy pilot", que construye la imagen con `ARCA_TARGET=pilot`. Esa imagen lleva
  una etiqueta propia, que nunca es el SHA del commit.
- El `deploy-image.sh` del host ejecuta el `activate.sh` de esa imagen. Ese script ve `target=pilot`, lee `/arca/pilot`
  y solo toca el proyecto `arca-pilot`.

**Secretos**

Van en `/arca/pilot`. Se cargan con `.\scripts\arca-pilot-secrets.ps1`, añadiendo `-CopyKeysFromProd` para reutilizar las
claves de Apify y OpenAI.

**Requisitos antes del primer despliegue**

1. El `cdk deploy` de `infra/aws` deja que el host lea `/arca/pilot` y que la rama `pilot` asuma el rol de GitHub. Antes,
   un administrador debe actualizar la política `ArcaCdkExecution`.
2. Los secretos, con el script de arriba.
3. El DNS en Vercel: registro A `api-pilot` → IP elástica del EC2.
4. Fusionar `feat/pilot-env` en `main`, porque el Caddyfile y el `compose.yaml` de producción cambian. Ese merge despliega
   producción: el proxy se une a `arca-edge` y aprende el sitio de pilot.
5. Recomendado: proteger la rama `pilot` como `main` (PR obligatorio), porque un push a `pilot` despliega en el mismo host.

**Memoria.** El EC2 tiene 4 GB. Producción no tiene límite; pilot tiene un tope de unos 1.7 GB en total. Después del
primer despliegue conviene mirar `docker stats`; si no alcanza, el siguiente tamaño es t3.large.

## Dev

No tiene back. El front, en la rama `dev`, construye en modo `demo` y responde a cada llamada desde
`lib/demo/recording.json`.

Cuando el back cambia, se vuelve a grabar:

1. En Arca-back, `npm run stack -- mock`.
2. En Arca-front, `npm run demo:record`.

## Contraseña de pilot y dev (front)

- El front lleva una protección Basic Auth: está en el middleware de Next (`proxy.ts` desde Next 16).
- Se activa solo si la variable de servidor `SITE_BASIC_AUTH` (`usuario:contraseña`) existe en ese despliegue.
- En Vercel se define solo para las ramas `pilot` y `dev`, nunca en Production.

## Contratos por entorno

El front instala `@arca/contracts` desde una release de GitHub:

- `dev` y `pilot` usan versiones previas (`contracts-v0.6.0-dev.N`).
- `main` usa la versión final (`contracts-v0.6.0`), que se publica al fusionar.
- El workflow `contracts-release.yml` acepta cualquier etiqueta `contracts-v*` cuyo número coincida con
  `packages/contracts/package.json`.
