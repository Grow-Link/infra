# SonarCloud: qué encontró y qué haremos con cada hallazgo

Fecha de la lectura: 13 de noviembre de 2026. Se leyó de los datos públicos de SonarCloud (organización `grow-link`,
un proyecto por repo: usuarios, cursos, trivia y front). **Es el análisis automático que hizo SonarCloud al importar los
repos**, no el del CI: todavía no hay cobertura ni puerta de calidad calculadas. Cuando corra el CI con el
secreto `SONAR_TOKEN`, estos números se actualizan (la cobertura aparece, la puerta de calidad se calcula y las etiquetas
*New* desaparecen); los hallazgos de código serán los mismos mientras no cambie el código.

## Regla para este documento

**Hoy no se marca nada en SonarCloud.** Marcar un hallazgo como *Safe* o *Falso positivo* borra una alerta de seguridad
de la vista de quien la revise después: se hace solo con el equipo de acuerdo y con un comentario que explique por qué.
Lo de abajo es una propuesta para decidir juntos, no una decisión tomada.

## Resumen

| Proyecto | Líneas | Seguridad | Fiabilidad | Mantenibilidad | Duplicación |
|---|---|---|---|---|---|
| usuarios-service | 2,9 k | E (3) | A | A | 0,0 % |
| cursos-service | 5,0 k | E (3) | A | A | 0,0 % |
| trivia-service | 4,6 k | E (2) | A | A | 0,4 % |
| GrowLink-FRONTEND | 18,3 k | C (9) | C (6 errores) | A | 1,1 % |

Cobertura: sin calcular (necesita el análisis del CI). El código de cifrado de esta semana (`CifradoFilter`,
`CifradoDeCanal`, `cifrado.ts`) no tiene ningún hallazgo.

## Hallazgos de los tres servicios Java

| # | Regla | Dónde | Qué dice | Qué creemos | Propuesta |
|---|---|---|---|---|---|
| 1 | `java:S6437` (BLOCKER) y `yaml:S2068` | `application.yml` línea 14, en los tres servicios | Una contraseña escrita en el código: `password: growlink` | **Falso positivo en cuanto a riesgo.** Es la contraseña por defecto de la base de datos *local de desarrollo* (el Postgres del `docker compose` de cada repo). La de Azure y la del Docker de `infra` son otras y viven solo en variables de entorno. Ver «Cómo quitarla» abajo | Candidato a falso positivo. Mejor aún, quitarla (abajo) |
| 2 | `java:S4502` (CRITICAL) | `SecurityConfig` de usuarios (l. 34) y de cursos (l. 77) | Se desactiva la protección CSRF | **Es lo correcto aquí.** CSRF solo ataca a las APIs que autentican con cookies. Estas autentican con un token en la cabecera `Authorization` y la sesión es `STATELESS`. Seguiría siendo cierto mientras nadie agregue autenticación por cookie | Candidato a *Safe*, con ese comentario |
| 3 | `java:S8786` (MAJOR) | `AuthModeConfig` de usuarios (l. 126) y de trivia (l. 106) | Una expresión regular que puede tardar mucho con entradas largas | **Real, riesgo bajo.** Hay que mirar sobre qué texto se aplica y si es antes de verificar la firma del token | No marcar. Revisar y simplificar |
| 4 | `java:S2699` (BLOCKER) | `LimiteDeGeneracionesTest` de cursos (l. 80) y `CierrePorTiempoTest` de trivia (l. 210) | Una prueba sin ninguna verificación | **Hay que abrir cada prueba.** Si verifica con otra herramienta que Sonar no reconoce, es falso positivo; si no verifica nada, falta la aserción | No marcar sin revisar la prueba |
| 5 | `java:S1845` (BLOCKER) | `RoadmapService` l. 45 (`cerrojos`/`CERROJOS`) y `PreguntaExamen` l. 33 (`opciones`/`OPCIONES`) en cursos | Dos campos cuyo nombre solo cambia en mayúsculas | **Real pero cosmético.** Renombrar toca código de Mariana | No marcar. Pendiente, después de la presentación |

## Hallazgos del front

| # | Regla | Dónde | Qué dice | Qué creemos | Propuesta |
|---|---|---|---|---|---|
| 6 | `typescript:S9383` (6 errores) | `NavigationContext`, `RetarPanel`, `CourseDetailPage`, `PublicProfilePage`, `ConcurrenciaEnVivo` | Promesas que no se esperan ni tienen `.catch` | **Reales**: un fallo en esas llamadas quedaría sin manejar | No marcar. Arreglar con `.catch` |
| 7 | `typescript:S8476` (MINOR) | `backendSession.ts` (función `send`) | Posible falsificación de petición desde el cliente | La dirección sale de constantes nuestras (`/api-usuarios`, `/api-cursos`, `/api-trivia`), no de lo que escribe una persona. Hay que confirmar que las partes variables de cada ruta se pasan por `encodeURIComponent` | Candidato a falso positivo, tras esa comprobación |
| 8 | `githubactions:S7637`, `S6505`, `S8543`; `docker:S6505` | `ci.yml`, `cd.yml`, `Dockerfile` | Acciones sin versión fija, `npm ci` sin `--ignore-scripts`, `npx` sin versión | **Reales**, son endurecimiento de la cadena de suministro, no fallos | No marcar. Mejora para después |
| 9 | `docker:S6471` (MINOR) | `Dockerfile` l. 22 | La imagen de nginx corre como `root` | Real. Cambiarla (nginx sin privilegios) cambia el puerto y la configuración de Azure: riesgo alto antes de presentar | No marcar. Mejora para después |
| 10 | `typescript:S6848`, `S6853`, `S9379` | Varias páginas | Accesibilidad: elementos clicables que no son botones, etiquetas sin control, `autoFocus` | Reales y menores | No marcar. Mejora para después |
| 11 | `typescript:S7767` | `EscenaJardin`, `MundoMap`, `AventuraMap` | Usar `Math.trunc` en lugar de `\| 0` | Falso positivo: es el generador de números al azar `mulberry32`, que usa `\| 0` para que la cuenta dé la vuelta como entero de 32 bits. `Math.trunc` **no** da la vuelta; cambiarlo alteraría los números y con ellos el dibujo del jardín y de los mapas (verificado leyendo el código) | Candidato a falso positivo |
| 12 | `css:S8778` | `index.css` l. 3 | `@import` fuera de lugar | Real y de una línea, pero afecta cómo se cargan las fuentes | No marcar. Arreglar probando en el navegador |
| — | Riesgos de dependencias (12, calificación C) | `package.json` | Paquetes de npm con avisos | Revisar con `npm audit`, sin actualizar a ciegas | No marcar |

## Cómo quitar la contraseña por defecto (hallazgo 1) sin afectar nada

Quién usa hoy ese valor y quién no:

| Entorno | ¿Depende del valor del `application.yml`? |
|---|---|
| Azure | No: tiene `SPRING_DATASOURCE_PASSWORD` en la configuración de cada app |
| Docker de `infra` | No: el compose pasa `SPRING_DATASOURCE_PASSWORD` desde el `.env` |
| `demo-sin-docker.ps1` | No: usa una base H2 en memoria y fija su propia variable |
| Pruebas (`mvn test`) | No: cada repo tiene su `application-test.yml` con H2 |
| `mvn spring-boot:run` con el Postgres local del repo | **Sí**: es el único que lo usa |

El cambio es de una línea por repo: `password: ${SPRING_DATASOURCE_PASSWORD:growlink}`. Mismo valor por defecto, así que
**nadie nota nada**, pero con la contraseña pasando por una variable. Es posible que Sonar siga avisando aunque quede el
valor por defecto: se prueba con un pull request antes de tocar `main`. Si sigue avisando, el hallazgo 1 queda como falso
positivo documentado y esa línea no se vuelve a tocar.

**No hay riesgo de perder el acceso a la base de datos de Azure con este cambio.** La contraseña real de Azure no está en
el repo: vive en dos sitios que este cambio no toca (el servidor PostgreSQL y las variables de cada app).

## Si no se marca nada

La nota de seguridad de los servicios seguirá en E por el hallazgo 1 (y la de usuarios y cursos también por el 2). El
documento de arquitectura debe decirlo así: es una contraseña de desarrollo, no un secreto de producción.
