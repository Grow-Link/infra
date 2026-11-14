# Guía de demostración y revisión de GrowLink (Sprint 2)

Escrita el 14 de noviembre de 2026 para quien siga el trabajo (Mariana, Julio, Paula o cualquiera con su propio Claude). Dice **dónde está todo,
qué ya está comprobado, qué falta, cómo se muestra cada escenario al profesor y qué hay que apagar después**. Todo lo marcado «comprobado» se
probó en Azure ese día; lo marcado «por ensayar» no se ha probado de punta a punta.

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
copias**, cada una en su propio servidor (`growlink-trivia` en el plan compartido, `growlink-trivia-b` en su plan, `growlink-trivia-c` en East US 2) · RabbitMQ,
Prometheus y Grafana en contenedores de Azure · PostgreSQL administrado. La decisión y por qué no hay autoescalado de Azure (cuota 0 en la suscripción de
estudiante, Front Door prohibido): [ADR-0010](adr/0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md).

## 2. Lo que el enunciado pide y dónde está cubierto

| Pide el enunciado | Cómo lo cubrimos | Estado |
|---|---|---|
| Disponibilidad: escalar el backend, **balanceador explícito**, componentes distribuidos, prototipo funcional, ≥ 1 escenario | D1 y D3 con el nginx balanceando 3 copias de trivia | Comprobado |
| Seguridad: 3 escenarios aprobados e implementados | S1 identidad (Microsoft), S2 roles, S3 cifrado, S4 límite por IP | S1, S2, S3 comprobados; **S4 con un fallo abierto (sección 5)** |
| Mantenibilidad: Sonar en el CI | Los 4 repos; ver sección 4 para el bono | **Por cerrar** |
| Rendimiento: 1 escenario aprobado + prueba técnica | P1, script de carga | **Falta medir en Azure** (`scripts/azure/medir-p1.sh`) |
| Observabilidad: ≥ 1 escenario y **dos tableros** (negocio y técnico) | O1 alertas, O2 logs; tableros en Grafana de Azure | Comprobado |
| Documento: UML (mínimo 5, con despliegue), ADR, drivers, PDF impreso | Documento en Docs + ADR en `infra/docs/adr` | **Desactualizado, ver sección 6** |
| Scrum en Azure DevOps con burndown | — | **Lo revisa el equipo (no tuve acceso)** |

## 3. Cómo mostrar cada escenario

Orden sugerido para la presentación: tableros en reposo → carga (P1) → apagar una copia (D1 y O1) → login y roles (S1, S2) → cifrado (S3) → límite (S4) → logs (O2) → Sonar (M1).
Antes de empezar: `curl -s https://growlink-front.azurewebsites.net/api-trivia/actuator/health` debe responder y los tableros deben mostrar 3 copias de trivia.

**D1. Una copia deja de estar disponible (y O1, la alerta).** *Comprobado.*
1. Abrir el tablero técnico. En «Réplicas que responden» trivia marca 3.
2. En otra terminal, tráfico constante por el balanceador:
   `for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code}\n' https://growlink-front.azurewebsites.net/api-trivia/actuator/health; done | sort | uniq -c`
3. Mientras corre: `az webapp stop -g rg-growlink -n growlink-trivia-b`
4. Se espera: casi todo 200 (en la prueba, 89 de 90 con la copia apagada; el WebSocket negoció 12 de 12); el tablero baja a 2 y a los ~30 s aparece la alerta **InstanciaCaida**
   con el nombre de la copia (también en Prometheus `/alerts`).
5. Volver a encender: `az webapp start -g rg-growlink -n growlink-trivia-b`. La copia tarda unos minutos en calentarse y puede dar errores al principio.

**D3. Sube la carga y se suma capacidad.** *Sin autoescalado de Azure: se dice así.* Es la medición de P1 con 1 copia y con 3. Para mostrar la regla de escalado (metrica, umbral,
tiempo sostenido) hay un script que lo hace en el Docker local: `node scripts/autoescalar.mjs` (README de `infra`, sección «Autoescalado»).

**P1. Muchos jugadores a la vez.** *Por medir.* `./scripts/azure/medir-p1.sh` (30 minutos, necesita `az login` y Node 22). **Mientras corre nadie puede jugar trivia con Microsoft**
(pasa las copias a modo `legacy`) y al terminar lo deja todo como estaba; si se interrumpe, `./scripts/azure/medir-p1.sh restaurar`. Deja `p1-1-copia-*` y `p1-3-copias-*` en
`scripts/carga/resultados/`. Tomar capturas del tablero técnico mientras corre. **Mediciones en Docker (13 de noviembre):** 60 jugadores, p95 de la respuesta ≈ 40 ms.

**S1. Autenticación con un proveedor externo.** *Comprobado.*
- Entrar con Microsoft desde la página (botón «Iniciar sesión con Microsoft»); la primera vez pide elegir rol.
- Token falso rechazado: `curl -i -H "Authorization: Bearer falso" https://growlink-usuarios-argqeudgbegyenca.canadacentral-01.azurewebsites.net/api/usuarios/me` → **401**.
- El login de demostración ya no sirve: un token del login viejo también da 401.

**S2. Autorización por rol.** *Por ensayar con una cuenta que no sea administradora.* Paula, Julio y Mariana están en `AUTH_ADMIN_EMAILS`, así que **entran siempre como ADMIN**:
para ver USUARIO y PUBLICADOR hay que usar otra cuenta (Juan Diego, o una cuenta personal de Microsoft). Recorrer las pantallas con cada rol: un USUARIO no ve «Publicar curso» ni
métricas; un PUBLICADOR sí publica; un ADMIN ve Métricas. Para el 403: con un token de USUARIO, crear un curso (`POST /api/cursos`) debe dar 403.

**S3. Confidencialidad.** *Comprobado.* En el navegador: Herramientas de desarrollo > Red, abrir una petición a `/api-usuarios/...`: la petición lleva `X-GL-Clave` y un cuerpo binario
(no se lee), la respuesta lleva `X-GL-Cifrado: 1` y tampoco se lee. Además cabecera `Strict-Transport-Security` (HSTS). Calificación del certificado: https://www.ssllabs.com/ssltest/analyze.html?d=growlink-front.azurewebsites.net
*Límites que hay que decir:* el WebSocket de trivia va por `wss` sin este cifrado extra, y las llamadas entre servicios no lo llevan ([ADR-0008](adr/0008-cifrado-de-la-informacion-entre-el-front-y-los-servicios.md)).

**S4. Resistir una ráfaga desde una misma IP.** *Parcial: ver sección 5.* Método que funciona hoy (una sola conexión, 400 peticiones):
`curl -s -o /dev/null -w '%{http_code}\n' "https://growlink-usuarios-argqeudgbegyenca.canadacentral-01.azurewebsites.net/api/auth/usuarios?n=[1-400]" | sort | uniq -c`
→ **300 respuestas 200 y 100 respuestas 429**. Luego, en Grafana, el tablero «Eventos de seguridad» muestra los 429.

**O2. Rastrear un evento por su identificador.** *Por ensayar el primer día* (los logs llegan con unos minutos de retraso). Hacer una acción en la app, copiar la cabecera de respuesta `X-Request-Id` (Red del
navegador; nginx ignora el que mande el cliente y pone el suyo) y, en el portal, `workspace-rggrowlinkkH1i` > Logs:
`AppServiceConsoleLogs | where ResultDescription has "<identificador>" | project TimeGenerated, App=tostring(split(_ResourceId,'/')[8]), ResultDescription | order by TimeGenerated asc`.
En Docker local hay un tablero «Logs» de Grafana que hace lo mismo ([ADR-0015](adr/0015-logs-y-alertas-en-docker-y-en-azure.md)).

**M1. Inspección continua.** Mostrar el panel de SonarCloud, la pestaña *Actions* (CI en verde: pruebas y análisis) y `node scripts/estado-calidad.mjs`. Para mostrar el **pipeline que se detiene**: en un repo,
crear una rama con una prueba que falle y abrir un pull request: el CI se pone en rojo y el despliegue no corre (solo corre tras un push a `main` con CI en verde). Para que también frene la puerta de calidad
de Sonar, crear la variable de repositorio `SONAR_ESPERAR_PUERTA=true` ([ADR-0014](adr/0014-sonarcloud-en-el-ci-y-puerta-de-calidad.md)); **solo cuando Sonar esté en verde**, si no bloquea todos los despliegues.

**D2. Falla la IA (cortacircuito).** *Por ensayar.* Hoy cursos en Azure no tiene llave de IA: siempre arma el roadmap con el respaldo. Para ver el cortacircuito abrirse, poner una llave inválida
(`az webapp config appsettings set -g rg-growlink -n growlink-cursos --settings CLAUDE_API_KEY=clave-invalida`), pedir 4 roadmaps seguidos (los 3 primeros fallan, el cuarto sale al instante con el respaldo),
mirar el tablero de negocio («roadmaps por origen») y **quitar la llave después** (`az webapp config appsettings delete ... --setting-names CLAUDE_API_KEY`). [ADR-0012](adr/0012-cortacircuito-delante-de-la-ia.md).

## 4. Para el bono (0,5 puntos): notas A, 80 % en el backend y 40 % en el front

Estado el 14 de noviembre (`node scripts/estado-calidad.mjs` lo muestra al momento):
- **usuarios:** puerta OK, cobertura 89 %, **solo falta marcar el CSRF** (abajo).
- **cursos, trivia y front:** SonarCloud todavía muestra el primer análisis automático. Hay que **volver a correr su CI** (*Actions* > CI > *Re-run all jobs*) con el secreto bien escrito
  (`SONAR_TOKEN`, una sola N, en *Repository secrets*) y apagado *Automatic Analysis*. Cobertura esperada: front 76 % (mínimo 40 %), backends 87 a 96 % (mínimo 80 %).
- **Falta marcar, en SonarCloud, dos alertas de CSRF como «Safe»** (usuarios `SecurityConfig:34` y cursos `SecurityConfig:77`), con este motivo: *la API autentica con un token en la cabecera
  y la sesión es STATELESS, no usa cookies, así que CSRF no aplica*. Lo decide y lo hace el equipo desde un usuario con permiso en SonarCloud. La nota «A» exige cero vulnerabilidades, incluso menores.
- Después de arreglar o marcar, **volver a correr CI otra vez** y comprobar con el script. Lo que sea falso positivo está explicado en [`sonarcloud-hallazgos.md`](sonarcloud-hallazgos.md).

## 5. Hallazgos abiertos (no esconderlos, se pueden decir en la presentación)

1. **El límite por IP no aguanta varias conexiones en Azure.** El registro del filtro muestra que cuenta la IP **con el puerto** (`181.61.204.192:3208`): cada conexión nueva empieza de cero, y el tope de 300 por minuto
   solo frena si todas las peticiones van por una misma conexión. El código del repo ya quita el puerto (`sinPuerto` en `LimitePorIpFilter`), así que hay que averiguar por qué el despliegue no lo aplica (qué forma
   trae `X-Forwarded-For` en Azure, o qué jar está desplegado) y corregirlo en usuarios y cursos. Además el filtro toma el **primer** valor de `X-Forwarded-For`, que un cliente puede inventar. *Sugerido: Mariana, que escribió el filtro.*
2. **Pausas ocasionales de 14 a 15 s** en la copia A y en las de otros planes (el plan compartido llegó al 76–89 % de memoria y 98 % de CPU). Se acotó el heap de las JVM; puede afectar P1. Se mide y se dice tal cual.
3. **En Docker, la conexión de trivia con RabbitMQ se cae y vuelve cada pocos minutos** y una de cuatro etapas perdió 3 de 6 salas ([README de infra](../README.md), sección «Autoescalado»). No se ha mirado en Azure: revisar con
   `AppServiceConsoleLogs | where ResultDescription has "BrokerAvailabilityEvent"`.
4. **Prometheus y Grafana en Azure quedan sin HTTPS y con dirección pública** (Container Instances no pone certificado). Solo muestran métricas de uso. Decirlo.
5. **Autoescalado:** no es el de Azure (ver [ADR-0010](adr/0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md)).
6. **El balanceador de nginx no revisa la salud:** una copia caída recibe tráfico hasta que falla la petición (cuesta ≤ 2 s) y se reintenta en otra.

## 6. El documento de arquitectura (entregable final, impreso)

Está en Docs («GrowLink: documento de arquitectura (Sprint 2)») y **no refleja el estado final**. Cambios que faltan:
- **3.1 D1 y D3:** el balanceador es el nginx del front con 3 copias de trivia en 3 servidores y 2 regiones; sin autoescalado de Azure; cuotas de la suscripción de estudiante.
- **3.2 S3** (ya implementado, con sus límites), **S4** (con el hallazgo 1), **3.3 M1** (CI con Sonar, el despliegue espera al CI, el bono), **3.4 P1** (mediciones de `medir-p1.sh`), **3.5 O1 y O2** (alertas y logs en Azure).
- **4 Arquitectura propuesta:** la Opción A (App Service con Front Door) **no es posible** (Front Door está prohibido en cuentas de estudiante): la decisión final es la de [ADR-0010](adr/0010-despliegue-con-balanceador-nginx-y-copias-de-trivia.md).
- **5 ADR:** renumerar como en `infra/docs/adr` (0007 identidad, 0008 cifrado, 0009 métricas, 0010 despliegue, 0011 tope por IP, 0012 cortacircuito, 0013 carga, 0014 Sonar, 0015 logs).
- **6.6 Diagrama de despliegue (obligatorio):** redibujar con la topología de la sección 1.
- **7 Cómo demostramos** y **9 Estado y riesgos:** las mediciones de D1, D3, P1, O1 y O2 se hacen en Azure (con el balanceador) y en Docker (autoescalado); poner esta guía como evidencia.
- Mínimo **5 diagramas UML** (hay 9 más el de despliegue), **drivers** y **ADR**: ya están. Exportar a PDF desde Docs (Exportar > PDF) e imprimir.
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
az webapp delete -g rg-growlink -n growlink-trivia-b && az appservice plan delete -g rg-growlink -n plan-trivia-b --yes
az webapp delete -g rg-growlink -n growlink-trivia-c && az appservice plan delete -g rg-growlink -n plan-trivia-c --yes
```
Si se borran las copias B y C, quitar `TRIVIA_URL_2` y `TRIVIA_URL_3` del front (o ponerlas iguales a `TRIVIA_URL`) y `TRIVIA_BROKER_RELAY_ENABLED` de la copia A.
Para volver al login de demostración: quitar `AUTH_MODE` de las 5 apps (usuarios, cursos y las 3 de trivia) y las 4 variables `VITE_*` del ambiente `actual` del front, y volver a desplegar el front.

## 9. Cómo se vuelve a desplegar

- Cambios en el front: un `push` a `main` (CI y, si sale bien, CD despliega solo).
- Cambios en los backends: `./scripts/azure/desplegar-backends.sh` (o `... trivia` para solo las tres copias). Trivia se sube de una en una: mientras una se actualiza el balanceador usa las otras.
- Tableros: `./scripts/azure/desplegar-metricas.sh` los recrea con lo que haya en `main` de este repo.
