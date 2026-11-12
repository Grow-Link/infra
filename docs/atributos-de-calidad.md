# Atributos de calidad de GrowLink

Qué atributos de calidad tiene el sistema, **cómo se comprueba cada uno** y cuáles faltan. Cada atributo se describe con un
**escenario** (quién o qué lo pone a prueba, qué pasa, cómo debe responder el sistema y cómo se mide), la **táctica** de
arquitectura que lo sostiene, dónde está en el código y la **evidencia** (una prueba o un script que se puede correr).

Las decisiones de fondo están en [`adr/`](adr/). La parte del roadmap está explicada en
[`arquitectura-roadmap-catalogo-publicador.md`](arquitectura-roadmap-catalogo-publicador.md).

> Este documento se va ampliando: la columna "Estado" dice qué ya está construido y qué es una propuesta.

---

## 1. Resumen

| Atributo | Qué garantiza hoy | Táctica principal | Estado |
|---|---|---|---|
| **Disponibilidad** | Una réplica caída no tumba el servicio; si la IA o un servicio vecino falla, el resto sigue | Redundancia + reintento en otra réplica · degradación (respaldo de la IA) · plazos máximos · sondas de salud | Construido |
| **Escalabilidad** | Se agregan réplicas sin cambiar código | Servicios sin estado (JWT) · candados en la base y no en memoria · broker compartido (RabbitMQ) | Construido |
| **Seguridad** | Nadie actúa a nombre de otro; la IA no manda; el abuso tiene tope | Autenticación firmada (JWT) · autorización por dueño · validar todo lo que viene de la IA · límite de uso | Construido (falta rol al publicar) |
| **Rendimiento y costo** | Misma pregunta, misma respuesta, una sola llamada a la IA; tiempos medidos con carga | Caché de propuestas por hash · candado por clave · plazos máximos · pruebas de carga con metas (ADR-0013) | Construido (metas por confirmar en Azure) |
| **Observabilidad** | Se puede saber qué réplica atendió, seguir una petición entre servicios, consultar la salud y ver en tableros cómo está cada réplica, el negocio y los rechazos de seguridad | `X-Instancia` · `X-Request-Id` en logs JSON · `/actuator/health` · métricas con etiqueta `instancia` en Prometheus y tres tableros en Grafana (ADR-0009) | Construido en local (en Azure falta cómo llegan las métricas) |
| **Modificabilidad** | Cambiar de IA o agregar un área no toca el servicio | Estrategia (`RoadmapAiClient`) · capas · catálogo derivado de la base | Construido |
| **Testabilidad** | Todo lo importante se prueba sin internet ni gastar IA | IA falsa · reloj inyectable · servidor de mentira · bases en memoria | Construido |
| **Usabilidad** | Pantallas con lo esencial, mensajes que dicen qué hacer | Divulgación progresiva · errores en lenguaje de la persona | Construido |
| **Interoperabilidad** | Los servicios se hablan por contratos claros | REST/JSON · OpenAPI · JWT compartido · endpoints de contrato | Construido |

---

## 2. Escenarios

### Disponibilidad

| Escenario | Detalle |
|---|---|
| **A1. Se cae una réplica** | **Estímulo:** una réplica de cursos, usuarios o trivia deja de responder. **Entorno:** operación normal con varias réplicas. **Respuesta:** nginx deja de mandarle tráfico y reintenta la petición en otra (`proxy_next_upstream`, `proxy_connect_timeout 2s`). **Medida:** ninguna petición falla. **Evidencia:** `infra/scripts/prueba-de-fuego.sh` (mata una réplica de cada servicio con `docker kill`). |
| **A2. La IA no responde o responde mal** | **Estímulo:** Claude se cae, tarda, devuelve un curso inventado o se pasa del tiempo. **Respuesta:** se usa el algoritmo de respaldo; el roadmap sale igual y dice quién lo armó. **Medida:** 200/201 con `generadoPor = RESPALDO`, nunca un error ni una ruta inventada. **Evidencia:** `RoadmapRestriccionTest` (IA falsa que falla, inventa o se pasa). |
| **A3. cursos-service se cuelga** | **Estímulo:** cursos-service no cae pero deja de contestar. **Respuesta:** usuarios-service lo espera como máximo 2 s para conectar y 3 s para leer (configurable) y sigue sin su respuesta: el Home muestra "sin roadmap" y el jardín una lista vacía. **Medida:** la pantalla responde en menos de unos pocos segundos en vez de quedarse esperando. **Evidencia:** `CursosServiceClientCalidadTest` (un servidor de verdad que tarda más que el plazo). |
| **A4. ¿Está viva y lista esta réplica?** | **Estímulo:** el balanceador o Azure consultan la salud. **Respuesta:** `/actuator/health` responde `UP` sin credenciales y sin filtrar detalles; `/liveness` dice si el proceso vive y `/readiness` si puede atender (incluye la base de datos; `liveness` no, a propósito). **Medida:** con la base caída, `/readiness` responde 503 y `/liveness` sigue en 200. **Evidencia:** `CalidadDeServicioTest` en cursos-service y usuarios-service, y `ReadinessConLaBaseDeDatosTest` en los tres (cierra el pool de conexiones de verdad). **Quién la consulta:** `docker-compose` (`healthcheck` de los tres servicios, visible como `(healthy)` en `docker compose ps`), `levantar.sh` (espera esta sonda antes de subir más réplicas) y el health check de Azure (ver el README de `infra`, paso 8). |
| **A5. Arrancar varias réplicas sin duplicar los datos de prueba** | **Estímulo:** `levantar.sh` sube la primera réplica y debe esperar a que termine de crear los datos de prueba antes de subir las demás. **Respuesta:** espera la sonda `/readiness`, que Spring solo marca lista **después** de los `CommandLineRunner`, y no cualquier ruta que ya conteste. **Medida:** medido en cursos-service, una ruta cualquiera respondía a los 11,48 s y `/readiness` recién dio 200 a los 11,89 s, cuando terminó de sembrar: esa ventana es la que duplicaba datos. |
| **A6. Se cae una réplica bajo carga: cuánto tarda en recuperarse** | **Estímulo:** con `npm run http` mandando una tasa constante, se apaga una réplica. **Respuesta:** el balanceador deja de mandarle tráfico. **Medida:** la *ventana de fallas* que dice el script (del primer al último segundo con fallas); meta inicial: ninguna falla después de 60 s al apagar 1 de 3 instancias (ADR-0013). **Evidencia:** `infra/scripts/carga/carga-http.mjs`; en local, apagando trivia-service a mitad de la prueba, la línea de tiempo marca el segundo exacto en que empiezan las fallas. |

### Escalabilidad

| Escenario | Detalle |
|---|---|
| **E1. Subir de 2 a N réplicas** | **Estímulo:** más personas de las que atiende una réplica. **Respuesta:** se agregan réplicas; cualquiera atiende cualquier petición porque la sesión es un JWT y el estado vive en la base. **Medida:** sin cambios de código. **Evidencia:** `infra/scripts/humo` (seis jugadores a la vez por WebSocket pasando por el balanceador) y las pruebas de concurrencia de cada servicio. |
| **E2. Cinco peticiones iguales a la vez** | **Respuesta:** una sola llamada a la IA. **Evidencia:** `RoadmapRestriccionTest.dosPeticionesIgualesALaVezLeCuestanUnaSolaLlamadaALaIa`. **Límite conocido:** el candado es por réplica; entre réplicas lo evita la restricción de unicidad de la base (no se guarda dos veces, aunque podría gastarse una llamada de más). |
| **E3. WebSocket con varias réplicas** | Un mensaje que sale por una réplica llega a los jugadores de otra: broker compartido RabbitMQ (`TRIVIA_BROKER_RELAY_ENABLED`). |

### Seguridad

| Escenario | Detalle |
|---|---|
| **S1. Alguien intenta actuar a nombre de otro** | **Estímulo:** un usuario manda el `usuarioId` de otra persona. **Respuesta:** 403; el `usuarioId` del cuerpo no se le cree (`AuthenticatedUser.exigirPropio`); el ADMIN sí puede. **Evidencia:** `RoadmapRestriccionTest.nadieGeneraNiLeeNiCompletaALaVozDeOtroUsuario`. |
| **S2. Texto malicioso en la meta ("ignora lo anterior…")** | **Respuesta:** la meta se limpia, va entre etiquetas `<meta>` como dato y el prompt dice que no son instrucciones; además se valida que sea una frase (`MetaValidator`). **Evidencia:** `CatalogoYRoadmapRealTest.unaMetaSinSentidoSeRechazaConUnMensajeClaro`. |
| **S3. La IA devuelve algo que no existe** | La IA propone, el servidor valida (`esPropuestaValida`): ids del catálogo activo, sin repetir, en orden de prerrequisitos. **Evidencia:** `RoadmapRestriccionTest`. |
| **S4. El examen filtra las respuestas** | Se califica en el servidor y las preguntas nunca traen la correcta. **Evidencia:** `CatalogoYRoadmapRealTest.elExamenNoRegalaLasRespuestasYSeCalificaEnElServidor`. |
| **S5. Alguien pide roadmaps sin parar** | **Estímulo:** un script o un clic repetido pide cientos de roadmaps. **Respuesta:** tras 10 en 10 minutos por persona responde `429` con `Retry-After` y un mensaje que dice cuánto esperar; las demás personas no se enteran. **Medida:** a lo más 10 llamadas a la IA por persona y ventana. **Evidencia:** `LimiteDeGeneracionesTest` (con reloj simulado) y `CalidadDeServicioTest.pedirRoadmapsSinParar…`. |
| **S6. La salud o las cabeceras filtran información** | `/actuator/health` no muestra componentes ni versiones y no se exponen `env`, `beans` ni `heapdump`; un `X-Request-Id` sospechoso (largo, con símbolos) se reemplaza en vez de copiarse al log. **Evidencia:** `CalidadDeServicioTest`. |
| **S7. (Pendiente) Un usuario normal publica un curso llamando al API** | Hoy solo se exige ser el dueño del `publicadorUsuarioId` (o ADMIN); lo que lo impide es que el front no muestra esa pantalla. **Propuesta:** exigir el rol PUBLICADOR o ADMIN en `POST /api/cursos` y `sugerir-prerequisitos`. Obliga a actualizar los tokens de prueba de 8 archivos de test. |

### Rendimiento y costo

| Escenario | Detalle |
|---|---|
| **R1. La misma meta, las mismas áreas, el mismo catálogo** | **Respuesta:** se reutiliza la propuesta validada de la IA: instantánea y sin gastar una llamada. **Medida:** 5 pruebas seguidas = 1 llamada. La clave incluye el catálogo completo: si cambia un curso, se vuelve a preguntar. **Evidencia:** `laMismaEntradaNoVuelveAPreguntarleALaIaYDaLaMismaRuta`. |
| **R2. Una llamada a la IA que tarda** | Plazo de 5 s para conectar y 90 s para leer; pasado eso se usa el respaldo. |
| **R3. Costo bajo control** | Caché (R1) + candado por clave (E2) + límite por persona (S5). |
| **R4. Carga HTTP constante** | **Estímulo:** 20 peticiones por segundo de lectura contra los tres servicios (`npm run http`, tasa constante de verdad). **Medida:** meta inicial p95 ≤ 500 ms y ≤ 1 % de fallas con 1 instancia, y lo mismo al triple de tasa con 3 instancias. **Línea base local** (una réplica, H2): p95 40 ms, sin fallas. **Evidencia:** `infra/scripts/carga`, ADR-0013. |
| **R5. Cien personas jugando trivia a la vez** | **Estímulo:** partidas completas por WebSocket con 10, 25, 50, 75 y 100 jugadores (`npm run trivia`). **Medida:** ida y vuelta de una respuesta (hasta `RESPUESTA_REGISTRADA`): meta inicial p95 ≤ 300 ms con 100 jugadores y ≤ 1 % sin resultados. **Línea base local:** p50 12 ms, p95 26 ms, p99 39 ms, sin errores. **Para qué:** la etapa donde crece el p95 señala el cuello de botella. **Hallazgo:** con el ritmo de una persona no hay cuello hasta 400 jugadores; si todos contestan a la vez, el p95 crece en línea recta (356 ms con 400; 271 ms con 100 en una instancia de 1 vCPU) por el trabajo por respuesta y el pool de conexiones, y en salas de 50 cada confirmación a toda la sala retrasa la siguiente pregunta. Ver el README de trivia-service. |

### Observabilidad

| Escenario | Detalle |
|---|---|
| **O1. ¿Qué réplica atendió esto?** | Cada respuesta trae `X-Instancia`, incluso las rechazadas (401/403). **Evidencia:** `InstanciaHeaderTest`. |
| **O2. Seguir una petición entre servicios** | nginx le pone a cada petición un `X-Request-Id` (el que mande el navegador se ignora); cada servicio lo respeta si es válido, lo muestra en cada línea del log (`[rid=...]`), lo devuelve en la respuesta y usuarios-service lo reenvía a cursos-service. Una búsqueda de ese id en los logs recorre toda la petición. **Evidencia:** `CalidadDeServicioTest` y `CursosServiceClientCalidadTest.laLlamadaLlevaElIdentificadorDeLaPeticionQueLaOrigino`. |
| **O3. ¿Cuánto resuelve la IA y cuánto el respaldo? ¿Sirve la caché?** | **Estímulo:** alguien (el equipo, el profe) quiere saber cómo se comporta el roadmap en la práctica. **Respuesta:** cinco medidas en `/actuator/metrics` (solo ADMIN): `growlink.roadmap.generaciones{fuente}`, `.cache{resultado}`, `.ia.llamadas{resultado}` con su `.ia.duracion`, `.ia.propuestas{resultado}` y `.limite.rechazos`. **Medida:** convierte los "response measure" de este documento en números: porcentaje de roadmaps armados por la IA, tasa de aciertos de la caché, cuánto de lo que propone la IA rechaza el servidor, tiempo de las llamadas. **Evidencia:** `MetricasDeRoadmapTest` (provoca cada resultado con una IA falsa y comprueba que se cuenta una sola vez; y que sin ser ADMIN no se ve). Cuentan por réplica. |
| **O4. ¿Está mal una réplica? ¿Reparte bien el balanceador?** | **Estímulo:** alguien abre el tablero *Técnico por instancia* (Grafana, http://localhost:3001). **Respuesta:** por servicio y réplica, si responde, peticiones por segundo, p95, errores 5xx, CPU, memoria, conexiones a la base en uso y esperando, WebSockets. **Medida:** una réplica caída sale en `up = 0` en segundos; una que se queda con todo el tráfico se ve en el reparto. **Evidencia:** ADR-0009; las 40 consultas de los tres tableros probadas contra un Prometheus de verdad. |
| **O5. ¿Alguien está probando la puerta?** | **Estímulo:** tokens inválidos, pedidos de ADMIN, abuso del tope por IP. **Respuesta:** el tablero *Eventos de seguridad* muestra 401, 403 y 429 por servicio, réplica y ruta, y cada uno deja una línea en el log JSON con su `rid`. **Evidencia:** ADR-0011 y ADR-0009. |

### Modificabilidad, testabilidad, usabilidad, interoperabilidad

| Atributo | Cómo se logra | Dónde |
|---|---|---|
| Modificabilidad | Cambiar de IA (o probar sin llave) es cambiar una implementación de `RoadmapAiClient`; las áreas y el catálogo salen de la base, no de listas escritas a mano | `RoadmapAiClient`, `CursoService.resumenAreas` |
| Testabilidad | IA falsa que contesta lo que cada prueba necesita; reloj inyectable en `LimiteDeGeneraciones`; `MockRestServiceServer` y un servidor del JDK para las llamadas entre servicios; bases en memoria | `RoadmapRestriccionTest`, `LimiteDeGeneracionesTest`, `CursosServiceClientCalidadTest` |
| Usabilidad | Una pantalla del roadmap con lo esencial a la vista y el resto a un toque (menú Opciones, logros plegados, panel con secciones); los errores explican qué hacer ("Espera 7 minutos…", "Con tu tiempo disponible…") | `RoadmapPage`, `NodePanel`, `AventuraHud` |
| Interoperabilidad | REST/JSON con OpenAPI (Swagger); el mismo JWT sirve en todos los servicios; contratos explícitos entre servicios (`GET /api/roadmap/completados`) que no se cambian sin avisar | `SecurityConfig`, `RoadmapController` |

---

## 3. Cómo comprobarlo en vivo (para la sustentación)

Con los servicios corriendo (`infra/scripts/demo-sin-docker.ps1`):

```bash
curl -i http://localhost:8086/actuator/health            # salud: UP, sin detalles
curl -i http://localhost:8086/actuator/health/readiness  # lista para atender (incluye la base)
curl -i http://localhost:8086/api/cursos                 # 403, y aun así trae X-Request-Id y X-Instancia
curl -i -H "X-Request-Id: mi-prueba-12345" http://localhost:8080/actuator/health   # respeta el id
```

Para ver el límite sin esperar, arrancar cursos-service con `ROADMAP_LIMITE_GENERACIONES=2` y pedir tres roadmaps
seguidos con la misma persona: el tercero responde `429` con `Retry-After`.

Para ver las métricas (hace falta el token de un ADMIN, por ejemplo el de Carla en el login de demostración):

```bash
curl -s -H "Authorization: Bearer $TOKEN_ADMIN" http://localhost:8086/actuator/metrics | grep growlink      # la lista
curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "http://localhost:8086/actuator/metrics/growlink.roadmap.generaciones?tag=fuente:RESPALDO"
curl -s -H "Authorization: Bearer $TOKEN_ADMIN" "http://localhost:8086/actuator/metrics/growlink.roadmap.cache?tag=resultado:acierto"
curl -i http://localhost:8086/actuator/metrics                                                              # sin token: 403
```

Para el chequeo de salud con Docker: `docker compose ps` (columna STATUS) y
`curl http://localhost:3000/api-cursos/actuator/health/readiness`.

Las pruebas: `mvn test` en cada servicio (con `CLAUDE_API_KEY` vacía para no gastar la IA), `npm run humo` en
`infra/scripts/humo` y `infra/scripts/prueba-de-fuego.sh` (necesitan Docker).

Los tableros: con el compose levantado, http://localhost:3001 (sin iniciar sesión). Las pruebas de carga, en
`infra/scripts/carga` con `AUTH_MODE=legacy` y `LIMITE_IP_MAXIMO_POR_MINUTO=0` en el ambiente que se prueba:
`npm run http` (tasa constante, con la ventana de fallas si se apaga una réplica) y `npm run trivia` (de 10 a 100
jugadores, con p50, p95 y p99 por etapa).

---

## 4. Lo que sigue (propuestas, en orden de valor)

| Atributo | Propuesta | Por qué ahora o después |
|---|---|---|
| Seguridad | Exigir rol PUBLICADOR/ADMIN al publicar (S7) | Cierra el único hueco de autorización conocido; toca tests de varios archivos |
| Observabilidad | Lo mismo de `X-Request-Id`, salud (y su healthcheck) en trivia-service | Hoy solo cursos y usuarios; trivia tiene trabajo en curso del equipo |
| Observabilidad | Que las métricas lleguen a un tablero también en Azure (cada instancia empujándolas a un Prometheus administrado, ADR-0009) y una métrica de cuántas veces el Home degradó por un cursos-service lento | En local ya hay tablero; en Azure, desde afuera no se puede raspar cada instancia |
| Disponibilidad | Cortacircuitos para la IA (tras N fallos seguidos, ir directo al respaldo un rato) | Hoy cada petición espera el plazo completo si Claude está caído |
| Rendimiento | Correr las pruebas de carga en Azure con 1 y 3 instancias y confirmar (o ajustar) las metas iniciales del ADR-0013 | Los scripts ya existen; falta el ambiente |
| Seguridad | Límite también por IP en el login | El login no tiene contraseña (es de demostración) |
| Usabilidad | Revisión de accesibilidad (contraste, teclado, lector de pantalla) | Ya hay etiquetas, falta medirlo |
