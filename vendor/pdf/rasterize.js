/**
 * Modo "Máxima" de compressão de PDF: transforma cada página numa imagem JPEG
 * e remonta um PDF novo com uma foto por página. Funciona em qualquer PDF e
 * reduz muito casos de documento escaneado, mas o texto deixa de ser
 * selecionável/pesquisável — é rasterização mesmo, não "compressão inteligente".
 *
 * Roda na thread principal (não no worker do módulo): o pdf.js cria seu
 * próprio Web Worker internamente pra decodificar/parsear, e esse padrão só é
 * garantido a partir da thread principal — daí essa função ser chamada assim
 * pelo index.html, diferente do modo "inteligente" (compress.js), que roda
 * dentro do worker desta app.
 */
import * as pdfjsLib from './pdfjs/pdf.min.mjs?v=27fc2a057a';
import { PDFDocument } from './pdf-lib.esm.min.js?v=72c052d97b';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs?v=1baa1844c8', import.meta.url).href;

/**
 * @param {Uint8Array} fileBytes
 * @param {{dpi?:number, jpegQuality?:number, onProgress?:(p:{page:number,total:number})=>void}} [opts]
 */
export async function rasterize(fileBytes, opts = {}) {
  const dpi = opts.dpi || 120;
  const jpegQuality = opts.jpegQuality ?? 0.6;

  const loadingTask = pdfjsLib.getDocument({ data: fileBytes, isEvalSupported: false });
  const pdf = await loadingTask.promise;

  const outDoc = await PDFDocument.create();
  const scale = dpi / 72; // pdf.js trabalha em pontos (72/in); escala pra pixels no dpi alvo

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    const ctx2d = canvas.getContext('2d');
    ctx2d.fillStyle = '#ffffff'; // PDF pode ter fundo transparente; JPEG não tem alfa
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx2d, viewport }).promise;

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
    const jpgBytes = new Uint8Array(await blob.arrayBuffer());
    const img = await outDoc.embedJpg(jpgBytes);

    const origViewport = page.getViewport({ scale: 1 }); // dimensão real da página (pontos), já com /Rotate aplicado
    const outPage = outDoc.addPage([origViewport.width, origViewport.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: origViewport.width, height: origViewport.height });

    if (page.cleanup) page.cleanup();
    if (opts.onProgress) opts.onProgress({ page: i, total: pdf.numPages });
  }

  const bytes = await outDoc.save();
  await loadingTask.destroy();
  return { bytes, stats: { pages: pdf.numPages } };
}
