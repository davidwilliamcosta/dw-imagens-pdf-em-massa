#!/usr/bin/env bash
# Publica o site no servidor do homelab.
#
#   ./deploy/deploy.sh               publica (exige o git sem mudanças pendentes)
#   ./deploy/deploy.sh --dry-run     mostra o que mudaria, sem enviar nada
#   ./deploy/deploy.sh --allow-dirty publica mesmo com mudanças não commitadas
#
# O que faz, em ordem:
#   1. carimba as versões dos imports (deploy/stamp.py)
#   2. confere se o git está limpo (o que vai pro ar = o que está no GitHub)
#   3. faz backup do site atual em ~/webp-backups no servidor (guarda os 10 últimos)
#   4. sincroniza os arquivos com rsync (remove do servidor o que saiu do projeto)
#   5. atualiza o nginx.conf se mudou (testa com nginx -t antes de recarregar)
#   6. confere hash a hash e avisa se a Cloudflare ainda serve a versão antiga
set -euo pipefail

HOST="${DEPLOY_HOST:-homelab@192.168.15.150}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${DEPLOY_DIR:-/home/homelab/webp}"
CONTAINER="${DEPLOY_CONTAINER:-webp-webp-1}"
URL="${DEPLOY_URL:-https://webp.davidwilliam.studio}"
KEEP_BACKUPS=10

DRY_RUN=0
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 1. versões
step "Carimbando versões"
if [ "$DRY_RUN" = 1 ]; then
  python3 deploy/stamp.py --check || echo "(rode sem --dry-run para carimbar)"
else
  python3 deploy/stamp.py
fi

# ---------------------------------------------------------------- 2. git
step "Conferindo o git"
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "$DIRTY"
  if [ "$ALLOW_DIRTY" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    echo "atenção: publicando com mudanças não commitadas"
  else
    echo
    echo "Há mudanças não commitadas (acima). Faça o commit — inclusive das versões"
    echo "que o carimbo acabou de atualizar — e rode de novo. Ou use --allow-dirty."
    exit 1
  fi
else
  echo "limpo ($(git log --oneline -1))"
fi

# ---------------------------------------------------------------- arquivos do site
# tudo que o git rastreia, menos o que é só do repositório
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
git ls-files -z --cached --others --exclude-standard \
  | tr '\0' '\n' \
  | grep -vE '^(deploy/|README\.md$|LICENSE$|\.gitignore$)' \
  | while IFS= read -r f; do
      [ -f "$f" ] || continue
      mkdir -p "$STAGE/$(dirname "$f")"
      cp "$f" "$STAGE/$f"
    done
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +   # o rsync -p leva essas permissões pro servidor
FILE_COUNT="$(find "$STAGE" -type f | wc -l | tr -d ' ')"
echo "$FILE_COUNT arquivos para publicar"

# ---------------------------------------------------------------- 3. backup
TS="$(date +%Y%m%d-%H%M%S)"
step "Backup no servidor"
if [ "$DRY_RUN" = 1 ]; then
  echo "(dry-run) criaria ~/webp-backups/site-$TS.tar.gz"
else
  "${SSH[@]}" "set -e
    mkdir -p ~/webp-backups
    tar -czf ~/webp-backups/site-$TS.tar.gz -C '$REMOTE_DIR' site nginx.conf docker-compose.yml
    ls -1t ~/webp-backups/site-*.tar.gz | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
    echo \"~/webp-backups/site-$TS.tar.gz (\$(ls ~/webp-backups/site-*.tar.gz | wc -l) backups guardados)\""
fi

# ---------------------------------------------------------------- 4. arquivos
step "Sincronizando arquivos"
RSYNC_FLAGS=(-rlpt --checksum --delete-after --itemize-changes)
[ "$DRY_RUN" = 1 ] && RSYNC_FLAGS+=(--dry-run)
CHANGES="$(rsync "${RSYNC_FLAGS[@]}" -e "ssh -i $KEY -o BatchMode=yes" "$STAGE/" "$HOST:$REMOTE_DIR/site/")"
if [ -n "$CHANGES" ]; then echo "$CHANGES"; else echo "nenhum arquivo mudou"; fi

# ---------------------------------------------------------------- 5. nginx.conf
step "nginx.conf"
LOCAL_CONF_MD5="$(md5 -q deploy/nginx.conf 2>/dev/null || md5sum deploy/nginx.conf | cut -d' ' -f1)"
REMOTE_CONF_MD5="$("${SSH[@]}" "md5sum '$REMOTE_DIR/nginx.conf' | cut -d' ' -f1")"
if [ "$LOCAL_CONF_MD5" = "$REMOTE_CONF_MD5" ]; then
  echo "sem mudanças"
elif [ "$DRY_RUN" = 1 ]; then
  echo "(dry-run) o nginx.conf mudou e seria atualizado"
else
  # o arquivo é montado no container como bind de arquivo único: precisa ser
  # reescrito no mesmo inode (cat >), senão o container continua vendo o antigo
  "${SSH[@]}" "set -e
    cp -p '$REMOTE_DIR/nginx.conf' /tmp/webp-nginx.conf.prev
    cat > '$REMOTE_DIR/nginx.conf'
    if docker exec '$CONTAINER' nginx -t 2>/tmp/webp-nginx-test.log; then
      docker exec '$CONTAINER' nginx -s reload
      echo 'atualizado e recarregado'
    else
      cat /tmp/webp-nginx.conf.prev > '$REMOTE_DIR/nginx.conf'
      cat /tmp/webp-nginx-test.log
      echo 'ERRO: nginx -t falhou — configuração anterior restaurada' >&2
      exit 1
    fi" < deploy/nginx.conf
fi

[ "$DRY_RUN" = 1 ] && { echo; echo "dry-run concluído, nada foi enviado"; exit 0; }

# ---------------------------------------------------------------- 6. verificação
step "Verificando"
LOCAL_SUMS="$(cd "$STAGE" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s  %s\n' "$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)" "${f#./}"; done)"
REMOTE_SUMS="$("${SSH[@]}" "cd '$REMOTE_DIR/site' && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s  %s\n' \"\$(md5sum \"\$f\" | cut -d' ' -f1)\" \"\${f#./}\"; done")"
if [ "$LOCAL_SUMS" = "$REMOTE_SUMS" ]; then
  echo "servidor idêntico ao projeto ($FILE_COUNT arquivos)"
else
  echo "ERRO: servidor diferente do projeto:" >&2
  diff <(echo "$LOCAL_SUMS") <(echo "$REMOTE_SUMS") >&2 || true
  exit 1
fi

INDEX_MD5="$(md5 -q index.html 2>/dev/null || md5sum index.html | cut -d' ' -f1)"
ORIGIN_MD5="$(curl -fsS "$URL/index.html?deploy=$TS" | (md5 -q 2>/dev/null || md5sum | cut -d' ' -f1))"
PUBLIC_MD5="$(curl -fsS "$URL/" | (md5 -q 2>/dev/null || md5sum | cut -d' ' -f1))"
CF_STATUS="$(curl -fsSI "$URL/" | tr -d '\r' | awk -F': ' 'tolower($1)=="cf-cache-status"{print $2}')"
[ "$ORIGIN_MD5" = "$INDEX_MD5" ] && echo "origem servindo a versão nova" || echo "ATENÇÃO: a origem ainda não serve a versão nova"
if [ "$PUBLIC_MD5" = "$INDEX_MD5" ]; then
  echo "$URL/ já mostra a versão nova (cf-cache-status: ${CF_STATUS:-?})"
else
  echo
  echo "ATENÇÃO: $URL/ ainda mostra a versão antiga (cf-cache-status: ${CF_STATUS:-?})."
  echo "Purgue / e /index.html no painel da Cloudflare (Caching → Configuration → Purge)."
fi
echo
echo "deploy concluído"
