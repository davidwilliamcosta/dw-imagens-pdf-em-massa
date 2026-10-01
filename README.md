# Imagens & PDF em massa

Ferramenta web para tratar imagens e PDFs em lote, **100% no navegador**: nenhum arquivo sai da máquina de quem usa até
o download do resultado. Não tem backend nem build — é um `index.html` estático com algumas bibliotecas
auto-hospedadas em `vendor/`.

No ar em <https://webp.davidwilliam.studio>.

## Funções

### Imagens
- Converte em massa para **WebP** (Canvas API) ou **AVIF** (encoder WASM `@jsquash/avif`, rodando num Web Worker).
- Qualidade ajustável e redimensionamento opcional por lado máximo.
- **SEO & metadados**: a partir de uma palavra-chave e de templates (`{keyword}`, `{Keyword}`, `{n}`, `{n2}`, `{total}`…)
  gera nome de arquivo (slug), title, alt e descrição para todas as imagens, com edição individual.
- Exporta `metadados.csv` (colunas `file_name, title, alt_text, description`, pronto para WP All Import / Media Library
  Assistant) e `metadados.json`, também incluídos no `.zip`.

### Recortar
- Modos: **Proporção** (1:1, 4:5, 9:16, 16:9, 1.91:1… ou personalizada), **Tamanho exato** (px),
  **Manter largura** (corta só em cima/embaixo) e **Manter altura** (corta só nas laterais).
- **Ponto do corte** numa grade 3×3, mais ponto de foco por imagem clicando na prévia.
- **Cortar sobra** ou **Ampliar área com fundo** (a imagem inteira cabe no quadro e o resto vira fundo: branco,
  cor da borda automática, transparente, preto ou cor personalizada).
- Saída no formato original, WebP, JPG, PNG ou AVIF.

### PDF
Compressão em três níveis:
- **Baixa** — recomprime só as imagens internas, qualidade alta. Texto continua selecionável.
- **Recomendada** — interpreta o content stream (inclusive Form XObjects) para descobrir o tamanho real de exibição de
  cada imagem e reamostra para 150 DPI efetivos. Trata imagens com transparência (`/SMask`) e perfis ICC.
  Texto continua selecionável.
- **Máxima** — rasteriza cada página (pdf.js) e remonta o PDF. Menor arquivo, mas o texto vira imagem.

Imagens em CMYK, com máscara de recorte (`/Mask`) ou já em CCITT/JBIG2/JPEG2000 ficam intocadas por segurança.

## Estrutura

```
index.html              app inteiro (HTML, CSS e a lógica de cada aba)
manifest.webmanifest    PWA
icon-*.png              ícones
.htaccess               MIME de .wasm/.mjs para hospedagem Apache (não usado no nginx)
vendor/avif/            @jsquash/avif 2.1.1 (encoder WASM) + wrapper/worker próprios
vendor/pdf/             pdf-lib 1.17.1, pdf.js 4.10.38 + motor de compressão próprio
  compress.js           níveis Baixa/Recomendada (roda no worker)
  content-ops.js        interpretador mínimo de content stream (DPI efetivo)
  rasterize.js          nível Máxima (thread principal)
  worker.js             worker dos níveis Baixa/Recomendada
deploy/                 docker-compose.yml e nginx.conf usados em produção
```

## Rodar localmente

Qualquer servidor estático serve (workers de módulo não funcionam via `file://`):

```bash
python3 -m http.server 8080
```

## Deploy

Produção roda num container `nginx:alpine` atrás do Nginx Proxy Manager + Cloudflare Tunnel. No servidor, os arquivos
do site ficam em `./site` ao lado do `docker-compose.yml` (ver `deploy/`).

O `nginx.conf` precisa declarar os MIME types `application/wasm` (`.wasm`) e `application/javascript` (`.mjs`); sem
isso o encoder AVIF cai num caminho mais lento e o pdf.js (nível Máxima) não carrega.

### Cache

- Os imports internos de `vendor/pdf` e `vendor/avif` usam um sufixo de versão (`?b=N`). Ao alterar um desses
  arquivos, incremente o `?b=` em quem o importa (e em `index.html`, se for o worker), senão o navegador e a
  Cloudflare continuam servindo a versão antiga.
- Ao alterar o `avif_enc.wasm`, incremente `WASM_VERSION` em `vendor/avif/encode.js`.
- Se a Cloudflare estiver cacheando HTML, é preciso purgar `/` e `/index.html` a cada deploy.

## Bibliotecas de terceiros

| Biblioteca | Versão | Licença |
|---|---|---|
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT (`vendor/pdf/pdf-lib.LICENSE.md`) |
| [pdf.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 (`vendor/pdf/pdfjs/LICENSE`) |
| [@jsquash/avif](https://github.com/jamsinclair/jSquash) | 2.1.1 | Apache-2.0 (`vendor/avif/LICENSE`) |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPLv3 (carregado do cdnjs) |
