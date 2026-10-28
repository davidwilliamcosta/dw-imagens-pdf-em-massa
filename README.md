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
- **Tamanhos responsivos**: gera cada imagem em várias larguras (padrão 480/800/1200/1600 + a original, sem
  ampliar), em um formato ou em AVIF + WebP de reserva, e monta o HTML pronto (`<picture>` ou `<img srcset>`, com
  `sizes`, `width`/`height`, alt e title do SEO). O botão `</>` de cada linha copia o HTML; o `.zip` traz um
  `picture.html` com todos.
- **Enviar para o WordPress**: sobe as imagens convertidas direto pra biblioteca de mídia pela API REST, com title,
  alt e descrição, usando uma senha de aplicativo (Usuários → Perfil → Senhas de aplicativo; exige HTTPS). Os
  arquivos vão do navegador direto pro site. A senha só fica salva no navegador se a opção "lembrar" for marcada.

### Recortar
- Modos: **Proporção** (1:1, 4:5, 9:16, 16:9, 1.91:1… ou personalizada), **Tamanho exato** (px),
  **Manter largura** (corta só em cima/embaixo) e **Manter altura** (corta só nas laterais).
- **Ponto do corte** numa grade 3×3, mais ponto de foco por imagem clicando na prévia.
- **Cortar sobra** ou **Ampliar área com fundo** (a imagem inteira cabe no quadro e o resto vira fundo: branco,
  cor da borda automática, transparente, preto ou cor personalizada).
- Saída no formato original, WebP, JPG, PNG ou AVIF.

### Contraste
Verificador de contraste de cores pela WCAG 2.2:
- **Por cor**: cor do texto e do fundo (seletor, hex ou conta-gotas da tela no Chrome/Edge), razão de contraste,
  os critérios texto normal AA/AAA, texto grande AA/AAA e componentes de interface (1.4.11), e prévia ao vivo.
  Quando não passa, sugere a cor mais próxima (só mais clara ou mais escura) que passa no AA, ou no AAA.
- **Por imagem**: extrai as cores principais de um print/banner (inclusive as de pouca área, como a de um texto),
  lista as combinações entre elas com o nível de cada uma, e permite clicar na imagem pra pegar a cor do texto e a
  do fundo, com lupa ampliada pra acertar letras finas.

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
deploy/
  deploy.sh             publica no servidor (backup, rsync, nginx, verificação)
  stamp.py              carimba os imports com o hash do conteúdo (?v=…)
  docker-compose.yml    e nginx.conf: configuração usada em produção
```

## Rodar localmente

Qualquer servidor estático serve (workers de módulo não funcionam via `file://`):

```bash
python3 -m http.server 8080
```

## Deploy

Produção roda num container `nginx:alpine` atrás do Nginx Proxy Manager + Cloudflare Tunnel. No servidor, os arquivos
do site ficam em `./site` ao lado do `docker-compose.yml` (ver `deploy/`).

Para publicar, commite e rode:

```bash
./deploy/deploy.sh
```

O script carimba as versões, exige o git limpo (o que vai pro ar é o que está no GitHub), guarda um backup do site
atual em `~/webp-backups` no servidor (os 10 últimos), sincroniza os arquivos com rsync, atualiza o `nginx.conf`
se ele mudou (testando com `nginx -t` antes de recarregar) e confere hash a hash. `--dry-run` mostra o que mudaria
sem enviar nada. Servidor, chave e URL podem ser trocados por variáveis (`DEPLOY_HOST`, `DEPLOY_KEY`, `DEPLOY_DIR`,
`DEPLOY_CONTAINER`, `DEPLOY_URL`).

### Cache

- Os imports internos (`vendor/pdf`, `vendor/avif` e os workers chamados pelo `index.html`) levam `?v=<hash do
  conteúdo>`. Quem atualiza é o `deploy/stamp.py`, em cadeia (mudou `compress.js` → muda o `worker.js` que o importa →
  muda o `index.html`). Rode `python3 deploy/stamp.py` antes de commitar; o `deploy.sh` também roda.
- O `nginx.conf` manda `Cache-Control: no-cache` no HTML e no manifest. Se uma regra da Cloudflare forçar cache longo
  de HTML, ela tem prioridade: nesse caso o deploy avisa e é preciso purgar `/` e `/index.html` no painel.
- O `.mjs` precisa do MIME `application/javascript` no nginx; sem isso o pdf.js (nível Máxima) não carrega.

## Bibliotecas de terceiros

| Biblioteca | Versão | Licença |
|---|---|---|
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT (`vendor/pdf/pdf-lib.LICENSE.md`) |
| [pdf.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 (`vendor/pdf/pdfjs/LICENSE`) |
| [@jsquash/avif](https://github.com/jamsinclair/jSquash) | 2.1.1 | Apache-2.0 (`vendor/avif/LICENSE`) |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT / GPLv3 (carregado do cdnjs) |
