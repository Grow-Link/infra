// Prueba de humo de GrowLink: recorre el sistema de punta a punta contra los servicios de verdad
// (no contra mocks) y dice que paso en cada paso. Hace falta Node 22 o mas nuevo.
//
//   npm install
//   npm run humo
//
// Por defecto habla con los servicios directos en localhost. Con todo el compose levantado:
//   URL_USUARIOS=http://localhost:3000/api-usuarios URL_CURSOS=http://localhost:3000/api-cursos \
//   URL_TRIVIA=http://localhost:3000/api-trivia WS_TRIVIA=ws://localhost:3000/ws-trivia npm run humo
//
// Usa los usuarios de prueba: Ana (1, usuario), Daniela (4, usuario) y Carla (3, admin).

import { Client } from '@stomp/stompjs';

const USUARIOS = process.env.URL_USUARIOS ?? 'http://localhost:8080';
const CURSOS = process.env.URL_CURSOS ?? 'http://localhost:8086';
const TRIVIA = process.env.URL_TRIVIA ?? 'http://localhost:8085';
const WS = process.env.WS_TRIVIA ?? 'ws://localhost:8085/ws';

let fallos = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const mal = (msg) => {
  fallos++;
  console.log(`  FALLA ${msg}`);
};
const revisar = (condicion, bueno, malo) => (condicion ? ok(bueno) : mal(malo));

async function pedir(base, ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  return { estado: res.status, datos, instancia: res.headers.get('x-instancia') };
}

async function login(usuarioId) {
  const r = await pedir(USUARIOS, '/api/auth/login', { metodo: 'POST', cuerpo: { usuarioId } });
  if (r.estado !== 200) throw new Error(`no se pudo iniciar sesion como ${usuarioId}: ${r.estado}`);
  return r.datos.token;
}

// ---------------------------------------------------------------------------------------------
console.log('\n1. Sesion y perfil (usuarios-service)');
const ana = await login(1);
const daniela = await login(4);
const carla = await login(3);
ok('login de Ana, Daniela y Carla');

const antes = (await pedir(USUARIOS, '/api/perfil/me', { token: ana })).datos;
revisar(typeof antes.triviasGanadas === 'number', `Ana tiene ${antes.triviasGanadas} trivias ganadas`, 'el perfil no trae triviasGanadas');

// ---------------------------------------------------------------------------------------------
console.log('\n2. Roles entre servicios (el token de usuarios-service tiene que servir en cursos y trivia)');
const adminEnCursos = await pedir(CURSOS, '/api/cursos', { token: carla });
revisar(adminEnCursos.estado === 200, 'cursos-service acepta el token', `cursos-service respondio ${adminEnCursos.estado}`);
const dashSinRol = await pedir(TRIVIA, '/api/metricas/dashboard', { token: ana });
revisar(dashSinRol.estado === 403, 'un usuario normal no ve el dashboard (403)', `esperaba 403 y fue ${dashSinRol.estado}`);
const dashAntes = await pedir(TRIVIA, '/api/metricas/dashboard', { token: carla });
revisar(dashAntes.estado === 200, 'el admin si ve el dashboard', `el admin recibio ${dashAntes.estado}`);

const curso = adminEnCursos.datos?.find((c) => c.activo);
if (curso) {
  const baja = await pedir(CURSOS, `/api/cursos/${curso.id}/baja`, { metodo: 'PATCH', token: carla });
  revisar(baja.estado === 204, `el admin da de baja el curso "${curso.titulo}" aunque no sea suyo`, `la baja como admin respondio ${baja.estado}`);
}

// ---------------------------------------------------------------------------------------------
console.log('\n3. Roadmap (cursos-service) y Home (usuarios-service consulta a cursos-service)');
const pasos = [
  ['metas', { metas: 'Quiero ser backend developer' }],
  ['intereses', { intereses: ['INGENIERIA_SISTEMAS'] }],
  ['nivel', { nivel: 'PRINCIPIANTE' }],
];
for (const [ruta, cuerpo] of pasos) await pedir(USUARIOS, `/api/perfil/${ruta}`, { metodo: 'PUT', token: ana, cuerpo });
const gen = await pedir(CURSOS, '/api/roadmap/generar', {
  metodo: 'POST',
  token: ana,
  cuerpo: { usuarioId: 1, metas: 'Quiero ser backend developer', intereses: ['INGENIERIA_SISTEMAS'], nivel: 'PRINCIPIANTE' },
});
revisar(gen.estado === 201 && gen.datos.cursos.length > 0, `roadmap generado con ${gen.datos?.cursos?.length} cursos`, `generar roadmap respondio ${gen.estado}`);
const home = await pedir(USUARIOS, '/api/home/estado', { token: ana });
revisar(home.datos?.estado === 'CON_ROADMAP', 'el Home de Ana pasa a CON_ROADMAP', `el Home dice ${home.datos?.estado}`);

// ---------------------------------------------------------------------------------------------
console.log('\n4. Partida de trivia completa por WebSocket (trivia-service)');
const sala = await pedir(TRIVIA, '/api/salas', {
  metodo: 'POST',
  cuerpo: { categoria: 'INGENIERIA_SISTEMAS', hostUsuarioId: 1, hostNombre: 'Ana', numPreguntas: 5, duracionSegundos: 20 },
});
revisar(sala.estado === 201, `sala ${sala.datos?.codigo} creada`, `crear sala respondio ${sala.estado}`);
const codigo = sala.datos.codigo;

function conectar(usuarioId, alMensaje) {
  return new Promise((resolve, reject) => {
    const cliente = new Client({ brokerURL: WS, reconnectDelay: 0 });
    cliente.onConnect = () => {
      cliente.subscribe(`/topic/salas/${codigo}`, (m) => alMensaje(JSON.parse(m.body)));
      resolve(cliente);
    };
    cliente.onStompError = (f) => reject(new Error(f.headers.message));
    cliente.onWebSocketError = () => reject(new Error(`no se pudo conectar a ${WS}`));
    cliente.activate();
  });
}

const resultado = await new Promise(async (resolve, reject) => {
  const limite = setTimeout(() => reject(new Error('la partida no termino en 60 segundos')), 60000);
  let clienteAna, clienteDaniela;
  const respondidas = new Set();
  const fin = (r) => {
    clearTimeout(limite);
    clienteAna.deactivate();
    clienteDaniela.deactivate();
    resolve(r);
  };
  const enviar = (cliente, usuarioId, indice, opcionElegida) =>
    cliente.publish({ destination: `/app/salas/${codigo}/responder`, body: JSON.stringify({ usuarioId, indice, opcionElegida }) });

  // Ana siempre acierta la primera (opcion 0), Daniela siempre falla (opcion 1)
  const manejar = (mensaje) => {
    if (mensaje.type === 'PREGUNTA' && !respondidas.has(mensaje.indice)) {
      respondidas.add(mensaje.indice);
      enviar(clienteAna, 1, mensaje.indice, 0);
      setTimeout(() => enviar(clienteDaniela, 4, mensaje.indice, 1), 150);
    }
    if (mensaje.type === 'RESULTADOS_FINALES') fin(mensaje);
    if (mensaje.type === 'ERROR') {
      clearTimeout(limite);
      reject(new Error(`trivia-service avisó un error: ${mensaje.message}`));
    }
  };
  try {
    clienteAna = await conectar(1, manejar);
    clienteDaniela = await conectar(4, () => {});
    clienteDaniela.publish({ destination: `/app/salas/${codigo}/unirse`, body: JSON.stringify({ usuarioId: 4, nombre: 'Daniela' }) });
    await new Promise((r) => setTimeout(r, 500));
    clienteAna.publish({ destination: `/app/salas/${codigo}/iniciar`, body: '' });
  } catch (e) {
    clearTimeout(limite);
    reject(e);
  }
});
revisar(resultado.ganadorUsuarioId === 1, 'la partida termino y gano Ana', `el ganador fue ${resultado.ganadorUsuarioId}`);

// ---------------------------------------------------------------------------------------------
console.log('\n5. Lo que dejo la partida en los otros servicios');
// trivia le avisa a usuarios cuando termina la partida, damos un momento a que llegue la llamada
await new Promise((r) => setTimeout(r, 1000));
const despues = (await pedir(USUARIOS, '/api/perfil/me', { token: ana })).datos;
revisar(despues.triviasGanadas === antes.triviasGanadas + 1, `Ana ahora tiene ${despues.triviasGanadas} trivias ganadas (+1)`, `las trivias ganadas fueron ${antes.triviasGanadas} -> ${despues.triviasGanadas}`);
const dashDespues = await pedir(TRIVIA, '/api/metricas/dashboard', { token: carla });
const d0 = dashAntes.datos;
const d1 = dashDespues.datos;
revisar(d1.partidasFinalizadas === d0.partidasFinalizadas + 1, `el dashboard cuenta la partida (${d1.partidasFinalizadas} finalizadas)`, 'el dashboard no cambio');
revisar(d1.latenciaPromedioMs !== null, `latencia promedio a la primera respuesta: ${Math.round(d1.latenciaPromedioMs)} ms`, 'no hay latencia registrada');
revisar(d1.empatesResueltos >= d0.empatesResueltos, `empates resueltos: ${d1.empatesResueltos}`, 'los empates bajaron');

console.log(fallos === 0 ? '\nTODO BIEN: el sistema funciona de punta a punta.\n' : `\n${fallos} cosa(s) fallaron, revisa arriba.\n`);
process.exit(fallos === 0 ? 0 : 1);
