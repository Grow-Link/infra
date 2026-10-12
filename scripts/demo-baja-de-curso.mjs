// Demuestra, contra los servicios corriendo, que un curso dado de baja deja de recomendarse:
//   1. se toma el roadmap de Esteban (usuario 5) y se elige un curso que todavia no ha aprobado
//   2. Carla (admin) da de baja ese curso (baja logica: PATCH /api/cursos/{id}/baja)
//   3. el roadmap guardado lo marca como "no disponible"
//   4. se pide un roadmap nuevo con la misma meta y el curso NO aparece
//   5. el catalogo tampoco lo muestra
//
//   node infra/scripts/demo-baja-de-curso.mjs
//
// Hace falta tener usuarios-service (8080) y cursos-service (8086) arriba, por ejemplo con
// infra/scripts/demo-sin-docker.ps1. Si el servicio tiene CLAUDE_API_KEY, el roadmap nuevo lo arma la IA;
// si no, el modo de respaldo. En ambos casos el resultado tiene que ser el mismo: el curso no aparece.

const USUARIOS = process.env.USUARIOS_URL ?? 'http://localhost:8080';
const CURSOS = process.env.CURSOS_URL ?? 'http://localhost:8086';

let fallos = 0;
const ok = (cond, bien, mal) => {
  console.log(`${cond ? '  OK ' : '  XX '} ${cond ? bien : mal}`);
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

const entrar = async (usuarioId) => (await pedir(USUARIOS, '/api/auth/login', { metodo: 'POST', cuerpo: { usuarioId } })).datos.token;

const esteban = await entrar(5);
const carla = await entrar(3);

console.log('\n1. El roadmap actual de Esteban');
const antes = await pedir(CURSOS, '/api/roadmap/mio?usuarioId=5', { token: esteban });
ok(antes.estado === 200, `tiene roadmap (${antes.datos?.cursos?.length} cursos)`, `no se pudo leer el roadmap (${antes.estado})`);
const historial = await pedir(CURSOS, '/api/cursos/completados?usuarioId=5', { token: esteban });
const aprobados = new Set((historial?.datos ?? []).map((c) => c.cursoId));
const elegido =
  antes.datos.cursos.filter((c) => !aprobados.has(c.cursoId)).sort((a, b) => b.orden - a.orden)[0] ?? antes.datos.cursos[antes.datos.cursos.length - 1];
console.log(`   curso que se va a dar de baja: «${elegido.titulo}» (id ${elegido.cursoId})`);

console.log('\n2. Carla (admin) da de baja el curso');
const baja = await pedir(CURSOS, `/api/cursos/${elegido.cursoId}/baja`, { metodo: 'PATCH', token: carla });
ok(baja.estado === 204 || baja.estado === 200, `el curso se dio de baja (HTTP ${baja.estado})`, `no se pudo dar de baja (HTTP ${baja.estado})`);

console.log('\n3. El roadmap que ya tenia Esteban');
const guardado = await pedir(CURSOS, '/api/roadmap/mio?usuarioId=5', { token: esteban });
const nodo = guardado.datos.cursos.find((c) => c.cursoId === elegido.cursoId);
ok(nodo && nodo.activo === false, 'el curso sigue en su ruta pero marcado como NO disponible (la pantalla pide actualizar)', 'el curso no quedo marcado como no disponible');

console.log('\n4. Un roadmap nuevo con la misma meta');
const perfil = await pedir(USUARIOS, '/api/perfil/me', { token: esteban });
const nuevo = await pedir(CURSOS, '/api/roadmap/generar', {
  metodo: 'POST',
  token: esteban,
  cuerpo: { usuarioId: 5, metas: antes.datos.metas, intereses: perfil.datos?.intereses ?? antes.datos.intereses, nivel: antes.datos.nivel },
});
ok(nuevo.estado === 200 || nuevo.estado === 201, `se generó el roadmap nuevo (${nuevo.datos?.cursos?.length} cursos, armado por: ${nuevo.datos?.generadoPor ?? 'sin dato'})`, `no se pudo generar (HTTP ${nuevo.estado}: ${nuevo.datos?.message ?? ''})`);
const aparece = (nuevo.datos?.cursos ?? []).some((c) => c.cursoId === elegido.cursoId);
ok(!aparece, `«${elegido.titulo}» NO está en el roadmap nuevo`, `¡el curso dado de baja volvió a aparecer en el roadmap!`);
ok((nuevo.datos?.cursos ?? []).every((c) => c.activo), 'todos los cursos del roadmap nuevo están activos', 'hay cursos inactivos en el roadmap nuevo');
console.log('   ruta nueva: ' + (nuevo.datos?.cursos ?? []).map((c) => c.titulo).join('  >  '));

console.log('\n5. El catálogo');
const catalogo = await pedir(CURSOS, '/api/cursos', { token: esteban });
ok(!(catalogo.datos ?? []).some((c) => c.id === elegido.cursoId), 'el catálogo ya no lo muestra', 'el catálogo todavía muestra el curso');

console.log(fallos === 0 ? '\nTodo bien: un curso dado de baja no se vuelve a recomendar.\n' : `\n${fallos} comprobación(es) fallaron.\n`);
process.exit(fallos === 0 ? 0 : 1);
