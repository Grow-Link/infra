# Decisiones de arquitectura (ADR)

Una decisión por archivo: qué problema había, qué se decidió, qué se ganó y qué se paga por ello. Sirven para
que, meses después, nadie tenga que adivinar por qué algo es como es (ni deshacerlo sin saber qué rompe).

| # | Decisión | Atributos de calidad |
|---|---|---|
| [0001](0001-microservicios-con-base-propia.md) | Tres servicios, cada uno con su propia base de datos | Modificabilidad, escalabilidad |
| [0002](0002-sesion-sin-estado-con-jwt.md) | La sesión es un JWT firmado y los servicios no guardan estado | Escalabilidad, disponibilidad |
| [0003](0003-la-ia-propone-el-servidor-decide.md) | La IA propone, el servidor valida, y hay un respaldo algorítmico | Disponibilidad, seguridad |
| [0004](0004-cache-de-propuestas-de-la-ia.md) | Se guardan las propuestas validadas de la IA, con una clave que incluye el catálogo | Rendimiento, costo |
| [0005](0005-un-roadmap-nuevo-no-ofrece-lo-ya-completado.md) | Un roadmap nuevo no vuelve a ofrecer lo que la persona ya completó | Integridad del jardín |
| [0006](0006-salud-trazabilidad-y-plazos.md) | Salud consultable (y quién la usa), identificador por petición, plazos en las llamadas entre servicios y métricas del roadmap | Disponibilidad, observabilidad |
| [0007](0007-la-identidad-la-pone-microsoft-y-el-rol-growlink.md) | La identidad la pone Microsoft Entra ID (multi-tenant, por el `sub`) y el rol lo pone GrowLink | Seguridad, interoperabilidad |
| [0008](0008-cifrado-de-la-informacion-entre-el-front-y-los-servicios.md) | El front cifra lo que manda (AES-GCM por petición, llave envuelta con la RSA del servicio) y los servicios lo descifran, encima de HTTPS | Seguridad (confidencialidad) |
| [0009](0009-metricas-con-prometheus-y-tableros-en-grafana.md) | Métricas con Prometheus (etiqueta `instancia`, protegidas con un token) y tres tableros en Grafana | Observabilidad, seguridad |
| [0010](0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md) | Despliegue en Azure: balanceador en el nginx del front y trivia en tres copias, en servidores y regiones distintos | Disponibilidad, rendimiento |
| [0011](0011-tope-por-ip-y-eventos-de-seguridad.md) | Tope de peticiones por IP y cada rechazo de seguridad (401, 403, 429) contado y en el log | Seguridad, disponibilidad, observabilidad |
| [0012](0012-cortacircuito-delante-de-la-ia.md) | Un cortacircuito delante de la IA (3 fallos seguidos, 60 s abierto, una prueba al volver) y el respaldo algorítmico | Disponibilidad, costo |
| [0013](0013-pruebas-de-carga-tasa-constante-y-trivia-de-10-a-100.md) | Pruebas de carga: HTTP a tasa constante y trivia en vivo de 10 a 100 jugadores, con p50, p95 y p99 | Rendimiento, escalabilidad, disponibilidad |
| [0014](0014-sonarcloud-en-el-ci-y-puerta-de-calidad.md) | SonarCloud en el CI de los cuatro repos; el despliegue espera al CI y la puerta de calidad puede frenarlo | Mantenibilidad, seguridad |
| [0015](0015-logs-y-alertas-en-docker-y-en-azure.md) | Logs en Loki (Docker) y Log Analytics (Azure), y tres alertas por instancia | Observabilidad |

Formato: **Contexto** (la fuerza que obligó a decidir) · **Decisión** · **Consecuencias** (lo bueno y lo que se paga) ·
**Estado**. Para una decisión nueva, copiar el último archivo y cambiar el número.

Los atributos de calidad y cómo se comprueba cada uno están en [`../atributos-de-calidad.md`](../atributos-de-calidad.md).
