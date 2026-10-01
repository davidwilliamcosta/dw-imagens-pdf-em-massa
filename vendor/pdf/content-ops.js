/**
 * Interpretador mínimo de content streams do PDF — só o suficiente pra rastrear
 * a matriz de transformação corrente (q/Q/cm) e descobrir, pra cada uso de uma
 * imagem (Do), em que tamanho ela é exibida na página. Isso dá o "DPI efetivo"
 * de cada imagem — a base do modo "Recomendada" (reamostra pra resolução real
 * de exibição, igual ao que Acrobat/Ghostscript chamam de "downsample").
 *
 * Não é um interpretador completo de PDF: ignora tudo que não seja q/Q/cm/Do
 * e trata inline images (BI..ID..EI) só o suficiente pra não se perder no meio
 * dos bytes binários. Recursa em Form XObjects via o callback `onDo` (quem
 * chama decide se é imagem ou form e faz a recursão — ver compress.js) porque
 * boa parte dos PDFs "reais" (Word/LibreOffice/Canva/Adobe) coloca imagem
 * dentro de um Form XObject em vez de desenhar direto na página; sem recursar
 * nesses forms a análise de DPI efetivo simplesmente não vê a imagem. Erros
 * aqui nunca devem derrubar a conversão — quem chama trata falha como "sem
 * info de DPI" e cai pro cap fixo.
 */

// multiplica duas matrizes [a b c d e f] no formato do PDF (linha-vetor)
export function mul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

export const IDENTITY = [1, 0, 0, 1, 0, 0];

function isDelim(ch) {
  return ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']' ||
    ch === '{' || ch === '}' || ch === '/' || ch === '%';
}
function isWhite(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\0';
}

/**
 * @param {Uint8Array} bytes conteúdo do content stream (já decodificado)
 * @param {object} [opts]
 * @param {number[]} [opts.initialCTM] matriz inicial (pra recursão em Form XObject)
 * @param {(name:string, ctm:number[])=>void} [opts.onDo] chamado a cada "/Nome Do"
 *   com a CTM corrente. Se omitido, mantém o comportamento antigo (só imagens,
 *   devolvido no Map de retorno).
 * @returns {Map<string, {w:number, h:number}>} nome do XObject -> maior "escala
 *   de exibição" vista (pontos), só preenchido quando `opts.onDo` não é passado
 */
export function analyzeContentStream(bytes, opts = {}) {
  const s = typeof bytes === 'string' ? bytes : Buffer_or_latin1(bytes);
  const len = s.length;
  let i = 0;

  const matrixStack = [];
  let ctm = opts.initialCTM || IDENTITY;
  const operands = []; // números e nomes crus, na ordem em que apareceram
  /** @type {Map<string, {w:number, h:number}>} */
  const usage = new Map();

  function readToken() {
    // pula espaços e comentários
    while (i < len) {
      const ch = s[i];
      if (isWhite(ch)) { i++; continue; }
      if (ch === '%') { while (i < len && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      break;
    }
    if (i >= len) return null;
    const ch = s[i];

    if (ch === '/') { // nome
      let j = i + 1;
      while (j < len && !isWhite(s[j]) && !isDelim(s[j])) j++;
      const tok = { type: 'name', value: s.slice(i + 1, j) };
      i = j;
      return tok;
    }
    if (ch === '(') { // string literal — respeita parênteses balanceados e escapes
      let depth = 1; let j = i + 1;
      while (j < len && depth > 0) {
        if (s[j] === '\\') j += 2;
        else { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
      }
      i = j;
      return { type: 'string' };
    }
    if (ch === '<') {
      if (s[i + 1] === '<') { // dict << ... >> — pula balanceado
        let depth = 1; let j = i + 2;
        while (j < len && depth > 0) {
          if (s[j] === '<' && s[j + 1] === '<') { depth++; j += 2; }
          else if (s[j] === '>' && s[j + 1] === '>') { depth--; j += 2; }
          else j++;
        }
        i = j;
        return { type: 'dict' };
      }
      let j = i + 1; // hex string
      while (j < len && s[j] !== '>') j++;
      i = j + 1;
      return { type: 'string' };
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      i++;
      return { type: 'bracket', value: ch };
    }
    // número ou operador (mantém sinal e ponto)
    let j = i;
    while (j < len && !isWhite(s[j]) && !isDelim(s[j])) j++;
    const raw = s.slice(i, j);
    i = j;
    if (raw.length === 0) { i++; return readToken(); } // guarda contra loop infinito
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { type: 'num', value: parseFloat(raw) };
    return { type: 'op', value: raw };
  }

  let guard = 0;
  const MAX_TOKENS = 2_000_000; // trava de segurança pra content stream corrompido
  while (i < len && guard++ < MAX_TOKENS) {
    const tok = readToken();
    if (!tok) break;

    if (tok.type === 'num') { operands.push(tok); continue; }
    if (tok.type === 'name') { operands.push(tok); continue; }
    if (tok.type === 'bracket' || tok.type === 'string' || tok.type === 'dict') {
      // TJ (array de strings/números) etc — não usamos, só garante que não
      // sobra lixo acumulado nos operandos
      continue;
    }
    if (tok.type !== 'op') continue;

    switch (tok.value) {
      case 'q':
        matrixStack.push(ctm);
        break;
      case 'Q':
        if (matrixStack.length) ctm = matrixStack.pop();
        break;
      case 'cm': {
        const nums = operands.filter((o) => o.type === 'num').slice(-6).map((o) => o.value);
        if (nums.length === 6) ctm = mul(nums, ctm);
        break;
      }
      case 'Do': {
        const nameTok = [...operands].reverse().find((o) => o.type === 'name');
        if (nameTok) {
          if (opts.onDo) {
            opts.onDo(nameTok.value, ctm);
          } else {
            // largura/altura (em pontos) do quadrado unitário [0,1]x[0,1] após a CTM
            const [a, b, c, d] = ctm;
            const w = Math.hypot(a, b);
            const h = Math.hypot(c, d);
            const prev = usage.get(nameTok.value);
            if (!prev || w > prev.w || h > prev.h) {
              usage.set(nameTok.value, { w: Math.max(w, prev ? prev.w : 0), h: Math.max(h, prev ? prev.h : 0) });
            }
          }
        }
        break;
      }
      case 'BI': {
        // inline image: dict de dois-em-dois até "ID", depois bytes crus até "EI" isolado
        while (i < len) {
          const t = readToken();
          if (!t) break;
          if (t.type === 'op' && t.value === 'ID') break;
        }
        i++; // espaço obrigatório após ID
        while (i < len - 1) {
          if (s[i] === 'E' && s[i + 1] === 'I' && (i + 2 >= len || isWhite(s[i + 2])) &&
            (i === 0 || isWhite(s[i - 1]))) {
            i += 2;
            break;
          }
          i++;
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0; // qualquer operador consome os operandos pendentes
  }

  return usage;
}

// content streams de PDF são bytes "latin1-like" (cada byte = 1 char) — nunca UTF-8
function Buffer_or_latin1(bytes) {
  let out = '';
  const CHUNK = 0x8000;
  for (let off = 0; off < bytes.length; off += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(off, Math.min(off + CHUNK, bytes.length)));
  }
  return out;
}
