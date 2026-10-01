/**
 * Web Worker (módulo) que roda o encoder AVIF em WASM fora da thread principal,
 * pra não travar a interface durante a conversão em lote.
 *
 * Protocolo:
 *   ← { id, data: ArrayBuffer (RGBA), width, height, options }
 *   → { id, ok: true, buf: ArrayBuffer }   |   { id, ok: false, error: string }
 */
import avifEncode from './encode.js?b=1';

self.onmessage = async (e) => {
  const { id, data, width, height, options } = e.data;
  try {
    const view = new Uint8ClampedArray(data);
    const buf = await avifEncode({ data: view, width, height }, options);
    self.postMessage({ id, ok: true, buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
