# 0015. Dónde se leen los logs y las alertas: Loki y Prometheus en Docker, Log Analytics y Prometheus en Azure

**Estado:** vigente · **Atributos:** observabilidad (trazabilidad de eventos y detección de instancias degradadas)

**Contexto.** Los tres servicios escriben una línea JSON por evento con el identificador de la petición (`X-Request-Id`, que viaja de
un servicio a otro, 0006), y exponen métricas por instancia (0009). Faltaba un lugar donde buscar un evento por su identificador
en todos los servicios a la vez, y una alerta cuando una instancia se cae o se degrada, sin leer logs a ojo. Además, Docker no
debe ser requisito para mostrar nada en la demo.

**Decisión.**
- **En Azure:** los logs de consola de las cinco apps van a **Log Analytics** (ajuste de diagnóstico `logs-growlink`), donde se
  busca con KQL: `AppServiceConsoleLogs | where ResultDescription has "<identificador>" | order by TimeGenerated asc`. Las
  métricas las raspa un **Prometheus** en Azure Container Instances (con su Grafana, también allí), que ve las cinco apps y cada
  copia de trivia por separado (`observabilidad/azure`, `scripts/azure/desplegar-metricas.sh`).
- **En Docker (desarrollo y demo local):** **Loki** guarda los logs de todos los contenedores (recogidos por **Alloy**) y el tablero
  *Logs* de Grafana los busca por identificador; el mismo Prometheus y Grafana con los mismos tableros.
- **Alertas** (`observabilidad/prometheus/alertas.yml`, las mismas en los dos sitios): **InstanciaCaida** (una copia no contesta
  durante 15 s), **InstanciaLenta** (su p95 pasa de 1 s durante 30 s) y **ErroresEnReplica** (más de 0,5 errores 5xx por segundo
  durante 30 s). Se ven en Prometheus (`/alerts`) y en el tablero técnico por instancia (panel *Alertas activas*). **No hay
  Alertmanager**: la alerta se «dispara» cuando aparece ahí; avisar por correo o mensaje es el siguiente paso.
- **El identificador no es una etiqueta de Loki** (habría una por petición): se busca como texto dentro de la línea.
- **nginx ignora el identificador que manda el cliente** y pone el suyo (32 hexadecimales): para seguir una petición hay que
  usar el de la cabecera `X-Request-Id` de la respuesta.

**Consecuencias.**
- (+) Un evento crítico se rastrea por su identificador a través de usuarios, cursos y trivia, en Azure y en Docker.
- (+) La demo de observabilidad no depende de Docker: Prometheus y Grafana corren en Azure.
- (−) Prometheus y Grafana en Azure quedan con dirección pública y **sin HTTPS** (Container Instances no pone certificado);
  solo muestran métricas de uso, no datos de personas. Para producción irían detrás de HTTPS y autenticación.
- (−) Los logs llegan a Log Analytics con unos minutos de retraso.
- (−) Alloy lee el socket de Docker para descubrir los contenedores: un permiso grande que solo se justifica en una máquina de
  desarrollo.
