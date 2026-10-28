/**
 * Wrapper enxuto do @jsquash/avif (v2.1.1) para uso direto no navegador, sem build.
 *
 * O encode.js original importa 'wasm-feature-detect' (bare specifier, não resolve
 * sem bundler) e tenta a variante multithread quando crossOriginIsolated. Aqui a
 * gente fixa a variante single-thread (avif_enc.js), que só precisa do .wasm ao lado.
 *
 * Licença Apache-2.0 — ver LICENSE nesta pasta.
 */
import { defaultOptions } from './meta.js?v=d062b5f127';
import { initEmscriptenModule } from './utils.js?v=e71535eeee';
import avifEncoderFactory from './avif_enc.js?v=c6805e62ca';

let modulePromise;

// Sufixo de versão no .wasm: gera uma chave de cache limpa (evita cópias antigas
// guardadas com Content-Type errado) e permite invalidar de propósito ao atualizar.
const WASM_VERSION = 'd9f2a95164';

export function init() {
  if (!modulePromise) {
    modulePromise = initEmscriptenModule(avifEncoderFactory, undefined, {
      locateFile: (path) => new URL(path + '?v=' + WASM_VERSION, import.meta.url).href,
    });
  }
  return modulePromise;
}

/**
 * @param {ImageData|{data:Uint8ClampedArray|Uint8Array,width:number,height:number}} imageData
 * @param {object} [options] — quality (0-100), speed (0-10), etc. Ver meta.js.
 * @returns {Promise<ArrayBuffer>} bytes do arquivo .avif
 */
export default async function encode(imageData, options = {}) {
  const opts = { ...defaultOptions, ...options };
  const module = await init();
  const output = module.encode(
    new Uint8Array(imageData.data.buffer),
    imageData.width,
    imageData.height,
    opts
  );
  if (!output) throw new Error('Falha ao codificar AVIF');
  return output.buffer;
}
