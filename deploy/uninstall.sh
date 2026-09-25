#!/usr/bin/env bash
# =============================================================================
#  MyCity — désinstallation complète : supprime toute trace de MyCity du VPS
# =============================================================================
#
#  sudo bash deploy/uninstall.sh            (ou : sudo mycity-uninstall)
#
#  Supprime, pour chaque instance installée (ou seulement --name N) :
#   • les services et minuteurs systemd, le conteneur Docker et l'image téléchargée pour MyCity ;
#   • les sites ajoutés à nginx / Apache / Caddy / Traefik / Nginx Proxy Manager (les autres sites ne
#     sont jamais touchés ; chaque configuration est testée avant rechargement) ;
#   • le certificat Let's Encrypt, les règles de pare-feu ajoutées par MyCity ;
#   • le code, le Node.js privé, la base de données, les sauvegardes, la configuration, l'utilisateur système ;
#   • les paquets installés par MyCity, s'ils ne servent à rien d'autre ;
#   • ce programme lui-même.
#
#  Options :
#    --name N          ne désinstaller que l'instance N (défaut : toutes)
#    --keep-data       conserver la base, les sauvegardes et la configuration
#    --backup-to F     exporter la base dans le fichier F avant suppression
#    --remove-source   supprimer aussi le dossier source d'où MyCity a été installée
#    --keep-packages   ne désinstaller aucun paquet système
#    --npm-email E / --npm-password P   identifiants Nginx Proxy Manager (retrait du Proxy Host)
#    -y, --yes         ne pose aucune question
# =============================================================================
set -Euo pipefail

ONLY=""
KEEP_DATA=0
BACKUP_TO=""
REMOVE_SOURCE=0
KEEP_PACKAGES=0
ASSUME_YES=0
NPM_EMAIL="${NPM_EMAIL:-}"
NPM_PASSWORD="${NPM_PASSWORD:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) ONLY="${2:-}"; shift 2 ;;
    --keep-data) KEEP_DATA=1; shift ;;
    --backup-to) BACKUP_TO="${2:-}"; shift 2 ;;
    --remove-source) REMOVE_SOURCE=1; shift ;;
    --keep-packages) KEEP_PACKAGES=1; shift ;;
    --npm-email) NPM_EMAIL="${2:-}"; shift 2 ;;
    --npm-password) NPM_PASSWORD="${2:-}"; shift 2 ;;
    --purge) shift ;; # compatibilité : la suppression complète est le comportement par défaut
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
done

if [[ -t 1 ]]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B='' G='' Y='' R='' C='' N=''; fi
step() { echo; echo "${B}${C}▸ $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; }
die()  { echo; echo "${R}✖ $*${N}" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Lancez ce programme en root (sudo)."

MARKER_DIR="/etc/mycity-instances"
docker_ok() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
port_in_use() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q . ; }

# ----------------------------------------------------------------- recherche des instances
is_mycity_instance() { # preuve qu'une instance MyCity porte ce nom (jamais de suppression « au hasard »)
  local n="$1"
  [[ "$n" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || return 1
  [[ -f "$MARKER_DIR/$n" ]] && return 0
  grep -qs '^INSTANCE=' "/etc/$n/install.state" && return 0
  grep -qs '^Description=MyCity (' "/etc/systemd/system/$n.service" && return 0
  grep -qs '"name": "mycity"' "/opt/$n/app/package.json" && return 0
  return 1
}

declare -a INSTANCES=()
find_instances() {
  local candidates=() n f
  [[ -d "$MARKER_DIR" ]] && for f in "$MARKER_DIR"/*; do [[ -f "$f" ]] && candidates+=("$(basename "$f")"); done
  for f in /etc/systemd/system/*.service; do
    [[ -f "$f" ]] && grep -qs '^Description=MyCity (' "$f" && candidates+=("$(basename "$f" .service)")
  done
  for f in /etc/*/install.state; do [[ -f "$f" ]] && grep -qs '^INSTANCE=' "$f" && candidates+=("$(basename "$(dirname "$f")")"); done
  for f in /opt/*/app/package.json; do grep -qs '"name": "mycity"' "$f" && candidates+=("$(basename "$(dirname "$(dirname "$f")")")"); done
  for n in $(printf '%s\n' "${candidates[@]}" | sort -u); do
    [[ -n "$ONLY" && "$n" != "$ONLY" ]] && continue
    is_mycity_instance "$n" && INSTANCES+=("$n")
  done
}

sget() { # sget <instance> <clé> : valeur de l'inventaire d'installation
  local f="/etc/$1/install.state"
  [[ -f "$f" ]] && grep -E "^$2=" "$f" | tail -1 | cut -d= -f2- || true
}
eget() { # eget <instance> <clé> : valeur de la configuration
  local f="/etc/$1/$1.env"
  [[ -f "$f" ]] && grep -E "^$2=" "$f" | tail -1 | cut -d= -f2- || true
}

# ----------------------------------------------------------------- rechargements sûrs
RELOAD_NGINX=0; RELOAD_APACHE=""; RELOAD_CADDY=0; declare -a DOCKER_RELOADS=()
reload_web_servers() {
  if [[ $RELOAD_NGINX -eq 1 ]] && command -v nginx >/dev/null; then
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx 2>/dev/null && ok "nginx rechargé"; else warn "nginx -t échoue : rechargement non effectué (configuration antérieure ?)."; fi
  fi
  if [[ -n "$RELOAD_APACHE" ]] && command -v apachectl >/dev/null; then
    if apachectl configtest >/dev/null 2>&1; then systemctl reload "$RELOAD_APACHE" 2>/dev/null && ok "Apache rechargé"; else warn "apachectl configtest échoue : rechargement non effectué."; fi
  fi
  if [[ $RELOAD_CADDY -eq 1 ]] && command -v caddy >/dev/null; then systemctl reload caddy 2>/dev/null && ok "Caddy rechargé"; fi
  local r
  for r in "${DOCKER_RELOADS[@]}"; do eval "$r" >/dev/null 2>&1 || true; done
}

remove_site_file() {
  local f="$1" inst="$2"
  [[ -e "$f" || -L "$f" ]] || return 0
  # Uniquement les fichiers qui portent la marque de cette instance
  if [[ -L "$f" ]] || grep -qs -e "$inst" -e "MyCity" "$f"; then
    local target=""
    [[ -L "$f" ]] && target="$(readlink -f "$f" || true)"
    rm -f "$f"
    [[ -n "$target" && "$target" == *"/$inst.conf" && -f "$target" ]] && rm -f "$target"
    ok "Site retiré : $f"
    case "$f" in
      /etc/nginx/*) RELOAD_NGINX=1 ;;
      /etc/apache2/*) RELOAD_APACHE=apache2 ;;
      /etc/httpd/*) RELOAD_APACHE=httpd ;;
      /etc/caddy/*) RELOAD_CADDY=1 ;;
    esac
  fi
}

# ----------------------------------------------------------------- désinstallation d'une instance
declare -a ALL_PKGS=() SOURCES=()
uninstall_instance() {
  local n="$1"
  local base="/opt/$n" data="/var/lib/$n" conf="/etc/$n"
  step "Instance « $n »"

  # 0. Export éventuel de la base
  if [[ -n "$BACKUP_TO" && -f "$data/mycity.db" ]]; then
    local dest="$BACKUP_TO"; [[ ${#INSTANCES[@]} -gt 1 ]] && dest="${BACKUP_TO%.db}-$n.db"
    if [[ -x "$base/runtime/bin/node" ]]; then
      "$base/runtime/bin/node" --disable-warning=ExperimentalWarning -e \
        "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});d.exec(\"VACUUM INTO '\"+process.argv[2].replace(/'/g,\"''\")+\"'\");" \
        "$data/mycity.db" "$dest" && ok "Base exportée : $dest"
    else cp -p "$data/mycity.db" "$dest" && ok "Base copiée : $dest"; fi
  fi

  # 1. Services systemd
  local u
  for u in "$n.service" "$n-backup.timer" "$n-backup.service"; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    if [[ -f "/etc/systemd/system/$u" ]]; then rm -f "/etc/systemd/system/$u"; ok "Unité systemd supprimée : $u"; fi
  done
  systemctl daemon-reload
  systemctl reset-failed "$n.service" "$n-backup.service" >/dev/null 2>&1 || true

  # 2. Conteneur et image Docker
  if docker_ok; then
    local ids; ids="$(docker ps -aq --filter "label=mycity.instance=$n")"
    if [[ -n "$ids" ]]; then docker rm -f $ids >/dev/null 2>&1 && ok "Conteneur Docker supprimé"; fi
    local img; img="$(sget "$n" DOCKER_IMAGE)"
    if [[ -n "$img" && "$(sget "$n" DOCKER_IMAGE_PULLED)" == 1 ]]; then
      if [[ -z "$(docker ps -aq --filter "ancestor=$img")" ]]; then
        docker rmi "$img" >/dev/null 2>&1 && ok "Image Docker $img supprimée (téléchargée pour MyCity)"
      else warn "Image $img conservée : utilisée par d'autres conteneurs."; fi
    fi
  fi

  # 3. Sites web (inventaire + emplacements conventionnels des anciennes versions)
  local f
  for f in $(sget "$n" SITE_FILES) \
           "/etc/nginx/sites-enabled/$n.conf" "/etc/nginx/sites-available/$n.conf" "/etc/nginx/conf.d/$n.conf" \
           "/etc/apache2/sites-enabled/$n.conf" "/etc/apache2/sites-available/$n.conf" "/etc/httpd/conf.d/$n.conf" \
           "/etc/caddy/sites/$n.caddy"; do
    remove_site_file "$f" "$n"
  done
  local pc; pc="$(sget "$n" PROXY_CONTAINER)"
  case "$(sget "$n" PROXY_KIND)" in
    nginx) [[ -n "$pc" ]] && DOCKER_RELOADS+=("docker exec '$pc' nginx -t && docker exec '$pc' nginx -s reload") ;;
  esac
  # Bloc ajouté au Caddyfile d'un conteneur Caddy (délimité par des marqueurs, retiré en place)
  local cf; cf="$(sget "$n" CADDYFILE_BLOCK)"
  if [[ -n "$cf" && -f "$cf" ]] && grep -q "^# >>> mycity:$n\$" "$cf"; then
    local content; content="$(sed "/^# >>> mycity:$n\$/,/^# <<< mycity:$n\$/d" "$cf")"
    printf '%s\n' "$content" > "$cf"
    [[ -n "$pc" ]] && DOCKER_RELOADS+=("docker exec '$pc' caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile")
    ok "Bloc retiré du Caddyfile ($cf)"
  fi
  # Ligne « import » ajoutée au Caddyfile de l'hôte : retirée si plus aucun site n'en dépend
  local ci; ci="$(sget "$n" CADDY_IMPORT_ADDED)"
  if [[ -n "$ci" && -f "$ci" ]] && ! compgen -G "/etc/caddy/sites/*.caddy" >/dev/null; then
    sed -i '\#^import /etc/caddy/sites/\*\.caddy$#d' "$ci"
    rmdir /etc/caddy/sites 2>/dev/null || true
    RELOAD_CADDY=1
  fi
  # Nginx Proxy Manager : suppression du Proxy Host via l'API
  local npm_api npm_id; npm_api="$(sget "$n" NPM_API)"; npm_id="$(sget "$n" NPM_HOST_ID)"
  if [[ -n "$npm_api" && -n "$npm_id" ]]; then
    if [[ -z "$NPM_EMAIL" || -z "$NPM_PASSWORD" ]] && [[ -t 0 && $ASSUME_YES -eq 0 ]]; then
      echo "  Nginx Proxy Manager : identifiants admin pour retirer le Proxy Host n°$npm_id (Entrée pour passer)."
      read -r -p "  E-mail admin NPM : " NPM_EMAIL
      [[ -n "$NPM_EMAIL" ]] && { read -r -s -p "  Mot de passe admin NPM : " NPM_PASSWORD; echo; }
    fi
    local node="$base/runtime/bin/node"
    if [[ -n "$NPM_EMAIL" && -n "$NPM_PASSWORD" && -x "$node" ]] && NPM_EMAIL="$NPM_EMAIL" NPM_PASSWORD="$NPM_PASSWORD" "$node" -e '
        const [api, id] = process.argv.slice(1);
        (async () => {
          const t = await fetch(api + "/api/tokens", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identity: process.env.NPM_EMAIL, secret: process.env.NPM_PASSWORD }) }).then((r) => r.json());
          if (!t.token) process.exit(1);
          const r = await fetch(api + "/api/nginx/proxy-hosts/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + t.token } });
          process.exit(r.ok || r.status === 404 ? 0 : 1);
        })().catch(() => process.exit(1));' "$npm_api" "$npm_id"; then
      ok "Proxy Host n°$npm_id retiré de Nginx Proxy Manager"
    else
      warn "Proxy Host n°$npm_id à supprimer dans Nginx Proxy Manager (identifiants non fournis ou API injoignable)."
    fi
  fi

  # 4. Certificat Let's Encrypt
  local domain cert
  domain="$(eget "$n" BASE_URL | sed -E 's#^https?://##')"
  for cert in $(sget "$n" CERT_NAME) ${domain:+"$n-$domain"}; do
    if command -v certbot >/dev/null && [[ -d "/etc/letsencrypt/live/$cert" ]]; then
      certbot delete --cert-name "$cert" --non-interactive >/dev/null 2>&1 && ok "Certificat $cert supprimé"
    fi
  done

  # 5. Modules Apache activés par MyCity (désactivés seulement si la configuration reste valide)
  local mod
  for mod in $(sget "$n" A2MODS); do
    if command -v a2dismod >/dev/null && [[ -e "/etc/apache2/mods-enabled/$mod.load" ]]; then
      a2dismod -q -f "$mod" >/dev/null 2>&1
      if apachectl configtest >/dev/null 2>&1; then RELOAD_APACHE=apache2; else a2enmod -q "$mod" >/dev/null 2>&1; fi
    fi
  done

  # 6. Pare-feu : règles ajoutées par MyCity, retirées si plus aucun service n'écoute sur ces ports
  local rule
  for rule in $(sget "$n" UFW_RULES); do
    if port_in_use "${rule%/*}"; then warn "Règle ufw $rule conservée : un autre service utilise ce port."
    else ufw delete allow "$rule" >/dev/null 2>&1 && ok "Règle ufw $rule retirée"; fi
  done
  local svc fw_changed=0
  for svc in $(sget "$n" FIREWALLD_SERVICES); do
    local p=80; [[ $svc == https ]] && p=443
    if port_in_use "$p"; then warn "Service firewalld $svc conservé : un autre service utilise ce port."
    else firewall-cmd --quiet --permanent --remove-service="$svc" >/dev/null 2>&1 && fw_changed=1; fi
  done
  [[ $fw_changed -eq 1 ]] && firewall-cmd --quiet --reload && ok "Règles firewalld retirées"

  # 7. Paquets installés par MyCity (traités à la fin, toutes instances confondues)
  local pkg
  for pkg in $(sget "$n" PKGS); do ALL_PKGS+=("$pkg"); done
  local src; src="$(eget "$n" INSTALL_REPO)"
  [[ "$src" == local:* ]] && SOURCES+=("${src#local:}")

  # 8. Fichiers
  [[ -d "$base" && ( -d "$base/app" || -d "$base/runtime" ) ]] && rm -rf "$base" && ok "Code et Node.js privé supprimés ($base)"
  rm -rf "/var/www/$n-acme" "/tmp/$n-webtest.log"
  rm -f "/usr/local/sbin/$n-ctl" "$MARKER_DIR/$n"
  local user_created; user_created="$(sget "$n" USER_CREATED)"
  if [[ $KEEP_DATA -eq 1 ]]; then
    warn "Données conservées (--keep-data) : $data et $conf"
  else
    [[ -d "$data" ]] && rm -rf "$data" && ok "Base de données et sauvegardes supprimées ($data)"
    [[ -d "$conf" ]] && rm -rf "$conf" && ok "Configuration supprimée ($conf)"
  fi

  # 9. Utilisateur système (seulement s'il a été créé par MyCity)
  if id "$n" >/dev/null 2>&1; then
    local home shell uid
    home="$(getent passwd "$n" | cut -d: -f6)"; shell="$(getent passwd "$n" | cut -d: -f7)"; uid="$(id -u "$n")"
    if [[ "$user_created" == 1 || ( -z "$user_created" && "$home" == "$data" && "$shell" == */nologin && $uid -lt 1000 ) ]]; then
      if [[ $KEEP_DATA -eq 1 ]]; then warn "Utilisateur $n conservé (propriétaire des données gardées)."
      else
        userdel "$n" >/dev/null 2>&1 || true
        getent group "$n" >/dev/null && groupdel "$n" >/dev/null 2>&1 || true
        ok "Utilisateur système $n supprimé"
      fi
    fi
  fi
}

# ----------------------------------------------------------------- paquets
remove_packages() {
  [[ $KEEP_PACKAGES -eq 1 || ${#ALL_PKGS[@]} -eq 0 ]] && return 0
  step "Paquets installés par MyCity"
  local pkg
  for pkg in $(printf '%s\n' "${ALL_PKGS[@]}" | sort -u); do
    # Paquets socles du système : jamais retirés.
    case "$pkg" in ca-certificates|tar|curl|iproute|iproute2) continue ;; esac
    # Encore utilisé ailleurs ?
    case "$pkg" in
      nginx)
        if compgen -G "/etc/nginx/conf.d/*.conf" >/dev/null || [[ -n "$(find /etc/nginx/sites-enabled -mindepth 1 ! -name default 2>/dev/null)" ]]; then
          warn "nginx conservé : d'autres sites l'utilisent."; continue; fi ;;
      apache2|httpd)
        if [[ -n "$(find /etc/apache2/sites-enabled /etc/httpd/conf.d -mindepth 1 ! -name '000-default*' ! -name 'welcome.conf' ! -name 'autoindex.conf' ! -name 'userdir.conf' ! -name 'ssl.conf' 2>/dev/null)" ]]; then
          warn "$pkg conservé : d'autres sites l'utilisent."; continue; fi ;;
      certbot)
        if [[ -n "$(find /etc/letsencrypt/live -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]]; then
          warn "certbot conservé : d'autres certificats en dépendent."; continue; fi ;;
    esac
    if command -v apt-get >/dev/null; then
      dpkg -s "$pkg" >/dev/null 2>&1 || continue
      # Retire le paquet et UNIQUEMENT les dépendances devenues orphelines à cause de lui.
      local before after extra
      before="$(apt-get -s autoremove 2>/dev/null | awk '/^Remv/{print $2}' | sort)"
      after="$(apt-get -s purge --autoremove "$pkg" 2>/dev/null | awk '/^Remv|^Purg/{print $2}' | sort -u)"
      extra="$(comm -23 <(echo "$after") <(echo "$before") | tr '\n' ' ')"
      # Si la suppression entraînait celle d'un autre paquet qui dépend de lui, on le garde.
      if apt-get -s purge "$pkg" 2>/dev/null | awk '/^Remv|^Purg/{print $2}' | grep -vqx "$pkg"; then
        warn "$pkg conservé : d'autres paquets en dépendent."; continue
      fi
      # shellcheck disable=SC2086
      DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq $extra >/dev/null 2>&1 && ok "Paquet retiré : $pkg${extra:+ (et dépendances : ${extra% })}"
    elif command -v dnf >/dev/null || command -v yum >/dev/null; then
      local mgr; mgr="$(command -v dnf || command -v yum)"
      rpm -q "$pkg" >/dev/null 2>&1 || continue
      if [[ -n "$(rpm -q --whatrequires "$pkg" 2>/dev/null | grep -v 'no package requires')" ]]; then warn "$pkg conservé : d'autres paquets en dépendent."; continue; fi
      "$mgr" remove -y -q "$pkg" >/dev/null 2>&1 && ok "Paquet retiré : $pkg"
    fi
  done
}

# ----------------------------------------------------------------- programme principal
find_instances
if [[ ${#INSTANCES[@]} -eq 0 ]]; then
  [[ -n "$ONLY" ]] && die "Aucune instance MyCity nommée « $ONLY »."
  echo "Aucune instance MyCity n'est installée sur ce serveur."
  rm -f /usr/local/sbin/mycity-uninstall; rmdir "$MARKER_DIR" 2>/dev/null || true
  exit 0
fi

echo "${B}Désinstallation de MyCity${N}"
echo "  Instance(s) : ${B}${INSTANCES[*]}${N}"
if [[ $KEEP_DATA -eq 1 ]]; then echo "  Les données et la configuration seront conservées."
else echo "  ${R}La base de données, les sauvegardes et la configuration seront définitivement effacées.${N}"; fi
[[ -n "$BACKUP_TO" ]] && echo "  Export préalable de la base vers : $BACKUP_TO"
if [[ $ASSUME_YES -eq 0 ]]; then
  [[ -t 0 ]] || die "Confirmation impossible sans terminal : relancez avec -y."
  read -r -p "  Tapez « oui » pour confirmer : " answer
  [[ "$answer" == "oui" ]] || die "Annulé, rien n'a été modifié."
fi

for inst in "${INSTANCES[@]}"; do uninstall_instance "$inst"; done
step "Rechargement des serveurs web"
reload_web_servers
remove_packages

# Dossier source (le clone Git d'où MyCity a été installée)
for src in $(printf '%s\n' "${SOURCES[@]}" | sort -u); do
  [[ -f "$src/server.js" ]] && grep -qs '"name": "mycity"' "$src/package.json" || continue
  if [[ $REMOVE_SOURCE -eq 0 && $ASSUME_YES -eq 0 && -t 0 ]]; then
    read -r -p "  Supprimer aussi le dossier source $src ? (oui/non) " answer
    [[ "$answer" == "oui" ]] && REMOVE_SOURCE=1
  fi
  if [[ $REMOVE_SOURCE -eq 1 ]]; then rm -rf "$src" && ok "Dossier source supprimé : $src"
  else warn "Dossier source conservé : $src (--remove-source pour le supprimer)"; fi
done

# Plus aucune instance : on retire le programme de désinstallation lui-même
if [[ -z "$(ls -A "$MARKER_DIR" 2>/dev/null)" ]]; then
  rmdir "$MARKER_DIR" 2>/dev/null || true
  rm -f /usr/local/sbin/mycity-uninstall
fi

echo
echo "${B}${G}MyCity a été désinstallée.${N}"
echo "  Seuls subsistent les messages déjà écrits dans le journal système (journalctl), effacés au fil de sa rotation normale."
