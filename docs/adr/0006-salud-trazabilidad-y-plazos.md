# 0006. Salud consultable, identificador por petición y plazos en las llamadas entre servicios

**Estado:** vigente en los tres servicios (trivia-service se sumó después) · **Atributos:** disponibilidad,
observabilidad, seguridad

**Contexto.** Con varias réplicas y servicios que se llaman entre sí hacían falta tres cosas: saber si una réplica sirve
sin entrar con credenciales, seguir una misma petición por varios servicios en los logs, y que un servicio que se cuelga
(no que cae) no arrastre a los que lo llaman. Además, la IA cuesta dinero por llamada.

**Decisión.**
- **Salud:** Spring Boot Actuator con solo `health` (sin detalles) y sus sondas `liveness` y `readiness`. `readiness`
  incluye la base de datos (una réplica sin base deja de recibir tráfico) y `liveness` no, a propósito: reiniciar una
  réplica no arregla la base, y reiniciarlas todas a la vez empeoraría la caída. Spring Boot no mete la base en readiness
  por su cuenta: hasta el 12-11-2026 no estaba configurado, y una réplica sin base seguía diciendo que estaba lista
  (`ReadinessConLaBaseDeDatosTest` en los tres servicios). No se exponen
  `env`, `beans` ni `heapdump`.
- **Trazabilidad:** un filtro (`SolicitudIdFilter`) da a cada petición un `X-Request-Id`; nginx lo genera, el servicio lo
  respeta si es válido (8 a 64 letras, números, punto, guion o guion bajo) y si no lo reemplaza, lo muestra en cada línea del
  log y lo devuelve; la llamada de usuarios a cursos lo reenvía.
- **Plazos:** conectar 2 s y leer 3 s en `CursosServiceClient` (configurables); pasados, se sigue sin esa respuesta.
- **Límite de uso:** 10 roadmaps por persona en 10 minutos (`LimiteDeGeneraciones`, configurable), 429 con `Retry-After`.
- **Quién usa la salud:** `docker-compose` (healthcheck de los tres servicios con `/actuator/health/readiness`),
  `levantar.sh` (la espera antes de subir más réplicas: readiness solo da 200 cuando terminó de sembrar los datos de prueba)
  y el health check de Azure (README de `infra`).
- **Métricas del roadmap** (`MetricasDeRoadmap`, Micrometer): generaciones por fuente (IA o respaldo), caché, llamadas a la
  IA con su duración, propuestas aceptadas o rechazadas y rechazos del límite. `/actuator/metrics` solo para ADMIN.

**Consecuencias.**
- (+) El balanceador y Azure pueden vigilar la salud; una búsqueda por id recorre la petición completa; un servicio
  colgado degrada la pantalla en lugar de congelarla; el costo de la IA tiene techo.
- (−) Una dependencia más (actuator) y un filtro más en cada servicio.
- (−) El límite cuenta por réplica (con N réplicas, hasta N veces el tope) para no introducir estado compartido.
- (−) Las métricas cuentan por réplica y se reinician con cada arranque; para verlas agregadas haría falta un tablero
  (ahora lo hay: ver [0009](0009-metricas-con-prometheus-y-tableros-en-grafana.md)).
- trivia-service ya tiene lo mismo: salud con sus sondas, `X-Request-Id` (con la misma regla de qué id se acepta) que
  reenvía a usuarios-service y a cursos-service, y su healthcheck en el `docker-compose`.
