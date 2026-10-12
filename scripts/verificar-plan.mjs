// Verifica, contra los servicios corriendo, el plan gratuito, las alternativas y el ahorro de llamadas a la IA:
//   1. el plan gratuito: UN solo tema (una área) por roadmap
//   2. si la meta mezcla temas distintos, se pide elegir uno (lo juzga la IA); una meta con partes que se
//      complementan ("backend con Python y bases de datos") sigue siendo un solo tema
//   3. cinco peticiones IGUALES a la vez: todas con la misma ruta y UNA sola llamada a la IA
//   4. las alternativas de cada paso: mismo nivel, cubren lo mismo y tienen examen
//
//   node infra/scripts/verificar-plan.mjs
//
// Hace falta usuarios-service (8080) y cursos-service (8086) arriba. Con CLAUDE_API_KEY usa la IA real (unas 4
// llamadas). Para el punto 3, el servidor tiene que escribir su registro en el archivo que diga LOG_CURSOS
// (por ejemplo LOG_CURSOS=cursos.log); si no se pasa, ese punto solo compara las rutas.

import fs from 'node:fs';

const USUARIOS = process.env.USUARIOS_URL ?? 'http://localhost:8080';
const CURSOS = process.env.CURSOS_URL ?? 'http://localhost:8086';

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
const generar = (u, metas, intereses = ['INGENIERIA_SISTEMAS']) =>
  pedir(CURSOS, '/api/roadmap/generar', { metodo: 'POST', token: u.token, cuerpo: { usuarioId: u.id, metas, intereses, nivel: 'PRINCIPIANTE' } });

const usuarios = await Promise.all([4, 6, 7, 8, 9, 10].map(entrar));
const [u4, u6, u7, u8, u9, u10] = usuarios;

console.log('\n1. Plan gratuito: un solo tema (una sola área)');
const dosAreas = await generar(u4, 'Quiero aprender Python para analizar datos', ['INGENIERIA_SISTEMAS', 'MATEMATICAS']);
ok(dosAreas.estado === 422 && /plan gratuito/i.test(dosAreas.datos?.message ?? ''), `dos áreas → 422: «${dosAreas.datos?.message}»`, `dos áreas respondió HTTP ${dosAreas.estado}`);

console.log('\n2. Una meta, un tema');
const mezcla = await generar(u6, 'Quiero aprender Python, contabilidad y diseño gráfico');
console.log(`   «Python, contabilidad y diseño gráfico» → HTTP ${mezcla.estado}${mezcla.datos?.message ? `: ${mezcla.datos.message}` : ''}`);
ok(mezcla.estado === 422, 'una meta que mezcla temas distintos se rechaza y se pide elegir uno', 'se aceptó una meta con varios temas');
const unTema = await generar(u7, 'Quiero aprender backend con Python y bases de datos');
console.log(`   «backend con Python y bases de datos» → HTTP ${unTema.estado}, armado por: ${unTema.datos?.generadoPor ?? '-'}`);
ok(unTema.estado === 201, 'una meta con partes que se complementan es UN solo tema y se acepta', `se rechazó una meta de un solo tema: ${unTema.datos?.message}`);

console.log('\n3. Cinco peticiones iguales a la vez');
const meta = 'Quiero entender cómo funcionan las redes de computadores';
const antes = process.env.LOG_CURSOS && fs.existsSync(process.env.LOG_CURSOS) ? fs.readFileSync(process.env.LOG_CURSOS, 'utf8') : '';
const t0 = Date.now();
const respuestas = await Promise.all([u4, u6, u8, u9, u10].map((u) => generar(u, meta)));
const segundos = ((Date.now() - t0) / 1000).toFixed(1);
const rutas = respuestas.map((r) => (r.datos?.cursos ?? []).map((c) => c.cursoId).join(','));
console.log(`   ${segundos} s en total; armado por: ${respuestas.map((r) => r.datos?.generadoPor).join(', ')}`);
ok(respuestas.every((r) => r.estado === 201) && rutas.every((r) => r === rutas[0]), `las 5 rutas son idénticas (${rutas[0]})`, `las rutas difieren:\n${rutas.join('\n')}`);
if (process.env.LOG_CURSOS && fs.existsSync(process.env.LOG_CURSOS)) {
  const nuevo = fs.readFileSync(process.env.LOG_CURSOS, 'utf8').slice(antes.length);
  const reutilizadas = (nuevo.match(/se reutiliza la propuesta de la IA/g) ?? []).length;
  console.log(`   en el registro del servidor: ${reutilizadas} propuestas reutilizadas`);
  if (respuestas[0].datos?.generadoPor === 'IA') ok(reutilizadas === 4, 'una sola llamada a la IA para las 5 peticiones (4 reutilizaron la respuesta)', `se reutilizaron ${reutilizadas} de 4: hubo más de una llamada a la IA`);
}

console.log('\n4. Alternativas de cada paso');
const catalogo = (await pedir(CURSOS, '/api/cursos', { token: u4.token })).datos ?? [];
const porId = new Map(catalogo.map((c) => [c.id, c]));
const rutaFund = await generar(u4, 'Quiero aprender fundamentos de programación');
let conAlternativas = 0;
for (const nodo of rutaFund.datos?.cursos ?? []) {
  const base = porId.get(nodo.cursoId);
  for (const alt of nodo.alternativas) {
    conAlternativas++;
    const detalle = porId.get(alt.cursoId);
    const cubre = (base?.habilidades ?? []).every((h) => (detalle?.habilidades ?? []).includes(h));
    ok(alt.nivel === nodo.nivel && cubre && alt.totalPreguntasExamen > 0, `«${alt.titulo}» es alternativa de «${nodo.titulo}» (mismo nivel, cubre ${base.habilidades.join(' + ')}, ${alt.totalPreguntasExamen} preguntas de examen)`, `«${alt.titulo}» no debería ser alternativa de «${nodo.titulo}»`);
  }
}
if (conAlternativas === 0) console.log('   (esta ruta no tiene pasos con alternativas equivalentes; es normal con un catálogo chico)');

console.log(fallos === 0 ? '\nTodo bien.\n' : `\n${fallos} comprobación(es) fallaron.\n`);
process.exit(fallos === 0 ? 0 : 1);
