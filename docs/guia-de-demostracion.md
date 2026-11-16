# Guía de demostración y revisión de GrowLink (Sprint 2)

Escrita el 14 de noviembre de 2026 y puesta al día el 16 de noviembre para quien siga el trabajo (Mariana, Julio, Paula o cualquiera con su propio Claude). Dice **dónde está todo,
qué ya está comprobado, qué falta, cómo se muestra cada escenario y qué hay que apagar después**. Todo lo marcado «comprobado» se probó en Azure;
lo marcado «por ensayar» no se ha probado de punta a punta.

## 1. Dónde está cada cosa

| Qué | Dirección |
|---|---|
| La aplicación (con login de Microsoft) | https://growlink-front.azurewebsites.net |
| Tableros (negocio, técnico por instancia, seguridad) | http://growlink-grafana-ca.canadacentral.azurecontainer.io:3000 (sin iniciar sesión; el técnico es `/d/growlink-tecnico`) |
| Prometheus (consultas y alertas) | http://growlink-prometheus-ca.canadacentral.azurecontainer.io:9090 (`/alerts` para las alertas) |
| Logs de las 5 apps | Portal de Azure > `workspace-rggrowlinkkH1i` > Logs (consulta en la sección 3, O2) |
| Calidad del código | https://sonarcloud.io/organizations/grow-link/projects, o `node scripts/estado-calidad.mjs` en `infra` |
| Despliegues y pruebas | pestaña *Actions* de cada repo en https://github.com/Grow-Link |
| Aplicación de Microsoft (Entra) | client ID `17fd558f-ea2b-4177-8142-48548dc5431c`; el portal de Entra da error 401 por la universidad: usar `az ad app show --id 17fd558f-ea2b-4177-8142-48548dc5431c` |

**Cómo está armado en Azure** (grupo `rg-growlink`, Canada Central salvo lo indicado): front con nginx (el balanceador) · usuarios y cursos · **trivia en 3
copias**, cada una en su propio servidor y plan B2 (`growlink-trivia` en el plan compartido, `growlink-trivia-d` en su plan B2 de East US, `growlink-trivia-c` en su plan B2 de East US 2) · RabbitMQ,
Prometheus y Grafana en contenedores de Azure · PostgreSQL administrado. La decisión y por qué no hay autoescalado de Azure (cuota 0 en la suscripción de
estudiante, Front Door prohibido): [ADR-0010](adr/0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md).

## 2. Lo que el enunciado pide y dónde está cubierto

| Pide el enunciado | Cómo lo cubrimos | Estado |
|---|---|---|
| Disponibilidad: escalar el backend, **balanceador explícito**, componentes distribuidos, prototipo funcional, ≥ 1 escenario | D1 y D3 con el nginx balanceando 3 copias de trivia | Comprobado |
| Seguridad: 3 escenarios aprobados e implementados | S1 identidad (Microsoft), S2 roles, S3 cifrado, S4 límite por IP | S1, S2, S3 y S4 comprobados (S2 con una cuenta USUARIO, el 16 de noviembre) |
| Mantenibilidad: Sonar en el CI | Los 4 repos; ver sección 4 para el bono | Comprobado el 16 de noviembre: los 4 con puerta OK y notas A |
| Rendimiento: 1 escenario aprobado + prueba técnica | P1, script de carga | **Medido en Azure** con `scripts/azure/medir-p1.sh`: 0 errores, pero p95 de cerca de 1,3 s con 1 y con 3 copias (la meta inicial era 300 ms y no se cumplió; se ajustó a 2 s) |
| Observabilidad: ≥ 1 escenario y **dos tableros** (negocio y técnico) | O1 alertas, O2 logs; tableros en Grafana de Azure | Comprobado |
| Documento: UML (mínimo 5, con despliegue), ADR, drivers, PDF impreso | Documento en Docs + ADR en `infra/docs/adr` | **Puesto al día el 16 de noviembre** (sección 6 dice qué falta) |
| Scrum en Azure DevOps con burndown | — | **Lo revisa el equipo (no tuve acceso)** |

## 3. Cómo mostrar cada escenario

Orden sugerido para la presentación: tableros en reposo → carga (P1) → apagar una copia (D1 y O1) → login y roles (S1, S2) → cifrado (S3) → límite (S4) → logs (O2) → Sonar (M1).
Antes de empezar: `curl -s https://growlink-front.azurewebsites.net/api-trivia/actuator/health` debe responder y los tableros deben mostrar 3 copias de trivia.

**D1. Una copia deja de estar disponible (y O1, la alerta).** *Comprobado.*
1. Abrir el tablero técnico. En «Réplicas que responden» trivia marca 3.
2. En otra terminal, tráfico constante por el balanceador:
   `for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code}\n' https://growlink-front.azurewebsites.net/api-trivia/actuator/health; done | sort | uniq -c`
3. Mientras corre: `az webapp stop -g rg-growlink -n growlink-trivia-d`
4. Se espera: casi todo 200 (en la prueba, 89 de 90 con la copia apagada; el WebSocket negoció 12 de 12); el tablero baja a 2 y a los ~30 s aparece la alerta **InstanciaCaida**
   con el nombre de la copia (también en Prometheus `/alerts`).
5. Volver a encender: `az webapp start -g rg-growlink -n growlink-trivia-d`. La copia tarda unos minutos en calentarse y puede dar errores al principio.

**D1 con jugadores conectados (16 de noviembre).** `scripts/azure/probar-falla-de-copia.sh` juega partidas de mentira (12 jugadores en 3 salas, 10 preguntas) y en la pregunta 3 apaga `growlink-trivia-d`.
Resultado: 4 de 12 jugadores perdieron la conexión y volvieron solos en 3,7 a 4,0 s; el servidor no sacó a nadie de su sala y las 3 partidas terminaron con resultados para todos. El script deja las tres copias en
modo `legacy` mientras corre y al terminar vuelve a `oidc` y enciende la copia: no correrlo mientras alguien juega. Resultado en `scripts/carga/resultados/falla-de-copia-*.txt`.

**D3. Sube la carga y se suma capacidad.** *Sin autoescalado de Azure: se dice así.* Es la medición de P1 con 1 copia y con 3. Para mostrar la regla de escalado (metrica, umbral,
tiempo sostenido) hay un script que lo hace en el Docker local: `node scripts/autoescalar.mjs` (README de `infra`, sección «Autoescalado»).

**P1. Muchos jugadores a la vez.** *Medido el 16 de noviembre (Mariana).* `./scripts/azure/medir-p1.sh` (30 minutos, necesita `az login` y Node 22). **Mientras corre nadie puede jugar trivia con Microsoft**
(pasa las copias a modo `legacy`) y al terminar lo deja todo como estaba; si se interrumpe, `./scripts/azure/medir-p1.sh restaurar`. Deja `p1-1-copia-*` y `p1-3-copias-*` en
`scripts/carga/resultados/` (esa carpeta no se sube a git). Tomar capturas del tablero técnico mientras corre.
**Resultado en Azure:** hasta 100 jugadores, 0 errores y 0 jugadores sin resultados, con 1 y con 3 copias. El p95 de la respuesta fue de cerca de 1,3 s en las dos: **no se cumplió la meta inicial de 300 ms**
(ADR-0013) y se ajustó a 2 s con el argumento de que la pregunta dura 10 s y la persona contesta en el primer segundo y medio. Sumar copias no bajó la latencia; con 3 copias mejoró el tiempo de conectar y ya no se caen
como el 14 de noviembre (cuando eran planes B1 de un solo núcleo). Hipótesis, sin comprobar: dos de las tres copias están en otra región que la base de datos y RabbitMQ (Canada Central), y la prueba corre desde un computador fuera de Azure.
**Mediciones en Docker (13 de noviembre):** 60 jugadores, p95 de la respuesta ≈ 40 ms.

**S1. Autenticación con un proveedor externo.** *Comprobado.*
- Entrar con Microsoft desde la página (botón «Iniciar sesión con Microsoft»); la primera vez pide elegir rol.
- Token falso rechazado: `curl -i -H "Authorization: Bearer falso" https://growlink-usuarios-argqeudgbegyenca.canadacentral-01.azurewebsites.net/api/usuarios/me` → **401**.
- El login de demostración ya no sirve: un token del login viejo también da 401.

**S2. Autorización por rol.** *Comprobado en Azure el 16 de noviembre (Mariana) con una cuenta USUARIO:* crear un curso, ver las métricas y pedir el roadmap de otra persona dan 403, y `/admin/metricas` también.
`scripts/azure/demo-s2.sh` lo muestra en vivo desde un computador (si Mariana lo sube a git). Paula, Julio y Mariana están en `AUTH_ADMIN_EMAILS`, así que **entran siempre como ADMIN**:
para ver USUARIO y PUBLICADOR hay que usar otra cuenta (Juan Diego, o una cuenta personal de Microsoft). Recorrer las pantallas con cada rol: un USUARIO no ve «Publicar curso» ni
métricas; un PUBLICADOR sí publica; un ADMIN ve Métricas. Para el 403: con un token de USUARIO, crear un curso (`POST /api/cursos`) debe dar 403.

**S3. Confidencialidad.** *Comprobado.* En el navegador: Herramientas de desarrollo > Red, abrir una petición a `/api-usuarios/...`: la petición lleva `X-GL-Clave` y un cuerpo binario
(no se lee), la respuesta lleva `X-GL-Cifrado: 1` y tampoco se lee. Además cabecera `Strict-Transport-Security` (HSTS). Calificación del certificado: https://www.ssllabs.com/ssltest/analyze.html?d=growlink-front.azurewebsites.net
*Límites que hay que decir:* el WebSocket de trivia va por `wss` sin este cifrado extra, y las llamadas entre servicios no lo llevan ([ADR-0008](adr/0008-cifrado-de-la-informacion-entre-el-front-y-los-servicios.md)).

**S4. Resistir una ráfaga desde una misma IP.** *Comprobado el 14 de noviembre en Azure, después de la corrección de Mariana (el filtro cuenta por la IP del socket, sin puerto, e ignora la cabecera `X-Forwarded-For` que escribe el cliente).*
Ráfaga por muchas conexiones a la vez (el caso de un atacante de verdad):
`seq 600 | xargs -P 20 -I{} curl -4 -s -o /dev/null -w '%{http_code}\n' https://growlink-usuarios-argqeudgbegyenca.canadacentral-01.azurewebsites.net/api/auth/usuarios | sort | uniq -c`
→ aparecen respuestas **429** (el tope es de 300 por minuto, por IP). Con una cabecera inventada distinta en cada petición **tampoco se salta el tope**: en la prueba, 300 respuestas 200 y 90 respuestas 429. En Grafana, el tablero «Eventos de seguridad» muestra los 429.
Para ver el mensaje de un 429 basta repetir un `curl -i` justo después de la ráfaga (dura hasta que termina la ventana de 60 s).

**O2. Rastrear un evento por su identificador.** *Comprobado el 14 de noviembre: un evento aparece en Log Analytics a los 2 minutos.* Generar un evento y copiar su identificador:
`curl -i -H "Authorization: Bearer falso" https://growlink-usuarios-argqeudgbegyenca.canadacentral-01.azurewebsites.net/api/usuarios/me` → la respuesta trae la cabecera `X-Request-ID` y el servicio deja un aviso «Token rechazado» con ese identificador.
Luego, en el portal de Azure: `workspace-rggrowlinkkH1i` > Logs, esperar 2 a 5 minutos y ejecutar (con el rango de tiempo en «Última hora»):
`AppServiceConsoleLogs | where ResultDescription has "<identificador>" | project TimeGenerated, App=tostring(split(_ResourceId,'/')[8]), ResultDescription | order by TimeGenerated asc`
Si la petición pasa por el front (nginx) hay que usar el identificador de la cabecera de respuesta, no uno propio: nginx ignora el que mande el cliente. En Docker local hay un tablero «Logs» de Grafana que hace lo mismo ([ADR-0015](adr/0015-logs-y-alertas-en-docker-y-en-azure.md)).

**M1. Inspección continua.** Mostrar el panel de SonarCloud, la pestaña *Actions* (CI en verde: pruebas y análisis) y `node scripts/estado-calidad.mjs`. Para mostrar el **pipeline que se detiene**: en un repo,
crear una rama con una prueba que falle y abrir un pull request: el CI se pone en rojo y el despliegue no corre (solo corre tras un push a `main` con CI en verde). Para que también frene la puerta de calidad
de Sonar, crear la variable de repositorio `SONAR_ESPERAR_PUERTA=true` ([ADR-0014](adr/0014-sonarcloud-en-el-ci-y-puerta-de-calidad.md)); **solo cuando Sonar esté en verde**, si no bloquea todos los despliegues.

**D2. Falla la IA (cortacircuito).** *Comprobado en Azure el 16 de noviembre (Mariana y Paula): con una llave inválida el roadmap salió completo con el respaldo y el tablero de negocio mostró la barra RESPALDO.* Para repetirlo desde el portal:
`growlink-cursos` > Settings > Environment variables > `CLAUDE_API_KEY`, poner una llave inválida (por ejemplo `clave-invalida`) y pedir 4 roadmaps con metas distintas (si se repite una meta responde la caché y no se ve nada).
Mirar el tablero de negocio («Roadmaps generados, por quien los armó», con el rango en los últimos 15 minutos) y **devolver la llave real después**. Con la línea de comandos:
`az webapp config appsettings set -g rg-growlink -n growlink-cursos --settings CLAUDE_API_KEY=clave-invalida`. [ADR-0012](adr/0012-cortacircuito-delante-de-la-ia.md).

## 4. Para el bono (0,5 puntos): notas A, 80 % en el backend y 40 % en el front

Estado el 16 de noviembre (`node scripts/estado-calidad.mjs` lo muestra al momento): **los cuatro repos con puerta OK, seguridad, fiabilidad y mantenibilidad A, sin vulnerabilidades ni errores abiertos.**
- Cobertura: usuarios 89,4 %, cursos 84,9 %, trivia 91,8 % (mínimo 80 %) y front 86,5 % (mínimo 40 %). Pruebas: 164, 235 y 222 en los backends.
- La cobertura del front se mide sin las páginas y componentes puramente visuales (declarados en `sonar-project.properties` y `vitest.config.ts`).
- El despliegue ya espera al CI. Para que además lo frene la puerta de Sonar hay que crear la variable de repositorio `SONAR_ESPERAR_PUERTA=true` en los cuatro repos (ahora que Sonar está en verde, es seguro).
- **CSRF (usuarios y cursos, `SecurityConfig`):** resuelto con una justificación escrita en el código (`NOSONAR java:S4502`: la API autentica con un token en la cabecera y no guarda sesión, no usa cookies, así que CSRF no aplica).
- **Front, dos alertas de Sonar en `backendSession.ts:105` (S8476 y S7044):** marcadas como falso positivo en SonarCloud. `send()` reconstruye la dirección desde una lista fija de tres servicios y rechaza `..`, `//` y `\`.
- **«Dependency risks» (columna E en SonarCloud):** son avisos de librerías de terceros (el análisis de dependencias de SonarCloud); no entran en la puerta ni en el bono. Decirlo así si preguntan. El resto de falsos positivos: [`sonarcloud-hallazgos.md`](sonarcloud-hallazgos.md).

## 5. Hallazgos abiertos (no esconderlos, se pueden decir en la presentación)

1. **Resuelto el 14 de noviembre: el límite por IP.** Mariana descubrió y corrigió que, en Azure, Tomcat copia la IP del cliente al socket **con su puerto** y deja una cabecera que el cliente podía inventar; el filtro ahora cuenta por el socket sin puerto. Comprobado en Azure con ráfagas por muchas conexiones y con cabeceras inventadas (sección 3, S4).
2. **Pausas ocasionales de 14 a 15 s** en la copia A y en las de otros planes (el plan compartido llegó al 76–89 % de memoria y 98 % de CPU). Se acotó el heap de las JVM; puede afectar P1. Se mide y se dice tal cual.
3. **En Docker, la conexión de trivia con RabbitMQ se cae y vuelve cada pocos minutos** y una de cuatro etapas perdió 3 de 6 salas ([README de infra](../README.md), sección «Autoescalado»). **En Azure se revisó con
   `AppServiceConsoleLogs | where ResultDescription has "BrokerAvailabilityEvent"`: las caídas del broker solo aparecen alrededor de reinicios de las copias, no cada pocos minutos.** La causa en Docker sigue sin explicarse (puede ser Docker Desktop).
4. **Prometheus y Grafana en Azure quedan sin HTTPS y con dirección pública** (Container Instances no pone certificado). Solo muestran métricas de uso. Decirlo.
5. **Autoescalado:** no es el de Azure (ver [ADR-0010](adr/0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md)).
6. **El balanceador de nginx no revisa la salud:** una copia caída recibe tráfico hasta que falla la petición (cuesta ≤ 2 s) y se reintenta en otra.
7. **El puerto 61613 de RabbitMQ (STOMP) está abierto a internet y sin TLS** (Container Instances con dirección pública). El contenedor pide usuario y clave y solo lleva los mensajes de las salas de trivia, pero el puerto es público. Es un riesgo conocido:
   la mejora sería ponerlo en una red privada y con TLS, y no cabe en este sprint. **Si preguntan, se dice así.** El documento de arquitectura lo lista en 9.2.
8. **P1 no cumplió la meta inicial de 300 ms** (se midió cerca de 1,3 s con 1 y con 3 copias) y la meta se ajustó a 2 s después de medir. Se dice tal cual, con la explicación de la sección 3 (P1).
9. **usuarios y cursos tienen una sola instancia** (la suscripción de estudiante permite una por plan y región): la prueba de caída de copia (D1) se hace con trivia.

## 6. El documento de arquitectura (entregable final, impreso)

Está en Docs («GrowLink: documento de arquitectura (Sprint 2)») y **se puso al día el 16 de noviembre**: escenarios D1 a O2 con lo que se midió en Azure, sección 4 con el nginx como balanceador (Front Door no es posible en cuentas de estudiante),
ADR 0007 a 0015 como en `infra/docs/adr`, diagrama de despliegue con la topología real, dos diagramas de secuencia nuevos (caída de una copia y seguimiento de una petición), la consulta de logs de O2 y riesgos (incluido el puerto de RabbitMQ).
Lo que queda:
- **Revisar cómo se ven los diagramas** al exportar a PDF desde Docs (Exportar > PDF) y que todo quepa en la página; imprimir.
- **Decidir entre el equipo** cómo queda el riesgo del puerto 61613 de RabbitMQ (cerrarlo o dejarlo como riesgo conocido, como dice hoy el documento en 9.2).
- Mariana tenía pendiente su propio diagrama de despliegue y el de login con Microsoft: si los suben, **reemplazar** el de la sección 6.6 o agregar el del login en 6.5 (ya hay uno de «Entrar con Microsoft»).
- Revisar en **Azure DevOps** que las historias estén en DONE y el burndown al día (82 puntos); el PDF de historias es del 12 de noviembre y está desactualizado.

## 7. Antes de presentar (lista de revisión)

- [ ] `curl` a la salud de usuarios, cursos y las 3 copias de trivia responde 200 (o mirar «Réplicas que responden» en Grafana).
- [ ] Entrar con Microsoft y llegar a `/inicio`; jugar una trivia con **dos cuentas** (un administrador y una cuenta que no lo sea).
- [ ] Grafana abre y los tableros tienen datos (si no, generar tráfico).
- [ ] `node scripts/estado-calidad.mjs` en verde, o con lo que falte explicado.
- [ ] Revisar los créditos de Azure (Cost Management) y que **nadie esté corriendo la medición** de P1.
- [ ] Plan B si Azure falla: `infra`, `cp .env.example .env` y `./scripts/levantar.sh` (Docker local, login de demostración, Grafana en http://localhost:3001).

## 8. Después de presentar (para dejar de gastar créditos)

```bash
az container delete -g rg-growlink -n growlink-grafana --yes
az container delete -g rg-growlink -n growlink-prometheus --yes
az container delete -g rg-growlink -n growlink-rabbitmq --yes      # trivia solo funciona con varias copias mientras exista
az webapp delete -g rg-growlink -n growlink-trivia-d && az appservice plan delete -g rg-growlink -n plan-trivia-d --yes
az webapp delete -g rg-growlink -n growlink-trivia-c && az appservice plan delete -g rg-growlink -n plan-trivia-c --yes
```
Si se borran las copias B y C, quitar `TRIVIA_URL_2` y `TRIVIA_URL_3` del front (o ponerlas iguales a `TRIVIA_URL`) y `TRIVIA_BROKER_RELAY_ENABLED` de la copia A.
Para volver al login de demostración: quitar `AUTH_MODE` de las 5 apps (usuarios, cursos y las 3 de trivia) y las 4 variables `VITE_*` del ambiente `actual` del front, y volver a desplegar el front.

## 9. Cómo se vuelve a desplegar

- Cambios en el front: un `push` a `main` (CI y, si sale bien, CD despliega solo).
- Cambios en los backends: `./scripts/azure/desplegar-backends.sh` (o `... trivia` para solo las tres copias). Trivia se sube de una en una: mientras una se actualiza el balanceador usa las otras.
- Tableros: `./scripts/azure/desplegar-metricas.sh` los recrea con lo que haya en `main` de este repo.
