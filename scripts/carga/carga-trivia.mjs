// Prueba de carga de la trivia en vivo (ver ADR-0013): juega partidas completas por WebSocket con cada vez mas
// jugadores a la vez (por defecto 10, 25, 50, 75 y 100) y dice, por etapa, cuanto tardo cada paso: p50, p95 y p99.
// Es la que sirve para buscar el cuello de botella de trivia-service. Hace falta Node 22 o mas nuevo.
//
//   npm run trivia                              las cinco etapas contra trivia-service en localhost
//   ETAPAS=10,50,100 POR_SALA=10 npm run trivia otras etapas y otro tamano de sala
//   ESPERA_MAX_MS=0 npm run trivia              todos contestan al instante (el peor caso para los candados)
//   META_P95_MS=300 META_ERRORES_PCT=1 npm run trivia   y dice si se cumplio la meta (si no, termina con codigo 1)
//
// Cada jugador tiene su propio WebSocket, como en el navegador. Por etapa se mide:
//   respuesta   desde que el jugador manda su respuesta hasta que le llega la confirmacion (RESPUESTA_REGISTRADA):
//               es la ida y vuelta por el servidor, la base de datos y el broker (RabbitMQ con varias replicas).
//               Es la medida principal: lo que siente la persona al tocar una opcion.
//   reparto     cuanto pasa entre el primer y el ultimo jugador de una sala que reciben la misma pregunta. Se mide
//               con el reloj de esta maquina (no con el del servidor), asi que no depende de relojes sincronizados.
//   unirse      desde que manda "unirse" hasta que se ve en la lista de la sala
//   conectar    abrir el WebSocket y el CONNECT de STOMP
//   crear sala  el POST /api/salas
//
// Los jugadores son de mentira: ids desde USUARIO_BASE (900000), que no existen en usuarios-service, para no
// llenarle las estadisticas a las personas de prueba. Al terminar cada partida trivia-service intenta sumarle la
// victoria al ganador y usuarios-service no lo encuentra: queda un aviso en el log de trivia, y es lo esperado.
//
// Funciona con AUTH_MODE=legacy (el CONNECT va sin token, como el de la prueba de humo). Con Microsoft no hay forma
// de sacar tokens para cien personas de mentira.
//
// Por defecto habla con trivia-service directo en localhost. Con el compose:
//   URL_TRIVIA=http://localhost:3000/api-trivia WS_TRIVIA=ws://localhost:3000/ws-trivia npm run trivia

import { Client } from '@stomp/stompjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contar, evaluarMeta, ms, numeroDelEntorno, repartir, resumen, tabla } from './estadisticas.mjs';

const TRIVIA = process.env.URL_TRIVIA ?? 'http://localhost:8085';
const WS = process.env.WS_TRIVIA ?? 'ws://localhost:8085/ws';
const ETAPAS = (process.env.ETAPAS ?? '10,25,50,75,100').split(',').map((v) => Number(v.trim()));
const POR_SALA = numeroDelEntorno('POR_SALA', 5);
const PREGUNTAS = numeroDelEntorno('PREGUNTAS', 5);
const DURACION = numeroDelEntorno('DURACION', 10);
const ESPERA_MAX_MS = numeroDelEntorno('ESPERA_MAX_MS', 1500);
const CATEGORIA = process.env.CATEGORIA ?? 'INGENIERIA_SISTEMAS';
const USUARIO_BASE = numeroDelEntorno('USUARIO_BASE', 900000);
const PLAZO_PARTIDA_MS = numeroDelEntorno('PLAZO_PARTIDA_MS', 120000);
const PLAZO_CONEXION_MS = numeroDelEntorno('PLAZO_CONEXION_MS', 10000);
const META_P95_MS = process.env.META_P95_MS ? numeroDelEntorno('META_P95_MS') : undefined;
const META_ERRORES_PCT = process.env.META_ERRORES_PCT ? numeroDelEntorno('META_ERRORES_PCT') : undefined;
const SALIDA = process.env.SALIDA ?? `resultados/trivia-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

// las mismas reglas que trivia-service (SalaService.crear), para fallar aqui y no con un 400 a media prueba
if (ETAPAS.some((n) => !Number.isInteger(n) || n < 2 || n > 999)) throw new Error('ETAPAS: numeros enteros de 2 a 999, separados por comas');
if (!Number.isInteger(POR_SALA) || POR_SALA < 2) throw new Error('POR_SALA tiene que ser un entero de 2 o mas');
if (![5, 10, 15].includes(PREGUNTAS)) throw new Error('PREGUNTAS tiene que ser 5, 10 o 15');
if (![10, 15, 20].includes(DURACION)) throw new Error('DURACION tiene que ser 10, 15 o 20 (segundos por pregunta)');
if (ESPERA_MAX_MS < 0 || ESPERA_MAX_MS >= DURACION * 1000) throw new Error('ESPERA_MAX_MS tiene que ser de 0 a menos que DURACION');

const esperar = (milis) => new Promise((r) => setTimeout(r, milis));
const ahora = () => performance.now();

// deactivate() de un cliente que nunca llego a conectarse puede quedarse esperando un cierre que no va a llegar (y
// si no queda nada mas pendiente, Node se sale a media prueba): se le da un plazo y se sigue
const cerrar = (cliente) => Promise.race([cliente.deactivate().catch(() => {}), esperar(2000)]);

async function crearSala(host, m) {
  const inicio = ahora();
  try {
    const res = await fetch(`${TRIVIA}/api/salas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoria: CATEGORIA, hostUsuarioId: host.id, hostNombre: host.nombre, numPreguntas: PREGUNTAS, duracionSegundos: DURACION }),
      signal: AbortSignal.timeout(PLAZO_CONEXION_MS),
    });
    const cuerpo = await res.json().catch(() => null);
    if (res.status !== 201) {
      m.errores.push(`crear sala respondio ${res.status}${cuerpo?.message ? `: ${cuerpo.message}` : ''}`);
      return null;
    }
    m.crearSala.push(ahora() - inicio);
    return cuerpo.codigo;
  } catch (e) {
    m.errores.push(`crear sala: ${e.name === 'TimeoutError' ? 'sin respuesta' : e.cause?.code ?? e.message}`);
    return null;
  }
}

// Una sala: se crea, se conectan sus jugadores, se unen, el host inicia, todos contestan cada pregunta y se espera a
// que a todos les lleguen los resultados finales (o se acabe el plazo). Lo que mide lo deja en `m`.
async function jugarSala(jugadores, m) {
  const codigo = await crearSala(jugadores[0], m);
  if (!codigo) return;
  const host = jugadores[0];
  const unidos = new Set();
  const recepciones = new Map(); // indice de la pregunta -> momentos en que le llego a cada jugador
  let iniciada = false;
  let terminados = 0;
  let resolver;
  const fin = new Promise((r) => (resolver = r));
  const plazo = setTimeout(() => resolver('plazo'), PLAZO_PARTIDA_MS);

  for (const j of jugadores) {
    Object.assign(j, { enviadas: new Map(), confirmadas: new Set(), termino: false, conectado: false, falloLaConexion: false });
    const inicioConexion = ahora();
    let inicioUnirse = 0;
    const cliente = new Client({ brokerURL: WS, reconnectDelay: 0, connectionTimeout: PLAZO_CONEXION_MS });
    j.cliente = cliente;

    const alMensaje = (mensaje) => {
      const t = ahora();
      switch (mensaje.type) {
        case 'SALA_UPDATE':
          if (!unidos.has(j.id) && mensaje.participantes?.some((p) => p.usuarioId === j.id)) {
            unidos.add(j.id);
            m.unirse.push(t - inicioUnirse);
          }
          // cuando el host ya ve a todos, inicia (una sola vez)
          if (j === host && !iniciada && jugadores.every((x) => mensaje.participantes?.some((p) => p.usuarioId === x.id))) {
            iniciada = true;
            cliente.publish({ destination: `/app/salas/${codigo}/iniciar`, body: '' });
          }
          break;
        case 'PREGUNTA': {
          if (j.enviadas.has(mensaje.indice)) break;
          if (!recepciones.has(mensaje.indice)) recepciones.set(mensaje.indice, []);
          recepciones.get(mensaje.indice).push(t);
          // la persona "piensa" un rato al azar antes de tocar una opcion
          const espera = Math.random() * ESPERA_MAX_MS;
          j.enviadas.set(mensaje.indice, null);
          setTimeout(() => {
            if (!cliente.connected) return;
            j.enviadas.set(mensaje.indice, ahora());
            cliente.publish({
              destination: `/app/salas/${codigo}/responder`,
              body: JSON.stringify({ usuarioId: j.id, indice: mensaje.indice, opcionElegida: Math.floor(Math.random() * 4) }),
            });
          }, espera);
          break;
        }
        case 'RESPUESTA_REGISTRADA': {
          // le llega a toda la sala; cada jugador cuenta solo la suya
          const enviada = j.enviadas.get(mensaje.indice);
          if (mensaje.usuarioId === j.id && enviada && !j.confirmadas.has(mensaje.indice)) {
            j.confirmadas.add(mensaje.indice);
            m.respuesta.push(t - enviada);
          }
          break;
        }
        case 'RESULTADOS_FINALES':
          if (!j.termino) {
            j.termino = true;
            terminados++;
            if (terminados === jugadores.length) resolver('termino');
          }
          break;
        case 'ERROR':
          // un error le llega a toda la sala: se cuenta una sola vez, en el host
          if (j === host) m.errores.push(`trivia-service aviso: ${mensaje.message}`);
          break;
        default:
          break;
      }
    };

    cliente.onConnect = () => {
      j.conectado = true;
      m.conectar.push(ahora() - inicioConexion);
      cliente.subscribe(`/topic/salas.${codigo}`, (frame) => {
        try {
          alMensaje(JSON.parse(frame.body));
        } catch {
          m.errores.push('llego un mensaje que no es JSON');
        }
      });
      inicioUnirse = ahora();
      cliente.publish({ destination: `/app/salas/${codigo}/unirse`, body: JSON.stringify({ usuarioId: j.id, nombre: j.nombre }) });
    };
    cliente.onStompError = (frame) => m.errores.push(`STOMP: ${frame.headers?.message ?? 'error'}`);
    cliente.onWebSocketError = () => {
      // el cliente puede avisar mas de una vez por el mismo intento: se cuenta una vez por jugador
      if (!j.conectado && !j.falloLaConexion) {
        j.falloLaConexion = true;
        m.errores.push('no se pudo abrir el WebSocket');
      }
    };
    cliente.onWebSocketClose = () => {
      if (j.conectado && !j.termino) m.errores.push('el WebSocket se cerro a media partida');
    };
    cliente.activate();
  }

  const como = await fin;
  clearTimeout(plazo);
  if (como === 'plazo') m.errores.push(`la sala ${codigo} no termino en ${PLAZO_PARTIDA_MS / 1000} s`);
  else m.salasTerminadas++;
  // el broker no promete que una confirmacion de la ultima pregunta llegue antes que los resultados finales: un
  // momento mas antes de cerrar, para no contar como perdida una que solo venia atrasada
  await esperar(500);

  // el reparto de cada pregunta: entre el primero y el ultimo de los que la recibieron
  const conectados = jugadores.filter((j) => j.conectado).length;
  for (const tiempos of recepciones.values()) {
    if (tiempos.length === conectados && tiempos.length > 1) m.reparto.push(Math.max(...tiempos) - Math.min(...tiempos));
    else if (tiempos.length < conectados) m.preguntasIncompletas++;
  }
  for (const j of jugadores) {
    if (j.termino) m.jugadoresTerminaron++;
    for (const [indice, enviada] of j.enviadas) if (enviada && !j.confirmadas.has(indice)) m.sinConfirmar++;
    m.respuestasEnviadas += [...j.enviadas.values()].filter(Boolean).length;
  }
  await Promise.all(jugadores.map((j) => cerrar(j.cliente)));
}

async function etapa(numero, n) {
  const salas = repartir(n, POR_SALA);
  const m = {
    jugadores: n, salas: salas.length, salasTerminadas: 0, jugadoresTerminaron: 0, respuestasEnviadas: 0,
    sinConfirmar: 0, preguntasIncompletas: 0, errores: [],
    conectar: [], unirse: [], crearSala: [], respuesta: [], reparto: [],
  };
  let siguiente = USUARIO_BASE + numero * 1000;
  const grupos = salas.map((tam) => Array.from({ length: tam }, () => {
    const id = siguiente++;
    return { id, nombre: `Carga ${id}` };
  }));
  const inicio = ahora();
  await Promise.all(grupos.map((g) => jugarSala(g, m)));
  m.duracionS = (ahora() - inicio) / 1000;
  return m;
}

// ---------------------------------------------------------------------------------------------
console.log(`\nCarga de trivia: etapas de ${ETAPAS.join(', ')} jugadores, salas de ${POR_SALA}, ${PREGUNTAS} preguntas de ${DURACION} s,`);
console.log(`cada jugador contesta entre 0 y ${ESPERA_MAX_MS} ms despues de recibir la pregunta. Contra ${TRIVIA} y ${WS}\n`);

const etapas = [];
for (const [i, n] of ETAPAS.entries()) {
  const m = await etapa(i + 1, n);
  etapas.push(m);
  const filas = [
    ['respuesta (ida y vuelta)', resumen(m.respuesta)],
    ['reparto de la pregunta', resumen(m.reparto)],
    ['unirse', resumen(m.unirse)],
    ['conectar', resumen(m.conectar)],
    ['crear sala', resumen(m.crearSala)],
  ].map(([nombre, r]) => [nombre, r.n, ms(r.p50), ms(r.p95), ms(r.p99), ms(r.max)]);
  console.log(`Etapa ${i + 1}: ${n} jugadores en ${m.salas} sala${m.salas === 1 ? '' : 's'}, ${m.duracionS.toFixed(1)} s. Partidas terminadas ${m.salasTerminadas}/${m.salas}, jugadores con resultados ${m.jugadoresTerminaron}/${n}`);
  console.log(tabla(['medida', 'n', 'p50', 'p95', 'p99', 'max'], filas));
  if (m.sinConfirmar) console.log(`  ${m.sinConfirmar} respuesta(s) enviadas que nunca se confirmaron`);
  if (m.preguntasIncompletas) console.log(`  ${m.preguntasIncompletas} pregunta(s) que no les llegaron a todos los de su sala`);
  for (const [motivo, veces] of contar(m.errores)) console.log(`  ${veces} x ${motivo}`);
  console.log('');
  await esperar(2000); // que se cierren las conexiones de esta etapa antes de abrir las de la siguiente
}

console.log('Resumen por etapa (donde empieza a crecer el p95 o a aparecer errores, ahi esta el cuello de botella):');
console.log(tabla(
  ['jugadores', 'salas ok', 'respuesta p50', 'p95', 'p99', 'reparto p95', 'unirse p95', 'sin resultados', 'errores'],
  etapas.map((m) => {
    const r = resumen(m.respuesta);
    return [m.jugadores, `${m.salasTerminadas}/${m.salas}`, ms(r.p50), ms(r.p95), ms(r.p99), ms(resumen(m.reparto).p95),
      ms(resumen(m.unirse).p95), m.jugadores - m.jugadoresTerminaron, m.errores.length];
  }),
));

// la meta se mira en todas las etapas: p95 de la respuesta, y el % de jugadores que no recibieron sus resultados
let cumpleTodo = true;
let pidioMeta = false;
for (const m of etapas) {
  const meta = evaluarMeta({ p95: resumen(m.respuesta).p95, errores: m.jugadores - m.jugadoresTerminaron, total: m.jugadores }, META_P95_MS, META_ERRORES_PCT);
  if (!meta) continue;
  pidioMeta = true;
  if (!meta.pasa) cumpleTodo = false;
  console.log(`Meta con ${m.jugadores} jugadores (ADR-0013): ${meta.pasa ? 'SE CUMPLE' : 'NO SE CUMPLE'} (${meta.detalle})`);
}

const archivo = fileURLToPath(new URL(SALIDA, import.meta.url));
await mkdir(dirname(archivo), { recursive: true });
await writeFile(archivo, JSON.stringify({
  prueba: 'trivia', fecha: new Date().toISOString(), trivia: TRIVIA, ws: WS,
  config: { etapas: ETAPAS, porSala: POR_SALA, preguntas: PREGUNTAS, duracion: DURACION, esperaMaxMs: ESPERA_MAX_MS, categoria: CATEGORIA },
  etapas: etapas.map((m) => ({
    jugadores: m.jugadores, salas: m.salas, salasTerminadas: m.salasTerminadas, jugadoresTerminaron: m.jugadoresTerminaron,
    respuestasEnviadas: m.respuestasEnviadas, sinConfirmar: m.sinConfirmar, preguntasIncompletas: m.preguntasIncompletas,
    duracionS: m.duracionS, errores: contar(m.errores),
    respuesta: resumen(m.respuesta), reparto: resumen(m.reparto), unirse: resumen(m.unirse), conectar: resumen(m.conectar), crearSala: resumen(m.crearSala),
  })),
}, null, 2));
console.log(`\nResultados guardados en ${archivo}\n`);
process.exit(pidioMeta && !cumpleTodo ? 1 : 0);
