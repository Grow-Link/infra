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

Formato: **Contexto** (la fuerza que obligó a decidir) · **Decisión** · **Consecuencias** (lo bueno y lo que se paga) ·
**Estado**. Para una decisión nueva, copiar el último archivo y cambiar el número.

Los atributos de calidad y cómo se comprueba cada uno están en [`../atributos-de-calidad.md`](../atributos-de-calidad.md).
