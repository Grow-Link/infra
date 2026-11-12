# 0009. Métricas con Prometheus, protegidas con un token, y tres tableros en Grafana

**Estado:** vigente en local (docker-compose); en Azure falta decidir cómo llegan las métricas (ver Consecuencias) ·
**Atributos:** observabilidad, seguridad, disponibilidad

**Contexto.** Los tres servicios ya contaban cosas con Micrometer: sesiones, cursos completados, el roadmap y la IA,
la trivia y los eventos de seguridad (0006, 0011). Pero cada contador vivía en la memoria de una réplica y se leía
con `curl`: cursos-service solo para un ADMIN, usuarios-service no los publicaba, y trivia-service los publicaba en
`/actuator/prometheus` **abierto a cualquiera** (el nginx del front reenvía `/api-trivia/**`, así que se leían desde
el navegador: rutas, volumen de tráfico, memoria). Con varias réplicas detrás del balanceador, para saber si una está
mal, cuánto tráfico le toca a cada una o cuántas sesiones empiezan en total, hace falta juntar todo en un solo lugar
y mirarlo en el tiempo.

**Decisión.**
- **Formato y recolección.** Los tres servicios publican `/actuator/prometheus` (`micrometer-registry-prometheus`) y
  Prometheus los raspa cada 5 s. En el docker-compose descubre **cada réplica** por el DNS de Docker
  (`dns_sd_configs`): una réplica nueva entra sola y una caída aparece como `up = 0`
  (`observabilidad/prometheus/prometheus.yml`).
- **Etiqueta `instancia` en todas las métricas** (`MetricsConfig` en cada servicio): `WEBSITE_INSTANCE_ID` en Azure
  App Service y, si no viene, el nombre del host, que es lo mismo que la cabecera `X-Instancia`. Sin ella Prometheus
  suma las réplicas y no se ve cuál está mal.
- **Latencia con cubetas fijas.** `http.server.requests` lleva 10 cubetas (10 ms a 10 s,
  `management.metrics.distribution.slo`) y no el histograma completo de Micrometer: alcanza para un p95 por réplica
  en el tablero sin multiplicar las series por cada ruta y cada réplica. El percentil exacto de una prueba lo dan los
  scripts de carga (0013).
- **El endpoint solo contesta con el token del scrape**, en la cabecera `X-Metricas-Token` (`METRICAS_TOKEN`, el
  mismo en los tres servicios y en Prometheus). Sin token configurado queda **cerrado**, no abierto; un token de menos
  de 16 caracteres no deja arrancar. Es una cabecera propia y no `Authorization` porque en modo `oidc` ahí va el token
  de Microsoft y los filtros de usuarios y cursos lo rechazarían como tal. En usuarios y cursos la regla está en la
  cadena de Spring Security (ni un ADMIN entra con su token); en trivia, que no tiene cadena de seguridad, la pone un
  filtro que reconoce la ruta con el mismo analizador que Spring MVC (si comparara el texto, `/actuator/prometheus;x=1`
  pasaría de largo y el endpoint igual contestaría). Prometheus manda el token desde un archivo
  (`http_headers.files`) que arma el arranque del contenedor con la variable: no queda escrito en el repo.
- **Tres tableros en Grafana**, aprovisionados desde JSON del repo junto con la fuente de datos
  (`observabilidad/grafana`):
  - **Negocio**: sesiones iniciadas (por modo), cursos completados (por área y por vía), roadmaps por quién los armó
    (IA o respaldo), salas, partidas y jugadores de trivia, y quién está conectado ahora.
  - **Técnico por instancia** (filtrable por servicio y réplica): réplicas que responden, tiempo arriba, peticiones
    por segundo, latencia p95 y media, errores 5xx, reparto del tráfico, CPU, memoria, conexiones a la base en uso y
    **esperando**, hilos y WebSockets abiertos por réplica.
  - **Eventos de seguridad**: 401, 403 y 429 por servicio, por réplica y por ruta, y los contadores propios de 0011.
  Se ven sin iniciar sesión (solo lectura) y editarlos pide el admin; Prometheus y Grafana solo escuchan en
  `127.0.0.1`, porque la interfaz de Prometheus no pide credenciales.

**Consecuencias.**
- (+) Una réplica que se cae, que se queda con todo el tráfico o que se pone lenta se ve sin entrar a ninguna, y una
  prueba de carga (0013) se ve mientras corre, con el recurso que se satura.
- (+) El mismo formato, la misma etiqueta y el mismo token en los tres servicios: un tablero suma o separa réplicas y
  servicios sin casos especiales.
- (+) Las métricas dejaron de ser públicas en trivia-service.
- (−) Un secreto compartido más, que hay que poner igual en cuatro lugares (tres servicios y Prometheus) y proteger.
- (−) Los contadores viven en memoria y se reinician con cada arranque. Prometheus compensa los reinicios en
  `increase()` y `rate()`, pero un contador que nace con su primer evento (por ejemplo `growlink.roadmap.generaciones`)
  pierde ese primero. Los de sesiones, cursos completados y trivia se registran desde el arranque, en 0.
- (−) El p95 del tablero es aproximado: se interpola dentro de la cubeta.
- (−) **En Azure App Service este modelo no funciona tal cual.** Desde afuera, la URL del servicio cae en la
  instancia que elija el balanceador, así que un Prometheus no puede raspar cada instancia por separado. Pendiente:
  que cada instancia **empuje** sus métricas (Micrometer con OTLP hacia un colector que escriba en un Prometheus
  administrado, por ejemplo Azure Monitor managed Prometheus, leído con PromQL desde Azure Managed Grafana). Como la
  etiqueta `instancia` viaja en cada métrica, los mismos tableros servirían sin cambios.
- (−) En Azure la etiqueta `instancia` (`WEBSITE_INSTANCE_ID`) no es el mismo valor que `X-Instancia` y el campo
  `instancia` de los logs (el nombre del contenedor). En local coinciden.
