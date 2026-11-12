# 0013. Pruebas de carga: HTTP a tasa constante y trivia en vivo de 10 a 100 jugadores

**Estado:** vigente (scripts en `scripts/carga`; las corridas en Azure con 1 y 3 instancias están pendientes) ·
**Atributos:** rendimiento, escalabilidad, disponibilidad

**Contexto.** "Rápido" y "aguanta" no eran números (en `atributos-de-calidad.md` la prueba de carga estaba como
propuesta). Hay tres preguntas que contestar con mediciones: cuánto aguanta cada servicio con 1 y con 3 instancias,
cuánto tarda en recuperarse cuando se apaga una, y dónde está el cuello de botella de la trivia en vivo, que es la
parte con más concurrencia: muchas personas contestando a la vez, con un candado de fila por pregunta y un broker
(RabbitMQ) repartiendo los mensajes entre réplicas.

**Decisión.**
- **Herramienta: scripts de Node 22**, con el mismo stack que la prueba de humo (`@stomp/stompjs`); no hay que instalar
  nada más. Las cuentas (percentil por rango más cercano, línea de tiempo, ventana de fallas, reparto en salas) están
  aparte (`estadisticas.mjs`) y tienen pruebas (`npm test`, en el CI de este repo).
- **Escenario 1, HTTP a tasa constante** (`npm run http`): `TASA` peticiones por segundo durante `DURACION_S`, con
  **modelo abierto**: cada petición sale a su hora aunque las anteriores no hayan contestado. Si se esperara la
  respuesta antes de mandar la siguiente, un servidor lento recibiría menos carga justo cuando más le cuesta y los
  tiempos saldrían mejores de lo que son. Solo lecturas de los tres servicios, para poder repetirla sin ensuciar los
  datos (`/api/home/estado` pasa además por cursos-service). Dice p50, p95, p99 y máximo por petición, las fallas por
  motivo, el reparto entre réplicas (`X-Instancia`) y, **segundo a segundo**, cuántas salieron y fallaron: al tumbar
  una réplica a la mitad, la ventana de fallas es lo que tardó en recuperarse.
- **Escenario 2, trivia de 10 a 100 jugadores** (`npm run trivia`): etapas de 10, 25, 50, 75 y 100 jugadores en
  salas de 5, cada uno con su WebSocket, jugando partidas completas. La medida principal es la **ida y vuelta de una
  respuesta**: desde que el jugador manda su respuesta hasta que le llega la confirmación (`RESPUESTA_REGISTRADA`),
  que atraviesa el servidor, la base de datos y el broker; es lo que siente la persona al tocar una opción. Además: el
  reparto de la pregunta dentro de la sala (medido con el reloj del cliente, así no depende de relojes
  sincronizados), unirse, conectar y crear la sala, y las partidas que no terminan o las respuestas que nunca se
  confirman. Donde empieza a crecer el p95 o a aparecer errores, ahí está el cuello de botella; el tablero técnico
  (0009) dice al mismo tiempo qué recurso se satura (conexiones a la base esperando, CPU, hilos).
- **Metas iniciales** (propuesta del equipo, a confirmar con la primera corrida en Azure). Los scripts las comprueban
  con `META_P95_MS` y `META_ERRORES_PCT` y terminan con código 1 si no se cumplen:

  | Escenario | Meta |
  |---|---|
  | HTTP, 1 instancia | p95 ≤ 500 ms y ≤ 1 % de fallas a 20 peticiones/s |
  | HTTP, 3 instancias | las mismas metas al triple de tasa (60 peticiones/s) |
  | Recuperación | al apagar 1 de 3 instancias bajo carga, sin fallas después de 60 s |
  | Trivia | p95 de la respuesta ≤ 300 ms y ≤ 1 % de jugadores sin sus resultados, con 100 jugadores |

  Línea base en local (12-11-2026, una réplica de cada servicio con H2 y broker en memoria, la carga desde la misma
  máquina): HTTP a 20 peticiones/s, p95 40 ms y ninguna falla; trivia con 100 jugadores, respuesta p50 12 ms, p95
  26 ms y p99 39 ms, sin errores. Es una referencia, no una meta: en Azure se suma la red.
- **Condiciones de la prueba**, que el README repite: `AUTH_MODE=legacy` en el ambiente que se prueba (no hay forma de
  sacar tokens de Microsoft para cien personas de mentira); `LIMITE_IP_MAXIMO_POR_MINUTO` alto o en 0, porque toda la
  carga sale de una IP y si no lo que se mide es el tope (el reporte avisa si vio 429); y jugadores de mentira con ids
  desde 900000, que no existen en usuarios-service, para no llenarle las estadísticas a las personas de prueba (al
  terminar cada partida queda un aviso en el log de trivia al no poder sumarle la victoria al ganador: es lo esperado).

**Consecuencias.**
- (+) Rendimiento, escalabilidad y disponibilidad quedan con un número y un comando que lo reproduce, y las metas se
  comprueban con el código de salida.
- (+) Comparar 1 y 3 instancias es correr lo mismo dos veces y comparar los JSON de `scripts/carga/resultados/`.
- (+) Ya sirvio para encontrar el cuello de botella de la trivia (en local, 12-11-2026): con el ritmo de una persona no
  aparece hasta 400 jugadores, pero cuando muchas respuestas llegan a la vez la latencia crece en línea recta, porque
  cada respuesta pasa entera por un camino de capacidad fija (hilos del canal de STOMP, 2 por núcleo → conexiones de la
  base → 7 a 9 consultas, varias con el candado de la pregunta); en salas grandes, además, cada confirmación se manda a
  toda la sala. Los números, cómo se midió y qué cambiar están en el README de trivia-service ("Prueba de carga: donde
  esta el cuello de botella").
- (−) Una sola máquina genera la carga: su red y su CPU ponen techo (Node maneja cientos de peticiones por segundo y
  cientos de WebSockets, no miles). Para más, correr varias copias a la vez desde máquinas distintas.
- (−) Con el tope por IP apagado, lo que se mide no incluye ese tope; y como toda la carga sale de una IP, tampoco
  prueba cómo se reparte el tope entre muchas personas.
- (−) El ambiente de prueba en Azure no puede ser uno con Microsoft (`AUTH_MODE=legacy`): conviene usar `avance` o
  uno propio para las pruebas.
- (−) Generar roadmaps no está en la carga a propósito: cada uno puede costar una llamada a la IA.
