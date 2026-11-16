# Diagramas de arquitectura de GrowLink

Copia en el repositorio de la sección 6 del documento de arquitectura (Sprint 2), actualizada el 16 de noviembre de 2026. El documento principal está en Claude Docs; aquí quedan los diagramas en formato Mermaid para que GitHub los dibuje y se puedan versionar.

Son diez diagramas: contexto, componentes, clases, dos de entidad-relación (usuarios y trivia), cuatro de secuencia y uno de despliegue. Lo que dice "nuevo" es lo que agregamos en este sprint.

## 6.1 Diagrama de contexto

Quién usa GrowLink y con qué sistemas externos se habla.

```mermaid
flowchart LR
  est["Estudiante"] --> gl
  pub["Publicador de cursos"] --> gl
  adm["Administrador"] --> gl
  gl["GrowLink: roadmap con IA, cursos, jardín y trivia en tiempo real"]
  gl -->|"pide roadmaps"| ia["API de Claude (externa)"]
  gl -->|"corre en"| az["Microsoft Azure"]
  gl -->|"código, CI/CD y análisis"| gh["GitHub y SonarCloud"]
```

## 6.2 Diagrama de componentes

Las piezas del sistema y quién habla con quién. El balanceador de carga es el nginx del front. Las líneas punteadas son las métricas, los logs y la verificación del token.

```mermaid
flowchart TB
  nav["Navegador: front React"] -->|"HTTPS y WSS"| lb["Balanceador de carga: nginx del front"]
  nav -->|"inicia sesión"| ms["Microsoft Entra ID"]
  lb --> usu["usuarios-service"]
  lb --> cur["cursos-service"]
  lb --> tri["trivia-service: tres copias"]
  usu -->|"HTTP con X-Request-Id y plazos"| cur
  cur -->|"HTTPS con plazo y cortacircuito"| ia["API de Claude"]
  usu --> dbu[("BD usuarios")]
  cur --> dbc[("BD cursos")]
  tri --> dbt[("BD trivia")]
  tri -->|"STOMP"| mq["RabbitMQ"]
  usu -.->|"verifica el token"| ms
  usu -.->|"métricas"| prom["Prometheus"]
  cur -.-> prom
  tri -.-> prom
  prom --> gr["Grafana: tableros de negocio, técnico y seguridad"]
  usu -.->|"logs"| la["Log Analytics"]
  cur -.-> la
  tri -.-> la
```

## 6.3 Diagrama de clases: módulo de roadmap

`RoadmapAiClient` es una interfaz con dos implementaciones: la IA real y el algoritmo de respaldo (es el patrón Strategy). Así podemos cambiar de una a otra sin tocar `RoadmapService`, y eso es lo que hace posible el escenario D2.

```mermaid
classDiagram
  class RoadmapController
  class RoadmapService {
    +generar()
    -esPropuestaValida()
  }
  class LimiteDeGeneraciones {
    +registrar()
  }
  class MetaValidator
  class PropuestaCache
  class MetricasDeRoadmap
  class CortacircuitoIA
  class RoadmapAiClient {
    <<interface>>
  }
  class ClaudeRoadmapAiClient
  class FallbackTopologicoRoadmapAiClient
  RoadmapController --> LimiteDeGeneraciones
  RoadmapController --> RoadmapService
  RoadmapService --> MetaValidator
  RoadmapService --> PropuestaCache
  RoadmapService --> MetricasDeRoadmap
  RoadmapService --> CortacircuitoIA : nuevo
  RoadmapService --> RoadmapAiClient
  RoadmapAiClient <|.. ClaudeRoadmapAiClient
  RoadmapAiClient <|.. FallbackTopologicoRoadmapAiClient
```

## 6.4 Diagramas entidad-relación

Cada servicio tiene su propia base de datos y no hay llaves foráneas entre servicios: cursos y trivia guardan el `usuarioId` como un número (ADR-0001). Lo marcado como "nuevo" es lo que agrega el login con Microsoft (el identificador de la persona en el proveedor, su correo y si ya eligió su rol). Mostramos usuarios y trivia; cursos no cambia en este sprint.

**usuarios-service**

```mermaid
erDiagram
  USUARIO ||--o| PERFIL : tiene
  USUARIO ||--o{ SEMILLA : gana
  USUARIO {
    long id PK
    string nombre
    string rol
    string cargo
    string proveedor_sub "nuevo"
    string correo "nuevo"
    boolean rol_elegido "nuevo"
  }
```

**trivia-service**

```mermaid
erDiagram
  SALA_TRIVIA ||--o{ SALA_PARTICIPANTE : tiene
  SALA_TRIVIA ||--o{ SALA_PREGUNTA : tiene
  SALA_PREGUNTA ||--o{ RESPUESTA_SALA : recibe
  SALA_TRIVIA ||--o{ METRICA_EVENTO : registra
  SALA_TRIVIA ||--o| PARTIDA_RESULTADO : termina_en
  PARTIDA_RESULTADO ||--o{ PARTIDA_PUESTO : ordena
  SALA_TRIVIA {
    long id PK
    string codigo
    string categoria
    long hostUsuarioId
    int numPreguntas
    int duracionSegundos
    string estado
    datetime creadaEn
    string revanchaCodigo
  }
```

## 6.5 Diagramas de secuencia

**Entrar con Microsoft (S1).** Cómo se obtiene el token, cómo lo verifica el servicio y qué pasa cuando no es válido.

```mermaid
sequenceDiagram
  actor P as Persona
  participant F as Front React
  participant MS as Microsoft Entra ID
  participant LB as Balanceador
  participant U as usuarios-service
  participant BD as BD usuarios
  P->>F: inicia sesión
  F->>MS: abre la ventana de Microsoft (MSAL)
  MS-->>F: token firmado
  F->>LB: petición con el token por HTTPS
  LB->>U: reenvía a una instancia sana
  U->>MS: toma las llaves públicas (JWKS, con caché)
  alt firma, emisor, audiencia y vencimiento correctos
    U->>BD: busca al usuario por sub o lo crea la primera vez
    U-->>F: datos del usuario y su rol
  else token inválido
    U-->>F: 401 y se cuenta el evento de seguridad
  end
```

**Responder en una trivia (****S1 y P1).** Por qué todos ven el mismo ranking aunque estén conectados a instancias distintas.

```mermaid
sequenceDiagram
  actor J as Jugador
  participant F as Front
  participant LB as Balanceador
  participant T as trivia-service, cualquier instancia
  participant BD as BD trivia
  participant MQ as RabbitMQ
  participant OT as Otras instancias y sus jugadores
  J->>F: entra a la sala
  F->>LB: conecta por WSS con el JWT
  LB->>T: reenvía a una instancia sana
  T->>T: valida el JWT y toma la identidad del token
  J->>F: responde la pregunta
  F->>T: envía la respuesta por STOMP
  T->>BD: registra la respuesta con una actualización atómica
  T->>MQ: publica el resultado en el canal de la sala
  MQ-->>OT: reparte el mensaje a todas las instancias
  OT-->>J: el ranking llega a toda la sala
```

**Se cae una copia de trivia en plena partida (D1).** Qué hace el balanceador y qué hace el jugador cuando una de las copias deja de contestar.

```mermaid
sequenceDiagram
  actor J as Jugador
  participant F as Front en el navegador
  participant LB as nginx del front
  participant A as Copia caída de trivia
  participant B as Otra copia de trivia
  participant BD as BD trivia
  J->>F: juega una partida
  F->>LB: conexión de tiempo real
  LB->>A: la manda a la copia elegida
  Note over A: la copia se apaga en plena partida
  A--xF: se corta la conexión
  F->>F: espera unos 3 segundos y reconecta
  F->>LB: nueva conexión
  LB->>A: intenta con la copia elegida
  A--xLB: no contesta (502, 503, 504 o 403)
  LB->>B: reintenta en la siguiente copia, con 2 segundos perdidos como máximo
  B->>BD: lee la sala y el estado de la partida
  B-->>F: el jugador sigue en su sala
```

**Seguir una petición por todos los servicios (O2).** Cómo un solo identificador junta las líneas de log de usuarios y cursos.

```mermaid
sequenceDiagram
  actor P as Persona
  participant LB as nginx del front
  participant U as usuarios-service
  participant C as cursos-service
  participant LA as Log Analytics
  P->>LB: abre el Home
  LB->>LB: crea el X-Request-Id
  LB->>U: petición con el identificador
  U->>C: pide el roadmap con el mismo identificador
  C-->>U: responde
  U-->>P: respuesta con el identificador en la cabecera
  U->>LA: línea de log con el identificador
  C->>LA: línea de log con el mismo identificador
  Note over P,LA: una búsqueda por el identificador en Log Analytics trae las dos líneas
```

## 6.6 Diagrama de despliegue

**Cómo quedó desplegado en Azure (grupo de recursos rg-growlink).** El front con su nginx, usuarios, cursos y la copia A de trivia comparten un plan B2 en Canada Central. La copia D y la copia C de trivia tienen cada una su propio plan B2, en East US y en East US 2. La base de datos PostgreSQL, RabbitMQ, Prometheus y Grafana están en Canada Central. Ningún componente comparte servidor con todos los demás, y apagar una copia de trivia no corta el servicio. La opción B (máquinas virtuales) no se construyó, por eso no la dibujamos.

```mermaid
flowchart TB
  nav["Navegador"]
  gha["GitHub Actions: pruebas, Sonar y despliegue"] -->|"despliega"| pc
  gha -->|"despliega"| pd
  gha -->|"despliega"| pe
  ms["Microsoft Entra ID"]
  subgraph pc["Plan compartido B2, Canada Central"]
    fe["front con nginx: el balanceador de carga"]
    us["usuarios-service"]
    cu["cursos-service"]
    ta["trivia, copia A"]
  end
  subgraph pd["Plan B2, East US"]
    td["trivia, copia D"]
  end
  subgraph pe["Plan B2, East US 2"]
    tc["trivia, copia C"]
  end
  subgraph dat["Datos y mensajes, Canada Central"]
    pg[("PostgreSQL administrado: una BD por servicio")]
    mq["RabbitMQ en Azure Container Instances"]
  end
  subgraph obs["Observabilidad, Canada Central"]
    pr["Prometheus en Container Instances"]
    gr["Grafana en Container Instances"]
    la["Log Analytics"]
  end
  nav -->|"HTTPS y WSS"| fe
  fe -->|"40 %"| ta
  fe -->|"40 %"| td
  fe -->|"20 %"| tc
  fe --> us
  fe --> cu
  us --> pg
  cu --> pg
  ta --> pg
  td --> pg
  tc --> pg
  ta --> mq
  td --> mq
  tc --> mq
  cu -->|"HTTPS"| ia["API de Claude, externa"]
  us -.->|"verifica tokens"| ms
  pr -.->|"lee las métricas de las cinco aplicaciones"| us
  pr -.-> cu
  pr -.-> ta
  pr -.-> td
  pr -.-> tc
  pr --> gr
  us -.->|"logs"| la
  cu -.-> la
  ta -.-> la
  td -.-> la
  tc -.-> la
```
