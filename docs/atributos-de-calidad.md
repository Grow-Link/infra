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
| **Rendimiento y costo** | Misma pregunta, misma respuesta, una sola llamada a la IA | Caché de propuestas por hash · candado por clave · plazos máximos | Construido |
| **Observabilidad** | Se puede saber qué réplica atendió, seguir una petición entre servicios y consultar la salud | `X-Instancia` · `X-Request-Id` en logs · `/actuator/health` | Construido (cursos y usuarios) |
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
| **A4. ¿Está viva y lista esta réplica?** | **Estímulo:** el balanceador o Azure consultan la salud. **Respuesta:** `/actuator/health` responde `UP` sin credenciales y sin filtrar detalles; `/liveness` dice si el proceso vive y `/readiness` si puede atender (incluye la base de datos). **Evidencia:** `CalidadDeServicioTest` en cursos-service y usuarios-service. |

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

### Observabilidad

| Escenario | Detalle |
|---|---|
| **O1. ¿Qué réplica atendió esto?** | Cada respuesta trae `X-Instancia`, incluso las rechazadas (401/403). **Evidencia:** `InstanciaHeaderTest`. |
| **O2. Seguir una petición entre servicios** | nginx le pone a cada petición un `X-Request-Id` (el que mande el navegador se ignora); cada servicio lo respeta si es válido, lo muestra en cada línea del log (`[rid=...]`), lo devuelve en la respuesta y usuarios-service lo reenvía a cursos-service. Una búsqueda de ese id en los logs recorre toda la petición. **Evidencia:** `CalidadDeServicioTest` y `CursosServiceClientCalidadTest.laLlamadaLlevaElIdentificadorDeLaPeticionQueLaOrigino`. |

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

Las pruebas: `mvn test` en cada servicio (con `CLAUDE_API_KEY` vacía para no gastar la IA), `npm run humo` en
`infra/scripts/humo` y `infra/scripts/prueba-de-fuego.sh` (necesitan Docker).

---

## 4. Lo que sigue (propuestas, en orden de valor)

| Atributo | Propuesta | Por qué ahora o después |
|---|---|---|
| Seguridad | Exigir rol PUBLICADOR/ADMIN al publicar (S7) | Cierra el único hueco de autorización conocido; toca tests de varios archivos |
| Observabilidad | Lo mismo de `X-Request-Id` y salud en trivia-service | Hoy solo cursos y usuarios; trivia tiene trabajo en curso del equipo |
| Disponibilidad | Usar `/actuator/health/readiness` en los healthchecks de `docker-compose` y en el health check de Azure | Hoy el compose solo vigila las bases y RabbitMQ |
| Observabilidad | Métricas (Micrometer: latencia, tasa de errores, llamadas a la IA, aciertos de caché) | Permite medir los "response measure" de este documento en lugar de solo probarlos |
| Disponibilidad | Cortacircuitos para la IA (tras N fallos seguidos, ir directo al respaldo un rato) | Hoy cada petición espera el plazo completo si Claude está caído |
| Rendimiento | Prueba de carga (por ejemplo k6) con una meta numérica: p95 de `GET /api/roadmap/mio` | Convierte "rápido" en un número |
| Seguridad | Límite también por IP en el login | El login no tiene contraseña (es de demostración) |
| Usabilidad | Revisión de accesibilidad (contraste, teclado, lector de pantalla) | Ya hay etiquetas, falta medirlo |
