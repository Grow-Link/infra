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
// Usa los usuarios de prueba: Ana (1), Daniela (4), Esteban (5, ya con roadmap y 3 cursos aprobados),
// Fernanda (6), Gabriel (7), Helena (8) y Carla (3, admin). La trivia se juega con SEIS personas a la vez.
//
// La seccion del jardin (usuarios-service) necesita que tambien esten mergeadas las ramas feat/garden de
// cursos-service (GET /api/roadmap/completados) y el endpoint GET/POST /api/jardin de usuarios-service;
// hasta entonces esa seccion falla con 404.

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
const JUGADORES = [
  { id: 1, nombre: 'Ana Torres' },
  { id: 4, nombre: 'Daniela Pérez' },
  { id: 5, nombre: 'Esteban Londoño' },
  { id: 6, nombre: 'Fernanda Ruiz' },
  { id: 7, nombre: 'Gabriel Osorio' },
  { id: 8, nombre: 'Helena Vargas' },
];
const tokens = {};
for (const j of JUGADORES) tokens[j.id] = await login(j.id);
const carla = await login(3);
ok(`login de ${JUGADORES.length} personas y de la admin`);
const ana = tokens[1];
const daniela = tokens[4];

// Todas piden su perfil por primera vez a la vez: ninguna puede fallar (carrera al crear el perfil)
const perfiles = await Promise.all(JUGADORES.map((j) => pedir(USUARIOS, '/api/perfil/me', { token: tokens[j.id] })));
revisar(perfiles.every((p) => p.estado === 200), 'seis perfiles pedidos a la vez, todos responden 200', `algun perfil fallo: ${perfiles.map((p) => p.estado)}`);
const victoriasAntes = Object.fromEntries(JUGADORES.map((j, i) => [j.id, perfiles[i].datos.triviasGanadas]));

const busqueda = await pedir(USUARIOS, '/api/usuarios/buscar?q=dani', { token: ana });
revisar(busqueda.datos?.some((u) => u.id === 4), 'Ana encuentra a Daniela buscando "dani"', 'la busqueda de personas no encontro a Daniela');

// ---------------------------------------------------------------------------------------------
console.log('\n2. Roles entre servicios (el token de usuarios-service tiene que servir en cursos y trivia)');
const adminEnCursos = await pedir(CURSOS, '/api/cursos', { token: carla });
revisar(adminEnCursos.estado === 200, 'cursos-service acepta el token', `cursos-service respondio ${adminEnCursos.estado}`);
const dashSinRol = await pedir(TRIVIA, '/api/metricas/dashboard', { token: ana });
revisar(dashSinRol.estado === 403, 'un usuario normal no ve el dashboard (403)', `esperaba 403 y fue ${dashSinRol.estado}`);
const dashAntes = await pedir(TRIVIA, '/api/metricas/dashboard', { token: carla });
revisar(dashAntes.estado === 200, 'el admin si ve el dashboard', `el admin recibio ${dashAntes.estado}`);

// ---------------------------------------------------------------------------------------------
console.log('\n3. Catalogo, control de metas y roadmap (cursos-service)');
const cursos = adminEnCursos.datos;
revisar(cursos.length >= 30 && cursos.every((c) => c.temario?.length >= 3 && c.duracionHoras > 0), `el catalogo trae ${cursos.length} cursos, todos con horas y temario`, 'hay cursos sin horas o sin temario');
const areas = await pedir(CURSOS, '/api/cursos/resumen', { token: ana });
revisar(areas.datos?.length >= 3, `las areas salen del catalogo real: ${areas.datos?.map((a) => `${a.etiqueta} (${a.cursos})`).join(', ')}`, 'no hay resumen de areas');

const generar = (token, usuarioId, metas, intereses) =>
  pedir(CURSOS, '/api/roadmap/generar', { metodo: 'POST', token, cuerpo: { usuarioId, metas, intereses, nivel: 'PRINCIPIANTE' } });
const absurda = await generar(ana, 1, 'asdfgh jkl qwerty zzz', ['INGENIERIA_SISTEMAS']);
revisar(absurda.estado === 400, 'una meta sin sentido se rechaza (400)', `la meta absurda respondio ${absurda.estado}`);
const ajena = await generar(ana, 1, 'Quiero cocinar pasteles de chocolate', ['INGENIERIA_SISTEMAS']);
revisar(ajena.estado === 422, 'una meta fuera del catalogo se rechaza (422)', `la meta ajena respondio ${ajena.estado}`);

const python = await generar(ana, 1, 'Quiero aprender Python para analizar datos', ['INGENIERIA_SISTEMAS']);
const liderazgo = await generar(daniela, 4, 'Quiero liderar equipos y gestionar proyectos', ['ADMINISTRACION_EMPRESAS']);
revisar(python.estado === 201 && liderazgo.estado === 201, 'dos metas distintas generan roadmaps', `generar respondio ${python.estado} y ${liderazgo.estado}`);
const titulos = (r) => r.datos.cursos.map((c) => c.titulo);
revisar(!titulos(python).some((t) => titulos(liderazgo).includes(t)), `los roadmaps son distintos (${titulos(python).length} y ${titulos(liderazgo).length} cursos, ninguno en comun)`, 'los dos roadmaps salieron iguales');
revisar(python.datos.cursos.every((c) => c.razon && c.duracionHoras > 0 && c.temario.length > 0 && c.linkContenido), 'cada curso del roadmap trae razon, horas, temario y enlace', 'faltan datos en el roadmap');
revisar(['IA', 'RESPALDO'].includes(python.datos.generadoPor), `el roadmap dice quien lo genero: ${python.datos.generadoPor}${python.datos.generadoPor === 'RESPALDO' ? ' (sin IA, falta CLAUDE_API_KEY)' : ''}`, 'el roadmap no trae generadoPor');

const ajeno = await pedir(CURSOS, '/api/roadmap/mio?usuarioId=1', { token: daniela });
revisar(ajeno.estado === 403, 'Daniela no puede leer el roadmap de Ana (403)', `Daniela recibio ${ajeno.estado} al pedir el roadmap de Ana`);

const yaAprobados = new Set((await pedir(CURSOS, '/api/cursos/completados?usuarioId=1', { token: ana })).datos.map((c) => c.cursoId));
const primero = python.datos.cursos.find((c) => !yaAprobados.has(c.cursoId));
const examen = await pedir(CURSOS, `/api/cursos/${primero.cursoId}/examen`, { token: ana });
revisar(examen.estado === 200 && !JSON.stringify(examen.datos).toLowerCase().includes('correcta'), 'el examen se descarga sin las respuestas correctas', 'el examen filtra las respuestas');
const intento = await pedir(CURSOS, `/api/cursos/${primero.cursoId}/examen`, { metodo: 'POST', token: ana, cuerpo: { respuestas: [-1, -1, -1] } });
revisar(intento.datos?.aprobado === false && intento.datos?.cursoCompletado === false, 'un examen en blanco no completa el curso', 'un examen en blanco completo el curso');
const forzado = await pedir(CURSOS, `/api/cursos/${primero.cursoId}/completar`, { metodo: 'POST', token: ana, cuerpo: { usuarioId: 1 } });
revisar(forzado.estado === 403, 'nadie se marca un curso como completado sin examen (403)', `completar sin examen respondio ${forzado.estado}`);

const esteban = await pedir(CURSOS, '/api/roadmap/mio?usuarioId=5', { token: tokens[5] });
const estebanCompletados = await pedir(CURSOS, '/api/cursos/completados?usuarioId=5', { token: tokens[5] });
revisar(esteban.estado === 200 && estebanCompletados.datos?.length >= 3, `Esteban (demo) ya tiene roadmap y ${estebanCompletados.datos?.length} cursos aprobados`, 'el usuario de demostracion no tiene avance');

// un curso dado de baja deja de recomendarse
const aBajar = python.datos.cursos[python.datos.cursos.length - 1];
const baja = await pedir(CURSOS, `/api/cursos/${aBajar.cursoId}/baja`, { metodo: 'PATCH', token: carla });
revisar(baja.estado === 204, `el admin da de baja "${aBajar.titulo}" aunque no sea suyo`, `la baja como admin respondio ${baja.estado}`);
const regenerado = await generar(ana, 1, 'Quiero aprender Python para analizar datos', ['INGENIERIA_SISTEMAS']);
revisar(regenerado.estado === 201 && !regenerado.datos.cursos.some((c) => c.cursoId === aBajar.cursoId), 'al regenerar, el curso dado de baja ya no se recomienda', 'el curso dado de baja siguio en el roadmap');

const home = await pedir(USUARIOS, '/api/home/estado', { token: tokens[5] });
revisar(home.datos?.estado === 'CON_ROADMAP', 'el Home de Esteban es CON_ROADMAP', `el Home dice ${home.datos?.estado}`);

// ---------------------------------------------------------------------------------------------
console.log('\n4. Reto entre dos personas (trivia-service)');
const reto = await pedir(TRIVIA, '/api/retos', {
  metodo: 'POST',
  token: ana,
  cuerpo: { retadoUsuarioId: 4, retadoNombre: 'Daniela Pérez', retadorNombre: 'Ana Torres', categoria: 'INGENIERIA_SISTEMAS', numPreguntas: 5, duracionSegundos: 10, mensaje: 'Te reto' },
});
revisar(reto.estado === 201 && reto.datos.estado === 'PENDIENTE', `Ana reto a Daniela, la sala ${reto.datos?.codigoSala} quedo esperando`, `retar respondio ${reto.estado}`);
const bandeja = await pedir(TRIVIA, '/api/retos/recibidos', { token: daniela });
revisar(bandeja.datos?.some((r) => r.id === reto.datos.id), 'el reto aparece en la bandeja de Daniela', 'el reto no llego a Daniela');
const intruso = await pedir(TRIVIA, `/api/retos/${reto.datos.id}/aceptar`, { metodo: 'POST', token: tokens[5] });
revisar(intruso.estado === 404, 'un tercero no puede aceptar un reto ajeno (404)', `un tercero recibio ${intruso.estado}`);
const aceptado = await pedir(TRIVIA, `/api/retos/${reto.datos.id}/aceptar`, { metodo: 'POST', token: daniela });
revisar(aceptado.estado === 200 && aceptado.datos.estado === 'ACEPTADO', 'Daniela acepta el reto', `aceptar respondio ${aceptado.estado}`);

// ---------------------------------------------------------------------------------------------
console.log('\n5. Partida de trivia con SEIS personas a la vez por WebSocket (trivia-service)');
const sala = await pedir(TRIVIA, '/api/salas', {
  metodo: 'POST',
  cuerpo: { categoria: 'INGENIERIA_SISTEMAS', hostUsuarioId: 1, hostNombre: 'Ana Torres', numPreguntas: 5, duracionSegundos: 20 },
});
revisar(sala.estado === 201, `sala ${sala.datos?.codigo} creada`, `crear sala respondio ${sala.estado}`);
const codigo = sala.datos.codigo;

function conectar(codigoSala, alMensaje) {
  return new Promise((resolve, reject) => {
    const cliente = new Client({ brokerURL: WS, reconnectDelay: 0 });
    cliente.onConnect = () => {
      cliente.subscribe(`/topic/salas.${codigoSala}`, (m) => alMensaje(JSON.parse(m.body)));
      resolve(cliente);
    };
    cliente.onStompError = (f) => reject(new Error(f.headers.message));
    cliente.onWebSocketError = () => reject(new Error(`no se pudo conectar a ${WS}`));
    cliente.activate();
  });
}

// Conecta a cada jugador por WebSocket, todos contestan al azar en cuanto llega la pregunta (la prueba es la
// concurrencia, no el puntaje) y resuelve con los resultados finales. La reusan la partida de seis personas y,
// mas abajo, los duelos del jardin.
function jugarPartida(codigoSala, jugadores, limiteMs = 90000) {
  return new Promise(async (resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`la partida ${codigoSala} no termino en ${limiteMs / 1000} segundos`)), limiteMs);
    const clientes = [];
    const recibieronFinal = new Set();
    const contestadas = new Map(); // usuario -> preguntas que ya contesto
    let final = null;

    const terminar = () => {
      clearTimeout(limite);
      clientes.forEach((c) => c.deactivate());
      resolve({ final, recibieronFinal });
    };

    try {
      for (const j of jugadores) {
        contestadas.set(j.id, new Set());
        const cliente = await conectar(codigoSala, (mensaje) => {
          if (mensaje.type === 'PREGUNTA' && !contestadas.get(j.id).has(mensaje.indice)) {
            contestadas.get(j.id).add(mensaje.indice);
            cliente.publish({
              destination: `/app/salas/${codigoSala}/responder`,
              body: JSON.stringify({ usuarioId: j.id, indice: mensaje.indice, opcionElegida: Math.floor(Math.random() * 4) }),
            });
          }
          if (mensaje.type === 'RESULTADOS_FINALES') {
            recibieronFinal.add(j.id);
            final = mensaje;
            if (recibieronFinal.size === jugadores.length) terminar();
          }
          if (mensaje.type === 'ERROR' && !/sala_participante/i.test(mensaje.message)) {
            clearTimeout(limite);
            reject(new Error(`trivia-service aviso un error: ${mensaje.message}`));
          }
        });
        clientes.push(cliente);
        cliente.publish({ destination: `/app/salas/${codigoSala}/unirse`, body: JSON.stringify({ usuarioId: j.id, nombre: j.nombre }) });
      }
      await new Promise((r) => setTimeout(r, 800));
      clientes[0].publish({ destination: `/app/salas/${codigoSala}/iniciar`, body: '' });
    } catch (e) {
      clearTimeout(limite);
      reject(e);
    }
  });
}

const inicio = Date.now();
const { final, recibieronFinal } = await jugarPartida(codigo, JUGADORES);
revisar(recibieronFinal.size === JUGADORES.length, `los ${JUGADORES.length} jugadores recibieron los resultados finales (en ${Math.round((Date.now() - inicio) / 1000)} s)`, `solo ${recibieronFinal.size} recibieron los resultados`);
revisar(final.ranking.length === JUGADORES.length, `el ranking final tiene a los ${JUGADORES.length}`, `el ranking tiene ${final.ranking.length} jugadores`);
revisar(final.ranking.every((r, i, a) => i === 0 || a[i - 1].puntos >= r.puntos), 'el ranking viene ordenado por puntos', 'el ranking esta desordenado');

// ---------------------------------------------------------------------------------------------
console.log('\n6. Lo que dejo la partida en los otros servicios');
await new Promise((r) => setTimeout(r, 1500)); // trivia le avisa a usuarios cuando termina, damos un momento
const acta = await pedir(TRIVIA, `/api/partidas/${codigo}`, { token: ana });
revisar(acta.estado === 200 && acta.datos.ranking.length === JUGADORES.length, `el acta de la partida quedo guardada con ${acta.datos?.ranking?.length} puestos`, `el acta respondio ${acta.estado}`);
const ganadores = final.ganadoresUsuarioIds ?? [];
const ultimos = await pedir(TRIVIA, '/api/partidas/ganadores?limite=10', { token: ana });
revisar(ultimos.datos?.some((p) => p.partida.codigo === codigo), 'la partida aparece en la lista de ganadores', 'la partida no esta en la lista de ganadores');
const mias = await pedir(TRIVIA, '/api/partidas/mias', { token: daniela });
revisar(mias.datos?.some((p) => p.partida.codigo === codigo), 'a Daniela le sale en "mis partidas"', 'la partida no sale en las partidas de Daniela');

let sumaOk = true;
for (const j of JUGADORES) {
  const ahora = (await pedir(USUARIOS, '/api/perfil/me', { token: tokens[j.id] })).datos.triviasGanadas;
  const esperado = victoriasAntes[j.id] + (ganadores.includes(j.id) ? 1 : 0);
  if (ahora !== esperado) sumaOk = false;
}
revisar(sumaOk, `las trivias ganadas se sumaron solo a quien gano (${ganadores.length === 0 ? 'nadie sumo puntos' : ganadores.length > 1 ? 'hubo empate' : 'una persona'})`, 'las trivias ganadas no cuadran');

const dashDespues = await pedir(TRIVIA, '/api/metricas/dashboard', { token: carla });
const d0 = dashAntes.datos;
const d1 = dashDespues.datos;
revisar(d1.partidasFinalizadas >= d0.partidasFinalizadas + 1, `el dashboard cuenta la partida (${d1.partidasFinalizadas} finalizadas)`, 'el dashboard no cambio');
revisar(d1.latenciaPromedioMs !== null, `latencia promedio a la primera respuesta: ${Math.round(d1.latenciaPromedioMs)} ms`, 'no hay latencia registrada');

// ---------------------------------------------------------------------------------------------
console.log('\n7. Jardin: una semilla por roadmap completado, una gota por trivia ganada (usuarios-service)');

// Semilla: el admin completa TODO lo que le falta a Ana de "regenerado" (su roadmap sin el curso dado de baja,
// armado en la seccion 3). Nadie mas puede forzar un curso como completado sin examen (ya se probo arriba con
// "forzado"), por eso lo hace Carla.
for (const c of regenerado.datos.cursos) {
  const completar = await pedir(CURSOS, `/api/cursos/${c.cursoId}/completar`, { metodo: 'POST', token: carla, cuerpo: { usuarioId: 1 } });
  if (completar.estado !== 201) mal(`el admin no pudo completar "${c.titulo}" para que Ana termine el roadmap: ${completar.estado}`);
}
const jardinTrasCompletar = await pedir(USUARIOS, '/api/jardin', { token: ana });
const semilla = jardinTrasCompletar.datos?.semillas?.find((s) => s.roadmapId === regenerado.datos.id);
revisar(jardinTrasCompletar.estado === 200 && semilla, 'al terminar el roadmap le aparece una semilla a Ana', `el jardin de Ana no tiene semilla del roadmap (${jardinTrasCompletar.estado})`);

const jardinOtraVez = await pedir(USUARIOS, '/api/jardin', { token: ana });
const semillasDelRoadmap = (jardinOtraVez.datos?.semillas ?? []).filter((s) => s.roadmapId === regenerado.datos.id);
revisar(semillasDelRoadmap.length === 1, 'un segundo GET /api/jardin no duplica la semilla', `salieron ${semillasDelRoadmap.length} semillas del mismo roadmap`);

// Plantar: el primer espacio libre del jardin de Ana. Con 0 riegos la etapa sigue siendo SEMILLA
// (sube a BROTE, PLANTA y FLORECIDA con el primer, segundo y tercer riego)
const plantada = await pedir(USUARIOS, `/api/jardin/plantas/${semilla.id}/plantar`, { metodo: 'POST', token: ana, cuerpo: { espacio: 0 } });
revisar(plantada.estado === 200 && plantada.datos?.etapa === 'SEMILLA' && plantada.datos?.espacio === 0, `la semilla se planto en el espacio 0`, `plantar la semilla respondio ${plantada.estado} (etapa ${plantada.datos?.etapa})`);
const plantaId = plantada.datos?.id;

// Gotas: un duelo de dos personas (como el reto de la seccion 4, pero jugado) por WebSocket. Nadie ve las
// respuestas correctas, asi que no se puede forzar quien gana; se repite el duelo hasta que a Ana le alcancen
// las gotas para los tres riegos (cuentan tambien las que ya tuviera, por ejemplo si gano la partida de seis).
async function gotasDeAna() {
  return (await pedir(USUARIOS, '/api/jardin', { token: ana })).datos.gotas;
}
let duelos = 0;
while ((await gotasDeAna()) < 3 && duelos < 15) {
  duelos++;
  const sala2 = await pedir(TRIVIA, '/api/salas', {
    metodo: 'POST',
    cuerpo: { categoria: 'INGENIERIA_SISTEMAS', hostUsuarioId: 1, hostNombre: 'Ana Torres', numPreguntas: 15, duracionSegundos: 20 },
  });
  await jugarPartida(sala2.datos.codigo, [JUGADORES[0], JUGADORES[1]]); // Ana y Daniela, solo dos
}
revisar(duelos < 15, `Ana junto al menos 3 gotas ganando trivias (${duelos} duelo(s) jugados)`, `Ana no llego a 3 gotas tras ${duelos} duelos`);

// Regar tres veces: SEMILLA -> BROTE -> PLANTA -> FLORECIDA, cada riego gasta una gota
const etapaEsperada = ['BROTE', 'PLANTA', 'FLORECIDA'];
let planta;
for (let i = 1; i <= 3; i++) {
  const riego = await pedir(USUARIOS, `/api/jardin/plantas/${plantaId}/regar`, { metodo: 'POST', token: ana });
  planta = riego.datos?.planta;
  revisar(riego.estado === 200 && planta?.etapa === etapaEsperada[i - 1], `riego ${i} de 3 aplicado, la planta pasa a ${etapaEsperada[i - 1]}`, `el riego ${i} respondio ${riego.estado} (etapa ${planta?.etapa})`);
}

// Un cuarto riego sobre una planta ya florecida se rechaza
const cuartoRiego = await pedir(USUARIOS, `/api/jardin/plantas/${plantaId}/regar`, { metodo: 'POST', token: ana });
revisar(cuartoRiego.estado === 409, 'un cuarto riego sobre una planta florecida se rechaza (409)', `el cuarto riego respondio ${cuartoRiego.estado}`);

console.log(fallos === 0 ? '\nTODO BIEN: el sistema funciona de punta a punta.\n' : `\n${fallos} cosa(s) fallaron, revisa arriba.\n`);
process.exit(fallos === 0 ? 0 : 1);
