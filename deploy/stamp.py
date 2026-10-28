#!/usr/bin/env python3
"""
Carimba as versões dos imports internos com o hash do conteúdo.

Troca cada referência do tipo './arquivo.js?b=1' ou './arquivo.js?v=abc123'
por './arquivo.js?v=<hash>', onde <hash> vem do conteúdo do arquivo apontado.
O cálculo é em cadeia: se compress.js muda, muda o hash dele, logo muda o
import dentro de worker.js, logo muda o hash de worker.js, logo muda a
referência em index.html. Assim o navegador e a Cloudflare nunca servem um
arquivo velho depois de um deploy, sem ninguém lembrar de incrementar nada.

Também atualiza WASM_VERSION em vendor/avif/encode.js com o hash do .wasm.

Idempotente: rodar de novo sem mudar nada não altera nenhum arquivo.
Uso: python3 deploy/stamp.py [--check]   (--check só avisa, não grava)
"""
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# arquivos que podem conter referências versionadas (as libs minificadas não têm
# e são grandes demais pra varrer à toa)
SCAN = ['index.html']
for base, _dirs, files in os.walk(os.path.join(ROOT, 'vendor')):
    for f in files:
        if f.startswith('._'):  # metadados do macOS no compartilhamento SMB
            continue
        if f.endswith(('.js', '.mjs')) and '.min.' not in f and f != 'avif_enc.js':
            SCAN.append(os.path.relpath(os.path.join(base, f), ROOT))
SCAN = sorted(set(SCAN))

REF = re.compile(r"""(['"])(\./[A-Za-z0-9_./-]+\.(?:m?js|wasm))\?(?:b|v)=[A-Za-z0-9]*\1""")
WASM_VERSION = re.compile(r"(const WASM_VERSION = ')[^']*(';)")
WASM_FILE = 'vendor/avif/avif_enc.wasm'
ENCODE_JS = 'vendor/avif/encode.js'


def short_hash(data):
    return hashlib.sha256(data).hexdigest()[:10]


def read(rel):
    with open(os.path.join(ROOT, rel), 'rb') as fh:
        return fh.read()


stamped = {}   # rel -> bytes já carimbados
visiting = set()


def resolve(from_rel, ref):
    base = os.path.dirname(from_rel)
    return os.path.normpath(os.path.join(base, ref))


def version_of(rel):
    """hash do conteúdo final (já carimbado, se for um arquivo varrido)"""
    if rel in SCAN:
        return short_hash(stamp(rel))
    path = os.path.join(ROOT, rel)
    if not os.path.isfile(path):
        raise SystemExit(f'referência quebrada: {rel} não existe')
    return short_hash(read(rel))


def stamp(rel):
    if rel in stamped:
        return stamped[rel]
    if rel in visiting:
        raise SystemExit(f'import circular envolvendo {rel}')
    visiting.add(rel)
    text = read(rel).decode('utf-8')

    def repl(m):
        quote, ref = m.group(1), m.group(2)
        target = resolve(rel, ref)
        return f'{quote}{ref}?v={version_of(target)}{quote}'

    text = REF.sub(repl, text)
    if rel == ENCODE_JS:
        text = WASM_VERSION.sub(lambda m: m.group(1) + short_hash(read(WASM_FILE)) + m.group(2), text)

    visiting.discard(rel)
    stamped[rel] = text.encode('utf-8')
    return stamped[rel]


def main():
    check_only = '--check' in sys.argv
    # calcula tudo antes de gravar qualquer coisa — erro no meio não deixa metade carimbada
    results = {rel: stamp(rel) for rel in SCAN}
    changed = [rel for rel in SCAN if results[rel] != read(rel)]
    if not check_only:
        for rel in changed:
            with open(os.path.join(ROOT, rel), 'wb') as fh:
                fh.write(results[rel])
    if changed:
        verb = 'desatualizados' if check_only else 'carimbados'
        print(f'{len(changed)} arquivo(s) {verb}:')
        for rel in changed:
            print('  ' + rel)
    else:
        print('versões em dia, nada a carimbar')
    return 1 if (check_only and changed) else 0


if __name__ == '__main__':
    sys.exit(main())
