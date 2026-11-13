#!/usr/bin/env node
// Autoescalado de trivia en el Docker de infra (escenario D3: sube la carga y el sistema escala).
//
// Es una REGLA, no un boton: cada INTERVALO segundos lee de Prometheus cuantas conexiones (jugadores) tiene en promedio
// cada replica de trivia-service y decide, igual que lo haria la regla de autoescalado de Azure:
//   - si pasa de SUBE_SOBRE durante ESPERA_SUBE segundos seguidos  -> sube una replica (hasta MAX)
//   - si la replica MAS OCUPADA baja de BAJA_BAJO durante ESPERA_BAJA segundos seguidos -> quita una replica (hasta MIN)
//   - despues de cada cambio espera ENFRIAMIENTO segundos antes de volver a decidir (para no subir y bajar sin parar)
// Subir una replica es "docker compose up --scale": la nueva entra al reparto de nginx y a Prometheus sola (ver README).
// Quitar una replica corta los WebSocket de sus jugadores, y docker se queda con la de numero mas alto sin mirar cuantos
// tiene. Una primera version bajaba cuando el PROMEDIO era bajo y en una prueba de carga corto la mitad de las partidas
// en curso (3 de 6 salas sin resultado). Por eso para bajar se mira la replica mas ocupada, no el promedio: solo se
// quita una cuando ninguna tiene jugadores de verdad.
//
// Uso (con el compose levantado, desde la carpeta infra):   node scripts/autoescalar.mjs
// Probar la regla sin tocar nada:                           SOLO_MOSTRAR=1 node scripts/autoescalar.mjs
// Se detiene con Ctrl+C y deja las replicas como estan.
//
// Variables (todas opcionales):
//   SERVICIO      servicio del compose que se escala                      (trivia-service)
//   CONSULTA      PromQL con el numero que se vigila para SUBIR           (avg(trivia_websocket_conexiones_activas))
//   CONSULTA_BAJA PromQL que se vigila para BAJAR                         (max(trivia_websocket_conexiones_activas))
//   SUBE_SOBRE    umbral para subir                                       (30)
//   BAJA_BAJO     umbral para bajar (la replica mas ocupada, no el promedio) (3)
//   MIN, MAX      limites de replicas                                     (1, 4)
//   INTERVALO     cada cuantos segundos se mira                           (5)
//   ESPERA_SUBE   segundos seguidos sobre el umbral antes de subir        (20)
//   ESPERA_BAJA   segundos seguidos bajo el umbral antes de bajar         (120)
//   ENFRIAMIENTO  segundos de calma despues de cada cambio                (60)
//   PROMETHEUS    direccion de Prometheus                                 (http://localhost:9090)
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const num = (nombre, defecto) => {
  const v = Number(env[nombre] ?? defecto);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${nombre} tiene que ser un numero (llego "${env[nombre]}")`);
  return v;
};

const SERVICIO = env.SERVICIO ?? 'trivia-service';
const CONSULTA = env.CONSULTA ?? 'avg(trivia_websocket_conexiones_activas)';
// para bajar se mira la replica mas ocupada (ver el encabezado): si se personaliza CONSULTA y no CONSULTA_BAJA, se usa la misma
const CONSULTA_BAJA = env.CONSULTA_BAJA ?? (env.CONSULTA ? CONSULTA : 'max(trivia_websocket_conexiones_activas)');
const SUBE_SOBRE = num('SUBE_SOBRE', 30);
const BAJA_BAJO = num('BAJA_BAJO', 3);
const MIN = num('MIN', 1);
const MAX = num('MAX', 4);
const INTERVALO = num('INTERVALO', 5);
const ESPERA_SUBE = num('ESPERA_SUBE', 20);
const ESPERA_BAJA = num('ESPERA_BAJA', 120);
const ENFRIAMIENTO = num('ENFRIAMIENTO', 60);
const PROMETHEUS = (env.PROMETHEUS ?? 'http://localhost:9090').replace(/\/$/, '');
const SOLO_MOSTRAR = env.SOLO_MOSTRAR === '1';
const CARPETA_INFRA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (BAJA_BAJO >= SUBE_SOBRE) throw new Error('BAJA_BAJO tiene que ser menor que SUBE_SOBRE (si no, subiria y bajaria sin parar)');
if (MIN < 1 || MAX < MIN) throw new Error('hace falta 1 <= MIN <= MAX');

const hora = () => new Date().toTimeString().slice(0, 8);
const registrar = (texto) => console.log(`${hora()}  ${texto}`);

async function consultar(promql) {
  const respuesta = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(promql)}`);
  if (!respuesta.ok) throw new Error(`Prometheus respondio ${respuesta.status}`);
  const cuerpo = await respuesta.json();
  const resultado = cuerpo.data?.result?.[0]?.value?.[1];
  return resultado === undefined ? NaN : Number(resultado);
}

// una consulta sin resultado (Prometheus aun no tiene la metrica) es NaN, y no cuenta ni para subir ni para bajar
const valorActual = () => consultar(CONSULTA);
const valorParaBajar = () => (CONSULTA_BAJA === CONSULTA ? valorActual() : consultar(CONSULTA_BAJA));

function replicasCorriendo() {
  const salida = execFileSync('docker', ['compose', 'ps', '--status', 'running', '-q', SERVICIO], { cwd: CARPETA_INFRA, encoding: 'utf8' });
  return salida.split('\n').filter((linea) => linea.trim()).length;
}

function escalarA(cantidad) {
  // --no-recreate: las replicas que ya corren no se tocan; --no-deps: no se reinicia nada mas del compose
  execFileSync('docker', ['compose', 'up', '-d', '--no-recreate', '--no-deps', '--scale', `${SERVICIO}=${cantidad}`, SERVICIO],
    { cwd: CARPETA_INFRA, stdio: 'ignore' });
}

registrar(`vigilando ${SERVICIO}: sube sobre ${SUBE_SOBRE} (${ESPERA_SUBE}s), baja bajo ${BAJA_BAJO} (${ESPERA_BAJA}s), entre ${MIN} y ${MAX} replicas`
  + (SOLO_MOSTRAR ? '  [SOLO MOSTRAR: no cambia nada]' : ''));
registrar(`regla para subir: ${CONSULTA}`);
registrar(`regla para bajar: ${CONSULTA_BAJA}`);

let segundosSobre = 0;
let segundosBajo = 0;
let ultimoCambio = 0;
let detener = false;
process.on('SIGINT', () => { detener = true; registrar('detenido, las replicas se quedan como estan'); process.exit(0); });

while (!detener) {
  try {
    const valor = await valorActual();
    const valorBaja = await valorParaBajar();
    const replicas = replicasCorriendo();
    if (Number.isNaN(valor) || Number.isNaN(valorBaja)) {
      registrar(`replicas=${replicas}  sin datos todavia (Prometheus aun no tiene la metrica)`);
    } else {
      if (valor > SUBE_SOBRE) { segundosSobre += INTERVALO; segundosBajo = 0; }
      else if (valorBaja < BAJA_BAJO) { segundosBajo += INTERVALO; segundosSobre = 0; }
      else { segundosSobre = 0; segundosBajo = 0; }

      const enCalma = (Date.now() - ultimoCambio) / 1000 < ENFRIAMIENTO;
      let accion = '';
      if (segundosSobre >= ESPERA_SUBE && replicas < MAX && !enCalma) {
        accion = `SUBE a ${replicas + 1} replicas`;
        if (!SOLO_MOSTRAR) escalarA(replicas + 1);
        ultimoCambio = Date.now(); segundosSobre = 0;
      } else if (segundosBajo >= ESPERA_BAJA && replicas > MIN && !enCalma) {
        accion = `BAJA a ${replicas - 1} replicas`;
        if (!SOLO_MOSTRAR) escalarA(replicas - 1);
        ultimoCambio = Date.now(); segundosBajo = 0;
      } else if (enCalma && (segundosSobre >= ESPERA_SUBE || segundosBajo >= ESPERA_BAJA)) {
        accion = 'en calma tras el ultimo cambio';
      }
      registrar(`replicas=${replicas}  promedio=${valor.toFixed(1)} mas-ocupada=${valorBaja.toFixed(0)}  sobre=${segundosSobre}s bajo=${segundosBajo}s${accion ? `  -> ${accion}` : ''}`);
    }
  } catch (error) {
    registrar(`no se pudo decidir: ${error.message}`);
  }
  await new Promise((listo) => setTimeout(listo, INTERVALO * 1000));
}
