/**
 * Modo "inteligente" de compressão de PDF (níveis Baixa e Recomendada):
 * percorre os XObjects de imagem do documento e recomprime cada um via Canvas,
 * SEM tocar em texto, fontes ou vetores — o PDF continua com texto selecionável
 * e pesquisável. Roda dentro do worker (usa OffscreenCanvas).
 *
 * O que é recomprimido, com segurança:
 *   - imagens já em JPEG (/DCTDecode) com colorspace RGB/Gray (pula CMYK/Indexed/
 *     ICC exótico pra não arriscar corromper cor)
 *   - bitmaps crus 8bpc RGB/Gray (normalmente /FlateDecode, típico de PNG colado
 *     em editor de texto/apresentação)
 * O que fica de fora por segurança (não mexe, mantém como está):
 *   - imagens com /SMask ou /Mask (transparência)
 *   - CCITTFax/JBIG2 (fax/scan preto-e-branco — já são bem compactos)
 *   - JPXDecode (JPEG2000 — já eficiente)
 *   - Indexed, CMYK, Separation/DeviceN, 1/2/4 bpc
 *
 * "Recomendada" usa content-ops.js pra descobrir o tamanho REAL de exibição de
 * cada imagem na página (o "DPI efetivo") e reamostra pra maxDpi daquele nível —
 * a mesma técnica que Acrobat/Ghostscript chamam de "downsample". "Baixa" só
 * aplica um teto de dimensão em pixels, sem olhar a página (mais conservador).
 */
import {
  PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict,
  decodePDFRawStream,
} from './pdf-lib.esm.min.js?v=72c052d97b';
import { analyzeContentStream, mul, IDENTITY } from './content-ops.js?v=b6b7c5499b';

export const LEVELS = {
  baixa: { jpegQuality: 0.88, maxDpi: null, fallbackMaxDim: 3000, minSourceBytes: 8192 },
  recomendada: { jpegQuality: 0.75, maxDpi: 150, fallbackMaxDim: 1800, minSourceBytes: 4096 },
};

function name(v) {
  return v && typeof v.asString === 'function' ? v.asString() : undefined;
}

function isSafeRgbColorSpace(csObj) {
  if (!csObj) return true; // sem specifier: assume o padrão do próprio JPEG (RGB/Gray)
  const n = name(csObj);
  if (n === '/DeviceRGB' || n === '/DeviceGray' || n === '/CalRGB' || n === '/CalGray') return true;
  if (n === '/DeviceCMYK') return false;
  if (csObj instanceof PDFArray) {
    const head = name(csObj.lookup(0));
    if (head === '/ICCBased') {
      const profile = csObj.lookup(1);
      const comps = profile && profile.dict ? profile.dict.lookup(PDFName.of('N')) : undefined;
      const nComp = comps && comps.asNumber ? comps.asNumber() : undefined;
      return nComp === 1 || nComp === 3;
    }
    if (head === '/CalRGB' || head === '/CalGray') return true;
    return false; // Indexed, Separation, DeviceN, Lab...
  }
  return false;
}

// só chamar depois de isSafeRgbColorSpace(csObj) já ter dado true
function colorSpaceChannelCount(csObj) {
  const n = name(csObj);
  if (n === '/DeviceGray' || n === '/CalGray') return 1;
  if (n === '/DeviceRGB' || n === '/CalRGB') return 3;
  if (!csObj) return 3;
  if (csObj instanceof PDFArray) {
    const head = name(csObj.lookup(0));
    if (head === '/CalGray') return 1;
    if (head === '/CalRGB') return 3;
    if (head === '/ICCBased') {
      const profile = csObj.lookup(1);
      const comps = profile && profile.dict ? profile.dict.lookup(PDFName.of('N')) : undefined;
      const nComp = comps && comps.asNumber ? comps.asNumber() : undefined;
      if (nComp === 1) return 1;
    }
  }
  return 3;
}

function refKey(ref) {
  return ref && ref.tag ? ref.tag : String(ref);
}

/** Mapa PDFRef(tag) -> {w,h} maior tamanho de exibição visto (em pontos, 1/72in) */
function mergedStreamBytes(ctx, contentsField) {
  const contents = ctx.lookup(contentsField);
  const parts = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = ctx.lookup(contents.get(i));
      if (s) parts.push(decodePDFRawStream(s).decode());
    }
  } else if (contents) {
    parts.push(decodePDFRawStream(contents).decode());
  }
  if (!parts.length) return null;
  const total = parts.reduce((n, b) => n + b.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const b of parts) { merged.set(b, off); off += b.length; }
  return merged;
}

const FORM_MATRIX_IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Anda pelo content stream registrando o tamanho de exibição de cada imagem
 * (em `out`), recursando em Form XObjects — muitos geradores de PDF real
 * (Word, LibreOffice, Canva, Adobe) colocam imagem dentro de um Form em vez
 * de desenhar direto na página, então sem isso a análise não vê nada.
 */
function walkXObjects(ctx, resources, contentBytes, initialCTM, depth, visited, out) {
  if (depth > 6 || !resources) return; // trava de segurança contra form autorreferente/aninhamento absurdo
  // lookupMaybe (não lookup): página/form sem nenhum XObject é normal (texto
  // puro), não deve virar exceção
  const xobjDict = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xobjDict) return;

  analyzeContentStream(contentBytes, {
    initialCTM,
    onDo: (xname, ctm) => {
      const ref = xobjDict.get(PDFName.of(xname));
      if (!ref) return;
      let obj;
      try { obj = ctx.lookup(ref); } catch (e) { return; }
      if (!(obj instanceof PDFRawStream)) return;
      const subtype = name(obj.dict.lookup(PDFName.of('Subtype')));

      if (subtype === '/Image') {
        const [a, b, c, d] = ctm;
        const w = Math.hypot(a, b);
        const h = Math.hypot(c, d);
        const key = refKey(ref);
        const prev = out.get(key);
        if (!prev || w > prev.w || h > prev.h) {
          out.set(key, { w: Math.max(w, prev ? prev.w : 0), h: Math.max(h, prev ? prev.h : 0) });
        }
        return;
      }

      if (subtype === '/Form') {
        const refTag = refKey(ref);
        if (visited.has(refTag)) return; // evita loop (form que se referencia, direta ou indiretamente)
        let formBytes;
        try { formBytes = decodePDFRawStream(obj).decode(); } catch (e) { return; }

        // Matrix do form (opcional) é aplicada ANTES da CTM corrente, por spec
        const matrixArr = obj.dict.lookup(PDFName.of('Matrix'));
        let formMatrix = FORM_MATRIX_IDENTITY;
        if (matrixArr instanceof PDFArray && matrixArr.size() === 6) {
          formMatrix = [0, 1, 2, 3, 4, 5].map((i) => {
            const v = matrixArr.lookup(i);
            return v && v.asNumber ? v.asNumber() : FORM_MATRIX_IDENTITY[i];
          });
        }
        const composedCTM = mul(formMatrix, ctm);

        // Resources do form; se não tiver, herda o dos Resources que o envolvem (spec)
        const formResources = obj.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || resources;

        const nextVisited = new Set(visited);
        nextVisited.add(refTag);
        walkXObjects(ctx, formResources, formBytes, composedCTM, depth + 1, nextVisited, out);
      }
    },
  });
}

function computeEffectiveDisplaySizes(pdfDoc) {
  const ctx = pdfDoc.context;
  const out = new Map();
  let pages;
  try {
    pages = pdfDoc.getPages();
  } catch (e) {
    return out;
  }
  for (const page of pages) {
    try {
      const node = page.node;
      const resources = node.Resources && node.Resources();
      if (!resources) continue;
      const merged = mergedStreamBytes(ctx, node.get(PDFName.of('Contents')));
      if (!merged) continue;
      walkXObjects(ctx, resources, merged, IDENTITY, 0, new Set(), out);
    } catch (e) {
      console.warn('[pdf-compress] análise de DPI efetivo falhou numa página, ignorando:', e);
    }
  }
  return out;
}

async function decodeToBitmap(dict, contents, filterNames) {
  if (filterNames.length === 1 && filterNames[0] === '/DCTDecode') {
    if (!isSafeRgbColorSpace(dict.lookup(PDFName.of('ColorSpace')))) return null;
    const blob = new Blob([contents], { type: 'image/jpeg' });
    return createImageBitmap(blob);
  }

  if (filterNames.length === 0 || (filterNames.length === 1 && filterNames[0] === '/FlateDecode')) {
    const width = dict.lookup(PDFName.of('Width'))?.asNumber();
    const height = dict.lookup(PDFName.of('Height'))?.asNumber();
    const bpc = dict.lookup(PDFName.of('BitsPerComponent'))?.asNumber() ?? 8;
    const csObj = dict.lookup(PDFName.of('ColorSpace'));
    if (!width || !height || bpc !== 8) return null;
    // usa a mesma checagem do caminho JPEG — cobre ICCBased(sRGB/gray), muito
    // comum em foto profissional, que a checagem antiga (só nome literal
    // DeviceRGB/DeviceGray) deixava passar batido e silenciosamente pulava
    if (!isSafeRgbColorSpace(csObj)) return null; // Indexed/CMYK/etc: não arrisca
    const channels = colorSpaceChannelCount(csObj);

    const raw = decodePDFRawStream({ dict, contents }).decode();
    if (raw.length < width * height * channels) return null;

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0, s = 0; p < width * height; p++, s += channels) {
      if (channels === 1) {
        const v = raw[s];
        rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255;
      } else {
        rgba[p * 4] = raw[s]; rgba[p * 4 + 1] = raw[s + 1]; rgba[p * 4 + 2] = raw[s + 2]; rgba[p * 4 + 3] = 255;
      }
    }
    return createImageBitmap(new ImageData(rgba, width, height));
  }

  return null; // CCITT/JBIG2/JPX/cadeias de filtro exóticas: mantém como está
}

function computeTargetDims(width, height, level, displaySize) {
  let targetW = width;
  let targetH = height;
  if (level.maxDpi && displaySize && displaySize.w > 0 && displaySize.h > 0) {
    const maxPxW = Math.max(64, Math.ceil((displaySize.w / 72) * level.maxDpi));
    const maxPxH = Math.max(64, Math.ceil((displaySize.h / 72) * level.maxDpi));
    targetW = Math.min(width, maxPxW);
    targetH = Math.min(height, maxPxH);
  }
  // teto fixo sempre aplicado por cima do resultado acima — se a análise de DPI
  // efetivo não achou a imagem (ex.: veio de um caminho do PDF que a v1 do
  // interpretador ainda não cobre) ou achou uma área de exibição grande demais,
  // isso garante que "Recomendada" nunca fica menos agressivo que "Baixa"
  if (level.fallbackMaxDim && Math.max(targetW, targetH) > level.fallbackMaxDim) {
    const scale = level.fallbackMaxDim / Math.max(targetW, targetH);
    targetW = Math.max(1, Math.round(targetW * scale));
    targetH = Math.max(1, Math.round(targetH * scale));
  }
  return { targetW, targetH };
}

async function encodeJpeg(bitmap, targetW, targetH, quality) {
  const canvas = new OffscreenCanvas(targetW, targetH);
  const cctx = canvas.getContext('2d');
  cctx.drawImage(bitmap, 0, 0, targetW, targetH);
  if (bitmap.close) bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

function filterNamesOf(dict) {
  const filterVal = dict.lookup(PDFName.of('Filter'));
  return filterVal instanceof PDFArray
    ? Array.from({ length: filterVal.size() }, (_, i) => name(filterVal.lookup(i)))
    : filterVal ? [name(filterVal)] : [];
}

/**
 * Recomprime uma imagem que tem canal alfa (/SMask): decodifica e reamostra a
 * imagem base E a máscara juntas, pro mesmo tamanho, e só aplica as duas se o
 * par ficar menor no total — nunca troca só uma metade (a máscara sozinha
 * sem a imagem nova, ou vice-versa, deixaria o PDF com um descompasso bobo).
 * A máscara em si vira JPEG também (o formato PDF aceita /SMask em DCTDecode);
 * ela já é pequena, então o ganho real vem quase todo da imagem base.
 */
async function recompressWithSMask(ctx, ref, obj, smaskRef, smaskObj, level, displaySize) {
  const dict = obj.dict;
  const smaskDict = smaskObj.dict;

  const width = dict.lookup(PDFName.of('Width'))?.asNumber();
  const height = dict.lookup(PDFName.of('Height'))?.asNumber();
  if (!width || !height) return null;

  const beforeBase = obj.contents.length;
  const beforeMask = smaskObj.contents.length;
  const before = beforeBase + beforeMask;
  if (beforeBase < level.minSourceBytes) return null;

  let baseBitmap;
  let maskBitmap;
  try {
    baseBitmap = await decodeToBitmap(dict, obj.contents, filterNamesOf(dict));
    if (!baseBitmap) return null;
    maskBitmap = await decodeToBitmap(smaskDict, smaskObj.contents, filterNamesOf(smaskDict));
  } catch (e) {
    return null; // imagem ou máscara malformada/incomum — deixa como está
  }
  if (!baseBitmap || !maskBitmap) return null;

  const { targetW, targetH } = computeTargetDims(width, height, level, displaySize);

  const newBaseBytes = await encodeJpeg(baseBitmap, targetW, targetH, level.jpegQuality);
  const newMaskBytes = await encodeJpeg(maskBitmap, targetW, targetH, level.jpegQuality);
  const after = newBaseBytes.length + newMaskBytes.length;
  if (after >= before) return null; // não piora o par — mantém os dois como estavam

  const newMaskDict = ctx.obj({
    Type: 'XObject', Subtype: 'Image',
    Width: targetW, Height: targetH, BitsPerComponent: 8,
    ColorSpace: 'DeviceGray', Filter: 'DCTDecode',
  });
  ctx.assign(smaskRef, PDFRawStream.of(newMaskDict, newMaskBytes));

  const newBaseDict = ctx.obj({
    Type: 'XObject', Subtype: 'Image',
    Width: targetW, Height: targetH, BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB', Filter: 'DCTDecode',
    SMask: smaskRef, // mesma referência de antes — continua apontando pro objeto certo
  });
  ctx.assign(ref, PDFRawStream.of(newBaseDict, newBaseBytes));

  return { before, after };
}

async function recompressImage(ctx, ref, obj, level, displaySize) {
  const dict = obj.dict;
  if (dict.lookup(PDFName.of('Mask')) || dict.lookup(PDFName.of('ImageMask'))) {
    return null; // stencil mask / color-key mask: não mexe, risco demais pra v1
  }

  const smaskRef = dict.get(PDFName.of('SMask'));
  if (smaskRef) {
    let smaskObj;
    try { smaskObj = ctx.lookup(smaskRef); } catch (e) { return null; }
    if (!(smaskObj instanceof PDFRawStream)) return null;
    if (smaskObj.dict.lookup(PDFName.of('SMask')) || smaskObj.dict.lookup(PDFName.of('Mask'))) {
      return null; // máscara com a própria máscara — fora do espec comum, não arrisca
    }
    return recompressWithSMask(ctx, ref, obj, smaskRef, smaskObj, level, displaySize);
  }

  const width = dict.lookup(PDFName.of('Width'))?.asNumber();
  const height = dict.lookup(PDFName.of('Height'))?.asNumber();
  if (!width || !height) return null;

  const before = obj.contents.length;
  if (before < level.minSourceBytes) return null; // pequena demais, não compensa

  let bitmap;
  try {
    bitmap = await decodeToBitmap(dict, obj.contents, filterNamesOf(dict));
  } catch (e) {
    return null; // imagem malformada/incomum — deixa como está
  }
  if (!bitmap) return null;

  const { targetW, targetH } = computeTargetDims(width, height, level, displaySize);
  const newBytes = await encodeJpeg(bitmap, targetW, targetH, level.jpegQuality);
  if (newBytes.length >= before) return null; // não piora — mantém o original

  const newDict = ctx.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: targetW,
    Height: targetH,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    Filter: 'DCTDecode',
  });
  ctx.assign(ref, PDFRawStream.of(newDict, newBytes));

  return { before, after: newBytes.length };
}

/**
 * @param {Uint8Array} fileBytes
 * @param {'baixa'|'recomendada'} levelKey
 * @param {{onProgress?:(p:{imagesTotal:number, imagesTouched:number})=>void}} [opts]
 */
export async function smartCompress(fileBytes, levelKey, opts = {}) {
  const level = LEVELS[levelKey] || LEVELS.recomendada;
  const pdfDoc = await PDFDocument.load(fileBytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
  const ctx = pdfDoc.context;

  const effectiveSizes = level.maxDpi ? computeEffectiveDisplaySizes(pdfDoc) : new Map();

  const allObjects = [...ctx.enumerateIndirectObjects()];

  // imagens que são a /SMask de outra imagem são tratadas junto com a "dona"
  // (recompressWithSMask) — pular aqui evita processar a máscara 2x
  const smaskRefs = new Set();
  for (const [, obj] of allObjects) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (name(obj.dict.lookup(PDFName.of('Subtype'))) !== '/Image') continue;
    const sm = obj.dict.get(PDFName.of('SMask'));
    if (sm) smaskRefs.add(refKey(sm));
  }

  let imagesTotal = 0;
  let imagesTouched = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const [ref, obj] of allObjects) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (name(obj.dict.lookup(PDFName.of('Subtype'))) !== '/Image') continue;
    if (smaskRefs.has(refKey(ref))) continue; // conta como parte da imagem "dona", não solta
    imagesTotal++;
    try {
      const result = await recompressImage(ctx, ref, obj, level, effectiveSizes.get(refKey(ref)));
      if (result) {
        imagesTouched++;
        bytesBefore += result.before;
        bytesAfter += result.after;
      }
      if (opts.onProgress) opts.onProgress({ imagesTotal, imagesTouched });
    } catch (e) {
      console.warn('[pdf-compress] pulou uma imagem por erro:', e);
    }
  }

  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  return { bytes: outBytes, stats: { imagesTotal, imagesTouched, bytesBefore, bytesAfter } };
}
