// Prueba de carga HTTP a tasa constante (ver ADR-0013): manda TASA peticiones por segundo durante DURACION_S
// segundos contra los tres servicios y dice cuanto tardaron (p50, p95, p99), cuantas fallaron, que replica atendio
// cada una (cabecera X-Instancia) y, segundo a segundo, como se comporto. Hace falta Node 22 o mas nuevo.
//
//   npm run http                                  20 por segundo durante 60 s contra los servicios en localhost
//   TASA=50 DURACION_S=120 npm run http           otra tasa y otra duracion
//   SOLO=cursos npm run http                      solo contra un servicio (usuarios, cursos o trivia)
//   META_P95_MS=500 META_ERRORES_PCT=1 npm run http   y dice si se cumplio la meta (si no, termina con codigo 1)
//
// La tasa es CONSTANTE de verdad (modelo abierto): cada peticion sale a su hora aunque las anteriores no hayan
// contestado. Si se esperara la respuesta antes de mandar la siguiente, un servidor lento recibiria menos carga
// justo cuando mas le cuesta, y los tiempos saldrian mejores de lo que son.
//
// Para medir la recuperacion al apagar una replica: correr esto con DURACION_S largo y, a la mitad, tumbar una
// replica (docker kill, o detener una instancia en Azure). La linea de tiempo dice en que segundo empezaron y
// terminaron las fallas.
//
// Ojo con el tope por IP (LIMITE_IP_MAXIMO_POR_MINUTO, 300 por defecto): todas las peticiones salen de esta maquina,
// asi que por encima de 5 por segundo el tope empieza a responder 429. Para medir capacidad hay que subirlo o
// apagarlo (0) en el ambiente que se prueba; el reporte avisa si vio 429. Y el login es el de demostracion
// (AUTH_MODE=legacy): con Microsoft no hay forma de sacar tokens para una prueba automatica.
//
// Por defecto habla con los servicios directos en localhost (igual que la prueba de humo). Con el compose:
//   URL_USUARIOS=http://localhost:3000/api-usuarios URL_CURSOS=http://localhost:3000/api-cursos \
//   URL_TRIVIA=http://localhost:3000/api-trivia npm run http

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contar, evaluarMeta, lineaDeTiempo, ms, numeroDelEntorno, resumen, tabla, ventanaDeFallas } from './estadisticas.mjs';

const URLS = {
  usuarios: process.env.URL_USUARIOS ?? 'http://localhost:8080',
  cursos: process.env.URL_CURSOS ?? 'http://localhost:8086',
  trivia: process.env.URL_TRIVIA ?? 'http://localhost:8085',
};
const TASA = numeroDelEntorno('TASA', 20);
const DURACION_S = numeroDelEntorno('DURACION_S', 60);
const PLAZO_MS = numeroDelEntorno('PLAZO_MS', 10000);
const MAX_EN_VUELO = numeroDelEntorno('MAX_EN_VUELO', 500);
const SOLO = process.env.SOLO?.trim() || null;
const META_P95_MS = process.env.META_P95_MS ? numeroDelEntorno('META_P95_MS') : undefined;
const META_ERRORES_PCT = process.env.META_ERRORES_PCT ? numeroDelEntorno('META_ERRORES_PCT') : undefined;
const SALIDA = process.env.SALIDA ?? `resultados/http-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

if (TASA <= 0 || DURACION_S <= 0) throw new Error('TASA y DURACION_S tienen que ser mayores que 0');
if (SOLO && !URLS[SOLO]) throw new Error(`SOLO tiene que ser usuarios, cursos o trivia, y llego "${SOLO}"`);

// Las personas de prueba que siembra usuarios-service (todas menos la admin). Esteban (5) es el unico con roadmap.
const PERSONAS = [1, 2, 4, 5, 6, 7, 8];
const ESTEBAN = 5;

// Lo que se pide: solo lecturas, para poder repetir la prueba sin ensuciar los datos. Cada una con lo que se espera
// que conteste; cualquier otra cosa cuenta como falla. /api/home/estado le pregunta ademas a cursos-service.
const MEZCLA = [
  { nombre: 'usuarios GET /api/perfil/me', servicio: 'usuarios', ruta: () => '/api/perfil/me', esperado: [200] },
  { nombre: 'usuarios GET /api/home/estado', servicio: 'usuarios', ruta: () => '/api/home/estado', esperado: [200] },
  { nombre: 'cursos GET /api/cursos', servicio: 'cursos', ruta: () => '/api/cursos', esperado: [200] },
  { nombre: 'cursos GET /api/roadmap/mio', servicio: 'cursos', ruta: () => `/api/roadmap/mio?usuarioId=${ESTEBAN}`, esperado: [200], persona: ESTEBAN },
  { nombre: 'trivia GET /api/partidas/ganadores', servicio: 'trivia', ruta: () => '/api/partidas/ganadores?limite=10', esperado: [200] },
].filter((p) => !SOLO || p.servicio === SOLO);

async function login(usuarioId) {
  const res = await fetch(`${URLS.usuarios}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuarioId }),
  });
  if (res.status !== 200) throw new Error(`no se pudo iniciar sesion como ${usuarioId} (${res.status}): ¿AUTH_MODE=legacy?`);
  return (await res.json()).token;
}

async function pedir(peticion, token) {
  const inicio = performance.now();
  try {
    const res = await fetch(`${URLS[peticion.servicio]}${peticion.ruta()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PLAZO_MS),
    });
    await res.arrayBuffer(); // el tiempo incluye bajar la respuesta entera
    return { ms: performance.now() - inicio, estado: res.status, instancia: res.headers.get('x-instancia'), error: null };
  } catch (e) {
    const motivo = e.name === 'TimeoutError' ? `sin respuesta en ${PLAZO_MS} ms` : e.cause?.code ?? e.message;
    return { ms: null, estado: null, instancia: null, error: motivo };
  }
}

const esperar = (milis) => new Promise((r) => setTimeout(r, milis));

// ---------------------------------------------------------------------------------------------
console.log(`\nCarga HTTP: ${TASA} peticiones/s durante ${DURACION_S} s${SOLO ? ` solo contra ${SOLO}` : ''}`);
console.log(`  ${MEZCLA.map((p) => p.nombre).join('\n  ')}\n`);

const tokens = Object.fromEntries(await Promise.all(PERSONAS.map(async (id) => [id, await login(id)])));
// una vuelta de calentamiento: la primera peticion de cada ruta paga la carga de clases de la JVM, y eso no es carga
for (const p of MEZCLA) await pedir(p, tokens[p.persona ?? ESTEBAN]);

const total = Math.round(TASA * DURACION_S);
const intervalo = 1000 / TASA;
const resultados = [];
const enCurso = new Set();
let noEnviadas = 0;
const t0 = performance.now();

for (let k = 0; k < total; k++) {
  const hora = k * intervalo;
  const falta = hora - (performance.now() - t0);
  if (falta > 1) await esperar(falta);
  if (enCurso.size >= MAX_EN_VUELO) {
    // el servidor dejo de contestar y ya hay demasiadas esperando: se cuenta y se sigue, para no reventar esta maquina
    noEnviadas++;
    const { nombre, servicio } = MEZCLA[k % MEZCLA.length];
    resultados.push({ t: hora, peticion: nombre, servicio, ms: null, estado: null, instancia: null, error: 'no enviada (demasiadas en vuelo)', ok: false });
    continue;
  }
  const peticion = MEZCLA[k % MEZCLA.length];
  const persona = peticion.persona ?? PERSONAS[k % PERSONAS.length];
  const promesa = pedir(peticion, tokens[persona]).then((r) => {
    resultados.push({ t: hora, peticion: peticion.nombre, servicio: peticion.servicio, ...r, ok: peticion.esperado.includes(r.estado) });
    enCurso.delete(promesa);
  });
  enCurso.add(promesa);
}
await Promise.all(enCurso);
const duracionReal = (performance.now() - t0) / 1000;

// ---------------------------------------------------------------------------------------------
const filas = MEZCLA.map((p) => {
  const deEsta = resultados.filter((r) => r.peticion === p.nombre);
  const r = resumen(deEsta.filter((x) => x.ms !== null).map((x) => x.ms));
  const fallas = deEsta.filter((x) => !x.ok).length;
  return [p.nombre, deEsta.length, fallas, ms(r.p50), ms(r.p95), ms(r.p99), ms(r.max)];
});
const todos = resumen(resultados.filter((x) => x.ms !== null).map((x) => x.ms));
const fallas = resultados.filter((x) => !x.ok);
filas.push(['TOTAL', resultados.length, fallas.length, ms(todos.p50), ms(todos.p95), ms(todos.p99), ms(todos.max)]);
console.log(tabla(['peticion', 'n', 'fallas', 'p50', 'p95', 'p99', 'max'], filas));
console.log(`\nTasa lograda: ${(resultados.length / duracionReal).toFixed(1)} peticiones/s (pedida ${TASA}) en ${duracionReal.toFixed(1)} s`);

if (fallas.length) {
  console.log('\nFallas:');
  for (const [motivo, n] of contar(fallas.map((f) => f.error ?? `respondio ${f.estado}`))) console.log(`  ${n} x ${motivo}`);
}
if (resultados.some((r) => r.estado === 429)) {
  console.log('\nAVISO: hubo 429 del tope por IP. Lo que se midio fue el tope, no la capacidad: subir o apagar');
  console.log('LIMITE_IP_MAXIMO_POR_MINUTO en el ambiente que se prueba (ver el README de infra).');
}
if (noEnviadas) console.log(`\nAVISO: ${noEnviadas} peticiones no se mandaron porque ya habia ${MAX_EN_VUELO} esperando respuesta.`);

console.log('\nReparto entre replicas (cabecera X-Instancia):');
for (const servicio of [...new Set(MEZCLA.map((p) => p.servicio))]) {
  const reparto = contar(resultados.filter((r) => r.servicio === servicio && r.instancia).map((r) => r.instancia));
  console.log(`  ${servicio}: ${reparto.map(([inst, n]) => `${inst} ${n}`).join(', ') || 'sin datos'}`);
}

const linea = lineaDeTiempo(resultados, Math.ceil(DURACION_S));
const ventana = ventanaDeFallas(linea);
console.log('\nSegundo a segundo (salieron / fallaron / p95 de las que salieron en ese segundo):');
for (const s of linea) {
  console.log(`  ${String(s.s).padStart(4)} s  ${String(s.enviadas).padStart(4)}  ${String(s.fallas).padStart(4)}  ${ms(s.p95).padStart(8)}${s.fallas ? '  <- fallas' : ''}`);
}
if (!ventana) {
  console.log('\nNinguna falla en toda la prueba.');
} else if (ventana.hasta >= linea.length - 1) {
  console.log(`\nVentana de fallas: desde el segundo ${ventana.desde} y hasta el final de la prueba: NO se recupero mientras duro.`);
} else {
  console.log(`\nVentana de fallas: del segundo ${ventana.desde} al ${ventana.hasta} (${ventana.duracionS} s, ${ventana.segundosConFallas} con fallas): lo que tardo en recuperarse.`);
}

const meta = evaluarMeta({ p95: todos.p95, errores: fallas.length, total: resultados.length }, META_P95_MS, META_ERRORES_PCT);
if (meta) console.log(`\nMeta (ADR-0013): ${meta.pasa ? 'SE CUMPLE' : 'NO SE CUMPLE'} (${meta.detalle})`);

// SALIDA relativa queda junto a este script (en resultados/, que git ignora); tambien puede ser una ruta absoluta
const archivo = fileURLToPath(new URL(SALIDA, import.meta.url));
await mkdir(dirname(archivo), { recursive: true });
await writeFile(archivo, JSON.stringify({
  prueba: 'http', fecha: new Date().toISOString(), tasa: TASA, duracionS: DURACION_S, solo: SOLO, urls: URLS,
  resumen: { ...todos, total: resultados.length, fallas: fallas.length, tasaLograda: resultados.length / duracionReal },
  porPeticion: Object.fromEntries(MEZCLA.map((p) => [p.nombre, resumen(resultados.filter((r) => r.peticion === p.nombre && r.ms !== null).map((r) => r.ms))])),
  lineaDeTiempo: linea, ventanaDeFallas: ventana, meta,
}, null, 2));
console.log(`\nResultados guardados en ${archivo}\n`);
process.exit(meta && !meta.pasa ? 1 : 0);
