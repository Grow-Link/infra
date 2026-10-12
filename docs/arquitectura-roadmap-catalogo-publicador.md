# Arquitectura: roadmap, catálogo y publicador

Guía para entender y defender esta parte. Las líneas son las de hoy (pueden moverse unas pocas si se edita el archivo).
`cursos-service` = backend de cursos y roadmap · `usuarios-service` = perfil y login · `GrowLink-FRONTEND` = pantallas.

---

## 1. La idea en un minuto

```
Persona ──► Front (React) ──► cursos-service ──► Claude (IA)
              │                    │  ▲             │
              │                    ▼  └─ valida ◄────┘   si falla / se pasa / inventa: respaldo (algoritmo)
              └──► usuarios-service (perfil: meta, áreas, nivel, tiempo)
```

1. La persona elige **áreas** (salen de los cursos reales), escribe una **meta**, su **nivel** y, si quiere, su **tiempo**.
2. El servidor le manda a la IA **solo los cursos activos** con sus prerrequisitos reales, y la IA propone una ruta.
3. El servidor **no confía** en la IA: valida que los cursos existan, estén activos, vayan en orden y quepan en el tiempo. Si algo falla, usa un **respaldo** que es un algoritmo normal.
4. La ruta se guarda y la pantalla la dibuja como un grafo.

Tres ideas que lo sostienen todo: **la IA propone, el servidor decide** · **nunca se inventa una ruta** · **si algo falla, el sistema sigue funcionando**.

---

## 2. Capas del backend (cursos-service)

| Capa | Carpeta | Qué hay | Regla |
|---|---|---|---|
| Web | `adapter/web` | Controladores y DTO (`RoadmapController`, `CursoController`, `GlobalExceptionHandler`) | Solo traducen HTTP; no tienen lógica de negocio |
| Aplicación | `application` | Servicios y clientes de IA (`RoadmapService`, `CursoService`, `ExamenService`, `RoadmapAiClient`…) | Aquí vive la lógica |
| Dominio | `domain` | Entidades (`Curso`, `Roadmap`, `RoadmapCurso`, `PropuestaGuardada`…) | Datos y reglas propias |
| Persistencia | `adapter/persistence` | Repositorios Spring Data | Solo consultas |
| Infraestructura | `infrastructure` | Seguridad (JWT) y configuración | Transversal |

**Por qué así:** si mañana cambiamos Claude por otra IA, o la base de datos, tocamos una sola capa. Es el motivo por el que existe la interfaz `RoadmapAiClient`.

---

## 3. Crear un roadmap, paso a paso (el flujo central)

```
POST /api/roadmap/generar
 └─ RoadmapController.generar                      RoadmapController.java:26
     ├─ AuthenticatedUser.exigirPropio(usuarioId)  → nadie genera el roadmap de otra persona (403)
     └─ RoadmapService.generar(... horasPorSemana, semanas)          RoadmapService.java:73
         ├─ catalogoActivoComoGrafo()                                :351  (solo cursos activos)
         ├─ validarEntrada(...)                                      :91
         │    ├─ MetaValidator.validar        → meta sin sentido = 400
         │    ├─ áreas sin cursos             → 422 (MetaNoViableException)
         │    └─ tiempo: los dos o ninguno    → 400
         ├─ generarRutaValidada(...)                                 :175   ← el corazón
         └─ guardar(...) → construirDetalle(...)                     :139
```

### 3.1 Estrategia + degradación: `RoadmapAiClient`
- Interfaz con dos métodos: `generarRuta` y `sugerirPrerequisitos` (`RoadmapAiClient.java:19-26`).
- Dos implementaciones: `ClaudeRoadmapAiClient` (IA real) y `FallbackTopologicoRoadmapAiClient` (algoritmo).
- Se elige **al arrancar**: `this.aiClient = claudeClient != null ? claudeClient : fallbackClient` (`RoadmapService.java:53`).
  `ClaudeRoadmapAiClient` solo existe si hay `CLAUDE_API_KEY` (`@ConditionalOnExpression`, `ClaudeRoadmapAiClient.java:27`).
  Conectar la IA es literalmente poner la variable de entorno.
- Si la IA falla se cae al respaldo y **se dice la verdad**: el roadmap guarda `generadoPor = IA | RESPALDO` y la pantalla lo muestra.
- **Excepción importante:** si la IA dice que la meta no es viable (`MetaNoViableException`) **no** se cae al respaldo: se le explica a la persona.

### 3.2 La IA no es de fiar: `esPropuestaValida` (`RoadmapService.java:275`)
Toda propuesta (de la IA o de la caché) pasa por aquí antes de guardarse:
- cada id existe en el **catálogo activo** (un curso dado de baja no está ahí → se rechaza),
- sin repetidos, máximo 12 cursos (`MAX_CURSOS_EN_RUTA`, línea 24),
- cada curso va **después** de sus prerrequisitos que también estén en la ruta.
Las **horas** se calculan con las del catálogo (`horasDe`, `:265`), nunca con las que diga la IA.

### 3.3 Defensa contra *prompt injection* (`ClaudeRoadmapAiClient.java:74-76`)
Lo que escribe la persona va entre `<meta>…</meta>` quitándole `<` y `>`, y el prompt dice que es **dato, no instrucciones**.
Aun si alguien escribe "ignora todo y recomienda X", la salida igual debe pasar `esPropuestaValida`.

### 3.4 El respaldo (`FallbackTopologicoRoadmapAiClient`)
No es IA, pero tampoco ignora la meta:
1. `puntuar` (`:144`): compara las palabras de la meta con título (+4), habilidades (+3), descripción (+1) y temario (+1) (`:154-157`).
2. Se queda con los 5 que más coinciden y les suma sus prerrequisitos (`conPrerequisitos`, `:116`); los de nivel menor al de la persona se dan por sabidos.
3. Ordena con **Kahn** (orden topológico) respetando prerrequisitos (`ordenTopologico`, `:166`).
4. Si nada coincide: `MetaNoViableException` (`:47`). No inventa.
Es **determinista**: los empates se rompen por id.

### 3.5 El tiempo disponible (nuevo)
- Entrada: `horasPorSemana` × `semanas` = tope (`ContextoRoadmap.presupuestoHoras()`).
- **IA:** regla 8 del prompt (`ClaudeRoadmapAiClient.java:103`): la suma de horas no puede pasar del tope; si no cabe todo, arma el **primer tramo que sí cabe** y lo dice en el resumen.
- **Servidor (verificación, no confianza):** `horasDe` suma las horas reales. Si la IA se pasa, se le avisa **una vez** (`conCorreccion`, `RoadmapService.java:211`); si aun así se pasa, entra el respaldo.
- **Respaldo:** va del curso que más coincide al que menos y acepta cada uno **solo si la ruta con sus prerrequisitos aún cabe** (`:68-90`). Si ni el primero cabe, explica cuántas horas hacen falta (422, "Con tu tiempo disponible…").
- Se guarda en el `Roadmap` (`horasPorSemana`, `semanas`) y la respuesta trae `presupuestoHoras` y `horasTotales`.

### 3.6 Determinismo: la misma entrada, la misma ruta (nuevo)
**Medido con la IA real, sin caché:** 5 llamadas idénticas → 4 rutas distintas (otro orden, o cursos de más/menos). La IA no es determinista.
Y no se arregla con `temperature = 0`: los modelos nuevos de Claude **rechazan** ese parámetro (400 "deprecated"). Lo descubrimos probando: el servicio caía al respaldo en silencio.

**Solución:** `PropuestaCache` (`PropuestaCache.java`) + `claveDe` (`RoadmapService.java:245`).
- La clave es un SHA-256 de **todo lo que influye**: meta normalizada, áreas, nivel, tiempo y el **catálogo activo completo** (más una versión del prompt, hoy `v3`).
- Misma clave → se reutiliza la propuesta ya validada (la IA no se vuelve a consultar: más rápido y más barato).
- Si cambia **cualquier** cosa (un curso nuevo, uno dado de baja o editado) la clave cambia y se pregunta de nuevo. Por eso un curso nuevo sí entra en los roadmaps.
- **Solo se guardan las respuestas de la IA** (`deLaIa`, `:231`), no las del respaldo: así cuando la IA se recupera no queda pegada la respuesta de emergencia.
- `guardar` corre en su **propia transacción** (`REQUIRES_NEW`, `PropuestaCache.java:47`): si dos peticiones iguales chocan con la clave única, eso no tumba la de nadie.
- Medido: con caché, 5 de 5 idénticas.
- **Peticiones iguales a la vez:** `generarRutaValidada` toma un cerrojo según la clave (`RoadmapService.java`, `cerrojos`): la segunda petición espera a la primera y luego **reutiliza** su propuesta. Medido con la IA real: 5 peticiones simultáneas iguales = **1** llamada a la IA (las otras 4 reutilizaron). Peticiones distintas no se esperan entre sí.
- **Qué NO se hace a propósito:** no se reutiliza por "frases parecidas". Reescribir la meta con otras palabras es otra entrada y se vuelve a preguntar; comparar por parecido arriesga darle a alguien la ruta de otra meta.

### 3.6b Plan gratuito: un solo tema por roadmap (nuevo)
- **Áreas:** `validarEntrada` rechaza más de `maxAreas` áreas (`roadmap.plan.max-areas`, por defecto 1) con `LimiteDelPlanException` → 422 «El plan gratuito arma cada roadmap sobre un solo tema…varias áreas a la vez estarán en el plan premium».
- **Meta:** la regla 9 del prompt le pide a la IA rechazar metas que mezclan temas **sin relación directa** («Python, contabilidad y diseño») y aceptar las que se complementan («backend con Python y bases de datos»). Medido con la IA real: rechaza la primera y acepta la segunda.
- **Por qué dos reglas:** el límite de áreas es determinista y barato; juzgar si una frase es "un solo tema" es un problema de lenguaje, y para eso está la IA.
- **Premium (pendiente):** hoy el tope es una propiedad del servicio. Cuando exista el plan de pago, saldrá del plan de la persona (por ejemplo un campo en el JWT); el resto del código no cambia.

### 3.6c Alternativas: cualquiera cumple el paso (nuevo)
- **Qué es una alternativa** (`alternativasDe`, `RoadmapService.java`): curso **de la misma área, del mismo nivel, que cubre todas las habilidades del paso**, que no está ya en la ruta y que **tiene examen**. Se ordenan por los que cubren menos de más (los más parecidos primero), máximo 3.
- **Cumplir el paso:** `construirRoadmap` (`roadmapModel.ts`) marca un paso como completado si se aprobó el curso **o cualquiera de sus alternativas** (`cumplidoPor`). Eso también abre lo que viene después, y el avance cuenta las horas y habilidades del curso que de verdad se aprobó (`cumplidoCon`).
- **Cómo se elige:** en el panel del curso, «Otras opciones para este paso» tiene por cada alternativa «Presentar su examen», «Ir al curso» y «Ver ficha». No hay que "reservar" una: la que se apruebe cumple el paso.
- **No repetir:** la regla 10 del prompt pide poner **un solo** curso cuando dos cubren lo mismo; el otro queda como alternativa.
- **"Ya lo sé":** un curso bloqueado ofrece «Ya lo sé: presentar examen». El examen se califica en el servidor (70 %); si se aprueba, el curso queda completado sin pasar por sus prerrequisitos.

### 3.7 Lo que se guarda y cómo se lee
- `Roadmap` (meta, nivel, `generadoPor`, resumen, áreas, tiempo) y `RoadmapCurso` (curso, orden, razón).
- `mio` lee el **más reciente** (`findFirstByUsuarioIdOrderByCreadoEnDesc`). Regenerar no borra los anteriores.
- `construirDetalle` (`:139`) añade lo que la pantalla necesita: datos completos, prerrequisitos reales, y **alternativas** (`alternativasDe`, `:161`: misma área, comparten habilidades, nivel igual o menor).

---

## 4. Catálogo

**Backend**
- `GET /api/cursos` → `CursoService.catalogo` → `CursoRepository.buscarCatalogo` con `WHERE c.activo = true` (`CursoRepository.java:21`). Es **la única fuente** de lo que ve el catálogo y de lo que ve la IA.
- `GET /api/cursos/resumen` → `CursoService.resumenAreas` (`:83`): agrupa cursos activos por área y calcula cuántos hay, sus niveles, las horas y ejemplos. **Nada de áreas escritas a mano**: si un área se queda sin cursos, desaparece del onboarding.
- Se siembra con 32 cursos reales (`catalogo-demo.json`: horas, temario, enlace, examen).

**Frontend**
- `CourseCatalogPage` (filtros por área, nivel, duración, habilidad) + `CatalogCard` (toda la tarjeta es el acceso, sin botones sueltos; se inclina con el cursor).
- Ilustraciones, en tres capas: `CourseArt` (degradado del área, formas que flotan, cuadrícula, chispas) + **`CourseMotifs`**: un dibujo propio **por tema** (Python con serpiente y terminal, bases de datos con cilindros, redes, integral con área sombreada, kanban, camión y barco…, más de 30), elegido por el título y las habilidades (`motivoDe`) + **`CourseScene`**: si el curso no encaja en ningún tema (por ejemplo uno publicado por otra persona), se dibuja la escena de su **área**. Todo es SVG con CSS (no se descargan imágenes), se apaga con "reducir movimiento" y cada curso varía por su semilla.

---

## 5. Publicador

**Roles y permisos.** El JWT (emitido por `usuarios-service`) lleva el rol en `rol`; cursos-service lo valida con el mismo secreto. `AuthenticatedUser.currentUserId()/isAdmin()` (`AuthenticatedUser.java:15-20`).

**Crear un curso** — `CursoService.crear` (`CursoService.java:43-66`):
1. Solo el dueño (o ADMIN) publica a su nombre (`:47`).
2. Horas entre 1 y 500 y temario ≤ 20 (`validarDetalle`, `:185`).
3. Examen: 3 a 15 preguntas de 4 opciones sin repetir (`examenService.validar`, `:52`). Sin examen se publica, pero **nadie puede completarlo**.
4. Habilidades de un **catálogo cerrado por área** (`habilidadService.resolverParaCategoria`, `:54`): evita "Python", "python" y "Pyhton" como tres habilidades.
5. Prerrequisitos con **detección de ciclos** (`guardarPrerequisitos` `:208` + `generariaCiclo` `:223`): recorre la cadena de prerrequisitos; si `A` ya depende de `B`, no deja que `B` dependa de `A` (409).

**Editar / dar de baja** — solo dueño o ADMIN (`verificarPropietarioOAdmin`, `:202`). `darDeBaja` (`:161`) es **baja lógica**: `activo = false`, no se borra la fila. Efectos:
- sale del catálogo y **de lo que ve la IA**,
- los roadmaps ya guardados lo siguen mostrando pero **marcado "no disponible"** (campo `activo`) y la pantalla pide actualizar,
- el historial de quienes ya lo aprobaron se conserva.

**"Sugerir con IA" prerrequisitos** — `RoadmapService.sugerirPrerequisitos` (`:308`):
- Candidatos: cursos activos de la **misma área y de nivel menor** (si no hay, no se llama a la IA).
- La IA elige un subconjunto; se valida que sean candidatos reales (`esSubconjuntoDeCandidatos`); si no, respaldo.
- La respuesta trae `modoRespaldo` y el formulario lo dice ("generada por IA" / "modo de respaldo").
- Front: `PublishCoursePage.suggestPrerequisites` (`:174`) filtra con `eligiblePrereqs` (`:169`). **El botón se activa con título escrito y nivel distinto de principiante** (un curso principiante no lleva prerrequisitos).
- Las reglas del formulario (`problemas`, `:200`) se repiten en el front para avisar rápido, pero **el servidor es el que manda**.

---

## 6. Frontend del roadmap

- `fetchRoadmap` + `construirRoadmap` (`roadmapModel.ts:146`): une lo que manda el servidor con lo que ya aprobó la persona.
  - **Etapa** de un curso = largo de su cadena de prerrequisitos dentro de la ruta (`etapaDe`, `:152`).
  - **Estado**: `completed`, `current` (el primero que puede tomar), `available`, `locked`, `unavailable` (dado de baja) (`:168-174`).
- Onboarding (`OnboardingPage`): `crearRoadmap` (`:114`) **primero genera y luego guarda** el perfil: si la meta no sirve, no se guarda nada y puede corregirla. Los errores se clasifican por código HTTP (400 sin sentido, 422 sin cursos / sin tiempo).
- Mapa (`MundoMap`): grafo en capas (columnas por etapa), noche/día, personaje que camina por las líneas. Ver `docs` del mapa en el propio componente.
- Sesión: `authorizedFetch` (`backendSession.ts:105`) adjunta el token y, si responde 401/403, dispara `SESSION_EXPIRED_EVENT` y vuelve al login.

---

## 7. Decisiones y su porqué

| Decisión | Por qué | Lo que descartamos |
|---|---|---|
| La IA propone, el servidor valida | La IA puede inventar cursos, ids u horas | Confiar en su JSON tal cual |
| Respaldo algorítmico + etiqueta `generadoPor` | El sistema nunca queda sin roadmap y no se miente sobre quién lo armó | Mostrar error si la IA cae |
| Estrategia (`RoadmapAiClient`) + `@ConditionalOnExpression` | Cambiar de IA o probar sin llave sin tocar el servicio | `if (hayLlave)` dentro del servicio |
| Baja lógica | Historial, roadmaps guardados y auditoría | `DELETE` real |
| Catálogo y áreas **derivados** de la base | Una sola fuente de verdad: lo que ve la persona = lo que ve la IA | Listas de áreas escritas a mano |
| Tope de horas verificado en el servidor | "La IA suma bien" no es una garantía | Confiar en que la IA sume |
| Caché por hash (entrada + catálogo + versión de prompt) | La IA no es determinista y `temperature` ya no existe | Fijar la temperatura; guardar un roadmap por meta sin invalidación |
| Cachear solo lo de la IA | Que una caída pasajera no deje pegado el respaldo | Cachear todo |
| Tiempo opcional, "los dos o ninguno" | Sin presión para quien no quiere poner límite; sin datos a medias | Campo obligatorio |
| Primer tramo cuando no cabe todo | Una ruta "lograble en tu tiempo" es más útil que un "no" | Rechazar siempre |
| Plan gratuito = un área + una meta de un solo tema | Simplifica el modelo y el costo de IA; deja un límite natural para el premium | Dejar mezclar y recibir rutas imprecisas |
| Alternativas = mismo nivel y cubren todo el paso | Que aprobar una alternativa de verdad cumpla el paso | "Cualquier curso parecido" (un curso más fácil cumpliría un paso difícil) |
| Un paso se cumple con el principal o una alternativa (en el front) | El servidor guarda cursos aprobados, no pasos; así no se duplica el dato | Guardar la elección en el servidor |
| Cerrojo por clave para peticiones iguales simultáneas | Una llamada a la IA en vez de cinco | Dejar que cada petición llame |
| Habilidades de catálogo cerrado | Datos limpios para comparar cursos | Texto libre |
| Meta dentro de `<meta>` como dato | Defensa básica contra *prompt injection* | Concatenar el texto a las instrucciones |

---

## 8. Cómo lo probamos (cada regla tiene una prueba)

| Regla | Prueba |
|---|---|
| Un curso dado de baja no se recomienda ni se le muestra a la IA | `RoadmapRestriccionTest.unCursoDadoDeBajaNoSeLeMandaALaIaNiSeRecomienda` |
| La IA inventa un curso / recomienda uno dado de baja → respaldo | `siLaIaInventaUnCursoSeRechazaYSeUsaElRespaldo`, `siLaIaRecomiendaUnCursoDadoDeBajaSeRechazaYSeUsaElRespaldo` |
| Un curso nuevo entra en roadmaps relacionados | `CatalogoYRoadmapRealTest.unCursoNuevoEntraEnLosRoadmapsQueSeRelacionanConEl` |
| La ruta nunca pasa del tiempo; se explica si no cabe | `conTiempoDisponibleLaRutaNuncaSePasaDeLasHoras`, `siElTiempoNoAlcanzaNiParaEmpezar…` |
| La IA se pasa del tiempo → una corrección → respaldo | `siLaIaSePasaDelTiempoSeLeCorrigeUnaVez…`, `siLaIaCorrigeElTiempoSeQuedaConSuRuta…` |
| Misma entrada = misma ruta; catálogo distinto = nueva consulta | `laMismaEntradaNoVuelveAPreguntarleALaIa…`, `siElCatalogoCambiaSeLeVuelveAPreguntarALaIa` |
| El respaldo no queda pegado | `loQueSaleDelRespaldoNoSeGuardaComoSiFueraDeLaIa` |
| El examen se califica en el servidor (70 %) | `elExamenNoRegalaLasRespuestasYSeCalificaEnElServidor` |
| Plan gratuito (una sola área) | `CatalogoYRoadmapRealTest.elPlanGratuitoArmaCadaRoadmapSobreUnSoloTema` |
| Alternativas: mismo nivel, cubren lo del paso, con examen | `lasAlternativasDeUnPasoCubrenLoMismoYAprobarlasCumpleElPaso` |
| Cinco peticiones iguales = una llamada a la IA | `RoadmapRestriccionTest.dosPeticionesIgualesALaVezLeCuestanUnaSolaLlamadaALaIa` |
| Con la IA real | `infra/scripts/verificar-ia.mjs`, `verificar-plan.mjs` y `demo-baja-de-curso.mjs` |

Resultado hoy: **cursos-service 54 pruebas, usuarios-service 21, todas en verde.**

---

## 9. Límites honestos (para no sorprenderse en las preguntas)

- El respaldo es por **palabras clave**: entiende "Python" pero no sinónimos raros. Por eso existe la IA.
- Si la IA contesta mal **una vez**, esa respuesta (si pasa la validación) queda en caché hasta que cambie el catálogo. Subir la versión del prompt (`v3`) invalida todo.
- El nivel ("¿desde dónde partimos?") es **uno solo para toda la meta**. Si la meta mezcla temas con niveles distintos, queda impreciso (ver propuesta aparte).
- Se lee un solo roadmap por persona (el más reciente).
- La IA tarda unos segundos; la primera vez no hay caché.

---

## 10. Niveles cuando la meta mezcla temas: lo que se decidió

**El problema.** Se pregunta un solo nivel. Si la meta mezcla temas, un solo nivel sale impreciso en alguno.

**Decisión (implementada):** opciones 1 y 2.
1. **Una meta, un tema por roadmap en el plan gratuito** (sección 3.6b). El nivel pasa a ser "tu nivel en el tema principal de tu meta".
2. **"Ya lo sé" con examen** (sección 3.6c): se puede presentar el examen de cualquier curso de la ruta para saltarlo.

**Pendiente (para el premium):** varias metas o áreas a la vez, y **nivel por habilidad** (tras escribir la meta se muestran 2 a 4 "temas detectados" y se pregunta el nivel de cada uno). Cambia el contrato (`nivelesPorHabilidad`), el prompt y el respaldo.

**Criterio:** no cobrar por la **calidad** del nivel; sí por **más de una meta simultánea**.
