#!/bin/bash
# QNet Automated Deployment Script for aiqnet.io
# Server: 195.246.231.53 (the site's VPS)
# Usage: deploy-aiqnet.sh [STEP...] runs the steps named (1 to 5, or upgrade, the host's packages), else 1 to 5, and
# ends every run with the host's status report; SSH_PORT=<port> deploy-aiqnet.sh ... when the host's sshd listens on
# another port than 2222.

set -e  # Exit on any error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SERVER_IP="195.246.231.53"
DOMAIN_NAME="aiqnet.io"
# The four names of the site: its one origin, and the three that lead there or serve the link pages.
SITE_NAMES="$DOMAIN_NAME www.$DOMAIN_NAME explorer.$DOMAIN_NAME link.$DOMAIN_NAME"
SSH_USER="root"
# The port the host's sshd listens on: every ssh of this script, its printed commands and the host's firewall and
# fail2ban rules use it, so no rule closes the way in.
SSH_PORT="${SSH_PORT:-2222}"
# The site's checkout: fetched at each update and exported into a release, never built in or run from.
APP_DIR="/var/www/qnet"
GITHUB_REPO="https://github.com/AIQnetLab/QNet-Blockchain.git"
# The branch the site is built from, as on the live host.
APP_BRANCH="testnet"
# The site installs, builds and runs as this unprivileged system user, never as root. It owns only $APP_DIR: code of the
# site's dependencies can read the site's own settings, never the indexer's, the TLS keys or the database superuser's
# access, and can change nothing the indexer runs.
APP_USER="aiqnet"
APP_HOME="/home/$APP_USER"
FRONTEND_DIR="$APP_DIR/applications/qnet-explorer/frontend"
# The balance check's checkpoints (src/server/light/store.ts), untracked in the checkout: every release's data/ links
# here, so they outlive every release.
SITE_DATA="$FRONTEND_DIR/data"
# The site's releases, each exported from one commit of the checkout and installed and built in a folder of its own;
# current names the one the site runs, previous the one before it, kept for a rollback.
SITE_RELEASES="/var/www/qnet-releases"
SITE_CURRENT="$SITE_RELEASES/current"
SITE_FRONTEND="$SITE_CURRENT/applications/qnet-explorer/frontend"
# The site's settings and secrets (DATABASE_URL of the role explorer_reader, QNET_API_URLS, QNET_API_KEY,
# FAUCET_PRIVATE_KEY, the pass keys, SOLANA_RPC_URL, ...): root's file, mode 600, which systemd reads before it starts
# the site as $APP_USER, so the user that builds the site never reads them from a file.
SITE_ENV="/root/qnet-explorer.env"
# The indexer's settings (its database writer's DATABASE_URL, QNET_API_URLS, QNET_API_KEY): root's file, mode 600,
# which systemd reads when it starts the indexer; the indexer reads no .env file of its own.
INDEXER_ENV="/root/qnet-indexer.env"
# The indexer runs releases of its own, fetched, installed with no install script and compiled by this user, so neither
# the site's user nor the indexer can change the code that holds the database writer's settings.
INDEXER_BUILDER="qnet-indexer-build"
# Its sparse checkout, fetched only when its inputs change, and its releases, kept as the site's are.
INDEXER_DIR="/opt/qnet-indexer"
INDEXER_RELEASES="/opt/qnet-indexer-releases"
INDEXER_CURRENT="$INDEXER_RELEASES/current"
INDEXER_FRONTEND="$INDEXER_CURRENT/applications/qnet-explorer/frontend"
# What the indexer's install reads, then everything its build and its run read: the checkout and each release hold only
# these paths, and a release is built only when the site's commit holds other contents of them than the running one.
INDEXER_INSTALL_INPUTS="applications/qnet-explorer/package.json applications/qnet-explorer/package-lock.json applications/qnet-explorer/frontend/package.json applications/qnet-explorer/frontend/scripts/lockfile-check.mjs"
INDEXER_INPUTS="$INDEXER_INSTALL_INPUTS applications/qnet-explorer/frontend/tsconfig.indexer.json applications/qnet-explorer/frontend/src/indexer applications/qnet-explorer/frontend/migrations"
# The fingerprints of those inputs that the running release was installed and built from, written by its builder once
# its build is done.
INDEXER_INSTALLED="$INDEXER_CURRENT/.installed-inputs"
INDEXER_BUILT="$INDEXER_CURRENT/.built-inputs"
# Room an update must find on the disk before it builds: about what each release it replaces takes (RELEASE_SPACE_MB
# when there is none yet), with FREE_RESERVE_MB left for the database and the logs on the same disk.
RELEASE_SPACE_MB=2048
FREE_RESERVE_MB=1024
# The services' units, which the update writes there itself once the release each names is built.
UNIT_DIR="/etc/systemd/system"
# A site release counts as started once it serves aiqnet.io's home page on 127.0.0.1:3000 within this many seconds.
SITE_START_S=60
# The nginx site file names the self-signed certificate until the Let's Encrypt one exists, then this one's paths.
LE_LIVE="/etc/letsencrypt/live/$DOMAIN_NAME"
CERT_PATHS="s#/etc/ssl/certs/ssl-cert-snakeoil.pem#$LE_LIVE/fullchain.pem#; s#/etc/ssl/private/ssl-cert-snakeoil.key#$LE_LIVE/privkey.pem#"
# The test of every change to the site file, which keeps the file before as .previous: a file nginx refuses, or one
# whose names another enabled file of nginx also names (nginx only warns, and serves the name from the file it loads
# first), never stays where the next restart or boot of nginx would meet it. The one before comes back (on a new host
# the site is left out) and nginx runs on as it was.
NGINX_TEST="NGINX_SAID=\$(nginx -t 2>&1) && NGINX_OK=1 || NGINX_OK=
    printf '%s\n' \"\$NGINX_SAID\" >&2
    ALSO_NAMED=
    for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
        if [ -e \"\$f\" ] && [ \"\$(readlink -f \"\$f\")\" != /etc/nginx/sites-available/$DOMAIN_NAME ] \\
            && grep -hoE '^[[:space:]]*server_name[^;]*' \"\$f\" | tr -s ' \t' '\n' | grep -qxF \"\$(printf '%s\n' $SITE_NAMES)\"; then
            ALSO_NAMED=\"\${ALSO_NAMED:+\$ALSO_NAMED }\$f\"
        fi
    done
    if [ -z \"\$NGINX_OK\" ] || [ -n \"\$ALSO_NAMED\" ] || printf '%s' \"\$NGINX_SAID\" | grep -q 'conflicting server name'; then
        if [ -f /etc/nginx/sites-available/$DOMAIN_NAME.previous ]; then
            mv /etc/nginx/sites-available/$DOMAIN_NAME.previous /etc/nginx/sites-available/$DOMAIN_NAME
        else
            rm -f /etc/nginx/sites-enabled/$DOMAIN_NAME /etc/nginx/sites-available/$DOMAIN_NAME
        fi
        echo \"nginx -t refused the site file, or another file of nginx names one of its hosts (\${ALSO_NAMED:-see the conflicting server name above}): the one before is back and nginx runs on as it was. This site file serves $SITE_NAMES: take them out of any other file, then run again.\" >&2
        exit 1
    fi
    rm -f /etc/nginx/sites-available/$DOMAIN_NAME.previous"
# Node.js release line for the site: an LTS line with security support (18 reached end of life on
# 2025-04-30). package.json "engines" and /root/update-aiqnet.sh refuse anything older.
NODE_MAJOR=22

# The steps this run makes: those named, in this script's order, or 1 to 5; upgrade runs only when it is named.
STEPS="${*:-1 2 3 4 5}"
for STEP in $STEPS; do
    case "$STEP" in
        1|2|3|4|5|upgrade) ;;
        *) echo "Unknown step '$STEP': name 1 to 5 or upgrade." >&2; exit 2 ;;
    esac
done
runs() { case " $STEPS " in *" $1 "*) return 0 ;; esac; return 1; }
if ! [[ "$SSH_PORT" =~ ^[0-9]+$ ]] || [ "$SSH_PORT" -lt 1 ] || [ "$SSH_PORT" -gt 65535 ]; then
    echo "SSH_PORT '$SSH_PORT' is not a port number." >&2
    exit 2
fi

echo -e "${BLUE}QNet Deployment to aiqnet.io${NC}"
echo -e "${BLUE}============================${NC}"
echo -e "Server IP: ${GREEN}$SERVER_IP${NC}, SSH port ${GREEN}$SSH_PORT${NC}"
echo -e "Domain: ${GREEN}$DOMAIN_NAME${NC}"
echo -e "Steps: ${GREEN}$STEPS${NC}"
echo ""

# accept-new pins the host key on first contact and rejects it if it ever
# changes (MITM), unlike "no" which blindly trusts every key. For stronger
# assurance, pre-provision the host key: ssh-keyscan -p $SSH_PORT $SERVER_IP >> ~/.ssh/known_hosts
# and switch this to StrictHostKeyChecking=yes.
SSH_OPTS="-o StrictHostKeyChecking=accept-new"

# Function to run commands on remote server
run_remote() {
    ssh -p "$SSH_PORT" $SSH_OPTS $SSH_USER@$SERVER_IP "$1"
}

# The host's packages to their latest versions, only when this step is named: it can take long and replace libraries
# under running services, which needrestart lists and does not restart (a package's own scripts may still restart its
# service; the end says whether the host needs a reboot), and it keeps every configuration file the host changed, sshd's
# port among them.
if runs upgrade; then
echo -e "${YELLOW}Step upgrade: Upgrade the host's packages${NC}"
run_remote "
    set -e
    apt-get update
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
    if [ -f /var/run/reboot-required ]; then
        echo 'The upgrade is installed; the host needs a reboot for all of it to take effect.'
    else
        echo 'The upgrade is installed; no reboot is needed.'
    fi
"
fi

if runs 1; then
echo -e "${YELLOW}Step 1: Initial Server Setup${NC}"
run_remote "
    set -e
    # The firewall below allows SSH on SSH_PORT only: a session that came in on another port would be cut.
    if [ \"\${SSH_CONNECTION##* }\" != $SSH_PORT ]; then
        echo \"This session reached sshd on port \${SSH_CONNECTION##* }, not SSH_PORT=$SSH_PORT: run again with SSH_PORT set to the port sshd listens on. Nothing was changed.\" >&2
        exit 1
    fi

    echo 'Updating the package lists...'
    apt update

    # The packages that are missing, none of those installed upgraded (the upgrade step does that); needrestart lists
    # and restarts nothing. ssl-cert makes the self-signed pair the nginx site file names until the certificate exists;
    # bind9-dnsutils has the dig of step 4.
    echo 'Installing essential packages...'
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y --no-upgrade nginx git curl wget htop ufw fail2ban certbot python3-certbot-nginx ssl-cert bind9-dnsutils
    if [ ! -f /etc/ssl/certs/ssl-cert-snakeoil.pem ] || [ ! -f /etc/ssl/private/ssl-cert-snakeoil.key ]; then
        make-ssl-cert generate-default-snakeoil --force-overwrite
    fi

    # Node.js from NodeSource only on a host without the NODE_MAJOR line or a later one: a running host keeps its own.
    if ! command -v node > /dev/null || [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
        echo 'Installing Node.js $NODE_MAJOR LTS...'
        curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | bash -
        DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y nodejs
    fi
    if [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
        echo \"Node.js \$(node --version) is installed; $NODE_MAJOR or later is required.\" >&2
        exit 1
    fi

    echo 'Creating the app user $APP_USER...'
    id -u $APP_USER >/dev/null 2>&1 || useradd --system --create-home --home-dir $APP_HOME --shell /usr/sbin/nologin $APP_USER

    # Only SSH_PORT and nginx's ports are let in by this step: the port-22 rule earlier versions of this script added by
    # the service's name goes, and any other rule of the host stays.
    echo 'Configuring the firewall...'
    ufw default deny incoming
    ufw default allow outgoing
    if [ $SSH_PORT != 22 ]; then ufw delete allow 'ssh' || true; fi
    ufw allow $SSH_PORT/tcp
    ufw allow 'Nginx Full'
    ufw --force enable

    # fail2ban's sshd jail bans on the port sshd listens on.
    echo 'Starting security services...'
    printf '[sshd]\nport = $SSH_PORT\n' > /etc/fail2ban/jail.d/qnet-sshd.local
    systemctl enable fail2ban
    systemctl restart fail2ban

    echo 'Setting hostname...'
    hostnamectl set-hostname aiqnet
    # sudo resolves the host's own name: a line for it is added once, when no line names it.
    grep -Eq '^[^#]*[[:space:]]aiqnet([[:space:]]|\$)' /etc/hosts || echo '127.0.0.1 aiqnet' >> /etc/hosts

    echo 'Initial setup completed'
"
fi

if runs 2; then
echo -e "${YELLOW}Step 2: Deploy QNet Application${NC}"
run_remote "
    set -e
    echo 'Creating the directories of the site and of the indexer...'
    mkdir -p $APP_DIR $SITE_RELEASES
    chown $APP_USER:$APP_USER $APP_DIR $SITE_RELEASES
    id -u $INDEXER_BUILDER >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$INDEXER_BUILDER --shell /usr/sbin/nologin $INDEXER_BUILDER
    mkdir -p $INDEXER_DIR $INDEXER_RELEASES
    chown $INDEXER_BUILDER:$INDEXER_BUILDER $INDEXER_DIR $INDEXER_RELEASES

    # The site's settings and secrets go into $SITE_ENV (root's, mode 600); no file of the checkout holds one.
    [ -f $SITE_ENV ] || install -m 600 -o root -g root /dev/null $SITE_ENV
    chmod 600 $SITE_ENV
    # Settings the units leave to this file, a value already set kept: the cabinet's requests to QNet Wallet start off
    # until app builds that answer them are installed (src/server/phone-flows.ts); /wallet offers no Android file until
    # one is named (src/server/wallet-apk.ts).
    grep -q '^CABINET_PHONE_FLOWS=' $SITE_ENV || echo 'CABINET_PHONE_FLOWS=0' >> $SITE_ENV
    grep -q '^WALLET_APK_URL=' $SITE_ENV || echo 'WALLET_APK_URL=' >> $SITE_ENV

    [ -f $INDEXER_ENV ] || install -m 600 -o root -g root /dev/null $INDEXER_ENV
    chmod 600 $INDEXER_ENV

    # Each service needs its database before anything is built: an indexer release without one would not start.
    for f in $SITE_ENV $INDEXER_ENV; do
        if ! grep -q '^DATABASE_URL=' \$f; then
            echo \"DATABASE_URL is not set in \$f: set it there ($SITE_ENV takes the DATABASE_URL of the role explorer_reader, $INDEXER_ENV the indexer's writer), then run deploy-aiqnet.sh 2 3 4 5 again. Nothing was built or switched.\" >&2
            exit 1
        fi
    done

    # The one path that builds, installs the units of, switches and restarts both services: the end of every deploy, and
    # every update. A unit goes in only once the release it names is built, so a host that runs either service another
    # way runs it on until then.
    echo 'Creating update script...'
    cat > /root/update-aiqnet.sh << 'EOF'
#!/bin/bash
set -eo pipefail
# Builds a release of the site, and of the indexer when its inputs changed, each in a folder of its own, then switches
# the services to them, so no build writes a file a running service reads. rollback puts the site's previous release
# back, rollback-indexer the indexer's.
case \"\${1:-}\" in
    ''|rollback|rollback-indexer) ;;
    *) echo \"Usage: \$0 [rollback|rollback-indexer]\" >&2; exit 2 ;;
esac
# One update or rollback at a time: another would build into, switch or remove this one's releases.
exec 9> /run/update-aiqnet.lock
flock -n 9 || { echo 'Another update or rollback of aiqnet.io is running: nothing was changed.' >&2; exit 1; }
# The release a link of a releases folder names, read as the folder's owner; empty when there is none.
link() { sudo -u \"\$1\" -H readlink \"\$2\" 2>/dev/null || true; }
# Points current, and previous (none when empty), of a releases folder at the releases named, as the folder's owner:
# each link changes in one rename, so a start of the service meets one release or the other, never none.
point() {
    sudo -u \"\$1\" -H bash -c '
        set -e
        cd \"\$1\"
        ln -sfn \"\$2\" .current
        mv -T .current current
        if [ -n \"\$3\" ]; then ln -sfn \"\$3\" .previous; mv -T .previous previous; else rm -f previous; fi
    ' _ \"\$2\" \"\$3\" \"\${4:-}\"
}
# Puts current and previous of a releases folder back where this update found them (\$3, \$4); true when current named a
# release then, else (a first release) both links go.
point_back() {
    if [ -n \"\$3\" ]; then
        point \"\$1\" \"\$2\" \"\$3\" \"\$4\"
        return 0
    fi
    sudo -u \"\$1\" -H rm -f \"\$2/current\" \"\$2/previous\"
    return 1
}
# Removes each release of a releases folder that is neither current nor previous, as the folder's owner; a link that
# names its release by full path keeps it too.
prune() {
    sudo -u \"\$1\" -H bash -c '
        cd \"\$1\" || exit 0
        keep=\" \$(basename \"\$(readlink current 2>/dev/null)\") \$(basename \"\$(readlink previous 2>/dev/null)\") \"
        for r in *; do
            if [ -d \"\$r\" ] && [ ! -L \"\$r\" ] && [[ \"\$keep\" != *\" \$r \"* ]]; then rm -rf -- \"\$r\"; fi
        done
    ' _ \"\$2\"
}
# Puts the unit this update wrote for a service (\$1.new) in place of the one there when they differ, that one kept as
# \$1.previous until the next update, and loads it; an unchanged unit stays and leaves no .previous behind.
unit_in() {
    if cmp -s $UNIT_DIR/\$1.new $UNIT_DIR/\$1; then
        rm -f $UNIT_DIR/\$1.new $UNIT_DIR/\$1.previous
        return 0
    fi
    if [ -f $UNIT_DIR/\$1 ]; then cp -p $UNIT_DIR/\$1 $UNIT_DIR/\$1.previous; else rm -f $UNIT_DIR/\$1.previous; fi
    mv $UNIT_DIR/\$1.new $UNIT_DIR/\$1
    systemctl daemon-reload
    systemctl enable --no-reload \$1
}
# Puts back, loaded, the unit unit_in replaced for a service; true when there was one.
unit_back() {
    [ -f $UNIT_DIR/\$1.previous ] || return 1
    mv $UNIT_DIR/\$1.previous $UNIT_DIR/\$1
    systemctl daemon-reload
}
# Whether the site serves aiqnet.io's home page on 127.0.0.1:3000: asked SITE_START_S / 5 times, each ask waiting at most
# 4 s and followed by 5 s, so a port still closed (refused at once) is given SITE_START_S in all.
site_answers() {
    for _ in \$(seq \$(( $SITE_START_S / 5 ))); do
        curl -fs -o /dev/null --max-time 4 -H 'Host: $DOMAIN_NAME' http://127.0.0.1:3000/ && return 0
        sleep 5
    done
    return 1
}
if [ -n \"\${1:-}\" ]; then
    if [ \"\$1\" = rollback ]; then
        OWNER=$APP_USER RELEASES=$SITE_RELEASES UNIT=qnet-explorer.service
    else
        OWNER=$INDEXER_BUILDER RELEASES=$INDEXER_RELEASES UNIT=qnet-indexer.service
    fi
    BACK=\$(link \$OWNER \$RELEASES/previous)
    if [ -z \"\$BACK\" ] || [ ! -d \$RELEASES/previous/ ]; then
        echo \"\$RELEASES has no previous release: nothing was changed.\" >&2
        exit 1
    fi
    point \$OWNER \$RELEASES \"\$BACK\" \"\$(link \$OWNER \$RELEASES/current)\"
    systemctl restart \$UNIT
    echo \"\$UNIT runs \$RELEASES/\$BACK again; the release it left is kept as previous.\"
    exit 0
fi
echo 'Updating aiqnet.io...'
# The site needs a supported Node.js line (package.json engines); an older one is never built on.
if [ \"\$(node --version | sed 's/^v//; s/\\..*//')\" -lt $NODE_MAJOR ]; then
    echo \"Node.js \$(node --version) is installed; $NODE_MAJOR or later is required. Nothing was changed.\" >&2
    exit 1
fi
# The site's checkout, fetched from the repository by its own user, never as root.
sudo -u $APP_USER -H bash -c '
    set -e
    cd $APP_DIR
    if [ -d .git ]; then git fetch origin $APP_BRANCH; git checkout $APP_BRANCH; git pull --ff-only origin $APP_BRANCH; else git clone --branch $APP_BRANCH $GITHUB_REPO .; fi
'
# next build and next start also read .env files of the site's folder, which would fill each key $SITE_ENV lacks without
# a sign, and the build user reads every file of the checkout: the site's settings live only in $SITE_ENV.
for f in $FRONTEND_DIR/.env*; do
    if [ -e \"\$f\" ]; then
        echo \"\$f exists: move each setting it holds into $SITE_ENV (DATABASE_URL of the role explorer_reader, the CABINET_READ_KEY and FAUCET_PASS_KEY in use), delete it and run again. Nothing was built or switched.\" >&2
        exit 1
    fi
done
# One fingerprint of what a checkout's commit holds of the given paths, read by the user that owns the checkout.
inputs() { local user=\$1 dir=\$2; shift 2; sudo -u \"\$user\" -H git -C \"\$dir\" ls-tree HEAD -- \"\$@\" | sha256sum | cut -c1-64; }
SITE_INPUTS=\$(inputs $APP_USER $APP_DIR $INDEXER_INPUTS)
# This update's releases are named by the time and the site's commit, the indexer's (when one is built) alike.
RELEASE=\$(date -u +%Y%m%dT%H%M%SZ)-\$(sudo -u $APP_USER -H git -C $APP_DIR rev-parse --short=12 HEAD)
INDEXER_RELEASE=
INSTALL_INPUTS=
REUSE=
# The indexer's checkout is fetched and a release of it built only when the site's commit holds other indexer inputs
# than the running release was built from: an update of the site alone fetches, installs and builds nothing of it.
if [ \"\$(sudo -u $INDEXER_BUILDER -H cat $INDEXER_BUILT 2>/dev/null)\" != \"\$SITE_INPUTS\" ]; then
    sudo -u $INDEXER_BUILDER -H bash -c '
        set -e
        cd $INDEXER_DIR
        # The tip of the branch, shallow, with the contents of the indexer inputs only: no other file is fetched or
        # checked out.
        [ -d .git ] || git clone --depth 1 --filter=blob:none --no-checkout --branch $APP_BRANCH $GITHUB_REPO .
        git config core.sparseCheckout true
        printf \"/%s\\n\" $INDEXER_INPUTS > .git/info/sparse-checkout
        git fetch --depth 1 origin $APP_BRANCH
        git checkout -q --detach FETCH_HEAD
        git read-tree -mu HEAD
    '
    # Both trees serve one commit's indexer: the inputs the release builds are the site commit's.
    TREE_INPUTS=\$(inputs $INDEXER_BUILDER $INDEXER_DIR $INDEXER_INPUTS)
    if [ \"\$TREE_INPUTS\" != \"\$SITE_INPUTS\" ]; then
        echo \"$APP_BRANCH changed the indexer's inputs between the two fetches (site \$SITE_INPUTS, indexer \$TREE_INPUTS): run again. Nothing was built or switched.\" >&2
        exit 1
    fi
    INDEXER_RELEASE=\$RELEASE
    # The install runs again only when what it reads changed; otherwise the new release links in the running release's
    # packages, which nothing writes after their install: no install script runs there, and the build writes only
    # dist-indexer.
    INSTALL_INPUTS=\$(inputs $INDEXER_BUILDER $INDEXER_DIR $INDEXER_INSTALL_INPUTS)
    RUNNING=\$(link $INDEXER_BUILDER $INDEXER_CURRENT)
    if [ -n \"\$RUNNING\" ] && [ \"\$(sudo -u $INDEXER_BUILDER -H cat $INDEXER_INSTALLED 2>/dev/null)\" = \"\$INSTALL_INPUTS\" ]; then
        REUSE=$INDEXER_RELEASES/\$RUNNING
    fi
fi
# Releases an earlier update built without switching to them go first; then the disk must hold every build of this
# update with FREE_RESERVE_MB to spare, or nothing is built.
prune $APP_USER $SITE_RELEASES
prune $INDEXER_BUILDER $INDEXER_RELEASES
size() { local kib; kib=\$(sudo -u \"\$1\" -H du -sk \"\$2/\" 2>/dev/null | cut -f1) || kib=; echo \"\${kib:-\$(($RELEASE_SPACE_MB * 1024))}\"; }
NEED_KIB=\$(( \$(size $APP_USER $SITE_CURRENT) + $FREE_RESERVE_MB * 1024 ))
if [ -n \"\$INDEXER_RELEASE\" ]; then NEED_KIB=\$(( NEED_KIB + \$(size $INDEXER_BUILDER $INDEXER_CURRENT) )); fi
for DIR in $SITE_RELEASES \${INDEXER_RELEASE:+$INDEXER_RELEASES}; do
    FREE_KIB=\$(df -Pk \$DIR | awk 'NR == 2 {print \$4}')
    if [ \"\$FREE_KIB\" -lt \"\$NEED_KIB\" ]; then
        echo \"The disk of \$DIR has \$((FREE_KIB / 1024)) MB free; this update needs \$((NEED_KIB / 1024)) MB, $FREE_RESERVE_MB MB of them left free for the database and the logs. Free space on it and run again. Nothing was built or switched.\" >&2
        exit 1
    fi
done
# The site's release: the commit's applications/qnet-explorer exported into a new folder, installed and built there by
# its own user while the site runs on from the release before; its data/ is the checkpoints' folder.
sudo -u $APP_USER -H bash -c '
    set -eo pipefail
    install -d -m 700 $SITE_DATA
    mkdir \"\$1\"
    git -C $APP_DIR archive HEAD applications/qnet-explorer | tar -x -C \"\$1\"
    cd \"\$1/applications/qnet-explorer/frontend\"
    ln -s $SITE_DATA data
    # Every package the lockfile installs pins its tarball (sha512), so npm ci takes no other bytes.
    node scripts/lockfile-check.mjs
    npm ci
    npm run build
' _ $SITE_RELEASES/\$RELEASE
if [ -n \"\$INDEXER_RELEASE\" ]; then
    sudo -u $INDEXER_BUILDER -H bash -c '
        set -eo pipefail
        mkdir \"\$1\"
        git -C $INDEXER_DIR archive HEAD -- $INDEXER_INPUTS | tar -x -C \"\$1\"
        cd \"\$1/applications/qnet-explorer/frontend\"
        if [ -n \"\$2\" ]; then
            cp -al \"\$2/applications/qnet-explorer/node_modules\" ..
            if [ -d \"\$2/applications/qnet-explorer/frontend/node_modules\" ]; then cp -al \"\$2/applications/qnet-explorer/frontend/node_modules\" .; fi
        else
            # No install script runs in this tree, and no optional package (native addons, binaries of the site build tools).
            export npm_config_ignore_scripts=true npm_config_omit=optional
            node scripts/lockfile-check.mjs
            npm ci
        fi
        npm run build:indexer
        # What it was installed and built from, for the updates after it, written once its build is done.
        echo \"\$3\" > \"\$1/.installed-inputs\"
        echo \"\$4\" > \"\$1/.built-inputs\"
    ' _ $INDEXER_RELEASES/\$INDEXER_RELEASE \"\$REUSE\" \"\$INSTALL_INPUTS\" \"\$SITE_INPUTS\"
fi
# The keys of the faucet passes the node cabinet gives (src/server/faucet-pass.ts) and of the node pages' read passes
# (src/server/cabinet/solana-proxy.ts), each made once and kept, so that a pass outlives every restart of the site.
grep -Eq '^FAUCET_PASS_KEY=[0-9a-f]{64}\$' $SITE_ENV || { sed -i '/^FAUCET_PASS_KEY=/d' $SITE_ENV; echo FAUCET_PASS_KEY=\$(openssl rand -hex 32) >> $SITE_ENV; }
grep -Eq '^CABINET_READ_KEY=[0-9a-f]{64}\$' $SITE_ENV || { sed -i '/^CABINET_READ_KEY=/d' $SITE_ENV; echo CABINET_READ_KEY=\$(openssl rand -hex 32) >> $SITE_ENV; }
# Without SOLANA_RPC_URL every visitor of the node pages shares the public endpoint's few requests a second
# (src/server/solana-endpoint.ts).
grep -q '^SOLANA_RPC_URL=https://' $SITE_ENV || echo 'SOLANA_RPC_URL is not set in $SITE_ENV: the node pages share the public Solana endpoint.' >&2
# The indexer first: its restart returns once its unit has committed the migrations the new site reads, while the site
# runs on from its own release. A new indexer release, or unit, that does not start gives way to what ran before, and the
# update ends there with the site not switched.
OLD=\$(link $INDEXER_BUILDER $INDEXER_CURRENT)
OLD_PREVIOUS=\$(link $INDEXER_BUILDER $INDEXER_RELEASES/previous)
SITE_OLD=\$(link $APP_USER $SITE_CURRENT)
SITE_OLD_PREVIOUS=\$(link $APP_USER $SITE_RELEASES/previous)
if [ -n \"\$INDEXER_RELEASE\" ]; then point $INDEXER_BUILDER $INDEXER_RELEASES \$INDEXER_RELEASE \"\$OLD\"; fi
# Two services, each a process systemd supervises and restarts, logging to the journal, its unit put in once current
# names a built release. Per-IP limits key on X-Real-IP, which nginx sets to the connecting address on every location.
cat > $UNIT_DIR/qnet-indexer.service.new << 'UNIT'
[Unit]
Description=QNet Explorer Indexer
# After the database and before the site, which reads the tables its migrations make.
After=network-online.target postgresql.service
Before=qnet-explorer.service
Wants=network-online.target

[Service]
Type=exec
# A user of its own, made by systemd for each run: the site's user cannot read the writer's DATABASE_URL from this
# process's environment. It runs the release $INDEXER_BUILDER builds and writes no file, so it can change none of it.
DynamicUser=yes
# The release current names, resolved at each start, as for the site.
WorkingDirectory=$INDEXER_FRONTEND
Environment=NODE_ENV=production
EnvironmentFile=$INDEXER_ENV
# The migrations first, under the writer lock: the unit counts as started, and the site after it, only once they are
# committed. No start timeout: systemd would stop a long migration midway, and every attempt would roll it back.
ExecStartPre=/usr/bin/node $INDEXER_FRONTEND/dist-indexer/main.js --migrate-only
TimeoutStartSec=infinity
ExecStart=/usr/bin/node $INDEXER_FRONTEND/dist-indexer/main.js
Restart=always
RestartSec=10
Nice=5
# The explorer's only database writer.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
unit_in qnet-indexer.service
if ! systemctl restart qnet-indexer.service; then
    # What ran before comes back: the release before it (a first release leaves none) and the unit this update replaced.
    BACK=
    if [ -n \"\$INDEXER_RELEASE\" ] && point_back $INDEXER_BUILDER $INDEXER_RELEASES \"\$OLD\" \"\$OLD_PREVIOUS\"; then BACK=\$OLD; fi
    if unit_back qnet-indexer.service; then BACK=\${BACK:-the indexer as it ran before}; fi
    if [ -z \"\$BACK\" ]; then
        echo 'qnet-indexer did not start (journalctl -u qnet-indexer): the site was not switched.' >&2
    elif systemctl restart qnet-indexer.service; then
        echo \"The indexer release \${INDEXER_RELEASE:-of this update} did not start (journalctl -u qnet-indexer): \$BACK runs again, and the site was not switched.\" >&2
    else
        echo \"Neither the indexer of this update nor \$BACK started (journalctl -u qnet-indexer); the site was not switched.\" >&2
    fi
    exit 1
fi
point $APP_USER $SITE_RELEASES \$RELEASE \"\$SITE_OLD\"
cat > $UNIT_DIR/qnet-explorer.service.new << 'UNIT'
[Unit]
Description=QNet Explorer Frontend
After=network.target postgresql.service

[Service]
Type=exec
User=$APP_USER
# The release current names, resolved at each start: an update switches current, then restarts the service.
WorkingDirectory=$SITE_FRONTEND
# package.json 'start' run by node itself, so systemd supervises the server process: 127.0.0.1, port 3000, which only
# nginx on this host reaches.
ExecStart=/usr/bin/node $SITE_CURRENT/applications/qnet-explorer/node_modules/next/dist/bin/next start -H 127.0.0.1
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=30
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=512
Environment=NEXT_TELEMETRY_DISABLED=1
# The site's settings and secrets, read by systemd before it starts the process as $APP_USER.
EnvironmentFile=$SITE_ENV
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
# Other users' processes, the command lines of root's included, stay out of its view.
ProtectProc=invisible
# The only paths it writes: its release's build cache and the balance check's checkpoints.
ReadWritePaths=$SITE_FRONTEND/.next $SITE_DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
unit_in qnet-explorer.service
# Type=exec returns once node runs, not once the site answers: the release counts as started when it serves the home
# page. One that does not gives way to what ran before (the release before it, or on a first release the unit this
# update replaced), and nothing is removed.
set +e
systemctl restart qnet-explorer.service
set -e
if ! site_answers; then
    BACK=
    if point_back $APP_USER $SITE_RELEASES \"\$SITE_OLD\" \"\$SITE_OLD_PREVIOUS\"; then BACK=\$SITE_OLD; fi
    if unit_back qnet-explorer.service; then BACK=\${BACK:-the site as it ran before}; fi
    if [ -n \"\$BACK\" ] && systemctl restart qnet-explorer.service; then
        echo \"The site release \$RELEASE did not answer on 127.0.0.1:3000 within $SITE_START_S s (journalctl -u qnet-explorer): \$BACK runs again, and no release was removed.\" >&2
    else
        echo \"The site release \$RELEASE did not answer on 127.0.0.1:3000 within $SITE_START_S s (journalctl -u qnet-explorer), and nothing that ran before it is left to run.\" >&2
    fi
    exit 1
fi
# Each folder keeps the release that runs and the one before it, for a rollback.
prune $APP_USER $SITE_RELEASES
prune $INDEXER_BUILDER $INDEXER_RELEASES
echo \"aiqnet.io runs $SITE_RELEASES/\$RELEASE and the indexer $INDEXER_RELEASES/\$(link $INDEXER_BUILDER $INDEXER_CURRENT).\"
EOF
    chmod +x /root/update-aiqnet.sh

    # On a host that already runs both services as on a new one: the new releases and units take effect now.
    /root/update-aiqnet.sh

    echo 'QNet Explorer deployed successfully'
"
fi

if runs 3; then
echo -e "${YELLOW}Step 3: Configure Nginx${NC}"
run_remote "
    set -e
    echo 'Configuring Nginx for aiqnet.io...'
    # The file nginx runs now, kept until the new one passes nginx -t.
    if [ -f /etc/nginx/sites-available/$DOMAIN_NAME ]; then
        cp -p /etc/nginx/sites-available/$DOMAIN_NAME /etc/nginx/sites-available/$DOMAIN_NAME.previous
    fi
    cat > /etc/nginx/sites-available/$DOMAIN_NAME << 'EOF'
# Rate-limit zone for /api. limit_req_zone is valid only in the http context: this file is included
# inside http {}, so the zone is declared here, outside the server blocks. Its own name: a zone 'api' may
# already be declared in conf.d on the host, and nginx refuses a zone declared twice. This file is the only
# nginx site of aiqnet.io: scripts/security_hardening.sh sets http-level options only, and refuses to run
# over a site file without the relay's rules below.
limit_req_zone \$binary_remote_addr zone=aiqnet_api:10m rate=10r/s;
# The QNet Link relay's own zone: explorer /api traffic, which any page can send from a visitor's browser
# (an <img> or a script needs no permission), never uses up the relay's budget.
limit_req_zone \$binary_remote_addr zone=aiqnet_link:10m rate=10r/s;
# The node cabinet's own zone (/api/cabinet/), for the same reason.
limit_req_zone \$binary_remote_addr zone=aiqnet_cabinet:10m rate=10r/s;
# Fetch Metadata: 1 for a browser request that no page of this origin made (Sec-Fetch-Site cross-site,
# same-site or none). The header is absent from the app's requests and from browsers that do not send it.
map \$http_sec_fetch_site \$aiqnet_cross_fetch {
    default 1;
    '' 0;
    same-origin 0;
}
# The activation routes and the wallets' Solana relay also take the QNet extension's own requests, which carry
# Sec-Fetch-Site none: the rule of src/server/request-guard.ts activationOriginAllowed, so nginx never refuses what the
# app accepts.
map \$http_sec_fetch_site \$aiqnet_activation_cross_fetch {
    default 1;
    '' 0;
    same-origin 0;
    none 0;
}
# One second of the explorer's most read public answers, shared by every visitor (see aiqnet.io below).
proxy_cache_path /var/cache/nginx/explorer_hot levels=1:2 keys_zone=explorer_hot:10m max_size=100m inactive=60s use_temp_path=off;
# The bare root of explorer.aiqnet.io, the explorer's former host, leads to the explorer, over http and https; of
# aiqnet.io and www.aiqnet.io, home.
map \$host \$aiqnet_old_root {
    default /;
    explorer.aiqnet.io /explorer;
}

# The site has one origin, https://aiqnet.io (src/lib/hosts.ts): the relay's and the faucet's Origin
# check, the extension's activation origin and the app's relay base all name it. www.aiqnet.io and
# explorer.aiqnet.io (old links) only redirect there, and so does the app itself for any other Host.
server {
    listen 80;
    server_name aiqnet.io www.aiqnet.io explorer.aiqnet.io;

    location = / {
        return 301 https://aiqnet.io\$aiqnet_old_root\$is_args\$args;
    }

    location / {
        return 301 https://aiqnet.io\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name aiqnet.io;

    # Self-signed in every TLS block until the Let's Encrypt certificate exists; from then on the script names its paths.
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    # TLS 1.2 and 1.3 only, in every TLS block: the distribution's nginx.conf still lists 1.0 and 1.1.
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;

    # Security headers come from the app, not from nginx: next.config.js sends X-Frame-Options,
    # X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy and HSTS,
    # and src/proxy.ts sends each page's Content-Security-Policy with a fresh script nonce. nginx
    # adds none of them: a second Content-Security-Policy would be enforced alongside the app's, and a
    # second copy of the others with a different value would conflict with it.

    # Proxy to Next.js application
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Build assets: Next.js itself sends Cache-Control: public, max-age=31536000, immutable for them.
    # Exactly the /_next/static/ directory (a path like /_next/staticx goes to 'location /'). Host and
    # X-Real-IP here too, as in every location: without Host nginx sends its upstream name, 127.0.0.1:3000,
    # which the app would take for a local run; a client's own X-Real-IP never passes.
    location ^~ /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # The head event stream (src/app/api/stream/route.ts): unbuffered and open for up to an hour; each connection is one
    # request of the /api budget.
    location = /api/stream {
        limit_req zone=aiqnet_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    # The faucet's claim route answers within FAUCET_CLAIM_MS and the page waits FAUCET_CLAIM_REQUEST_MS
    # (src/lib/faucet-handover.ts): nginx waits between the two, so a slow claim still reaches the page as the app's answer.
    location = /api/faucet/claim {
        limit_req zone=aiqnet_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 142s;
    }

    # The explorer's most read public answers, the same for every visitor: a crowd on the live pages costs the app one
    # request a second for each; a waiting request takes the one in flight.
    location ~ ^/api/(activity|head|network/stats)\$ {
        limit_req zone=aiqnet_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache explorer_hot;
        proxy_cache_key \$scheme\$host\$request_uri;
        proxy_cache_valid 200 1s;
        proxy_cache_lock on;
        proxy_cache_use_stale updating error timeout;
        proxy_ignore_headers Set-Cookie;
        add_header X-Cache \$upstream_cache_status;
    }

    # API routes with rate limiting
    location /api {
        limit_req zone=aiqnet_api burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The QNet Link relay (docs/protocols/qnet-link-v1.md section 5). Its URLs carry the session id, and
    # a session's requests come from the computer (polls) and the phone (the app): an access log would
    # pair the two addresses under one id. So nothing of it is logged, and only critical errors (the
    # 'error' level names the client and the request line). A browser request that another page, another
    # host or a typed address made (Fetch Metadata Sec-Fetch-Site other than same-origin) is refused here,
    # in the rewrite phase, before limit_req counts it; the app sends no such header, and the site's own
    # pages send same-origin. src/server/request-guard.ts refuses the same in the app.
    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_link burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The node cabinet's routes (src/server/cabinet): their paths and bodies name nodes, wallets and payment
    # addresses, so nothing of them is logged either, and only critical errors. Only the site's own pages call
    # them: another page's request is refused before the cabinet's zone counts it, as for the relay.
    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_cabinet burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # The activation routes, which the QNet extension calls too: the same as the cabinet's, with the extension's
    # Sec-Fetch-Site none let through (the map above).
    location ^~ /api/cabinet/activation/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_activation_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_cabinet burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # QNet Wallet's and the QNet extension's Solana calls when the Solana endpoint gives them no answer
    # (src/server/cabinet/solana-relay.ts): the extension's requests carry Sec-Fetch-Site none (the map above).
    location = /api/cabinet/solana {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        if (\$aiqnet_activation_cross_fetch) {
            return 403;
        }
        limit_req zone=aiqnet_cabinet burst=20 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Health check
    location /health {
        access_log off;
        default_type text/plain;
        return 200 \"QNet Explorer is running\";
    }
}

# The other names of the site redirect to https://aiqnet.io, path and query kept, and reach no proxy: no
# second origin of the site, and no location here that could hand the app a client's own X-Real-IP. A
# relay or cabinet path is not logged here either, as on aiqnet.io.
server {
    listen 443 ssl http2;
    server_name www.aiqnet.io explorer.aiqnet.io;

    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;

    location = / {
        return 308 https://aiqnet.io\$aiqnet_old_root\$is_args\$args;
    }

    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location / {
        return 308 https://aiqnet.io\$request_uri;
    }
}

# QNet Link host (docs/protocols/qnet-link-v1.md sections 4 and 15): the links the site hands to the QNet app live
# on a host of their own, so a browser never keeps them as a same-host navigation. The same Next.js app
# answers here: src/proxy.ts serves the link pages /l and /send and the /.well-known app-association files and
# redirects every other path to aiqnet.io. Same proxy headers as aiqnet.io, no headers of nginx's own (no second CSP).
server {
    listen 80;
    server_name link.aiqnet.io;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name link.aiqnet.io;

    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # The link page's build assets: exactly /_next/static/, with this host's name (see aiqnet.io above).
    location ^~ /_next/static/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # The relay and the cabinet answer only on aiqnet.io (the app redirects these paths there); not logged here
    # either.
    location ^~ /api/link/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }

    location ^~ /api/cabinet/ {
        access_log off;
        error_log /var/log/nginx/error.log crit;
        return 308 https://aiqnet.io\$request_uri;
    }
}
EOF

    echo 'Enabling site...'
    # The one-second cache's parent directory; nginx makes explorer_hot inside it.
    mkdir -p /var/cache/nginx
    ln -sf /etc/nginx/sites-available/$DOMAIN_NAME /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default
    # A host that already has the certificate keeps serving it: no name falls back to the self-signed one while step 4
    # waits for the operator.
    if [ -f $LE_LIVE/fullchain.pem ]; then
        sed -i '$CERT_PATHS' /etc/nginx/sites-available/$DOMAIN_NAME
    fi

    echo 'Testing Nginx configuration...'
    $NGINX_TEST

    echo 'Restarting Nginx...'
    systemctl restart nginx
    systemctl enable nginx

    echo 'Nginx configured successfully'
"
fi

if runs 4; then
echo -e "${YELLOW}Step 4: Setup SSL Certificate${NC}"
echo -e "${BLUE}Make sure DNS is propagated: aiqnet.io, www.aiqnet.io, explorer.aiqnet.io and link.aiqnet.io resolve to $SERVER_IP, and none of them has an IPv6 address (AAAA)${NC}"
echo -e "${BLUE}Check with: nslookup aiqnet.io; nslookup www.aiqnet.io; nslookup explorer.aiqnet.io; nslookup link.aiqnet.io${NC}"
read -p "Press Enter when DNS is ready..."

# One certificate, named aiqnet.io, for the four names. certonly: certbot proves the names through nginx and never
# edits the site file, which then names the certificate's own paths; the certbot package's timer renews it and the
# deploy hook reloads nginx with each renewed certificate.
run_remote "
    set -e
    # Each name must resolve, in DNS as the certificate authority reads it, to this server only: every IPv4 address to
    # SERVER_IP, and no IPv6 address at all, since every block of the site file listens on IPv4 only and a challenge also
    # goes to an AAAA address. Any other fails certbot --non-interactive and the self-signed certificate stays.
    command -v dig > /dev/null || { echo 'dig is missing: apt install bind9-dnsutils, then run again.' >&2; exit 1; }
    for HOST_NAME in $SITE_NAMES; do
        RESOLVED_V4=\$(dig +short A \$HOST_NAME | grep -E '^[0-9.]+\$' | sort -u | tr '\n' ' ' | sed 's/ \$//')
        if [ \"\$RESOLVED_V4\" != $SERVER_IP ]; then
            echo \"\$HOST_NAME resolves to '\${RESOLVED_V4:-nothing}' over IPv4, expected $SERVER_IP only. Fix DNS and run again.\" >&2
            exit 1
        fi
        RESOLVED_V6=\$(dig +short AAAA \$HOST_NAME | grep -E '^[0-9A-Fa-f:.]+\$' | grep ':' | sort -u | tr '\n' ' ' | sed 's/ \$//')
        if [ -n \"\$RESOLVED_V6\" ]; then
            echo \"\$HOST_NAME resolves to \$RESOLVED_V6 over IPv6, but the site listens on IPv4 only. Remove the AAAA record and run again.\" >&2
            exit 1
        fi
    done
    echo 'Obtaining the certificate for aiqnet.io, www.aiqnet.io, explorer.aiqnet.io and link.aiqnet.io...'
    certbot certonly --nginx --cert-name aiqnet.io -d aiqnet.io -d www.aiqnet.io -d explorer.aiqnet.io -d link.aiqnet.io --non-interactive --agree-tos --email admin@aiqnet.io --deploy-hook 'systemctl reload nginx'
    sed -i.previous '$CERT_PATHS' /etc/nginx/sites-available/$DOMAIN_NAME
    $NGINX_TEST
    systemctl reload nginx

    echo 'SSL certificate installed'
"
fi

if runs 5; then
echo -e "${YELLOW}Step 5: Setup Monitoring${NC}"
run_remote "
    echo 'Installing monitoring tools...'
    apt install -y netdata

    echo 'Configuring netdata...'
    systemctl enable netdata
    systemctl start netdata

    # The site's and the indexer's output goes to the journal (journalctl -u qnet-explorer, -u qnet-indexer), which
    # keeps at most 300 MB.
    echo 'Capping the journal...'
    mkdir -p /etc/systemd/journald.conf.d
    printf '[Journal]\nSystemMaxUse=300M\n' > /etc/systemd/journald.conf.d/qnet.conf
    systemctl restart systemd-journald

    echo 'Monitoring setup completed'
"
fi

echo -e "${GREEN}Steps $STEPS completed${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "${BLUE}QNet Deployment Summary:${NC}"
echo -e "• Website: ${GREEN}https://$DOMAIN_NAME${NC}"
echo -e "• Server IP: ${GREEN}$SERVER_IP${NC}"
echo -e "• Monitoring (netdata on the host, closed to the outside by the firewall): ${YELLOW}ssh -p $SSH_PORT -L 19999:127.0.0.1:19999 $SSH_USER@$SERVER_IP${NC}, then ${GREEN}http://127.0.0.1:19999${NC}"
echo ""
echo -e "${BLUE}Management Commands:${NC}"
echo -e "• View logs: ${YELLOW}ssh -p $SSH_PORT $SSH_USER@$SERVER_IP 'journalctl -u qnet-explorer -u qnet-indexer -f'${NC}"
echo -e "• Update: ${YELLOW}ssh -p $SSH_PORT $SSH_USER@$SERVER_IP '/root/update-aiqnet.sh'${NC}"
echo -e "• Roll the site back to its previous release: ${YELLOW}ssh -p $SSH_PORT $SSH_USER@$SERVER_IP '/root/update-aiqnet.sh rollback'${NC}"
echo -e "• Status: ${YELLOW}ssh -p $SSH_PORT $SSH_USER@$SERVER_IP '/root/status-aiqnet.sh'${NC}"
echo -e "• Restart: ${YELLOW}ssh -p $SSH_PORT $SSH_USER@$SERVER_IP 'systemctl restart qnet-explorer'${NC}"
echo ""
# The closing figures are the host's own, measured now by the status script, which every run writes first, so it is
# this script's version whatever steps ran.
echo -e "${BLUE}Measured on the host:${NC}"
run_remote "
    cat > /root/status-aiqnet.sh << 'EOF'
#!/bin/bash
# Only what the host measures as it runs: load, memory and disk, both services (their memory among them), the site's
# answer, the indexer's published state and the certificate.
echo 'QNet Status Report'
echo '=================='
echo \"CPU Usage: \$(top -bn1 | grep \"Cpu(s)\" | awk '{print \$2}' | awk -F'%' '{print \$1}')%\"
echo \"Memory Usage: \$(free | grep Mem | awk '{printf \"%.1f%%\", \$3/\$2 * 100.0}')\"
echo \"Disk Usage: \$(df -h / | awk 'NR==2{printf \"%s\", \$5}')\"
echo ''
systemctl --no-pager status qnet-explorer.service qnet-indexer.service
echo ''
echo \"https://$DOMAIN_NAME answers: \$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$DOMAIN_NAME)\"
echo \"Indexer: \$(curl -s --max-time 10 https://$DOMAIN_NAME/api/sync/start)\"
echo \"Certificate: \$(openssl x509 -enddate -noout -in $LE_LIVE/fullchain.pem 2>/dev/null || echo none), renewal timer \$(systemctl is-active certbot.timer)\"
EOF
    chmod +x /root/status-aiqnet.sh
    /root/status-aiqnet.sh
"
