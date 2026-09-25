# MyCity 🏙️

**Réclame ton terrain, bâtis ta marque.** MyCity est une ville numérique vivante, en vue isométrique. Chacun peut y
acheter un terrain, dessiner son immeuble sur mesure et y afficher sa marque, son logo et son site. Des panneaux
publicitaires se louent au mois. La ville grandit avec ses habitants : de nouveaux quartiers ouvrent au fil des ventes.

- **Une vraie ville** de 61×61 tuiles avec 7 quartiers, 1 374 terrains et 42 panneaux publicitaires. On y trouve aussi
  l'Hôtel de Ville, la Grand-Place et sa fontaine, la gare, le stade, le musée, une grande roue, un phare, des parcs et
  la mer. Des voitures, des bus et des voiliers circulent.
- **Jour/nuit** calé sur l'heure locale : fenêtres éclairées, phares et lampadaires. La météo change chaque jour
  (pluie, neige l'hiver, nuages).
- **Éditeur d'immeuble** avec aperçu en direct, dans le panneau et sur la carte :
  - hauteur de 1 à 60 étages ;
  - 8 formes, 6 toits, 5 styles de fenêtres ;
  - couleurs libres ;
  - enseigne, description, site et logo.
- **Paiements Stripe** (Checkout + webhook signé), ou **mode démo** automatique sans clé.
- **Temps réel** (Server-Sent Events) : un achat apparaît instantanément chez tous les visiteurs, avec un fil
  d'activité et le nombre de personnes en ligne.
- **Social** :
  - « J'aime » et livre d'or sur chaque immeuble ;
  - profils publics et badges (Pionnier, Gratte-ciel, Magnat…) ;
  - classements, statistiques, recherche instantanée ;
  - visite guidée, liens partageables (`/?plot=12`).
- **Administration complète** (« la mairie ») :
  - construire, modifier, surélever, réattribuer et démolir n'importe quel immeuble, gratuitement, même dans un
    quartier fermé ;
  - afficher des pubs gratuitement ;
  - modération (signalements, effacement de logo ou de textes), gestion des habitants (promotion, suspension) ;
  - prix par quartier, ouverture forcée des quartiers, annonces publiques en direct, suivi des commandes et des
    recettes.
- **Carte des prix**, mini-carte, rotation de la vue en 4 orientations, rayons X autour de la sélection.
- **Navigation** à la souris, au clavier (ZQSD, WASD ou flèches) et au tactile (pincement).
- **Sécurité et RGPD** :
  - mots de passe hachés avec scrypt, sessions HttpOnly, CSP stricte, protection CSRF, limitation de débit ;
  - images validées par leurs octets (SVG refusés), polices auto-hébergées, aucun traceur tiers ;
  - export et suppression du compte par l'utilisateur.

## Installation sur un VPS (100 % automatisée)

Prérequis : un VPS Debian, Ubuntu ou RHEL avec systemd, et un nom de domaine dont l'enregistrement **A** pointe vers le
serveur.

```bash
git clone https://github.com/TheRemiDev/MyCity.git
cd MyCity
sudo bash deploy/install.sh --domain ville.exemple.fr --email vous@exemple.fr
```

C'est tout. À la fin, le script affiche l'adresse de **création du compte administrateur**
(`https://ville.exemple.fr/?setup=<code>`). Le premier accès au site ouvre l'assistant de configuration. Il est protégé
par ce code : personne d'autre ne peut prendre la main sur votre instance.

### Ce que fait le script

| Étape | Détail |
| --- | --- |
| Node.js | Télécharge Node.js 22 officiel dans `/opt/mycity/runtime` et vérifie sa somme SHA-256. **Le Node.js système n'est jamais touché.** |
| Application | Code dans `/opt/mycity/app`, dépendances de production (`npm ci --omit=dev`). |
| Isolation | Utilisateur système dédié `mycity`, sans shell. Service systemd durci (`ProtectSystem=strict`, `NoNewPrivileges`, mémoire bornée…). Écoute **uniquement sur 127.0.0.1**. |
| Port | Premier port libre à partir de 3080, conservé lors des mises à jour. |
| Reverse proxy | S'adapte à ce qui tient déjà les ports 80/443, voir ci-dessous. Les autres sites ne sont jamais modifiés, et chaque configuration est testée avant rechargement puis restaurée en cas d'erreur. |
| HTTPS | Certificat Let's Encrypt pour ce seul domaine (`certbot --webroot`), redirection HTTP → HTTPS, renouvellement automatique. |
| Pare-feu | Ouvre 80 et 443 si ufw ou firewalld est actif. |
| Sauvegardes | Sauvegarde SQLite quotidienne à chaud, 14 jours conservés, dans `/var/lib/mycity/backups`. |
| Configuration | `/etc/mycity/mycity.env`, lisible uniquement par root et `mycity`. |
| Inventaire | Chaque élément créé (service, site, certificat, conteneur, paquet, règle de pare-feu) est noté dans `/etc/mycity/install.state`, pour une désinstallation sans trace qui ne touche jamais à l'existant. |
| Vérification | Contrôle final de bout en bout : le domaine doit répondre à travers le proxy. |

### Cohabitation avec les programmes déjà en place

Le script détecte ce qui écoute sur les ports 80/443 et s'y greffe.

**Serveur web installé directement sur l'hôte**

| Serveur | Intégration |
| --- | --- |
| nginx, Apache, Caddy | Ajoute un seul fichier de site dédié au domaine. Certificat Let's Encrypt par `certbot --webroot` (Caddy gère le sien). |
| Aucun | Installe nginx. |

**Reverse proxy dans Docker** (cas typique : le processus `docker-proxy` tient 80/443)

MyCity tourne alors dans un conteneur minimal et isolé : lecture seule, sans privilèges, mémoire bornée, aucun port
ouvert sur Internet. Il rejoint le réseau du proxy.

| Proxy | Intégration |
| --- | --- |
| **Traefik** (dont **Coolify**, **Dokploy**…) | Étiquettes Docker, ou fichier de configuration dynamique. Points d'entrée et résolveur ACME détectés automatiquement. |
| **Nginx Proxy Manager** | Ajoute un « Proxy Host » avec certificat via son API. Identifiants admin demandés, ou `--npm-email` / `--npm-password`. |
| **nginx-proxy** (+ acme-companion) | Variables `VIRTUAL_HOST` / `LETSENCRYPT_HOST`. |
| **caddy-docker-proxy** | Étiquettes `caddy=…`. |
| **Caddy** en conteneur | Bloc ajouté au Caddyfile monté, entre marqueurs. |

**Cloudflare**

Détecté automatiquement. Les vraies IP des visiteurs sont retrouvées, en ne faisant confiance qu'aux adresses de
Cloudflare. Dans Cloudflare → SSL/TLS, choisissez le mode **Full (strict)**.

**Proxy non reconnu** (HAProxy, application qui publie elle-même le port 80…)

Le script s'arrête sans rien casser. Il indique précisément vers quelle adresse interne router le domaine, à utiliser
avec `--web-server none`.

Le script est **idempotent** : on peut le relancer sans risque. Il conserve les données, le port et les réglages.

### Options utiles

```bash
sudo bash deploy/install.sh --help
  --name ville2                  # une 2e instance côte à côte (utilisateur, port, dossiers et site séparés)
  --www                          # inclut aussi www.<domaine>
  --web-server nginx|apache|caddy|docker|none
  --npm-email admin@… --npm-password …   # si Nginx Proxy Manager est détecté
  --stripe-key sk_live_… --stripe-webhook whsec_…
  --port 3500                    # forcer le port interne
  --no-tls                       # HTTP seul (tests)
  -y                             # aucune question
```

### Au quotidien

```bash
mycity-ctl logs       # journaux en direct
mycity-ctl status     # état du service
mycity-ctl restart
mycity-ctl backup     # sauvegarde immédiate
mycity-ctl config     # éditer la configuration (Stripe…), puis mycity-ctl restart
mycity-ctl update     # mise à jour (sauvegarde préalable, retour arrière automatique si échec)
```

### Désinstallation complète

```bash
sudo mycity-uninstall                  # ou : sudo bash deploy/uninstall.sh
```

Supprime **toute trace** de MyCity :
- services et minuteurs systemd, conteneur Docker et image téléchargée pour l'occasion ;
- sites ajoutés à nginx, Apache, Caddy, Traefik ou Nginx Proxy Manager, certificat Let's Encrypt, règles de pare-feu
  ajoutées ;
- code, Node.js privé, base de données, sauvegardes, configuration, utilisateur système ;
- paquets installés par MyCity s'ils ne servent à rien d'autre, et le programme de désinstallation lui-même.

Il ne touche jamais à ce qui existait avant MyCity, et reconnaît aussi les installations faites avec d'anciennes
versions du script.

Options :
- `--backup-to /root/mycity.db` : exporter la base avant ;
- `--keep-data` : garder les données ;
- `--remove-source` : supprimer aussi le clone Git ;
- `--name ville2` : une seule instance ;
- `-y` : sans question.

Seuls les messages déjà écrits dans le journal système (`journalctl`) subsistent, jusqu'à leur rotation normale.

### Encaisser de vrais paiements (Stripe)

1. Dans Stripe : **Développeurs → Webhooks → Ajouter un endpoint** `https://votre-domaine/api/stripe/webhook`, avec
   les événements `checkout.session.completed`, `checkout.session.async_payment_succeeded` et
   `checkout.session.expired`.
2. `mycity-ctl config` : renseignez `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`, puis `mycity-ctl restart`.

Sans clé, MyCity fonctionne en **mode démo** : les achats sont simulés, et c'est clairement indiqué aux visiteurs.
Pendant le paiement, le terrain est réservé 15 minutes. Si un paiement arrive pour un bien devenu indisponible, il est
signalé dans l'administration pour remboursement.

## Développement

```bash
npm install
npm run dev                          # http://localhost:3000 (rechargement automatique)
npm test                             # tests (API, paiements simulés, générateur, validation)
npm run seed:demo -- --yes           # peupler la ville d'immeubles fictifs
npm run backup                       # sauvegarde de la base
```

Node.js ≥ 22.5 est requis (SQLite natif `node:sqlite`). La seule dépendance est Express. Aucune étape de build : le
front-end est en modules ES natifs. Les variables d'environnement sont documentées dans [`.env.example`](.env.example).

### Architecture

```
server.js                      point d'entrée
src/
  app.js                       assemblage Express, tâches périodiques
  config.js · db.js            configuration, schéma SQLite et migrations
  middleware.js                en-têtes de sécurité, CSRF, limitation de débit, sessions
  routes/                      auth.js · city.js · admin.js
  services/
    city.js                    logique métier : terrains, commandes, panneaux, social, classements
    auth.js · payments.js      scrypt et sessions · Stripe (REST + vérification de webhook)
    live.js · validation.js    hub SSE · validation et nettoyage des entrées
public/
  index.html · admin.html      la ville · la console de la mairie
  js/shared/                   catalogue et générateur de ville, PARTAGÉS avec le serveur
  js/renderer.js · sprites.js  moteur isométrique (canvas) et dessin procédural
  js/ui/                       panneaux, éditeur, comptes, recherche, fil d'activité
deploy/install.sh              installation et mise à jour automatisées (détection des proxys, Cloudflare)
deploy/uninstall.sh            désinstallation complète, sans trace
deploy/lib/                    détection des proxys Docker, API Nginx Proxy Manager
scripts/                       sauvegarde, données de démonstration
test/                          tests node:test
```

La ville est générée de façon **déterministe** à partir d'une graine (`CITY_SEED`) : le serveur et le navigateur
calculent exactement le même plan. Seul l'état dynamique (propriétaires, immeubles, pubs) transite par l'API.

### API (extrait)

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/api/city` | État complet de la ville (quartiers, terrains occupés, panneaux, statistiques) |
| GET | `/api/live` | Flux temps réel (SSE) |
| GET | `/api/plots/:n` | Détail d'un terrain (visites, j'aime, livre d'or) |
| POST | `/api/checkout` | Acheter un terrain avec son design (gratuit pour l'admin) |
| PATCH | `/api/buildings/:n` | Modifier un immeuble (étages supplémentaires payants, sauf admin) |
| POST | `/api/billboards/checkout` | Louer un panneau |
| GET | `/api/leaderboard` · `/api/stats` · `/api/search?q=` | Classements, chiffres, recherche |
| POST | `/api/setup` | Création du compte administrateur au premier accès |
| * | `/api/admin/*` | Console d'administration |

## Licence

MIT. Polices DM Sans et Syne sous licence SIL Open Font License.
