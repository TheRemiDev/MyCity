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
#    uninstall  désinstalle : voir deploy/uninstall.sh (efface toute trace de MyCity)
#
#  Options :
#    --domain D            nom de domaine (obligatoire à l'installation)
#    --email E             e-mail Let's Encrypt (obligatoire sauf --no-tls)
#    --name N              nom de l'instance (défaut : mycity)
#    --port P              port interne (défaut : premier port libre à partir de 3080)
#    --web-server S        auto | nginx | apache | caddy | docker | none (défaut : auto)
#                          « docker » : s'intègre au proxy Docker existant (Traefik, Coolify, Dokploy,
#                          Nginx Proxy Manager, nginx-proxy, caddy-docker-proxy, Caddy)
#    --npm-email E         identifiants Nginx Proxy Manager (sinon demandés, ou NPM_EMAIL/NPM_PASSWORD)
#    --npm-password P
#    --no-tls              pas de certificat (HTTP seul, déconseillé)
#    --stripe-key K        clé secrète Stripe (sk_live_… ou sk_test_…)
#    --stripe-webhook W    secret du webhook Stripe (whsec_…)
#    --repo URL            dépôt git à installer (défaut : dossier courant, sinon GitHub)
#    --branch B            branche git (défaut : main)
#    --node-major M        version majeure de Node.js (défaut : 22)
#    --www                 ajoute aussi www.<domaine> au certificat et au site
#    --skip-dns-check      ne vérifie pas que le domaine pointe vers ce serveur
#    --cloudflare          le domaine passe par le proxy Cloudflare (détecté automatiquement sinon)
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
ASSUME_YES=0
NPM_EMAIL="${NPM_EMAIL:-}"
NPM_PASSWORD="${NPM_PASSWORD:-}"
MODE="host"                      # host : service systemd natif · docker : conteneur derrière un proxy Docker
DOCKER_IMAGE="debian:bookworm-slim"
PKGS_ADDED=""
CLOUDFLARE=0
PUBLIC_SCHEME=""
DEFAULT_REPO="https://github.com/TheRemiDev/MyCity.git"
INSTALL_SOURCE=""

case "${1:-}" in
  install|update|status|backup|uninstall) ACTION="$1"; shift ;;
esac
if [[ "$ACTION" == uninstall ]]; then
  # La désinstallation est un programme autonome (il doit survivre à la suppression de l'application).
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
  for u in "$here/uninstall.sh" /usr/local/sbin/mycity-uninstall; do [[ -f "$u" ]] && exec bash "$u" "$@"; done
  echo "Programme de désinstallation introuvable (deploy/uninstall.sh)." >&2; exit 1
fi
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
    --cloudflare) CLOUDFLARE=1; shift ;;
    --npm-email) NPM_EMAIL="${2:-}"; shift 2 ;;
    --npm-password) NPM_PASSWORD="${2:-}"; shift 2 ;;
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
STATE_FILE="$CONF_DIR/install.state"   # inventaire de tout ce que l'installation a créé (pour la désinstallation)
MARKER_DIR="/etc/mycity-instances"
CONTAINER="$NAME"
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
  PKGS_ADDED="$PKGS_ADDED ${missing[*]}"
  [[ -d "$CONF_DIR" ]] && state_flush_pkgs
  return 0
}

port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . ; }
listener_on() { { ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'users:\(\("[^"]+' | head -1 | sed 's/users:(("//'; } || true; }
listener_pid() { { ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; } || true; }
# Vrai si le processus qui écoute sur ce port tourne dans un conteneur (réseau « host » ou docker-proxy).
listener_in_container() {
  local pid; pid="$(listener_pid "$1")"
  [[ -n "$pid" && -e "/proc/$pid/root" ]] || return 1
  [[ "$(stat -Lc %d:%i "/proc/$pid/root" 2>/dev/null)" != "$(stat -Lc %d:%i / 2>/dev/null)" ]]
}
docker_ok() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
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

# Inventaire de l'installation : chaque élément créé y est noté, pour une désinstallation sans trace
# qui ne touche jamais à ce qui existait avant MyCity.
state_get() { [[ -f "$STATE_FILE" ]] && grep -E "^$1=" "$STATE_FILE" | tail -1 | cut -d= -f2- || true; }
state_set() {
  install -d -m 750 "$CONF_DIR"
  [[ -f "$STATE_FILE" ]] || install -m 600 /dev/null "$STATE_FILE"
  local tmp; tmp="$(mktemp)"
  grep -vE "^$1=" "$STATE_FILE" > "$tmp" || true
  echo "$1=$2" >> "$tmp"
  cat "$tmp" > "$STATE_FILE"; rm -f "$tmp"
}
state_add() { # ajoute une valeur à une liste (séparateur : espace), sans doublon
  local cur; cur="$(state_get "$1")"
  [[ " $cur " == *" $2 "* ]] && return 0
  state_set "$1" "${cur:+$cur }$2"
}
state_flush_pkgs() {
  local p
  for p in $PKGS_ADDED; do state_add PKGS "$p"; done
  PKGS_ADDED=""
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
  USER_CREATED=0
  if ! id "$USER_NAME" >/dev/null 2>&1; then
    USER_CREATED=1
    useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
    ok "Utilisateur $USER_NAME créé"
  else ok "Utilisateur $USER_NAME existant"; fi
  install -d -m 750 -o "$USER_NAME" -g "$USER_NAME" "$DATA" "$DATA/backups"
  install -d -m 750 -o root -g "$USER_NAME" "$CONF_DIR"
  install -d -m 755 "$MARKER_DIR"
  echo "$NAME" > "$MARKER_DIR/$NAME"
  state_set INSTANCE "$NAME"
  [[ -n "$(state_get USER_CREATED)" ]] || state_set USER_CREATED "$USER_CREATED"
  state_flush_pkgs

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
write_backup_units() {
  # Sauvegarde quotidienne (14 jours conservés) — exécutée par le Node privé, même en mode Docker.
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
}

write_host_unit() {
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
}

# Mode Docker : l'application tourne dans un conteneur minimal (image Debian officielle), qui réutilise
# le Node privé et le code installés sur l'hôte (montés en lecture seule). Aucune image à construire.
ensure_docker_image() {
  docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1 && return 0
  local img
  for img in "$DOCKER_IMAGE" "mirror.gcr.io/library/$DOCKER_IMAGE" "public.ecr.aws/docker/library/$DOCKER_IMAGE"; do
    if docker pull -q "$img" >/dev/null 2>&1; then
      [[ "$img" != "$DOCKER_IMAGE" ]] && docker tag "$img" "$DOCKER_IMAGE" && docker rmi "$img" >/dev/null 2>&1
      state_set DOCKER_IMAGE_PULLED 1
      ok "Image $DOCKER_IMAGE téléchargée"
      return 0
    fi
  done
  die "Impossible de télécharger l'image $DOCKER_IMAGE (Docker Hub injoignable ?)."
}

write_docker_unit() {
  local existing
  existing="$(docker inspect -f '{{index .Config.Labels "mycity.instance"}}' "$CONTAINER" 2>/dev/null || true)"
  if docker inspect "$CONTAINER" >/dev/null 2>&1 && [[ "$existing" != "$NAME" ]]; then
    die "Un conteneur « $CONTAINER » qui n'appartient pas à MyCity existe déjà. Choisissez un autre nom d'instance (--name)."
  fi
  ensure_docker_image
  state_set DOCKER_IMAGE "$DOCKER_IMAGE"
  local uid gid net publish
  uid="$(id -u "$USER_NAME")"; gid="$(id -g "$USER_NAME")"
  net="$(state_get DOCKER_NET)"; publish="$(state_get DOCKER_PUBLISH)"
  touch "$CONF_DIR/docker.labels" "$CONF_DIR/docker.env"
  chmod 640 "$CONF_DIR/docker.labels" "$CONF_DIR/docker.env"
  cat > "$CONF_DIR/run-container.sh" <<RUN
#!/usr/bin/env bash
# Lancement du conteneur MyCity ($NAME) — généré par deploy/install.sh
exec docker run --rm --name "$CONTAINER" --hostname "$CONTAINER" \\
  ${net:+--network "$net" --network-alias "$CONTAINER"} ${publish:+-p "$publish"} \\
  --label "mycity.instance=$NAME" --label-file "$CONF_DIR/docker.labels" \\
  --env-file "$ENV_FILE" --env-file "$CONF_DIR/docker.env" -e HOST=0.0.0.0 -e PORT=3000 \\
  --user "$uid:$gid" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \\
  --cap-drop ALL --security-opt no-new-privileges:true \\
  --memory 768m --pids-limit 256 --cpu-shares 800 \\
  --log-opt max-size=10m --log-opt max-file=3 \\
  -v "$BASE:$BASE:ro" -v "$DATA:$DATA:rw" -w "$APP" \\
  "$DOCKER_IMAGE" "$RUNTIME/bin/node" --disable-warning=ExperimentalWarning "$APP/server.js"
RUN
  chmod 750 "$CONF_DIR/run-container.sh"
  # Nom de l'unité Docker (paquet officiel, snap…) ; aucune dépendance si Docker n'est pas géré par systemd.
  local dunit="" u
  for u in docker.service snap.docker.dockerd.service; do
    if systemctl cat "$u" >/dev/null 2>&1; then dunit="$u"; break; fi
  done
  cat > "/etc/systemd/system/$SERVICE" <<UNIT
[Unit]
Description=MyCity ($NAME) — ville numérique (conteneur Docker)
Documentation=https://github.com/TheRemiDev/MyCity
After=network-online.target ${dunit}
${dunit:+Requires=$dunit}
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/env docker rm -f $CONTAINER
ExecStart=/bin/bash $CONF_DIR/run-container.sh
ExecStop=/usr/bin/env docker stop -t 15 $CONTAINER
Restart=always
RestartSec=5
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
UNIT
}

app_healthy() {
  if [[ "$MODE" == docker ]]; then
    docker exec "$CONTAINER" "$RUNTIME/bin/node" -e \
      "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1
  else
    curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1
  fi
}

setup_service() {
  step "Service systemd $SERVICE (mode $MODE)"
  write_backup_units
  if [[ "$MODE" == docker ]]; then write_docker_unit; else write_host_unit; fi
  state_set MODE "$MODE"
  systemctl daemon-reload
  systemctl enable --quiet "$SERVICE" "$NAME-backup.timer"
  systemctl restart "$SERVICE"
  systemctl start "$NAME-backup.timer"

  local _
  for _ in $(seq 1 45); do
    if app_healthy; then
      if [[ "$MODE" == docker ]]; then ok "Conteneur « $CONTAINER » démarré"; else ok "Service démarré sur 127.0.0.1:$PORT"; fi
      return 0
    fi
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
PROXY_KIND=""; PROXY_CONTAINER=""; PROXY_IMAGE=""; PROXY_NETWORK=""; PROXY_HOSTNET=0; PROXY_IP=""
# shellcheck disable=SC2034 # renseignées par eval (detect-proxy.mjs)
TRAEFIK_EP_HTTPS=""; TRAEFIK_EP_HTTP=""; TRAEFIK_RESOLVER=""; TRAEFIK_DOCKER=0; TRAEFIK_SWARM=0; TRAEFIK_FILE_DIR=""
NGINX_PROXY_ACME=0; CADDYFILE_HOST=""; NGINX_CONFD_HOST=""

detect_docker_proxy() {
  docker_ok || return 1
  local out
  out="$("$RUNTIME/bin/node" "$APP/deploy/lib/detect-proxy.mjs")" || return 1
  eval "$out"
  [[ "$PROXY_KIND" != none && -n "$PROXY_KIND" ]]
}

detect_web_server() {
  step "Détection du serveur web en place"
  if [[ "$WEB_SERVER" == docker ]]; then
    detect_docker_proxy || die "Aucun reverse proxy Docker détecté (Traefik, Nginx Proxy Manager, nginx-proxy, Caddy…)."
    MODE=docker
  elif [[ "$WEB_SERVER" == auto ]]; then
    local l80 l443
    l80="$(listener_on 80)"; l443="$(listener_on 443)"
    if [[ "$l80$l443" == *docker-proxy* ]] || listener_in_container 80 || listener_in_container 443; then
      detect_docker_proxy || die "Les ports 80/443 sont tenus par un conteneur Docker, mais Docker est inaccessible pour l'analyser."
      MODE=docker; WEB_SERVER=docker
    else
      case "$l80$l443" in
        *nginx*) WEB_SERVER=nginx ;;
        *apache*|*httpd*) WEB_SERVER=apache ;;
        *caddy*) WEB_SERVER=caddy ;;
        "")
          if detect_docker_proxy; then MODE=docker; WEB_SERVER=docker
          elif command -v nginx >/dev/null; then WEB_SERVER=nginx
          elif command -v caddy >/dev/null; then WEB_SERVER=caddy
          elif command -v apache2 >/dev/null || command -v httpd >/dev/null; then WEB_SERVER=apache
          else WEB_SERVER=nginx; fi ;;
        *) die "Les ports 80/443 sont tenus par « $l80 $l443 », que ce script ne sait pas piloter. Relancez avec --web-server none puis faites pointer ce proxy vers http://127.0.0.1:$PORT (en-têtes X-Forwarded-For et X-Forwarded-Proto)." ;;
      esac
    fi
  fi
  if [[ "$MODE" == docker ]]; then
    case "$PROXY_KIND" in
      traefik|npm|nginx-proxy|caddy-docker-proxy|caddy|nginx) ;;
      *) die "Les ports 80/443 sont tenus par le conteneur « $PROXY_CONTAINER » ($PROXY_IMAGE), qui n'est pas un reverse proxy reconnu. Relancez avec --web-server none puis routez $DOMAIN vers http://127.0.0.1:$PORT depuis ce conteneur." ;;
    esac
    ok "Proxy Docker détecté : $PROXY_KIND (conteneur « $PROXY_CONTAINER », réseau « ${PROXY_NETWORK:-host} »)"
    # Raccordement réseau du conteneur MyCity
    if [[ "$PROXY_HOSTNET" == 1 ]]; then
      state_set DOCKER_NET ""; state_set DOCKER_PUBLISH "127.0.0.1:$PORT:3000"; UPSTREAM="127.0.0.1:$PORT"
    elif [[ -n "$PROXY_NETWORK" && "$PROXY_NETWORK" != bridge ]]; then
      state_set DOCKER_NET "$PROXY_NETWORK"; state_set DOCKER_PUBLISH ""; UPSTREAM="$CONTAINER:3000"
    else
      # Réseau « bridge » par défaut : pas de DNS interne, on publie sur la passerelle Docker (jamais sur Internet).
      local gw; gw="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"
      state_set DOCKER_NET ""; state_set DOCKER_PUBLISH "$gw:$PORT:3000"; UPSTREAM="$gw:$PORT"
    fi
    state_set PROXY_KIND "$PROXY_KIND"; state_set PROXY_CONTAINER "$PROXY_CONTAINER"
  else
    ok "Serveur web retenu : $WEB_SERVER"
  fi
  state_set WEB_SERVER "$WEB_SERVER"
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
  state_set ACME_ROOT "$ACME_ROOT"; state_set CERT_NAME "$NAME-$DOMAIN"
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
    state_add SITE_FILES "/etc/nginx/sites-enabled/$NAME.conf"
  else
    file="/etc/nginx/conf.d/$NAME.conf"
  fi
  state_add SITE_FILES "$file"; state_set RELOAD_NGINX 1
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
    local mod
    for mod in proxy proxy_http headers ssl rewrite; do
      if [[ ! -e "/etc/apache2/mods-enabled/$mod.load" ]]; then a2enmod -q "$mod" >/dev/null; state_add A2MODS "$mod"; fi
    done
  else
    command -v httpd >/dev/null || pkg_install httpd mod_ssl
    svc=httpd; conf_dir=/etc/httpd/conf.d; file="$conf_dir/$NAME.conf"
  fi
  systemctl enable --quiet --now "$svc"
  state_add SITE_FILES "$file"; state_set RELOAD_APACHE "$svc"
  [[ $svc == apache2 ]] && state_add SITE_FILES "/etc/apache2/sites-enabled/$NAME.conf"
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
    printf '\nimport %s/*.caddy\n' "$dir" >> "$main"
    state_set CADDY_IMPORT_ADDED "$main"
  fi
  state_add SITE_FILES "$dir/$NAME.caddy"; state_set RELOAD_CADDY 1
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

# ----------------------------------------------------------------- proxys Docker
docker_domains() { if [[ $WITH_WWW -eq 1 ]]; then echo "$DOMAIN www.$DOMAIN"; else echo "$DOMAIN"; fi; }

# Étiquettes / variables lues par les proxys « à découverte automatique » : à écrire AVANT de lancer le conteneur.
configure_docker_labels() {
  : > "$CONF_DIR/docker.labels"; : > "$CONF_DIR/docker.env"
  local rule="" d
  for d in $(docker_domains); do rule="${rule:+$rule || }Host(\`$d\`)"; done
  case "$PROXY_KIND" in
    traefik)
      if [[ "$TRAEFIK_SWARM" == 1 && "$TRAEFIK_DOCKER" != 1 ]]; then
        die "Traefik fonctionne en mode Swarm : ajoutez un service vers http://$UPSTREAM, ou relancez avec --web-server none."
      fi
      if [[ "$TRAEFIK_DOCKER" == 1 ]]; then
        {
          echo "traefik.enable=true"
          [[ -n "$(state_get DOCKER_NET)" ]] && echo "traefik.docker.network=$(state_get DOCKER_NET)"
          echo "traefik.http.services.$NAME.loadbalancer.server.port=3000"
          if [[ $TLS -eq 1 && -n "$TRAEFIK_EP_HTTPS" ]]; then
            echo "traefik.http.routers.$NAME.rule=$rule"
            echo "traefik.http.routers.$NAME.entrypoints=$TRAEFIK_EP_HTTPS"
            echo "traefik.http.routers.$NAME.service=$NAME"
            echo "traefik.http.routers.$NAME.tls=true"
            [[ -n "$TRAEFIK_RESOLVER" ]] && echo "traefik.http.routers.$NAME.tls.certresolver=$TRAEFIK_RESOLVER"
            if [[ -n "$TRAEFIK_EP_HTTP" ]]; then
              echo "traefik.http.routers.$NAME-http.rule=$rule"
              echo "traefik.http.routers.$NAME-http.entrypoints=$TRAEFIK_EP_HTTP"
              echo "traefik.http.routers.$NAME-http.service=$NAME"
              echo "traefik.http.routers.$NAME-http.middlewares=$NAME-https"
              echo "traefik.http.middlewares.$NAME-https.redirectscheme.scheme=https"
              echo "traefik.http.middlewares.$NAME-https.redirectscheme.permanent=true"
            fi
          else
            echo "traefik.http.routers.$NAME-http.rule=$rule"
            [[ -n "$TRAEFIK_EP_HTTP" ]] && echo "traefik.http.routers.$NAME-http.entrypoints=$TRAEFIK_EP_HTTP"
            echo "traefik.http.routers.$NAME-http.service=$NAME"
          fi
        } > "$CONF_DIR/docker.labels"
        ok "Routage Traefik par étiquettes Docker (entrée ${TRAEFIK_EP_HTTPS:-http}${TRAEFIK_RESOLVER:+, certificats « $TRAEFIK_RESOLVER »})"
        [[ $TLS -eq 1 && -z "$TRAEFIK_RESOLVER" ]] && warn "Aucun résolveur ACME trouvé dans Traefik : il servira son certificat par défaut pour $DOMAIN."
      fi ;;
    nginx-proxy)
      local hosts; hosts="$(docker_domains | tr ' ' ',')"
      {
        echo "VIRTUAL_HOST=$hosts"
        echo "VIRTUAL_PORT=3000"
        if [[ $TLS -eq 1 && "$NGINX_PROXY_ACME" == 1 ]]; then echo "LETSENCRYPT_HOST=$hosts"; echo "LETSENCRYPT_EMAIL=$EMAIL"; fi
      } > "$CONF_DIR/docker.env"
      ok "Routage nginx-proxy (VIRTUAL_HOST=$hosts)"
      [[ $TLS -eq 1 && "$NGINX_PROXY_ACME" != 1 ]] && warn "Pas d'acme-companion détecté : HTTPS dépend de vos propres certificats nginx-proxy." ;;
    caddy-docker-proxy)
      local names; names="$(docker_domains | sed 's/ /, /g')"; [[ $TLS -eq 0 ]] && names="http://$DOMAIN"
      {
        echo "caddy=$names"
        echo "caddy.reverse_proxy={{upstreams 3000}}"
        echo "caddy.reverse_proxy.flush_interval=-1"
      } > "$CONF_DIR/docker.labels"
      ok "Routage caddy-docker-proxy (TLS automatique par Caddy)" ;;
  esac
  return 0
}

# Proxys configurés APRÈS le démarrage du conteneur (fichier ou API).
configure_docker_proxy() {
  step "Raccordement au proxy Docker « $PROXY_CONTAINER » ($PROXY_KIND)"
  case "$PROXY_KIND" in
    traefik)
      if [[ "$TRAEFIK_DOCKER" != 1 ]]; then
        [[ -n "$TRAEFIK_FILE_DIR" && -d "$TRAEFIK_FILE_DIR" ]] || die "Traefik n'utilise ni le fournisseur Docker ni un dossier de configuration dynamique accessible. Routez $DOMAIN vers http://$UPSTREAM, ou relancez avec --web-server none."
        local f="$TRAEFIK_FILE_DIR/$NAME.yml" rule="" d
        for d in $(docker_domains); do rule="${rule:+$rule || }Host(\`$d\`)"; done
        {
          echo "# MyCity ($NAME) — généré par deploy/install.sh"
          echo "http:"
          echo "  routers:"
          echo "    $NAME:"
          echo "      rule: \"$rule\""
          [[ -n "$TRAEFIK_EP_HTTPS" && $TLS -eq 1 ]] && echo "      entryPoints: [\"$TRAEFIK_EP_HTTPS\"]"
          echo "      service: $NAME"
          if [[ $TLS -eq 1 ]]; then
            echo "      tls:"
            [[ -n "$TRAEFIK_RESOLVER" ]] && echo "        certResolver: $TRAEFIK_RESOLVER" || echo "        {}"
          fi
          echo "  services:"
          echo "    $NAME:"
          echo "      loadBalancer:"
          echo "        servers:"
          echo "          - url: \"http://$UPSTREAM\""
        } > "$f"
        state_add SITE_FILES "$f"
        ok "Route Traefik ajoutée : $f"
      else
        ok "Traefik découvre le conteneur automatiquement"
      fi ;;
    nginx-proxy|caddy-docker-proxy) ok "Le proxy découvre le conteneur automatiquement" ;;
    npm) configure_npm ;;
    caddy) configure_caddy_container ;;
    nginx) configure_nginx_container ;;
  esac
}

configure_npm() {
  local api="http://${PROXY_IP:-127.0.0.1}:81"; [[ "$PROXY_HOSTNET" == 1 ]] && api="http://127.0.0.1:81"
  if [[ -z "$NPM_EMAIL" || -z "$NPM_PASSWORD" ]]; then
    [[ -t 0 && $ASSUME_YES -eq 0 ]] || die "Nginx Proxy Manager détecté : fournissez ses identifiants admin (--npm-email et --npm-password, ou NPM_EMAIL/NPM_PASSWORD)."
    echo "  Nginx Proxy Manager détecté : ses identifiants administrateur sont nécessaires pour ajouter le site."
    [[ -n "$NPM_EMAIL" ]] || read -r -p "  E-mail admin NPM : " NPM_EMAIL
    [[ -n "$NPM_PASSWORD" ]] || { read -r -s -p "  Mot de passe admin NPM : " NPM_PASSWORD; echo; }
  fi
  local res
  res="$(NPM_EMAIL="$NPM_EMAIL" NPM_PASSWORD="$NPM_PASSWORD" "$RUNTIME/bin/node" "$APP/deploy/lib/npm-api.mjs" \
    "$api" "$(docker_domains | tr ' ' ',')" "${UPSTREAM%:*}" "${UPSTREAM##*:}" "$EMAIL" "$TLS")" \
    || die "L'API de Nginx Proxy Manager ($api) a refusé la demande (identifiants ?)."
  local id; id="$(echo "$res" | awk '{print $2}')"
  state_set NPM_API "$api"; state_set NPM_HOST_ID "$id"
  if [[ "$res" == *notls* && $TLS -eq 1 ]]; then
    warn "Site publié en HTTP : le certificat a été refusé (${res#*notls }). Réessayez depuis l'interface NPM une fois le DNS prêt."
    PUBLIC_SCHEME=http
  else ok "Proxy Host n°$id créé dans Nginx Proxy Manager (certificat Let’s Encrypt si HTTPS)"; fi
}

# Écrit (ou remplace) le bloc MyCity dans le Caddyfile monté, valide, recharge ; restaure en cas de refus.
write_caddy_block() { # write_caddy_block "<directives tls éventuelles>"
  local tls_lines="$1"
  local names; names="$(docker_domains | sed 's/ /, /g')"; [[ $TLS -eq 0 ]] && names="http://$DOMAIN"
  local backup; backup="$(mktemp)"; cp -p "$CADDYFILE_HOST" "$backup"
  local content indented=""
  content="$(sed "/^# >>> mycity:$NAME\$/,/^# <<< mycity:$NAME\$/d" "$backup")"
  [[ -n "$tls_lines" ]] && indented="$(printf '%s\n' "$tls_lines" | sed 's/^/\t/')"$'\n'
  # Écriture « en place » (même inode) pour ne pas casser le montage du fichier dans le conteneur.
  printf '%s\n\n# >>> mycity:%s\n%s {\n%s\treverse_proxy %s {\n\t\tflush_interval -1\n\t}\n}\n# <<< mycity:%s\n' \
    "$content" "$NAME" "$names" "$indented" "$UPSTREAM" "$NAME" > "$CADDYFILE_HOST"
  # Le conteneur voit-il bien le fichier modifié ? (un montage de fichier devient « périmé » si le fichier
  # a été remplacé au lieu d'être modifié, par exemple par un éditeur ou sed -i)
  if ! docker exec "$PROXY_CONTAINER" grep -q "^# >>> mycity:$NAME\$" /etc/caddy/Caddyfile 2>/dev/null; then
    cat "$backup" > "$CADDYFILE_HOST"; rm -f "$backup"
    die "Le conteneur « $PROXY_CONTAINER » ne voit pas les modifications de $CADDYFILE_HOST (montage périmé). Redémarrez-le (docker restart $PROXY_CONTAINER) puis relancez ce script."
  fi
  if ! docker exec "$PROXY_CONTAINER" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/tmp/"$NAME"-caddy.log 2>&1; then
    cat "$backup" > "$CADDYFILE_HOST"; rm -f "$backup"
    tail -5 /tmp/"$NAME"-caddy.log
    return 1
  fi
  rm -f "$backup"
  docker exec "$PROXY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
    || warn "Rechargement de Caddy à faire manuellement."
  state_set CADDYFILE_BLOCK "$CADDYFILE_HOST"
}

# La poignée de main TLS réussit-elle pour ce domaine (certificat présent) ? Attend jusqu'à $1 secondes.
tls_handshake_ok() {
  local _ code
  for _ in $(seq 1 "${1:-60}"); do
    code="$(curl --noproxy '*' -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && return 0
    sleep 1
  done
  return 1
}

configure_caddy_container() {
  [[ -n "$CADDYFILE_HOST" && -f "$CADDYFILE_HOST" ]] || die "Le Caddyfile du conteneur « $PROXY_CONTAINER » n'est pas monté depuis l'hôte : ajoutez-y « $DOMAIN { reverse_proxy $UPSTREAM } » ou relancez avec --web-server none."
  local tls_lines="" how="certificat Let's Encrypt automatique"
  if [[ $TLS -eq 1 ]]; then
    # 1. Faire comme les sites voisins du même domaine (défi DNS, certificat d'origine Cloudflare, snippet…)
    tls_lines="$("$RUNTIME/bin/node" "$APP/deploy/lib/caddy-tls.mjs" "$CADDYFILE_HOST" "$DOMAIN" 2>/dev/null || true)"
    [[ -n "$tls_lines" ]] && how="même méthode TLS que les autres sites : $(echo "$tls_lines" | head -1)"
    # 2. Sinon, derrière Cloudflare : défi DNS si Caddy dispose du module et d'un jeton Cloudflare
    if [[ -z "$tls_lines" && $CLOUDFLARE -eq 1 ]] \
       && docker exec "$PROXY_CONTAINER" caddy list-modules 2>/dev/null | grep -q '^dns.providers.cloudflare$'; then
      local var
      var="$(docker exec "$PROXY_CONTAINER" env 2>/dev/null | grep -oE '^(CF_API_TOKEN|CLOUDFLARE_API_TOKEN|CF_DNS_API_TOKEN|CLOUDFLARE_DNS_API_TOKEN)=' | head -1 | tr -d '=')"
      if [[ -n "$var" ]]; then
        tls_lines="$(printf 'tls {\n\tdns cloudflare {env.%s}\n}' "$var")"
        how="défi DNS Cloudflare (jeton $var du conteneur)"
      fi
    fi
  fi
  write_caddy_block "$tls_lines" || die "Caddy refuse la configuration : rien n'a été modifié."
  ok "Site ajouté au Caddyfile de « $PROXY_CONTAINER » ($how)"
  [[ $TLS -eq 1 ]] || return 0

  echo "  Attente du certificat pour $DOMAIN (jusqu'à 90 s)…"
  if tls_handshake_ok 90; then ok "Certificat en place : HTTPS opérationnel"; return 0; fi
  warn "Caddy n'a pas obtenu de certificat pour $DOMAIN. Extrait de ses journaux :"
  docker logs --since 5m "$PROXY_CONTAINER" 2>&1 | grep -iF "$DOMAIN" | grep -iE "error|fail|denied|invalid" | tail -3 | cut -c1-260 | sed 's/^/      /' || true
  if [[ $CLOUDFLARE -eq 1 ]]; then
    # Repli derrière Cloudflare : certificat interne de Caddy, accepté par Cloudflare en mode SSL « Full ».
    write_caddy_block "tls internal" || die "Caddy refuse la configuration de repli."
    state_set CADDY_TLS_FALLBACK internal
    if tls_handshake_ok 30; then
      ok "Repli appliqué : certificat interne Caddy (chiffrement Cloudflare ↔ serveur assuré)"
      echo "    ${B}Action requise dans Cloudflare → SSL/TLS : mode « Full » (pas « Full (strict) »).${N}"
      echo "    Pour le mode strict : ajoutez un défi DNS Cloudflare à Caddy ou un certificat d'origine Cloudflare, puis relancez ce script."
    else
      warn "Même le certificat interne n'est pas servi : vérifiez « docker logs $PROXY_CONTAINER »."
    fi
  else
    warn "Vérifiez que $DOMAIN pointe bien vers ce serveur et que les ports 80/443 sont ouverts, puis relancez ce script."
  fi
}

configure_nginx_container() {
  [[ -n "$NGINX_CONFD_HOST" && -d "$NGINX_CONFD_HOST" ]] || die "Le dossier /etc/nginx/conf.d du conteneur « $PROXY_CONTAINER » n'est pas monté depuis l'hôte : routez $DOMAIN vers http://$UPSTREAM, ou relancez avec --web-server none."
  local f="$NGINX_CONFD_HOST/$NAME.conf"
  cat > "$f" <<NGX
# MyCity ($NAME) — généré par deploy/install.sh
server {
    listen 80;
    server_name $(docker_domains);
    client_max_body_size 2m;
    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_read_timeout 1h;
    }
}
NGX
  if ! docker exec "$PROXY_CONTAINER" nginx -t >/dev/null 2>&1; then rm -f "$f"; die "nginx refuse la configuration : rien n'a été modifié."; fi
  docker exec "$PROXY_CONTAINER" nginx -s reload >/dev/null 2>&1
  state_add SITE_FILES "$f"
  ok "Site ajouté à « $PROXY_CONTAINER » ($f)"
  [[ $TLS -eq 1 ]] && warn "Ce conteneur nginx gère lui-même ses certificats : ajoutez HTTPS pour $DOMAIN dans sa configuration."
  return 0
}

open_firewall() {
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    local port
    for port in 80 443; do
      # On ne note que les règles réellement ajoutées par MyCity (jamais celles qui existaient déjà).
      if ! ufw status 2>/dev/null | grep -qE "^$port(/tcp)?[[:space:]]+ALLOW"; then ufw allow "$port/tcp" >/dev/null; state_add UFW_RULES "$port/tcp"; fi
    done
    ok "Pare-feu ufw : ports 80 et 443 autorisés"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    local svc
    for svc in http https; do
      if ! firewall-cmd --permanent --query-service="$svc" >/dev/null 2>&1; then
        firewall-cmd --quiet --permanent --add-service="$svc"; state_add FIREWALLD_SERVICES "$svc"
      fi
    done
    firewall-cmd --quiet --reload
    ok "Pare-feu firewalld : http et https autorisés"
  fi
}

# Adresse IPv4 appartenant à Cloudflare ? (https://www.cloudflare.com/ips-v4)
is_cloudflare_ip() {
  local ip="$1" cidr net bits a b c d n1 n2 mask
  IFS=. read -r a b c d <<<"$ip"; n1=$(( (a << 24) + (b << 16) + (c << 8) + d ))
  for cidr in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 \
              190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 \
              104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do
    net="${cidr%/*}"; bits="${cidr#*/}"
    IFS=. read -r a b c d <<<"$net"; n2=$(( (a << 24) + (b << 16) + (c << 8) + d ))
    mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
    (( (n1 & mask) == (n2 & mask) )) && return 0
  done
  return 1
}

check_dns() {
  [[ $DNS_CHECK -eq 1 ]] || return 0
  step "Vérification DNS de $DOMAIN"
  local public resolved first
  public="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [[ -z "$resolved" ]]; then
    [[ $TLS -eq 1 ]] || { warn "$DOMAIN ne résout pas encore."; return 0; }
    die "$DOMAIN ne résout vers aucune adresse. Créez un enregistrement A vers ${public:-l’IP de ce serveur}, attendez la propagation, puis relancez (ou --skip-dns-check)."
  fi
  first="${resolved%% *}"
  if is_cloudflare_ip "$first"; then
    CLOUDFLARE=1
    ok "$DOMAIN passe par Cloudflare ($resolved) : pris en charge."
    echo "    Dans Cloudflare → SSL/TLS, choisissez le mode « Full (strict) » (ou « Full » le temps que le certificat soit émis)."
  elif [[ -n "$public" && " $resolved " != *" $public "* ]]; then
    warn "$DOMAIN pointe vers $resolved alors que ce serveur sort avec $public. Vérifiez l'enregistrement DNS, sinon le certificat échouera."
  else ok "$DOMAIN → $resolved"; fi
}

# Vérification de bout en bout : le domaine répond-il via le proxy local ? (sans dépendre du DNS)
verify_public() {
  [[ "$WEB_SERVER" == none ]] && return 0
  step "Vérification de bout en bout"
  local code _ https_ok=0 http_ok=0
  for _ in $(seq 1 20); do
    code="$(curl --noproxy '*' -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" 2>/dev/null || true)"
    [[ "$code" == 200 ]] && { https_ok=1; break; }
    code="$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/api/health" 2>/dev/null || true)"
    if [[ "$code" == 200 ]]; then http_ok=1; [[ $TLS -eq 0 ]] && break; fi
    sleep 1
  done
  if [[ $https_ok -eq 1 ]]; then ok "https://$DOMAIN répond (via le proxy local)"
  elif [[ $http_ok -eq 1 ]]; then
    ok "http://$DOMAIN répond (via le proxy local)"
    [[ $TLS -eq 1 ]] && { warn "HTTPS ne répond pas encore : certificat absent pour $DOMAIN."; PUBLIC_SCHEME=http; }
  elif [[ "$code" =~ ^30[1278]$ ]]; then
    warn "Le proxy redirige vers HTTPS, mais aucun certificat n'est servi pour $DOMAIN (poignée de main TLS impossible)."
    [[ $CLOUDFLARE -eq 1 ]] && echo "    Derrière Cloudflare, cela provoque l'erreur 525. Voir la documentation de votre proxy pour le défi DNS Cloudflare."
  else
    warn "Le proxy ne renvoie pas encore MyCity pour $DOMAIN (dernier code HTTP : ${code:-aucun}). L'application tourne ; vérifiez la configuration du proxy."
  fi
  return 0
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
  detect_web_server
  # IP réelle des visiteurs : on ne fait confiance qu'aux proxys locaux/Docker (et à Cloudflare s'il est devant).
  if [[ $CLOUDFLARE -eq 1 ]]; then env_set TRUST_PROXY cloudflare
  elif [[ "$MODE" == docker ]]; then env_set TRUST_PROXY private
  else env_set TRUST_PROXY loopback; fi
  if [[ "$MODE" == docker ]]; then
    configure_docker_labels
    setup_service
    configure_docker_proxy
  else
    setup_service
    case "$WEB_SERVER" in
      nginx) configure_nginx ;;
      apache) configure_apache ;;
      caddy) configure_caddy ;;
      none) warn "Aucun reverse proxy configuré : dirigez votre proxy vers http://127.0.0.1:$PORT" ;;
      *) die "Serveur web inconnu : $WEB_SERVER" ;;
    esac
    [[ "$WEB_SERVER" != none ]] && open_firewall
  fi
  rm -rf "$BASE/app.old"
  state_flush_pkgs
  verify_public
  # Programme de désinstallation autonome (efface toute trace de MyCity)
  install -m 750 "$APP/deploy/uninstall.sh" /usr/local/sbin/mycity-uninstall

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
  uninstall) shift; exec /usr/local/sbin/mycity-uninstall --name $NAME "\$@" ;;
  *) echo "Usage : $NAME-ctl {logs|restart|status|backup|update|config|uninstall}"; exit 1 ;;
esac
CTL
  chmod 755 "/usr/local/sbin/$NAME-ctl"

  local scheme="${PUBLIC_SCHEME:-https}"; [[ $TLS -eq 0 ]] && scheme=http
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
  echo "  ${B}Commandes utiles${N} : $NAME-ctl logs | restart | status | backup | update | config | uninstall"
  echo "  Tout désinstaller, sans laisser de trace : sudo mycity-uninstall"
  echo "  Données : $DATA   ·   Configuration : $ENV_FILE   ·   Sauvegardes quotidiennes : $DATA/backups"
  echo
}

cmd_update() {
  [[ -f "$ENV_FILE" ]] || die "Instance « $NAME » introuvable ($ENV_FILE). Lancez d'abord l'installation."
  step "Mise à jour de l'instance « $NAME »"
  PORT="$(env_get PORT)"
  MODE="$(state_get MODE)"; MODE="${MODE:-host}"
  systemctl start "$NAME-backup.service" && ok "Sauvegarde préalable effectuée"
  install_node
  deploy_code
  env_set INSTALL_REPO "$INSTALL_SOURCE"
  env_set INSTALL_BRANCH "$BRANCH"
  setup_service
  rm -rf "$BASE/app.old"
  install -m 750 "$APP/deploy/uninstall.sh" /usr/local/sbin/mycity-uninstall
  state_flush_pkgs
  ok "Mise à jour terminée"
}

cmd_status() {
  systemctl status "$SERVICE" --no-pager || true
  PORT="$(env_get PORT)"; MODE="$(state_get MODE)"; MODE="${MODE:-host}"
  if app_healthy; then ok "Application en bonne santé (mode $MODE)"; else warn "L'application ne répond pas"; fi
}

cmd_backup() {
  systemctl start "$NAME-backup.service"
  ls -1t "$DATA/backups" | head -5
}

case "$ACTION" in
  install) cmd_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  backup) cmd_backup ;;
esac
