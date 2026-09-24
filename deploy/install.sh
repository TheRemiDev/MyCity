#!/usr/bin/env bash
# =============================================================================
#  MyCity — installation 100 % automatisée sur un VPS (Debian / Ubuntu / RHEL)
# =============================================================================
#
#  sudo bash deploy/install.sh --domain ville.exemple.fr --email vous@exemple.fr
#
#  Conçu pour cohabiter avec d'autres services sur une machine déjà en production :
#   • Node.js privé dans /opt/<instance>/runtime (le Node système n'est jamais touché) ;
#   • utilisateur système dédié, sans shell, service systemd durci et isolé ;
#   • écoute uniquement sur 127.0.0.1, sur un port libre détecté automatiquement ;
#   • reverse proxy : réutilise nginx, Apache ou Caddy s'ils tournent déjà, en ajoutant
#     UN fichier de site dédié (les autres sites ne sont jamais modifiés), configuration
#     testée avant chaque rechargement et restaurée en cas d'échec ;
#   • certificat Let's Encrypt pour ce seul domaine (renouvellement automatique) ;
#   • plusieurs instances possibles côte à côte (--name).
#
#  Commandes :
#    install    (défaut) installe ou met à jour l'instance
#    update     met à jour le code et redémarre (conserve données et réglages)
#    status     état du service
#    backup     sauvegarde immédiate de la base
#    uninstall  désinstalle (conserve les données sauf --purge)
#
#  Options :
#    --domain D            nom de domaine (obligatoire à l'installation)
#    --email E             e-mail Let's Encrypt (obligatoire sauf --no-tls)
#    --name N              nom de l'instance (défaut : mycity)
#    --port P              port interne (défaut : premier port libre à partir de 3080)
#    --web-server S        auto | nginx | apache | caddy | none (défaut : auto)
#    --no-tls              pas de certificat (HTTP seul, déconseillé)
#    --stripe-key K        clé secrète Stripe (sk_live_… ou sk_test_…)
#    --stripe-webhook W    secret du webhook Stripe (whsec_…)
#    --repo URL            dépôt git à installer (défaut : dossier courant, sinon GitHub)
#    --branch B            branche git (défaut : main)
#    --node-major M        version majeure de Node.js (défaut : 22)
#    --www                 ajoute aussi www.<domaine> au certificat et au site
#    --skip-dns-check      ne vérifie pas que le domaine pointe vers ce serveur
#    --purge               (uninstall) supprime aussi les données
#    -y, --yes             ne pose aucune question
# =============================================================================
set -Eeuo pipefail

# ----------------------------------------------------------------- paramètres
ACTION="install"
DOMAIN=""
EMAIL=""
NAME="mycity"
PORT=""
WEB_SERVER="auto"
TLS=1
STRIPE_KEY=""
STRIPE_WEBHOOK=""
REPO=""
BRANCH="main"
NODE_MAJOR="22"
WITH_WWW=0
DNS_CHECK=1
PURGE=0
ASSUME_YES=0
DEFAULT_REPO="https://github.com/TheRemiDev/MyCity.git"
INSTALL_SOURCE=""

case "${1:-}" in
  install|update|status|backup|uninstall) ACTION="$1"; shift ;;
esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --web-server) WEB_SERVER="${2:-}"; shift 2 ;;
    --no-tls) TLS=0; shift ;;
    --stripe-key) STRIPE_KEY="${2:-}"; shift 2 ;;
    --stripe-webhook) STRIPE_WEBHOOK="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --node-major) NODE_MAJOR="${2:-}"; shift 2 ;;
    --www) WITH_WWW=1; shift ;;
    --skip-dns-check) DNS_CHECK=0; shift ;;
    --purge) PURGE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------- affichage
if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B='' G='' Y='' R='' C='' N=''; fi
step() { echo; echo "${B}${C}▸ $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; }
die()  { echo; echo "${R}✖ $*${N}" >&2; exit 1; }
trap 'die "Échec à la ligne $LINENO : $BASH_COMMAND"' ERR

ask() { # ask VAR "question" [défaut]
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  [[ -n "${!__var}" ]] && return 0
  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then printf -v "$__var" '%s' "$__def"; return 0; fi
  read -r -p "  $__q${__def:+ [$__def]} : " __ans || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ----------------------------------------------------------------- chemins
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "Nom d'instance invalide : $NAME (minuscules, chiffres, tirets)."
BASE="/opt/$NAME"
APP="$BASE/app"
RUNTIME="$BASE/runtime"
DATA="/var/lib/$NAME"
CONF_DIR="/etc/$NAME"
ENV_FILE="$CONF_DIR/$NAME.env"
SERVICE="$NAME.service"
USER_NAME="$NAME"
ACME_ROOT="/var/www/$NAME-acme"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
SOURCE_DIR=""
[[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../package.json" && -f "$SCRIPT_DIR/../server.js" ]] && SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

[[ $EUID -eq 0 ]] || die "Lancez ce script en root (sudo bash $0 …)."

# ----------------------------------------------------------------- utilitaires système
PKG=""
if command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
elif command -v yum >/dev/null; then PKG=yum
fi
APT_UPDATED=0
pkg_install() {
  local missing=() names=()
  for p in "$@"; do
    # Noms de paquets différents sur les distributions Red Hat
    if [[ "$PKG" != apt ]]; then
      case "$p" in xz-utils) p=xz ;; iproute2) p=iproute ;; esac
    fi
    names+=("$p")
  done
  for p in "${names[@]}"; do
    case "$PKG" in
      apt) dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p") ;;
      dnf|yum) rpm -q "$p" >/dev/null 2>&1 || missing+=("$p") ;;
    esac
  done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  echo "  Installation des paquets : ${missing[*]}"
  case "$PKG" in
    apt)
      if [[ $APT_UPDATED -eq 0 ]]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null ;;
    dnf|yum) "$PKG" install -y -q "${missing[@]}" >/dev/null ;;
    *) die "Gestionnaire de paquets non pris en charge : installez ${missing[*]} manuellement." ;;
  esac
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . ; }
listener_on() { { ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'users:\(\("[^"]+' | head -1 | sed 's/users:(("//'; } || true; }
service_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

env_get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
env_set() { # env_set KEY VALUE : met à jour ou ajoute une variable
  local key="$1" val="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

random_token() { od -An -tx1 -N16 /dev/urandom | tr -d ' \n'; }

# ----------------------------------------------------------------- Node.js privé
install_node() {
  step "Node.js $NODE_MAJOR (privé, dans $RUNTIME)"
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "Architecture non prise en charge : $(uname -m)" ;;
  esac
  local index="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local sums file version current=""
  sums="$(curl -fsSL "$index/SHASUMS256.txt")" || die "Impossible de joindre nodejs.org."
  file="$(echo "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${arch}\.tar\.xz$" | head -1)"
  [[ -n "$file" ]] || die "Aucune archive Node.js $NODE_MAJOR pour linux-$arch."
  version="$(echo "$file" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')"
  [[ -x "$RUNTIME/bin/node" ]] && current="$("$RUNTIME/bin/node" --version 2>/dev/null || true)"
  if [[ "$current" == "$version" ]]; then ok "Node.js $version déjà présent"; return; fi
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$index/$file" -o "$tmp/$file"
  (cd "$tmp" && echo "$sums" | grep " $file\$" | sha256sum -c --status) || die "Somme de contrôle Node.js invalide."
  rm -rf "$RUNTIME.new" && mkdir -p "$RUNTIME.new"
  tar -xJf "$tmp/$file" -C "$RUNTIME.new" --strip-components=1
  rm -rf "$RUNTIME" && mv "$RUNTIME.new" "$RUNTIME"
  rm -rf "$tmp"
  ok "Node.js $version installé (le Node.js système, s'il existe, reste intact)"
}

# ----------------------------------------------------------------- code de l'application
deploy_code() {
  step "Code de l'application → $APP"
  local stage="$BASE/app.new"
  rm -rf "$stage"
  # Source : --repo explicite, sinon la copie locale d'où le script est lancé (si ce n'est pas
  # l'installation elle-même), sinon le dépôt mémorisé lors de l'installation, sinon GitHub.
  if [[ -z "$REPO" && ( -z "$SOURCE_DIR" || "$SOURCE_DIR" == "$APP" ) ]]; then
    REPO="$(env_get INSTALL_REPO)"
    if [[ "$REPO" == local:* && -f "${REPO#local:}/server.js" && "${REPO#local:}" != "$APP" ]]; then
      SOURCE_DIR="${REPO#local:}"; REPO=""
    elif [[ "$REPO" == local:* || -z "$REPO" ]]; then
      REPO="$DEFAULT_REPO"
    fi
    local saved_branch; saved_branch="$(env_get INSTALL_BRANCH)"
    [[ -n "$saved_branch" && "$BRANCH" == "main" ]] && BRANCH="$saved_branch"
  fi
  if [[ -n "$REPO" ]]; then
    INSTALL_SOURCE="$REPO"
    pkg_install git
    git clone --quiet --depth 1 --branch "$BRANCH" "${REPO:-$DEFAULT_REPO}" "$stage" || die "Clonage impossible de ${REPO:-$DEFAULT_REPO} ($BRANCH)."
    rm -rf "$stage/.git"
    ok "Clonage de ${REPO:-$DEFAULT_REPO} ($BRANCH)"
  else
    INSTALL_SOURCE="local:$SOURCE_DIR"
    mkdir -p "$stage"
    tar -C "$SOURCE_DIR" --exclude=./node_modules --exclude=./data --exclude=./.git -cf - . | tar -C "$stage" -xf -
    ok "Copie depuis $SOURCE_DIR"
  fi
  (cd "$stage" && PATH="$RUNTIME/bin:$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error --no-update-notifier) || die "npm ci a échoué."
  if [[ -d "$APP" ]]; then rm -rf "$BASE/app.old" && mv "$APP" "$BASE/app.old"; fi
  mv "$stage" "$APP"
  chown -R root:root "$APP"
  chmod -R go-w "$APP"
  ok "Dépendances installées (production)"
}

# ----------------------------------------------------------------- utilisateur, dossiers, configuration
setup_user_and_config() {
  step "Utilisateur système et configuration"
  if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    ok "Utilisateur $USER_NAME créé"
  else ok "Utilisateur $USER_NAME existant"; fi
  install -d -m 750 -o "$USER_NAME" -g "$USER_NAME" "$DATA" "$DATA/backups"
  install -d -m 750 -o root -g "$USER_NAME" "$CONF_DIR"

  if [[ ! -f "$ENV_FILE" ]]; then
    install -m 640 -o root -g "$USER_NAME" /dev/null "$ENV_FILE"
    {
      echo "# Configuration de l'instance $NAME — générée le $(date -Iseconds)"
      echo "NODE_ENV=production"
      echo "HOST=127.0.0.1"
    } > "$ENV_FILE"
  fi
  local scheme=https; [[ $TLS -eq 0 ]] && scheme=http
  env_set PORT "$PORT"
  env_set BASE_URL "$scheme://$DOMAIN"
  env_set DB_PATH "$DATA/mycity.db"
  env_set TRUST_PROXY 1
  [[ -n "$(env_get SETUP_TOKEN)" ]] || env_set SETUP_TOKEN "$(random_token)"
  env_set INSTALL_REPO "$INSTALL_SOURCE"
  env_set INSTALL_BRANCH "$BRANCH"
  [[ -n "$STRIPE_KEY" ]] && env_set STRIPE_SECRET_KEY "$STRIPE_KEY"
  [[ -n "$STRIPE_WEBHOOK" ]] && env_set STRIPE_WEBHOOK_SECRET "$STRIPE_WEBHOOK"
  grep -qE '^STRIPE_SECRET_KEY=' "$ENV_FILE" || echo "STRIPE_SECRET_KEY=" >> "$ENV_FILE"
  grep -qE '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE" || echo "STRIPE_WEBHOOK_SECRET=" >> "$ENV_FILE"
  chmod 640 "$ENV_FILE"; chown root:"$USER_NAME" "$ENV_FILE"
  ok "Configuration : $ENV_FILE (lisible uniquement par root et $USER_NAME)"
}

# ----------------------------------------------------------------- systemd
setup_service() {
  step "Service systemd $SERVICE"
  cat > "/etc/systemd/system/$SERVICE" <<UNIT
[Unit]
Description=MyCity ($NAME) — ville numérique
Documentation=https://github.com/TheRemiDev/MyCity
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=$RUNTIME/bin/node --disable-warning=ExperimentalWarning $APP/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
# Ressources bornées : l'instance ne peut pas affamer les autres services du VPS.
MemoryMax=768M
CPUWeight=80
TasksMax=256
LimitNOFILE=65536
# Isolation
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
UMask=0027

[Install]
WantedBy=multi-user.target
UNIT

  # Sauvegarde quotidienne (14 jours conservés)
  cat > "/etc/systemd/system/$NAME-backup.service" <<UNIT
[Unit]
Description=Sauvegarde de la base MyCity ($NAME)

[Service]
Type=oneshot
User=$USER_NAME
Group=$USER_NAME
EnvironmentFile=$ENV_FILE
ExecStart=$RUNTIME/bin/node --disable-warning=ExperimentalWarning $APP/scripts/backup.js $DATA/backups 14
ProtectSystem=strict
ReadWritePaths=$DATA
PrivateTmp=true
NoNewPrivileges=true
UNIT
  cat > "/etc/systemd/system/$NAME-backup.timer" <<UNIT
[Unit]
Description=Sauvegarde quotidienne de MyCity ($NAME)

[Timer]
OnCalendar=*-*-* 04:17:00
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --quiet "$SERVICE" "$NAME-backup.timer"
  systemctl restart "$SERVICE"
  systemctl start "$NAME-backup.timer"

  local _
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok "Service démarré sur 127.0.0.1:$PORT"; return; fi
    sleep 1
  done
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  if [[ -d "$BASE/app.old" ]]; then
    warn "Le nouveau code ne démarre pas : retour à la version précédente."
    rm -rf "$APP" && mv "$BASE/app.old" "$APP" && systemctl restart "$SERVICE"
  fi
  die "Le service ne répond pas (voir journalctl -u $SERVICE)."
}

# ----------------------------------------------------------------- reverse proxy
detect_web_server() {
  [[ "$WEB_SERVER" != "auto" ]] && return
  local l80 l443
  l80="$(listener_on 80)"; l443="$(listener_on 443)"
  case "$l80$l443" in
    *nginx*) WEB_SERVER=nginx ;;
    *apache*|*httpd*) WEB_SERVER=apache ;;
    *caddy*) WEB_SERVER=caddy ;;
    "") if command -v nginx >/dev/null; then WEB_SERVER=nginx
        elif command -v caddy >/dev/null; then WEB_SERVER=caddy
        elif command -v apache2 >/dev/null || command -v httpd >/dev/null; then WEB_SERVER=apache
        else WEB_SERVER=nginx; fi ;;
    *) die "Les ports 80/443 sont occupés par « $l80 $l443 », que ce script ne sait pas configurer. Relancez avec --web-server none et configurez votre proxy vers 127.0.0.1:$PORT." ;;
  esac
  ok "Serveur web retenu : $WEB_SERVER"
}

SERVER_NAMES=""
safe_apply() { # safe_apply <fichier> <contenu> <commande de test> <commande de rechargement>
  local file="$1" content="$2" test_cmd="$3" reload_cmd="$4" backup=""
  if [[ -f "$file" ]]; then backup="$(mktemp)"; cp -p "$file" "$backup"; fi
  printf '%s\n' "$content" > "$file"
  if ! eval "$test_cmd" >/tmp/"$NAME"-webtest.log 2>&1; then
    cat /tmp/"$NAME"-webtest.log
    if [[ -n "$backup" ]]; then cp -p "$backup" "$file"; else rm -f "$file"; fi
    die "Configuration du serveur web refusée : rien n'a été modifié."
  fi
  eval "$reload_cmd"
  [[ -n "$backup" ]] && rm -f "$backup"
  return 0
}

cert_dir() { echo "/etc/letsencrypt/live/$NAME-$DOMAIN"; }
have_cert() { [[ -s "$(cert_dir)/fullchain.pem" && -s "$(cert_dir)/privkey.pem" ]]; }

obtain_cert() {
  [[ $TLS -eq 1 ]] || return 0
  step "Certificat Let's Encrypt pour $SERVER_NAMES"
  pkg_install certbot
  install -d -m 755 "$ACME_ROOT"
  local domains=(-d "$DOMAIN"); [[ $WITH_WWW -eq 1 ]] && domains+=(-d "www.$DOMAIN")
  local hook=""
  case "$WEB_SERVER" in
    nginx) hook="systemctl reload nginx" ;;
    apache) hook="systemctl reload apache2 2>/dev/null || systemctl reload httpd" ;;
  esac
  certbot certonly --webroot -w "$ACME_ROOT" "${domains[@]}" --cert-name "$NAME-$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring --expand \
    ${hook:+--deploy-hook "$hook"} >/dev/null \
    || die "Let's Encrypt a refusé le certificat. Vérifiez que $DOMAIN pointe vers ce serveur et que le port 80 est ouvert."
  ok "Certificat obtenu (renouvellement automatique par certbot)"
}

nginx_common() { # blocs communs HTTP/HTTPS du site nginx
  local upstream="$1"
  cat <<NGX
    client_max_body_size 2m;
    location ^~ /.well-known/acme-challenge/ { root $ACME_ROOT; default_type text/plain; }
    location = /api/live {
        proxy_pass http://$upstream;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
    location / {
        proxy_pass http://$upstream;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 60s;
    }
NGX
}

configure_nginx() {
  step "nginx : site dédié à $DOMAIN"
  command -v nginx >/dev/null || pkg_install nginx
  systemctl enable --quiet --now nginx
  nginx -t >/dev/null 2>&1 || die "La configuration nginx actuelle est déjà en erreur (nginx -t). Corrigez-la avant d'installer MyCity."
  local file
  if [[ -d /etc/nginx/sites-available ]]; then
    file="/etc/nginx/sites-available/$NAME.conf"
    ln -sfn "$file" "/etc/nginx/sites-enabled/$NAME.conf"
  else
    file="/etc/nginx/conf.d/$NAME.conf"
  fi
  install -d -m 755 "$ACME_ROOT"

  local upstream="${NAME//-/_}_upstream"
  local common
  common="$(nginx_common "$upstream")"
  local head="upstream $upstream { server 127.0.0.1:$PORT; keepalive 16; }"
  local l6_80="" l6_443=""
  if [[ -f /proc/net/if_inet6 ]]; then l6_80="listen [::]:80;"; l6_443="listen [::]:443 ssl;"; fi
  # Phase 1 : HTTP seul (nécessaire au défi ACME)
  if [[ $TLS -eq 0 ]] || ! have_cert; then
    safe_apply "$file" "$head
server {
    listen 80;
    $l6_80
    server_name $SERVER_NAMES;
$common
}" "nginx -t" "systemctl reload nginx"
    ok "Site HTTP actif ($file)"
  fi
  [[ $TLS -eq 1 ]] || return 0
  obtain_cert
  # Phase 2 : HTTPS + redirection
  local http2="http2 on;"
  nginx -V 2>&1 | grep -qE 'nginx/1\.(2[5-9]|[3-9][0-9])' || http2=""
  local listen443="listen 443 ssl; $l6_443"
  if [[ -z "$http2" ]]; then
    listen443="listen 443 ssl http2;"
    [[ -n "$l6_443" ]] && listen443="$listen443 listen [::]:443 ssl http2;"
  fi
  safe_apply "$file" "$head
server {
    listen 80;
    $l6_80
    server_name $SERVER_NAMES;
    location ^~ /.well-known/acme-challenge/ { root $ACME_ROOT; default_type text/plain; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    $listen443
    $http2
    server_name $SERVER_NAMES;
    ssl_certificate $(cert_dir)/fullchain.pem;
    ssl_certificate_key $(cert_dir)/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:${upstream}_ssl:5m;
    ssl_session_timeout 1d;
$common
}" "nginx -t" "systemctl reload nginx"
  ok "HTTPS actif, HTTP redirigé ($file)"
}

apache_proxy() { # directives de proxy communes aux hôtes virtuels Apache
  cat <<APX
    Alias /.well-known/acme-challenge/ $ACME_ROOT/.well-known/acme-challenge/
    <Directory "$ACME_ROOT">
        Require all granted
    </Directory>
    ProxyPreserveHost On
    ProxyRequests Off
    ProxyPass /.well-known/acme-challenge/ !
    ProxyPass /api/live http://127.0.0.1:$PORT/api/live flushpackets=on timeout=3600
    ProxyPass / http://127.0.0.1:$PORT/ timeout=60
    ProxyPassReverse / http://127.0.0.1:$PORT/
    LimitRequestBody 2097152
APX
}

configure_apache() {
  step "Apache : hôte virtuel dédié à $DOMAIN"
  local svc conf_dir file
  if command -v apache2 >/dev/null || [[ "$PKG" == apt ]]; then
    command -v apache2 >/dev/null || pkg_install apache2
    svc=apache2; conf_dir=/etc/apache2/sites-available; file="$conf_dir/$NAME.conf"
    a2enmod -q proxy proxy_http headers ssl rewrite >/dev/null
  else
    command -v httpd >/dev/null || pkg_install httpd mod_ssl
    svc=httpd; conf_dir=/etc/httpd/conf.d; file="$conf_dir/$NAME.conf"
  fi
  systemctl enable --quiet --now "$svc"
  local test_cmd="apachectl configtest"
  $test_cmd >/dev/null 2>&1 || die "La configuration Apache actuelle est déjà en erreur. Corrigez-la avant d'installer MyCity."
  install -d -m 755 "$ACME_ROOT"
  local aliases=""; [[ $WITH_WWW -eq 1 ]] && aliases="ServerAlias www.$DOMAIN"
  local proxy
  proxy="$(apache_proxy)"
  if [[ $TLS -eq 0 ]] || ! have_cert; then
    safe_apply "$file" "<VirtualHost *:80>
    ServerName $DOMAIN
    $aliases
    RequestHeader set X-Forwarded-Proto \"http\"
$proxy
</VirtualHost>" "$test_cmd" "true"
    [[ $svc == apache2 ]] && a2ensite -q "$NAME" >/dev/null
    $test_cmd >/dev/null 2>&1 && systemctl reload "$svc"
    ok "Site HTTP actif ($file)"
  fi
  [[ $TLS -eq 1 ]] || return 0
  obtain_cert
  safe_apply "$file" "<VirtualHost *:80>
    ServerName $DOMAIN
    $aliases
    Alias /.well-known/acme-challenge/ $ACME_ROOT/.well-known/acme-challenge/
    <Directory \"$ACME_ROOT\">
        Require all granted
    </Directory>
    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>
<VirtualHost *:443>
    ServerName $DOMAIN
    $aliases
    SSLEngine on
    SSLCertificateFile $(cert_dir)/fullchain.pem
    SSLCertificateKeyFile $(cert_dir)/privkey.pem
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    RequestHeader set X-Forwarded-Proto \"https\"
$proxy
</VirtualHost>" "$test_cmd" "systemctl reload $svc"
  ok "HTTPS actif, HTTP redirigé ($file)"
}

configure_caddy() {
  step "Caddy : bloc de site dédié à $DOMAIN (TLS automatique par Caddy)"
  if ! command -v caddy >/dev/null; then
    die "Caddy n'est pas installé. Installez-le (https://caddyserver.com/docs/install) ou utilisez --web-server nginx."
  fi
  local main=/etc/caddy/Caddyfile dir=/etc/caddy/sites
  install -d -m 755 "$dir"
  [[ -f "$main" ]] || touch "$main"
  if ! grep -qE "^import $dir/\*\.caddy" "$main"; then
    cp -p "$main" "$main.bak-$NAME"
    printf '\nimport %s/*.caddy\n' "$dir" >> "$main"
  fi
  local site_names="$DOMAIN"; [[ $WITH_WWW -eq 1 ]] && site_names="$DOMAIN, www.$DOMAIN"
  [[ $TLS -eq 0 ]] && site_names="http://$DOMAIN"
  safe_apply "$dir/$NAME.caddy" "$site_names {
    encode zstd gzip
    request_body { max_size 2MB }
    reverse_proxy /api/live 127.0.0.1:$PORT {
        flush_interval -1
    }
    reverse_proxy 127.0.0.1:$PORT
}" "caddy validate --config $main --adapter caddyfile" "systemctl reload caddy"
  ok "Site actif ($dir/$NAME.caddy)"
}

open_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
    ok "Pare-feu ufw : ports 80 et 443 autorisés"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --quiet --permanent --add-service=http --add-service=https && firewall-cmd --quiet --reload
    ok "Pare-feu firewalld : http et https autorisés"
  fi
}

check_dns() {
  [[ $DNS_CHECK -eq 1 && $TLS -eq 1 ]] || return 0
  step "Vérification DNS de $DOMAIN"
  local public resolved
  public="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [[ -z "$resolved" ]]; then
    die "$DOMAIN ne résout vers aucune adresse. Créez un enregistrement A vers ${public:-l’IP de ce serveur}, attendez la propagation, puis relancez (ou --skip-dns-check)."
  fi
  if [[ -n "$public" && " $resolved " != *" $public "* ]]; then
    warn "$DOMAIN pointe vers $resolved alors que ce serveur sort avec $public (CDN/proxy ?). Le certificat risque d'échouer."
  else ok "$DOMAIN → $resolved"; fi
}

# ----------------------------------------------------------------- commandes
cmd_install() {
  step "Installation de MyCity (instance « $NAME »)"
  local existing_domain existing_port
  existing_domain="$(env_get BASE_URL | sed -E 's#^https?://##')"
  existing_port="$(env_get PORT)"
  [[ -z "$DOMAIN" && -n "$existing_domain" ]] && DOMAIN="$existing_domain"
  ask DOMAIN "Nom de domaine (ex. ville.exemple.fr)"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || die "Domaine invalide : « $DOMAIN »."
  DOMAIN="${DOMAIN,,}"
  if [[ $TLS -eq 1 ]]; then
    ask EMAIL "E-mail pour Let's Encrypt (alertes d'expiration)"
    [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "E-mail invalide (--email)."
  fi
  SERVER_NAMES="$DOMAIN"; [[ $WITH_WWW -eq 1 ]] && SERVER_NAMES="$DOMAIN www.$DOMAIN"

  step "Prérequis"
  [[ -n "$PKG" ]] || warn "Gestionnaire de paquets inconnu : les dépendances doivent déjà être présentes."
  command -v systemctl >/dev/null || die "systemd est requis."
  pkg_install curl ca-certificates tar xz-utils
  command -v ss >/dev/null || pkg_install iproute2
  ok "Outils de base présents"

  # Port interne : on garde celui de l'installation précédente, sinon le premier libre.
  if [[ -z "$PORT" ]]; then
    if [[ -n "$existing_port" ]]; then PORT="$existing_port"
    else
      PORT=3080
      while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
    fi
  elif port_in_use "$PORT" && [[ "$PORT" != "$existing_port" ]]; then
    die "Le port $PORT est déjà utilisé par « $(listener_on "$PORT") »."
  fi
  ok "Port interne : 127.0.0.1:$PORT"

  check_dns
  install_node
  deploy_code
  setup_user_and_config
  setup_service
  detect_web_server
  case "$WEB_SERVER" in
    nginx) configure_nginx ;;
    apache) configure_apache ;;
    caddy) configure_caddy ;;
    none) warn "Aucun reverse proxy configuré : dirigez votre proxy vers http://127.0.0.1:$PORT" ;;
    *) die "Serveur web inconnu : $WEB_SERVER" ;;
  esac
  [[ "$WEB_SERVER" != none ]] && open_firewall
  rm -rf "$BASE/app.old"

  # Petit utilitaire d'administration
  cat > "/usr/local/sbin/$NAME-ctl" <<CTL
#!/usr/bin/env bash
# Raccourcis pour l'instance $NAME
case "\${1:-}" in
  logs) exec journalctl -u $SERVICE -f ;;
  restart) exec systemctl restart $SERVICE ;;
  status) exec systemctl status $SERVICE --no-pager ;;
  backup) exec systemctl start $NAME-backup.service ;;
  update) shift; exec bash "$APP/deploy/install.sh" update --name $NAME "\$@" ;;
  config) exec \${EDITOR:-nano} $ENV_FILE ;;
  *) echo "Usage : $NAME-ctl {logs|restart|status|backup|update|config}"; exit 1 ;;
esac
CTL
  chmod 755 "/usr/local/sbin/$NAME-ctl"

  local scheme=https; [[ $TLS -eq 0 ]] && scheme=http
  local token; token="$(env_get SETUP_TOKEN)"
  echo
  echo "${B}${G}════════════════════════════════════════════════════════════════${N}"
  echo "${B}${G}  MyCity est en ligne : $scheme://$DOMAIN${N}"
  echo "${B}${G}════════════════════════════════════════════════════════════════${N}"
  echo
  echo "  ${B}1. Créez votre compte administrateur${N} (premier accès au site) :"
  echo "       $scheme://$DOMAIN/?setup=$token"
  echo "     Code d'installation : ${B}$token${N}"
  echo
  if [[ -z "$(env_get STRIPE_SECRET_KEY)" ]]; then
    echo "  ${B}2. Paiements${N} : mode démo (achats simulés). Pour encaisser réellement :"
    echo "       $NAME-ctl config   → renseignez STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET"
    echo "       Webhook Stripe à créer : $scheme://$DOMAIN/api/stripe/webhook"
    echo "       (événements : checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired)"
    echo "       puis : $NAME-ctl restart"
  else
    echo "  ${B}2. Paiements Stripe activés.${N} Webhook : $scheme://$DOMAIN/api/stripe/webhook"
  fi
  echo
  echo "  ${B}Commandes utiles${N} : $NAME-ctl logs | restart | status | backup | update | config"
  echo "  Données : $DATA   ·   Configuration : $ENV_FILE   ·   Sauvegardes quotidiennes : $DATA/backups"
  echo
}

cmd_update() {
  [[ -f "$ENV_FILE" ]] || die "Instance « $NAME » introuvable ($ENV_FILE). Lancez d'abord l'installation."
  step "Mise à jour de l'instance « $NAME »"
  PORT="$(env_get PORT)"
  systemctl start "$NAME-backup.service" && ok "Sauvegarde préalable effectuée"
  install_node
  deploy_code
  env_set INSTALL_REPO "$INSTALL_SOURCE"
  env_set INSTALL_BRANCH "$BRANCH"
  setup_service
  rm -rf "$BASE/app.old"
  ok "Mise à jour terminée"
}

cmd_status() {
  systemctl status "$SERVICE" --no-pager || true
  local port; port="$(env_get PORT)"
  [[ -n "$port" ]] && curl -fsS "http://127.0.0.1:$port/api/health" && echo
}

cmd_backup() {
  systemctl start "$NAME-backup.service"
  ls -1t "$DATA/backups" | head -5
}

cmd_uninstall() {
  step "Désinstallation de l'instance « $NAME »"
  if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
    local confirm=""; read -r -p "  Confirmer la désinstallation de $NAME ? (oui/non) " confirm
    [[ "$confirm" == "oui" ]] || die "Annulé."
  fi
  local domain; domain="$(env_get BASE_URL | sed -E 's#^https?://##')"
  systemctl disable --now "$SERVICE" "$NAME-backup.timer" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$SERVICE" "/etc/systemd/system/$NAME-backup.service" "/etc/systemd/system/$NAME-backup.timer"
  systemctl daemon-reload
  if [[ -f "/etc/nginx/sites-enabled/$NAME.conf" || -f "/etc/nginx/conf.d/$NAME.conf" ]]; then
    rm -f "/etc/nginx/sites-enabled/$NAME.conf" "/etc/nginx/sites-available/$NAME.conf" "/etc/nginx/conf.d/$NAME.conf"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
  fi
  if [[ -f "/etc/apache2/sites-available/$NAME.conf" ]]; then
    a2dissite -q "$NAME" >/dev/null 2>&1 || true
    rm -f "/etc/apache2/sites-available/$NAME.conf"
    apachectl configtest >/dev/null 2>&1 && systemctl reload apache2
  fi
  if [[ -f "/etc/httpd/conf.d/$NAME.conf" ]]; then
    rm -f "/etc/httpd/conf.d/$NAME.conf"; apachectl configtest >/dev/null 2>&1 && systemctl reload httpd
  fi
  if [[ -f "/etc/caddy/sites/$NAME.caddy" ]]; then
    rm -f "/etc/caddy/sites/$NAME.caddy"; systemctl reload caddy 2>/dev/null || true
  fi
  [[ -n "$domain" ]] && command -v certbot >/dev/null && certbot delete --cert-name "$NAME-$domain" --non-interactive >/dev/null 2>&1 || true
  rm -rf "$BASE" "$ACME_ROOT" "/usr/local/sbin/$NAME-ctl"
  if [[ $PURGE -eq 1 ]]; then
    rm -rf "$DATA" "$CONF_DIR"
    userdel "$USER_NAME" >/dev/null 2>&1 || true
    ok "Instance et données supprimées"
  else
    ok "Instance supprimée. Données conservées dans $DATA et $CONF_DIR (--purge pour tout effacer)."
  fi
}

case "$ACTION" in
  install) cmd_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  backup) cmd_backup ;;
  uninstall) cmd_uninstall ;;
esac
