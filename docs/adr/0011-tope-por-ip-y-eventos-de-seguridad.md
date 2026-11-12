# 0011. Un tope de peticiones por IP, y cada rechazo de seguridad contado y en el log

**Estado:** vigente (usuarios-service; el mismo filtro en cursos-service, con el arreglo del puerto pendiente allá) ·
**Atributos:** seguridad, disponibilidad, observabilidad

**Contexto.** Varios endpoints responden sin identificarse (el login de demostración, la salud, la documentación) y
cualquiera puede golpear también los que piden token: un script desde una sola red podía dejar al servicio sin hilos ni
conexiones a la base para los demás. Con el modo `oidc` (ver 0007) cada petición con token cuesta además verificar una
firma y buscar al usuario en la base. Y lo que se rechazaba no se veía: un emisor o una audiencia mal configurados en un
ambiente solo se notaban como "401" pelados en el navegador, y nadie podía decir si alguien estaba probando la puerta.

**Decisión.**
- **Tope por IP** (`LimitePorIpFilter`) a todas las peticiones, **antes** de la seguridad y de la base, que es donde
  rechazar sale barato. Va después de `InstanciaHeaderFilter` y `SolicitudIdFilter`, para que el rechazo lleve
  `X-Instancia` y `X-Request-Id`. Ventana fija por IP: más de `LIMITE_IP_MAXIMO_POR_MINUTO` (300) peticiones en
  `LIMITE_IP_VENTANA_SEGUNDOS` (60) reciben 429 con `Retry-After` y el mismo cuerpo de error del resto del servicio.
  Cada IP ocupa un contador y no la lista de sus peticiones, y se vigilan como mucho 50 000 IPs a la vez: pedir más rápido
  o desde más IPs no hace crecer la memoria sin límite. `0` lo apaga.
- **Cada réplica cuenta por su lado**, sin estado compartido (0002): con N réplicas el tope real es de hasta N veces el
  configurado.
- **La IP es el primer valor de `X-Forwarded-For`, sin el puerto**, y si no llega, la del socket (delante siempre hay un
  balanceador, y la del socket es la suya). Azure App Service manda el cliente como `IP:puerto`, y el puerto cambia con
  cada conexión: contado con puerto, cada conexión era una IP nueva y el tope nunca frenaba a nadie. Se quita de
  `203.0.113.7:51234` y de `[2001:db8::1]:51234`; una IPv6 sin corchetes se deja tal cual, porque sus `:` son de la
  dirección.
- **Tres eventos de seguridad contados** (`MetricasDeSeguridad`, Micrometer), cada uno con una línea `WARN` en el log que
  lleva el `X-Request-Id` (en el campo `rid` del log en JSON) y **nunca el token**:

  | Métrica | Qué cuenta |
  |---|---|
  | `growlink.seguridad.tokens-invalidos` | 401: el token falta o no pasó la verificación (el motivo exacto va al log, no al cliente) |
  | `growlink.http.limite-ip.rechazos` | 429: peticiones frenadas por el tope (mismo nombre en cursos-service, para sumarlos) |
  | `growlink.seguridad.prohibidos` | 403: pedir ADMIN sin estar en la lista, una llave interna que no cuadra, o una regla de autorización que dijo no |

**Consecuencias.**
- (+) Una red que abusa recibe 429 sin tocar la base ni verificar firmas, y las demás no se enteran (el tope es por IP).
- (+) Una subida sostenida de cualquiera de los tres contadores es la señal de que alguien está probando la puerta, y
  cada rechazo se puede seguir por su `rid` en los logs de los tres servicios.
- (+) Un ambiente mal configurado se diagnostica leyendo el log, sin adivinar desde el navegador.
- (−) El tope es por réplica: con N réplicas, hasta N veces lo configurado.
- (−) **Se confía en el primer valor de `X-Forwarded-For`, y ese valor lo puede escribir el cliente.** El nginx del
  frontend agrega la IP que ve al final (`$proxy_add_x_forwarded_for`) en vez de reemplazar la cabecera, así que quien
  mande su propia cabecera escoge con qué IP se le cuenta y puede esquivar el tope cambiándola. Pendiente: contar con la
  IP que puso el último proxy de confianza (o la que pone Azure Front Door en `X-Azure-ClientIP`), que depende de cómo
  quede montado Front Door.
- (−) Una red compartida (una universidad, una oficina detrás de una sola IP) comparte el tope: 300 por minuto entre
  todos.
- (−) Las métricas cuentan por réplica y se reinician con cada arranque; para verlas juntas hace falta el tablero de
  eventos de seguridad.
- Los contadores se publican en `/actuator/prometheus` (con el token del scrape) y se ven en el tablero de eventos de
  seguridad: ver [0009](0009-metricas-con-prometheus-y-tableros-en-grafana.md).
