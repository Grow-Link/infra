// Las cuentas de las pruebas de carga (estadisticas.mjs). `npm test`, sin servicios levantados.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contar, evaluarMeta, lineaDeTiempo, percentil, repartir, resumen, ventanaDeFallas } from './estadisticas.mjs';

test('percentil por rango mas cercano: siempre una muestra que de verdad ocurrio', () => {
  const cien = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentil(cien, 50), 50);
  assert.equal(percentil(cien, 95), 95);
  assert.equal(percentil(cien, 99), 99);
  assert.equal(percentil(cien, 100), 100);
  assert.equal(percentil(cien, 0), 1);
  // con pocas muestras, el p99 es la mas lenta: no se inventa un valor entre dos
  assert.equal(percentil([10, 20, 30], 99), 30);
  assert.equal(percentil([10, 20, 30], 50), 20);
  assert.equal(percentil([7], 95), 7);
  assert.equal(percentil([], 95), null);
});

test('resumen ordena por su cuenta y no toca la lista original', () => {
  const valores = [30, 10, 20];
  const r = resumen(valores);
  assert.deepEqual(valores, [30, 10, 20]);
  assert.equal(r.n, 3);
  assert.equal(r.p50, 20);
  assert.equal(r.max, 30);
  assert.equal(r.media, 20);
  assert.deepEqual(resumen([]), { n: 0, p50: null, p95: null, p99: null, max: null, media: null });
});

test('linea de tiempo: cada peticion cae en el segundo en que salio', () => {
  const linea = lineaDeTiempo([
    { t: 0, ms: 10, ok: true },
    { t: 999, ms: 30, ok: false },
    { t: 1000, ms: 20, ok: true },
    { t: 2500, ms: null, ok: false }, // sin respuesta: cuenta como enviada y fallida, pero no en el p95
    { t: 5000, ms: 5, ok: true }, // fuera de la duracion: no se cuenta
  ], 3);
  assert.deepEqual(linea, [
    { s: 0, enviadas: 2, fallas: 1, p95: 30 },
    { s: 1, enviadas: 1, fallas: 0, p95: 20 },
    { s: 2, enviadas: 1, fallas: 1, p95: null },
  ]);
});

test('ventana de fallas: del primer al ultimo segundo con fallas', () => {
  const linea = [0, 0, 3, 0, 1, 0].map((fallas, s) => ({ s, enviadas: 10, fallas, p95: 1 }));
  assert.deepEqual(ventanaDeFallas(linea), { desde: 2, hasta: 4, duracionS: 3, segundosConFallas: 2 });
  assert.equal(ventanaDeFallas(linea.map((s) => ({ ...s, fallas: 0 }))), null);
});

test('repartir: salas del tamano pedido, y nunca una sala de uno', () => {
  assert.deepEqual(repartir(10, 5), [5, 5]);
  assert.deepEqual(repartir(11, 5), [5, 6]);
  assert.deepEqual(repartir(12, 5), [5, 5, 2]);
  assert.deepEqual(repartir(2, 5), [2]);
  assert.deepEqual(repartir(100, 5).length, 20);
  for (const n of [2, 3, 7, 10, 25, 51, 99, 100]) {
    const salas = repartir(n, 5);
    assert.equal(salas.reduce((a, b) => a + b, 0), n, `nadie se queda afuera con ${n}`);
    assert.ok(salas.every((s) => s >= 2), `ninguna sala de uno con ${n}`);
  }
});

test('contar: de mayor a menor', () => {
  assert.deepEqual(contar(['a', 'b', 'a', 'c', 'a', 'b']), [['a', 3], ['b', 2], ['c', 1]]);
});

test('meta: sin meta no hay veredicto; con meta, dice que no se cumplio y por que', () => {
  assert.equal(evaluarMeta({ p95: 100, errores: 0, total: 10 }, undefined, undefined), null);
  assert.deepEqual(evaluarMeta({ p95: 100, errores: 0, total: 10 }, 200, 1), { pasa: true, detalle: 'cumple' });
  const mal = evaluarMeta({ p95: 300, errores: 2, total: 100 }, 200, 1);
  assert.equal(mal.pasa, false);
  assert.match(mal.detalle, /p95 300 ms > meta 200 ms/);
  assert.match(mal.detalle, /errores 2.00 % > meta 1 %/);
  // sin ninguna medida de tiempo no se puede decir que se cumplio
  assert.equal(evaluarMeta({ p95: null, errores: 0, total: 0 }, 200, undefined).pasa, false);
});
