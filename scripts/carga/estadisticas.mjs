// Cuentas de las pruebas de carga: percentiles, resumenes y la linea de tiempo por segundo. Sin dependencias, para
// poder probarlas solas (estadisticas.test.mjs, `npm test`).

/**
 * El percentil p (0 a 100) por el metodo del rango mas cercano: el valor que deja al p % de las muestras por debajo
 * o igual. Con 100 muestras ordenadas, el p95 es la numero 95. No interpola: siempre devuelve una muestra que de
 * verdad ocurrio. `ordenadas` tiene que venir ordenada de menor a mayor.
 */
export function percentil(ordenadas, p) {
  if (ordenadas.length === 0) return null;
  if (p <= 0) return ordenadas[0];
  if (p >= 100) return ordenadas[ordenadas.length - 1];
  const rango = Math.ceil((p / 100) * ordenadas.length);
  return ordenadas[rango - 1];
}

/** n, p50, p95, p99, maximo y media de una lista de tiempos (en ms). Con la lista vacia, todo null y n = 0. */
export function resumen(valores) {
  const ordenadas = [...valores].sort((a, b) => a - b);
  const n = ordenadas.length;
  return {
    n,
    p50: percentil(ordenadas, 50),
    p95: percentil(ordenadas, 95),
    p99: percentil(ordenadas, 99),
    max: n ? ordenadas[n - 1] : null,
    media: n ? ordenadas.reduce((s, v) => s + v, 0) / n : null,
  };
}

/**
 * Agrupa las peticiones por el segundo en que salieron (desde el inicio de la prueba): cuantas salieron, cuantas
 * fallaron y el p95 de las que salieron en ese segundo. Es lo que deja ver cuanto tardo el sistema en recuperarse
 * al apagar una replica. `peticiones`: [{ t (ms desde el inicio), ms, ok }].
 */
export function lineaDeTiempo(peticiones, duracionS) {
  const segundos = Array.from({ length: Math.max(0, duracionS) }, (_, s) => ({ s, enviadas: 0, fallas: 0, tiempos: [] }));
  for (const p of peticiones) {
    const s = Math.floor(p.t / 1000);
    if (s < 0 || s >= segundos.length) continue;
    segundos[s].enviadas++;
    if (!p.ok) segundos[s].fallas++;
    if (p.ms !== null && p.ms !== undefined) segundos[s].tiempos.push(p.ms);
  }
  return segundos.map(({ s, enviadas, fallas, tiempos }) => ({ s, enviadas, fallas, p95: resumen(tiempos).p95 }));
}

/**
 * La ventana de fallas de una linea de tiempo: desde el primer segundo con alguna falla hasta el ultimo. Si no hubo
 * fallas, null. `segundosConFallas` dice cuantos segundos de esa ventana tuvieron al menos una (si la ventana es de 8
 * s pero solo 3 tuvieron fallas, fueron fallas sueltas y no una caida).
 */
export function ventanaDeFallas(linea) {
  const conFallas = linea.filter((s) => s.fallas > 0);
  if (conFallas.length === 0) return null;
  const desde = conFallas[0].s;
  const hasta = conFallas[conFallas.length - 1].s;
  return { desde, hasta, duracionS: hasta - desde + 1, segundosConFallas: conFallas.length };
}

/** Reparte n jugadores en salas de `porSala`; si sobra uno solo, se va a la ultima sala (una sala necesita 2). */
export function repartir(n, porSala) {
  const salas = [];
  for (let i = 0; i < n; i += porSala) salas.push(Math.min(porSala, n - i));
  if (salas.length > 1 && salas[salas.length - 1] === 1) salas[salas.length - 2] += salas.pop();
  return salas;
}

/** Cuantas veces aparece cada valor de una lista, de mayor a menor. */
export function contar(valores) {
  const cuenta = new Map();
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
}

/** Un tiempo para mostrar: "123 ms", o "-" si no hay. */
export function ms(valor) {
  return valor === null || valor === undefined ? '-' : `${Math.round(valor)} ms`;
}

/** Una tabla de texto con las columnas alineadas. `filas` es una lista de listas de textos. */
export function tabla(encabezado, filas) {
  const todas = [encabezado, ...filas].map((f) => f.map((c) => String(c)));
  const anchos = encabezado.map((_, i) => Math.max(...todas.map((f) => f[i].length)));
  const linea = (f) => f.map((c, i) => (i === 0 ? c.padEnd(anchos[i]) : c.padStart(anchos[i]))).join('  ');
  return [linea(todas[0]), anchos.map((a) => '-'.repeat(a)).join('  '), ...todas.slice(1).map(linea)].join('\n');
}

/**
 * Compara un resultado con una meta opcional (las de ADR-0013). Devuelve null si no se pidio meta, o
 * { pasa, detalle }.
 */
export function evaluarMeta({ p95, errores, total }, metaP95Ms, metaErroresPct) {
  if (metaP95Ms === undefined && metaErroresPct === undefined) return null;
  const fallas = [];
  if (metaP95Ms !== undefined && (p95 === null || p95 > metaP95Ms)) fallas.push(`p95 ${ms(p95)} > meta ${metaP95Ms} ms`);
  const pct = total ? (100 * errores) / total : 0;
  if (metaErroresPct !== undefined && pct > metaErroresPct) fallas.push(`errores ${pct.toFixed(2)} % > meta ${metaErroresPct} %`);
  return { pasa: fallas.length === 0, detalle: fallas.length ? fallas.join('; ') : 'cumple' };
}

/** Lee un numero de una variable de entorno, o el valor por defecto. Un valor que no es numero corta la prueba. */
export function numeroDelEntorno(nombre, porDefecto) {
  const crudo = process.env[nombre];
  if (crudo === undefined || crudo.trim() === '') return porDefecto;
  const valor = Number(crudo);
  if (!Number.isFinite(valor)) throw new Error(`${nombre} tiene que ser un numero, y llego "${crudo}"`);
  return valor;
}
