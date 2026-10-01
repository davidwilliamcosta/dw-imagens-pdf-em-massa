/**
 * Worker (módulo) para os níveis "Baixa" e "Recomendada" (compressão inteligente,
 * só imagens — ver compress.js). O nível "Máxima" (rasterizar) roda na thread
 * principal — ver rasterize.js e o comentário lá explicando o porquê.
 *
 * Protocolo:
 *   ← { id, bytes: ArrayBuffer, level: 'baixa'|'recomendada' }
 *   → progresso: { id, progress: {imagesTotal, imagesTouched} }
 *   → final:     { id, ok:true, bytes: ArrayBuffer, stats }  |  { id, ok:false, error }
 */
import { smartCompress } from './compress.js?b=5';

self.onmessage = async (e) => {
  const { id, bytes, level } = e.data;
  try {
    const fileBytes = new Uint8Array(bytes);
    const { bytes: outBytes, stats } = await smartCompress(fileBytes, level, {
      onProgress: (p) => self.postMessage({ id, progress: p }),
    });
    self.postMessage({ id, ok: true, bytes: outBytes.buffer, stats }, [outBytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
