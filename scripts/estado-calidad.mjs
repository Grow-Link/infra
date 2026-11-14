#!/usr/bin/env node
// El estado de SonarCloud de los cuatro proyectos en una tabla: puerta de calidad, notas, cobertura y lo que la hace fallar.
// Lee los datos publicos de SonarCloud (no hace falta iniciar sesion). Uso:   node scripts/estado-calidad.mjs
//
// El bono del profesor pide: notas A, cobertura de al menos 80 % en el backend y 40 % en el front.
const ORG = 'grow-link';
const PROYECTOS = ['usuarios-service', 'cursos-service', 'trivia-service', 'GrowLink-FRONTEND'];
const MINIMO = { 'usuarios-service': 80, 'cursos-service': 80, 'trivia-service': 80, 'GrowLink-FRONTEND': 40 };
const NOTA = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 5: 'E' };
const api = async (ruta) => (await fetch(`https://sonarcloud.io/api/${ruta}`)).json();

for (const p of PROYECTOS) {
  const clave = `Grow-Link_${p}`;
  const [puerta, medidas, problemas] = await Promise.all([
    api(`qualitygates/project_status?projectKey=${clave}`),
    api(`measures/component?component=${clave}&metricKeys=coverage,security_rating,reliability_rating,sqale_rating,vulnerabilities,bugs`),
    api(`issues/search?organization=${ORG}&componentKeys=${clave}&resolved=false&types=VULNERABILITY,BUG&ps=50`),
  ]);
  const m = Object.fromEntries((medidas.component?.measures ?? []).map((x) => [x.metric, Number(x.value)]));
  const cobertura = m.coverage;
  const nota = (k) => (m[k] ? NOTA[Math.round(m[k])] : '?');
  const estado = puerta.projectStatus?.status ?? 'SIN ANALISIS';
  console.log(`\n== ${p}`);
  console.log(`   puerta de calidad: ${estado} | seguridad ${nota('security_rating')} · fiabilidad ${nota('reliability_rating')} · mantenibilidad ${nota('sqale_rating')}`);
  console.log(`   cobertura: ${cobertura ?? 'sin dato'} % (minimo del bono: ${MINIMO[p]} %) ${cobertura >= MINIMO[p] ? 'CUMPLE' : 'NO CUMPLE'}`);
  for (const i of problemas.issues ?? []) {
    console.log(`   pendiente [${i.severity}] ${i.rule} en ${i.component.split(':').pop()}:${i.line ?? '-'} - ${i.message.slice(0, 80)}`);
  }
  if (!(problemas.issues ?? []).length && estado !== 'SIN ANALISIS') console.log('   sin vulnerabilidades ni errores abiertos');
}
console.log('\nPara que el bono cuente, los cuatro deben decir puerta OK, notas A y cobertura CUMPLE.');
