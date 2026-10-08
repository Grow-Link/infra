# GrowLink - infra

Aqui vive todo lo que hace falta para correr y desplegar GrowLink completo:
el `docker-compose.yml` para levantar todo en local, los scripts, y la guia
de como se despliega a Azure. El codigo de cada parte esta en su propio repo.

## Si eres nueva en el proyecto (empieza aqui)

1. Clona los cinco repos **en la misma carpeta** (el compose y los scripts esperan que
   esten uno al lado del otro):
   `usuarios-service`, `cursos-service`, `trivia-service`, `GrowLink-FRONTEND` e `infra`,
   todos de la organizacion `Grow-Link` en GitHub. Todo el trabajo esta en la rama `main`.
2. Escoge como correrlo (mas detalle abajo, en "Correr todo en local"):
   - **Sin Docker** (lo mas rapido): `.\infra\scripts\demo-sin-docker.ps1` desde la carpeta
     que contiene los repos. Hace falta Java 21, Maven y Node 22.
   - **Con Docker** (con replicas y balanceo): `cp .env.example .env` y `./scripts/levantar.sh`
     desde Git Bash, dentro de `infra`.
3. Para que el roadmap use la IA de verdad hace falta una llave de la API de Claude
   (ver la siguiente seccion). Sin llave todo funciona igual, pero en modo de respaldo.

### La llave de Claude

Cada persona que corra el proyecto con IA necesita **una llave de API** (se crea en la consola de
desarrolladores de Anthropic; es un cobro por uso aparte de Claude Pro, con saldo prepagado, y un
roadmap cuesta unos centavos de dolar). Reglas para no tener problemas:

- La llave **nunca va en un archivo que se suba a git**, ni en el codigo, ni en un chat. Si hay que
  compartir una, que sea por un canal privado. Cada una puede crear la suya.
- Donde se pone, segun como corras el proyecto:

| Como lo corres | Donde va la llave |
|---|---|
| Sin Docker (Windows) | Variable de usuario, una sola vez: `[Environment]::SetEnvironmentVariable('CLAUDE_API_KEY', 'tu-llave', 'User')` |
| Con Docker | En `infra/.env`, en la linea `CLAUDE_API_KEY=` (el `.env` esta ignorado por git) |
| Azure | Variable de entorno `CLAUDE_API_KEY` de la app de `cursos-service` |

- Al levantar, tanto `demo-sin-docker.ps1` como `levantar.sh` dicen en la primera linea si la
  IA quedo **ACTIVADA** o **SIN LLAVE**. Si dice sin llave y acabas de guardar la variable de Windows,
  abre una terminal nueva (las ventanas ya abiertas no ven variables recien guardadas).
- Para saber como se genero un roadmap, mira el texto verde de la pantalla Roadmap: dice
  "generado por IA" o "modo de respaldo (sin IA)". Si cae al respaldo con llave puesta, el log de
  `cursos-service` dice el motivo (saldo, llave invalida, etc.).

## Como esta armado

```mermaid
flowchart LR
    U([Navegador]) --> F["Front + nginx<br/>entrada unica"]
    F -->|/api-usuarios| US[usuarios-service]
    F -->|/api-cursos| CS[cursos-service]
    F -->|/api-trivia y /ws-trivia| TS[trivia-service]
    TS <-->|mensajes en vivo entre replicas| MQ{{RabbitMQ}}
    US --> DBU[(Postgres usuarios)]
    CS --> DBC[(Postgres cursos)]
    TS --> DBT[(Postgres trivia)]
    TS -->|suma trivia ganada| US
    TS -->|categorias del publicador| CS
    US -->|estado del roadmap| CS
    CS -->|roadmap y prerequisitos con IA| CL([API de Claude])
```

Son 3 microservicios, cada uno con su propia base de datos, mas el front. Los
tres validan el mismo JWT, que firma usuarios-service. Los llamados entre
servicios que no vienen de un usuario (trivia avisando una victoria) se
identifican con una llave interna.

| Repo | Que hace |
|---|---|
| `usuarios-service` | Login, perfil, home segun el rol, contador de trivias ganadas |
| `cursos-service` | Cursos, prerequisitos, habilidades, completados y roadmap con IA |
| `trivia-service` | Salas de trivia en tiempo real (WebSocket), preguntas, metricas para el admin |
| `GrowLink-FRONTEND` | La app web, con nginx como entrada unica |
| `infra` | Este repo |

## Ramas y ambientes

Todos los repos tienen las mismas tres ramas. Cada rama se despliega sola a su
propio ambiente, asi se pueden tener desplegadas las tres versiones a la vez, o
desplegar solo la que toque.

| Rama | Ambiente de GitHub | Que es |
|---|---|---|
| `main` | `actual` | Lo que tenemos ahora |
| `avance` | `avance` | El avance intermedio |
| `final` | `final` | La entrega final |

- Cada vez que se sube algo a una de esas ramas, `ci.yml` corre las pruebas y
  `cd.yml` despliega al ambiente de esa rama (si las pruebas pasan).
- `cd.yml` tambien se puede correr a mano desde la pestana Actions
  (workflow_dispatch) para volver a desplegar sin cambiar nada.
- Para pasar una version a la siguiente: `git checkout avance && git merge main`
  y subir. Lo que no se mezcla se queda como esta, asi que `main` nunca cambia
  hasta que alguien decida cambiarlo.

## Correr todo en local

### Sin Docker (lo mas rapido, para probar y hacer demos)

Desde la carpeta `Growlink`, en PowerShell:

```powershell
.\infra\scripts\demo-sin-docker.ps1
```

Levanta los tres servicios (con las bases de datos en memoria) y el front, y abre
http://localhost:5173. Hace falta Java 21, Maven y Node 22. Se apaga con
`.\infra\scripts\demo-sin-docker.ps1 -Parar`. Como las bases viven en memoria, al
apagar se pierde lo que se haya hecho (los usuarios y cursos de prueba se vuelven a
crear solos). Con `CLAUDE_API_KEY` puesta en el entorno, el roadmap usa la IA real.

### Con Docker

Hace falta Docker. Los repos tienen que estar uno al lado del otro, como estan
en la carpeta `Growlink`.

```bash
cp .env.example .env       # y cambiar los secretos del .env
./scripts/levantar.sh
```

Abrir http://localhost:3000 y entrar con uno de los tres usuarios de prueba.

`levantar.sh` arranca primero una replica de cada servicio y despues sube las
demas. No es capricho: cada servicio, al arrancar sobre una base vacia, mete sus
datos de prueba si todavia no hay nada, y si varias replicas arrancan al mismo
tiempo todas ven la base vacia y los datos se duplican.

Para construir una version distinta, cambiar de rama en todos los repos a la vez:

```bash
./scripts/cambiar-rama.sh avance
./scripts/levantar.sh
```

El script no cambia nada si algun repo tiene cambios sin guardar.

## Balanceo y disponibilidad

En esta rama cada servicio corre con varias replicas (usuarios 2, cursos 2,
trivia 3, se cambia en el `.env`).

- **Reparto de carga**: nginx (el del front) resuelve el nombre de cada servicio
  en cada peticion y reparte entre todas las replicas. Si una no contesta, la
  peticion se reintenta en otra. Cada respuesta trae el header `X-Instancia` con
  la replica que la atendio, asi se ve el balanceo con `curl -i`.
- **Los servicios no guardan nada en memoria**: la sesion es un JWT que cualquier
  replica puede validar, y el estado de las salas y las partidas esta en la
  base de datos. Por eso cualquier replica atiende cualquier peticion.
- **Concurrencia entre replicas**: lo que ya protegia a los servicios dentro de
  una sola instancia (UPDATE atomico para iniciar la partida y para marcar al
  primer acertante, lock de fila al responder, suma atomica de trivias ganadas)
  funciona igual entre replicas, porque el candado es de la base de datos y no
  de la memoria de cada proceso.
- **WebSocket de la trivia**: con una sola instancia el broker de mensajes vive en
  memoria. Con varias, un mensaje que sale por una replica no le llega a los
  jugadores conectados a otra. Por eso en esta rama trivia usa RabbitMQ como
  broker compartido (relay STOMP). Se prende con `TRIVIA_BROKER_RELAY_ENABLED`.

### Prueba de humo

```bash
cd scripts/humo
npm install
npm run humo
```

Recorre el sistema de punta a punta contra los servicios de verdad (hace falta
Node 22 o mas nuevo): login, que el token de usuarios sirva en cursos y trivia, que
un admin pueda dar de baja un curso ajeno, roadmap y Home, una partida de trivia
completa con dos jugadores por WebSocket, y que lo que deja la partida llegue a
los otros servicios (trivia ganada en el perfil, metricas en el dashboard).
Funciona igual contra los servicios directos (por defecto) que contra el compose
completo: ver las variables `URL_*` al principio de `humo.mjs`.

### Prueba de fuego

```bash
./scripts/prueba-de-fuego.sh
```

Para cada servicio manda peticiones y cuenta que replica atiende cada una, mata
una replica con `docker kill`, vuelve a mandar peticiones para comprobar que
ninguna falle, y la levanta otra vez. Es la demostracion de disponibilidad y
balanceo. Para verlo en vivo con una partida: abrir una sala con dos navegadores,
y mientras se juega correr `docker kill` sobre una replica de trivia
(`docker compose ps trivia-service` para ver cuales hay).

## Desplegar en Azure

Se repite para cada ambiente (`actual`, `avance`, `final`). Servicio recomendado
por el profe: **App Service**, porque ya viene hecho para desplegar y trae el
escalado y el balanceador incluidos.

1. **Grupo de recursos**: `growlink-<ambiente>`.
2. **Base de datos**: un Azure Database for PostgreSQL Flexible Server con tres
   bases: `growlink`, `cursos` y `trivia`. Permitir el acceso desde los
   servicios de Azure.
3. **Plan de App Service** (Linux).
4. **Cuatro Web Apps**:
   - `usuarios`, `cursos` y `trivia`: runtime **Java 21 (Java SE)**.
   - `front`: **contenedor** (la imagen la sube el workflow a GitHub Container
     Registry, `ghcr.io/grow-link/growlink-frontend:<rama>`; mas facil si el
     paquete es publico).
5. **Variables de cada Web App** (Settings > Environment variables), estan en el
   README de cada repo. Las que se repiten:
   - `GROWLINK_JWT_SECRET`: el mismo en las tres.
   - `GROWLINK_INTERNAL_KEY`: la misma en usuarios y trivia.
   - `PORT` y `WEBSITES_PORT`: poner las dos con el puerto del servicio
     (usuarios 8080, cursos 8086, trivia 8085, front solo `WEBSITES_PORT=80`).
   - `CLAUDE_API_KEY` en cursos para el roadmap con IA.
6. **Front**: `USUARIOS_URL`, `CURSOS_URL` y `TRIVIA_URL` con las direcciones
   `https://...azurewebsites.net` de cada servicio, y `DNS_RESOLVER=168.63.129.16`.
7. **trivia**: prender **Web sockets** (Configuration > General settings).
   Para escalar a mas de una instancia hace falta un broker compartido:
   `TRIVIA_BROKER_RELAY_ENABLED=true` y `TRIVIA_BROKER_RELAY_HOST`, `_PORT`,
   `_USERNAME`, `_PASSWORD` apuntando a un RabbitMQ con el plugin STOMP
   (en Azure no hay uno administrado, se puede correr en un Azure Container
   Instance con la imagen `rabbitmq:3.13-management-alpine` y el plugin
   `rabbitmq_stomp`, o usar un servicio como CloudAMQP).
   Con el broker listo, subir el numero de instancias en el plan (Scale out) y
   App Service reparte la carga solo. La primera vez dejar una sola instancia hasta
   que arranquen los servicios, para que no se dupliquen los datos de prueba.
8. **GitHub**: en cada repo, Settings > Environments, crear `actual`, `avance` y
   `final`. En cada ambiente:
   - variable `AZURE_WEBAPP_NAME` con el nombre de la Web App de ese ambiente.
   - secreto `AZURE_WEBAPP_PUBLISH_PROFILE` con el contenido del archivo que se
     baja de la Web App (Overview > Get publish profile).
9. Hacer push a la rama y mirar la pestana Actions.

## Que falta confirmar

**Probado de verdad (en una maquina con Docker):**
- `./scripts/levantar.sh` con las replicas (usuarios 2, cursos 2, trivia 3), RabbitMQ y el nginx del front.
- La prueba de humo (`scripts/humo`) a traves del nginx: login, roles entre servicios, roadmap generado
  por la IA real de Claude, y una partida de trivia completa por WebSocket pasando por el RabbitMQ.
- `./scripts/prueba-de-fuego.sh`: se tumba una replica de cada servicio y ninguna peticion falla.
- Las pruebas de cada servicio (incluyendo las de concurrencia con hilos reales) y que el front compile.

Correr todo esto de verdad encontro cuatro errores que las pruebas automaticas no veian, todos ya
corregidos: el nginx del front tenia una directiva repetida y un `set` despues de un `rewrite`
(no arrancaba / no encontraba el servicio), RabbitMQ rechazaba los destinos `/topic/salas/CODIGO`
(ahora son `/topic/salas.CODIGO`), y el servidor avisaba a los jugadores antes de confirmar el
guardado en la base de datos (ahora avisa despues), lo que con replicas hacia que la respuesta de un
jugador llegara a una replica que aun no veia la pregunta.

**Sin probar:** el despliegue a Azure (los workflows `cd.yml` y la configuracion de las App Service)
no se ha corrido, porque hace falta una suscripcion de Azure. Si falla, lo mas probable es un nombre
de variable o un puerto, y se arregla en la configuracion de la Web App sin tocar el codigo.
Tampoco se probo que una partida en curso sobreviva a la caida de la replica a la que estaban
conectados los jugadores (el estado esta en la base de datos, pero el reconectar del front no se verifico).
