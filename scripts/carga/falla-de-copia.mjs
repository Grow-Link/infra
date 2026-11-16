// Prueba de que, si se cae una copia de trivia en pleno juego, nadie se sale de su sala (escenario D1 con gente de verdad conectada).
// Juega partidas completas por WebSocket con varios jugadores de mentira, pasando por el balanceador, y cuando las preguntas ya van
// por la numero PREGUNTA_FALLA ejecuta COMANDO_FALLA (por ejemplo, apagar una copia en Azure). Los jugadores se comportan como el front:
// si se les cae el WebSocket se reconectan a los 3 s y vuelven a mandar "unirse". Al final dice, por jugador, si perdio la conexion, si
// volvio, si el servidor lo sacó de la sala (JUGADOR_SALIO) y si recibio los resultados finales.
//
//   URL_TRIVIA=https://.../api-trivia WS_TRIVIA=wss://.../ws-trivia COMANDO_FALLA="az webapp stop -g rg-growlink -n growlink-trivia-d" node falla-de-copia.mjs
//
// Variables opcionales: JUGADORES (12), POR_SALA (4), PREGUNTAS (10), DURACION (15 s por pregunta), PREGUNTA_FALLA (3), PLAZO_MS (360000).
// Funciona con AUTH_MODE=legacy (los jugadores de mentira no tienen cuenta de Microsoft). Hace falta Node 22 o mas nuevo.
// Termina con codigo 0 solo si ningun jugador fue sacado de su sala, todos los que perdieron la conexion volvieron y todas las salas terminaron.

import { Client } from '@stomp/stompjs';
import { spawn } from 'node:child_process';

const TRIVIA = process.env.URL_TRIVIA;
const WS = process.env.WS_TRIVIA;
if (!TRIVIA || !WS) throw new Error('Faltan URL_TRIVIA y WS_TRIVIA (la direccion del balanceador)');
const COMANDO_FALLA = process.env.COMANDO_FALLA;
const num = (nombre, defecto) => (process.env[nombre] ? Number(process.env[nombre]) : defecto);
const JUGADORES = num('JUGADORES', 12);
const POR_SALA = num('POR_SALA', 4);
const PREGUNTAS = num('PREGUNTAS', 10);
const DURACION = num('DURACION', 15);
const PREGUNTA_FALLA = num('PREGUNTA_FALLA', 3);
const PLAZO_MS = num('PLAZO_MS', 360000);
const USUARIO_BASE = num('USUARIO_BASE', 950000);
const CATEGORIA = process.env.CATEGORIA ?? 'INGENIERIA_SISTEMAS';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const segundos = (desde) => ((performance.now() - desde) / 1000).toFixed(1);
const inicio = performance.now();
const registro = (texto) => console.log(`[${segundos(inicio).padStart(6)} s] ${texto}`);

let falloEn = null; // performance.now() del momento en que se lanzó el comando
function lanzarFalla() {
  if (falloEn !== null) return;
  falloEn = performance.now();
  registro(`>>> FALLA: ${COMANDO_FALLA ?? '(sin comando: la falla se provoca a mano)'}`);
  if (!COMANDO_FALLA) return;
  const hijo = spawn(COMANDO_FALLA, { shell: true, stdio: 'ignore' });
  hijo.on('exit', (codigo) => registro(`>>> el comando de falla terminó con código ${codigo}`));
}

async function crearSala(host) {
  const res = await fetch(`${TRIVIA}/api/salas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ categoria: CATEGORIA, hostUsuarioId: host.id, hostNombre: host.nombre, numPreguntas: PREGUNTAS, duracionSegundos: DURACION }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status !== 201) throw new Error(`crear sala respondió ${res.status}`);
  return (await res.json()).codigo;
}

async function jugarSala(jugadores) {
  const host = jugadores[0];
  const codigo = await crearSala(host);
  let iniciada = false;
  let terminados = 0;
  let resolver;
  const fin = new Promise((r) => (resolver = r));
  const plazo = setTimeout(() => resolver('plazo'), PLAZO_MS);

  for (const j of jugadores) {
    Object.assign(j, { cierres: 0, reconexiones: 0, salio: false, termino: false, conexiones: 0, avisos: 0, respuestas: 0, cierreEn: [], vueltaEn: [] });
    const cliente = new Client({ brokerURL: WS, reconnectDelay: 3000, connectionTimeout: 10000 });
    j.cliente = cliente;

    const alMensaje = (mensaje) => {
      switch (mensaje.type) {
        case 'SALA_UPDATE':
          if (j === host && !iniciada && jugadores.every((x) => mensaje.participantes?.some((p) => p.usuarioId === x.id))) {
            iniciada = true;
            cliente.publish({ destination: `/app/salas/${codigo}/iniciar`, body: '' });
          }
          break;
        case 'PREGUNTA':
          if (mensaje.indice >= PREGUNTA_FALLA) lanzarFalla();
          if (j.respondidas.has(mensaje.indice)) break;
          j.respondidas.add(mensaje.indice);
          setTimeout(() => {
            if (!cliente.connected) return;
            j.respuestas++;
            cliente.publish({
              destination: `/app/salas/${codigo}/responder`,
              body: JSON.stringify({ usuarioId: j.id, indice: mensaje.indice, opcionElegida: Math.floor(Math.random() * 4) }),
            });
          }, Math.random() * (DURACION * 1000 * 0.6));
          break;
        case 'JUGADOR_SALIO':
          if (mensaje.usuarioId === j.id) {
            j.salio = true;
            registro(`${j.nombre} (sala ${codigo}): EL SERVIDOR LO SACÓ DE LA SALA`);
          }
          break;
        case 'RESULTADOS_FINALES':
          if (!j.termino) {
            j.termino = true;
            if (++terminados === jugadores.length) resolver('termino');
          }
          break;
        case 'ERROR':
          j.avisos++; // p. ej. el "unirse" repetido al reconectar: el front también lo ignora
          break;
        default:
          break;
      }
    };
    j.respondidas = new Set();

    cliente.onConnect = () => {
      j.conexiones++;
      if (j.conexiones > 1) {
        j.reconexiones++;
        j.vueltaEn.push(performance.now());
        registro(`${j.nombre} volvió a conectarse (sala ${codigo})`);
      }
      cliente.subscribe(`/topic/salas.${codigo}`, (frame) => {
        try {
          alMensaje(JSON.parse(frame.body));
        } catch {
          /* mensaje que no es JSON: se ignora */
        }
      });
      cliente.publish({ destination: `/app/salas/${codigo}/unirse`, body: JSON.stringify({ usuarioId: j.id, nombre: j.nombre }) });
    };
    cliente.onWebSocketClose = () => {
      if (j.conexiones > 0 && !j.termino) {
        j.cierres++;
        j.cierreEn.push(performance.now());
        registro(`${j.nombre} perdió la conexión (sala ${codigo})`);
      }
    };
    cliente.activate();
  }

  const como = await fin;
  clearTimeout(plazo);
  await esperar(1000);
  await Promise.all(jugadores.map((j) => Promise.race([j.cliente.deactivate().catch(() => {}), esperar(2000)])));
  return { codigo, como };
}

const jugadores = Array.from({ length: JUGADORES }, (_, i) => ({ id: USUARIO_BASE + i, nombre: `Falla ${USUARIO_BASE + i}` }));
const salas = [];
for (let i = 0; i < jugadores.length; i += POR_SALA) salas.push(jugadores.slice(i, i + POR_SALA));
if (salas.some((s) => s.length < 2)) throw new Error('JUGADORES tiene que dejar al menos 2 por sala');

registro(`${JUGADORES} jugadores en ${salas.length} salas de hasta ${POR_SALA}; ${PREGUNTAS} preguntas de ${DURACION} s; la falla llega en la pregunta ${PREGUNTA_FALLA}`);
const resultados = await Promise.all(salas.map((s) => jugarSala(s).catch((e) => ({ codigo: '?', como: `error: ${e.message}` }))));

console.log('\nJugador          cierres  volvió  lo sacaron  resultados finales  avisos');
for (const j of jugadores) {
  console.log(`${j.nombre.padEnd(16)} ${String(j.cierres ?? '-').padStart(6)} ${String(j.reconexiones ?? '-').padStart(7)}  ${(j.salio ? 'SÍ' : 'no').padStart(9)}  ${(j.termino ? 'sí' : 'NO').padStart(17)}  ${String(j.avisos ?? '-').padStart(6)}`);
}
const afectados = jugadores.filter((j) => j.cierres > 0);
const sinVolver = afectados.filter((j) => j.reconexiones < j.cierres);
const sacados = jugadores.filter((j) => j.salio);
const sinResultados = jugadores.filter((j) => !j.termino);
const salasOk = resultados.filter((r) => r.como === 'termino').length;
const tardanzas = afectados.flatMap((j) => j.cierreEn.map((c, k) => (j.vueltaEn[k] ? (j.vueltaEn[k] - c) / 1000 : null))).filter((t) => t !== null);

console.log(`\nSalas terminadas: ${salasOk}/${salas.length}`);
console.log(`Jugadores que perdieron la conexión por la falla: ${afectados.length}/${JUGADORES}`);
if (tardanzas.length) console.log(`Tiempo en volver: mínimo ${Math.min(...tardanzas).toFixed(1)} s, máximo ${Math.max(...tardanzas).toFixed(1)} s`);
console.log(`Volvieron a conectarse: ${afectados.length - sinVolver.length}/${afectados.length}`);
console.log(`Sacados de su sala por el servidor: ${sacados.length}`);
console.log(`Sin resultados finales: ${sinResultados.length}`);

let veredicto;
if (falloEn === null) veredicto = 'NO CONCLUYENTE: la falla nunca se lanzó (las partidas no llegaron a la pregunta ' + PREGUNTA_FALLA + ')';
else if (afectados.length === 0) veredicto = 'NO CONCLUYENTE: ningún jugador estaba en la copia que se apagó; repetir la prueba';
else if (sacados.length === 0 && sinVolver.length === 0 && salasOk === salas.length) veredicto = 'OK: los jugadores de la copia caída volvieron solos y ninguno salió de su sala';
else veredicto = 'FALLÓ: hay jugadores sacados de su sala, sin reconectar o partidas sin terminar';
console.log(`\nVeredicto: ${veredicto}`);
process.exit(veredicto.startsWith('OK') ? 0 : 1);
