// Verifica, contra los servicios corriendo, cuatro cosas del roadmap con IA:
//   1. un curso NUEVO entra en los roadmaps cuya meta se relaciona con él
//   2. el TIEMPO disponible: la ruta nunca suma más horas que horas por semana x semanas
//   3. DETERMINISMO: la misma entrada da la misma ruta, una y otra vez
//   4. el publicador: "Sugerir con IA" propone prerrequisitos válidos (misma área, nivel menor)
//
//   node infra/scripts/verificar-ia.mjs              (todo)
//   SECCIONES=3 node infra/scripts/verificar-ia.mjs  (solo el determinismo; pueden ser varias: SECCIONES=1,2)
//
// Hace falta tener usuarios-service (8080) y cursos-service (8086) arriba, por ejemplo con
// infra/scripts/demo-sin-docker.ps1. Si el servicio tiene CLAUDE_API_KEY esto usa la IA real (gasta unas 12
// llamadas); si no, el modo de respaldo. El script dice en cada paso quién armó la ruta.

const USUARIOS = process.env.USUARIOS_URL ?? 'http://localhost:8080';
const CURSOS = process.env.CURSOS_URL ?? 'http://localhost:8086';

const secciones = new Set((process.env.SECCIONES ?? '1,2,3,4').split(',').map((x) => x.trim()));
let fallos = 0;
const ok = (cond, bien, mal) => {
  console.log(`  ${cond ? 'OK' : 'XX'}  ${cond ? bien : mal}`);
  if (!cond) fallos++;
};

async function pedir(base, ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  let datos = null;
  try {
    datos = await res.json();
  } catch {
    /* sin cuerpo */
  }
  return { estado: res.status, datos };
}

const entrar = async (usuarioId) => ({ id: usuarioId, token: (await pedir(USUARIOS, '/api/auth/login', { metodo: 'POST', cuerpo: { usuarioId } })).datos.token });

async function generar(usuario, metas, { intereses = ['INGENIERIA_SISTEMAS'], nivel = 'PRINCIPIANTE', horasPorSemana, semanas } = {}) {
  return pedir(CURSOS, '/api/roadmap/generar', {
    metodo: 'POST',
    token: usuario.token,
    cuerpo: { usuarioId: usuario.id, metas, intereses, nivel, ...(horasPorSemana ? { horasPorSemana, semanas } : {}) },
  });
}

const titulos = (r) => (r.datos?.cursos ?? []).map((c) => c.titulo);
const ids = (r) => (r.datos?.cursos ?? []).map((c) => c.cursoId);

const beto = await entrar(2); // publicador
const u4 = await entrar(4);
const u6 = await entrar(6);
const u7 = await entrar(7);

// ---------------------------------------------------------------- 1. curso nuevo
if (secciones.has('1')) {
console.log('\n1. Un curso nuevo entra en los roadmaps que se relacionan con él');
const metaSeguridad = 'Quiero aprender ciberseguridad para proteger los sistemas de una empresa';
const antes = await generar(u6, metaSeguridad);
console.log(`   antes de publicarlo -> HTTP ${antes.estado}, armado por: ${antes.datos?.generadoPor ?? '-'}`);
console.log(`   ruta: ${titulos(antes).join('  >  ') || antes.datos?.message}`);

const creado = await pedir(CURSOS, '/api/cursos', {
  metodo: 'POST',
  token: beto.token,
  cuerpo: {
    titulo: 'Ciberseguridad Esencial',
    descripcion: 'Aprende los fundamentos de la ciberseguridad: amenazas, contraseñas seguras, cifrado, redes seguras y cómo proteger los sistemas de una empresa.',
    categoria: 'INGENIERIA_SISTEMAS',
    nivel: 'PRINCIPIANTE',
    habilidadIds: [],
    linkContenido: 'https://www.cisa.gov/secure-our-world',
    publicadorUsuarioId: beto.id,
    prerequisitoIds: [],
    duracionHoras: 14,
    temario: ['Qué es la ciberseguridad', 'Amenazas comunes: phishing y malware', 'Contraseñas y autenticación', 'Cifrado básico', 'Proteger una red'],
    examen: [1, 2, 3].map((n) => ({ enunciado: `Pregunta ${n} de ciberseguridad`, opciones: ['Correcta', 'Incorrecta A', 'Incorrecta B', 'Incorrecta C'], respuestaCorrecta: 0 })),
  },
});
ok(creado.estado === 201, `el publicador creó «Ciberseguridad Esencial» (id ${creado.datos?.id})`, `no se pudo crear el curso (HTTP ${creado.estado}: ${JSON.stringify(creado.datos)})`);

const despues = await generar(u7, metaSeguridad);
console.log(`   después de publicarlo -> HTTP ${despues.estado}, armado por: ${despues.datos?.generadoPor ?? '-'}`);
console.log(`   ruta: ${titulos(despues).join('  >  ') || despues.datos?.message}`);
ok(ids(despues).includes(creado.datos?.id), 'el curso nuevo SÍ está en el roadmap de quien quiere aprender ciberseguridad', 'el curso nuevo no apareció en el roadmap');
const otra = await generar(u4, 'Quiero aprender Python para analizar datos');
ok(!ids(otra).includes(creado.datos?.id), 'y NO aparece en el roadmap de quien quiere analizar datos con Python (no se relaciona)', 'el curso nuevo apareció donde no tenía que ver');
}

// ---------------------------------------------------------------- 2. tiempo
if (secciones.has('2')) {
console.log('\n2. El tiempo disponible');
const metaPython = 'Quiero aprender Python para analizar datos';
const libre = await generar(u4, metaPython);
const horasLibre = libre.datos?.horasTotales ?? 0;
console.log(`   sin límite: ${horasLibre} h (armado por: ${libre.datos?.generadoPor})`);
for (const [h, s] of [[5, 8], [10, 10], [3, 20]]) {
  const r = await generar(u4, metaPython, { horasPorSemana: h, semanas: s });
  const tope = h * s;
  if (r.estado === 201) {
    ok(r.datos.horasTotales <= tope, `${h} h/semana x ${s} semanas = ${tope} h → la ruta suma ${r.datos.horasTotales} h (armado por: ${r.datos.generadoPor})`, `la ruta suma ${r.datos.horasTotales} h y el tope es ${tope} h`);
    console.log(`        ${titulos(r).join('  >  ')}`);
  } else {
    console.log(`   ${h} h/semana x ${s} semanas = ${tope} h → HTTP ${r.estado}: ${r.datos?.message}`);
    ok(r.estado === 422, 'se explica que no alcanza en vez de inventar una ruta imposible', 'respondió algo inesperado');
  }
}
const chico = await generar(u4, metaPython, { horasPorSemana: 1, semanas: 1 });
ok(chico.estado === 422 && /tiempo disponible/i.test(chico.datos?.message ?? ''), `1 hora en total → se explica: «${chico.datos?.message}»`, `con 1 hora respondió HTTP ${chico.estado}`);
}

// ---------------------------------------------------------------- 3. determinismo
if (secciones.has('3')) {
console.log('\n3. Determinismo: la misma entrada, cinco veces');
const rutas = [];
const armadoPor = [];
for (let i = 0; i < 5; i++) {
  const r = await generar(u4, 'Quiero dominar Python avanzado para desarrollar aplicaciones');
  rutas.push(ids(r));
  armadoPor.push(r.datos?.generadoPor);
}
console.log('   armado por: ' + armadoPor.join(', '));
rutas.forEach((r, i) => console.log(`   #${i + 1}: ${r.join(',')}`));
const iguales = rutas.every((r) => JSON.stringify(r) === JSON.stringify(rutas[0]));
ok(iguales, `las 5 rutas son idénticas (${rutas[0].length} cursos, mismo orden)`, `las rutas cambiaron:\n${rutas.map((r) => '     ' + r.join(',')).join('\n')}`);
const rutasT = [];
for (let i = 0; i < 3; i++) rutasT.push(ids(await generar(u4, 'Quiero dominar Python avanzado para desarrollar aplicaciones', { horasPorSemana: 8, semanas: 12 })));
ok(rutasT.every((r) => JSON.stringify(r) === JSON.stringify(rutasT[0])), 'con tiempo, también idénticas (3 de 3)', `con tiempo cambiaron:\n${rutasT.map((r) => '     ' + r.join(',')).join('\n')}`);
}

// ---------------------------------------------------------------- 4. sugerir prerrequisitos
if (secciones.has('4')) {
console.log('\n4. El publicador: «Sugerir con IA»');
const catalogo = (await pedir(CURSOS, '/api/cursos', { token: beto.token })).datos ?? [];
const nivelDe = { PRINCIPIANTE: 0, INTERMEDIO: 1, AVANZADO: 2 };
const sug = await pedir(CURSOS, '/api/cursos/sugerir-prerequisitos', {
  metodo: 'POST',
  token: beto.token,
  cuerpo: { categoria: 'INGENIERIA_SISTEMAS', nivel: 'AVANZADO', titulo: 'Seguridad Informática Avanzada', descripcion: 'Defensa de redes y aplicaciones, pruebas de penetración y respuesta a incidentes.' },
});
console.log(`   HTTP ${sug.estado}, modoRespaldo: ${sug.datos?.modoRespaldo}`);
const propuestos = (sug.datos?.prerequisitos ?? []).map((p) => catalogo.find((c) => c.id === p.id)).filter(Boolean);
console.log(`   propone: ${propuestos.map((c) => `${c.titulo} (${c.nivel})`).join(', ') || '(nada)'}`);
ok(sug.estado === 200 && propuestos.length > 0, 'devuelve prerrequisitos', 'no devolvió prerrequisitos');
ok(propuestos.every((c) => c.categoria === 'INGENIERIA_SISTEMAS' && nivelDe[c.nivel] < nivelDe.AVANZADO), 'todos son de la misma área y de un nivel menor', 'propuso algo de otra área o de nivel igual o mayor');
const principiante = await pedir(CURSOS, '/api/cursos/sugerir-prerequisitos', {
  metodo: 'POST',
  token: beto.token,
  cuerpo: { categoria: 'INGENIERIA_SISTEMAS', nivel: 'PRINCIPIANTE', titulo: 'Un curso para empezar' },
});
ok(principiante.estado === 200 && (principiante.datos?.prerequisitos ?? []).length === 0, 'para un curso de nivel principiante no sugiere nada (no hay nivel menor)', 'sugirió prerrequisitos para un curso principiante');
}

console.log(fallos === 0 ? '\nTodo bien.\n' : `\n${fallos} comprobación(es) fallaron.\n`);
process.exit(fallos === 0 ? 0 : 1);
