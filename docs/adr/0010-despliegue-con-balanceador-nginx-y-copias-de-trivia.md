# 0010. El despliegue en Azure: balanceador en el nginx del front y trivia en tres copias, en servidores distintos

**Estado:** vigente · **Atributos:** disponibilidad (escalabilidad horizontal y tolerancia a fallos), rendimiento

**Contexto.** El enunciado exige escalar horizontalmente el backend, un **balanceador de carga explícito**, componentes
distribuidos físicamente y nada de un despliegue centralizado en un solo servidor. El diseño original (Opción A del documento
de arquitectura) era App Service con Azure Front Door y autoescalado. Con una suscripción **Azure for Students** eso no es
posible, y se comprobó con los mensajes de Azure, no por suposición:
- **Front Door está prohibido** («Free Trial and Student account is forbidden for Azure Frontdoor resources»).
- **Los planes con autoescalado (S1, S2, S3, P0v3, P1v2, P1v3) tienen cuota 0.**
- **Cada tipo de plan permite una sola instancia por región** (B1: 1, B2: 1), así que ni siquiera se puede subir un plan
  a dos instancias; pero sí se pueden crear **planes distintos**, y otras regiones (East US 2, East US) permiten uno más. Canada East está
  vedada por una política de la suscripción.

**Decisión.**
- **El balanceador es el nginx del front** (`deploy/nginx.conf.template`), que ya era la entrada única. Reparte cada petición
  y cada WebSocket de trivia entre tres copias con `split_clients` (40 %, 40 % y 20 %), y **si la elegida no contesta
  (502, 503, 504 o el 403 con el que Azure responde a una app apagada) la reintenta en la siguiente**. Cada intento
  fallido cuesta como máximo 2 segundos (`proxy_connect_timeout`).
- **Trivia corre en tres App Service**: A en el plan compartido (B2, Canada Central), D en su propio plan (B2, East US) y C en
  su propio plan (B2, East US 2). D y C llevan latencia extra hacia la base de datos (que esta en Canada Central) y C lleva menos peso.
  **Una primera version usaba planes B1 de un solo nucleo para las copias propias, y no aguantaron la prueba de carga**: sin CPU, el
  relay no lograba conectarse al broker e incluso el HTTP dejaba de responder (hallazgo de Mariana, con logs y metricas). Por eso
  las copias propias son B2 (dos nucleos) y la copia que quedo en Canada Central (B1) se reemplazo por D.
- **Lo que hace que las copias sean intercambiables**: no guardan estado (0002), comparten RabbitMQ (en Azure Container
  Instances, para que un mensaje de una sala llegue a los jugadores conectados a otra copia) y la misma base de datos.
  Cada copia usa 6 conexiones a la base, porque Postgres admite 50 y las cinco apps suman 38.
- **Componentes en servidores distintos**: front, usuarios y cursos (plan compartido), tres copias de trivia (tres planes en
  tres regiones), RabbitMQ, Prometheus y Grafana (contenedores en Azure) y PostgreSQL (servicio administrado).
- **Sin autoescalado de Azure.** El escalamiento es horizontal pero decidido por nosotros: se agregan o se quitan copias del
  reparto (`az webapp start/stop`, o la regla de `scripts/autoescalar.mjs` en el Docker de la demo).

**Consecuencias.**
- (+) Apagar una copia no corta el servicio: se mide en D1. El reparto y la caída se ven en el tablero técnico, por copia.
- (+) Cumple el enunciado: balanceador explícito, backend escalable, componentes distribuidos y prototipo funcional.
- (−) **nginx de código abierto no revisa la salud de cada copia**: manda tráfico a una caída hasta que falla la petición, y
  cada intento fallido tarda hasta 2 s. Las partidas de una copia que cae se cortan y se reconectan.
- (−) **No es el autoescalado de Azure**: la regla la ejecuta un script, no la plataforma. Se dice así en la demo.
- (−) Más de una copia en un plan compartido (A) compite por memoria con usuarios y cursos; por eso se acotó el heap de las
  JVM de ese plan.
- (−) Cada copia hay que desplegarla y configurarla aparte (`scripts/azure/desplegar-backends.sh` lo hace en bloque).
