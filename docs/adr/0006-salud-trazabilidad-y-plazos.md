# 0006. Salud consultable, identificador por petición y plazos en las llamadas entre servicios

**Estado:** vigente (cursos-service y usuarios-service; trivia-service pendiente) · **Atributos:** disponibilidad,
observabilidad, seguridad

**Contexto.** Con varias réplicas y servicios que se llaman entre sí hacían falta tres cosas: saber si una réplica sirve
sin entrar con credenciales, seguir una misma petición por varios servicios en los logs, y que un servicio que se cuelga
(no que cae) no arrastre a los que lo llaman. Además, la IA cuesta dinero por llamada.

**Decisión.**
- **Salud:** Spring Boot Actuator con solo `health` (sin detalles) y sus sondas `liveness` y `readiness`; no se exponen
  `env`, `beans` ni `heapdump`.
- **Trazabilidad:** un filtro (`SolicitudIdFilter`) da a cada petición un `X-Request-Id`; nginx lo genera, el servicio lo
  respeta si es válido (8 a 64 letras, números, punto, guion o guion bajo) y si no lo reemplaza, lo muestra en cada línea del
  log y lo devuelve; la llamada de usuarios a cursos lo reenvía.
- **Plazos:** conectar 2 s y leer 3 s en `CursosServiceClient` (configurables); pasados, se sigue sin esa respuesta.
- **Límite de uso:** 10 roadmaps por persona en 10 minutos (`LimiteDeGeneraciones`, configurable), 429 con `Retry-After`.

**Consecuencias.**
- (+) El balanceador y Azure pueden vigilar la salud; una búsqueda por id recorre la petición completa; un servicio
  colgado degrada la pantalla en lugar de congelarla; el costo de la IA tiene techo.
- (−) Una dependencia más (actuator) y un filtro más en cada servicio.
- (−) El límite cuenta por réplica (con N réplicas, hasta N veces el tope) para no introducir estado compartido.
- Siguiente: lo mismo en trivia-service y usar `/readiness` en los healthchecks del compose.
