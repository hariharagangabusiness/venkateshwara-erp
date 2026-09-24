#!/usr/bin/env bash
# One-time setup for a fresh Oracle Cloud (or any Ubuntu 22.04/24.04) VM.
# Review this before running - it installs packages and creates a system
# user/service. Run as: sudo bash provision.sh
#
# Fill these in first:
REPO_URL="https://github.com/hariharagangabusiness/venkateshwara-erp.git"
BRANCH="main"
APP_DIR="/opt/venkateshwara-erp"
DATA_DIR="/opt/venkateshwara-erp-data"   # kept OUTSIDE the git checkout so
                                          # `git pull` never touches live data
DOMAIN=""   # e.g. erp.yourcompany.com - leave blank to skip nginx/certbot setup

set -euo pipefail

echo "== Installing Node.js 22, nginx, git, build tools =="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get update
apt-get install -y nodejs nginx git build-essential

echo "== Installing headless-Chromium's shared library dependencies =="
# Same list Railway's railpack.json installs - needed for @sparticuz/chromium
# (PDF generation: offers, challans, purchase orders, invoices, service reports).
# libasound2t64, not libasound2: Ubuntu 24.04's 64-bit time_t transition
# renamed the concrete package, leaving "libasound2" a virtual name with two
# ambiguous providers (libasound2t64 / liboss4-salsa-asound2) that apt
# refuses to auto-resolve - "has no installation candidate" otherwise.
apt-get install -y \
  fonts-liberation libappindicator3-1 libasound2t64 libatk-bridge2.0-0 \
  libatk1.0-0 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libxrandr2 \
  libxss1 libxtst6 xdg-utils

echo "== Adding swap space =="
# A safety net against OOM kills, most relevant on a small-RAM shape (e.g.
# the Always Free VM.Standard.E2.1.Micro's 1GB) - Puppeteer/headless-Chromium
# PDF generation (offers, POs, invoices, challans, service reports) commonly
# needs several hundred MB per render on top of Node/SQLite/nginx already
# running. A memory spike then hits swap and slows down rather than killing
# the process outright. Skipped if swap already exists (e.g. re-running this
# script, or a shape/image that already provisions some).
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Oracle-image firewall note =="
# Oracle's Ubuntu marketplace image ships iptables rules that allow only
# SSH (22) in by default, separate from the VCN Security List you configure
# in the OCI console - both have to allow 80/443 or the app stays
# unreachable even after the console-side rule is added. Uncomment once
# you've confirmed this is actually needed (check with: sudo iptables -L):
# iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
# iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
# netfilter-persistent save

echo "== Creating app user and directories =="
id -u erp &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin erp
mkdir -p "$DATA_DIR/uploads"
chown -R erp:erp "$DATA_DIR"

echo "== Cloning the app =="
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev

echo "== Writing .env (fill in SMTP/etc. after this runs - see .env.example) =="
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<EOF
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
DATA_DIR=$DATA_DIR
UPLOADS_DIR=$DATA_DIR/uploads
EOF
fi
chown erp:erp "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

echo "== Installing the systemd service =="
cp "$APP_DIR/deploy/oracle-cloud/erp.service" /etc/systemd/system/erp.service
sed -i "s|/opt/venkateshwara-erp|$APP_DIR|g" /etc/systemd/system/erp.service
systemctl daemon-reload
systemctl enable --now erp

if [ -n "$DOMAIN" ]; then
  echo "== Configuring nginx + HTTPS for $DOMAIN =="
  cp "$APP_DIR/deploy/oracle-cloud/nginx-erp.conf" /etc/nginx/sites-available/erp
  sed -i "s/YOUR_DOMAIN/$DOMAIN/g" /etc/nginx/sites-available/erp
  ln -sf /etc/nginx/sites-available/erp /etc/nginx/sites-enabled/erp
  nginx -t && systemctl reload nginx
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@"$DOMAIN" || \
    echo "certbot failed or needs interactive input - run manually: certbot --nginx -d $DOMAIN"
else
  echo "DOMAIN not set - skipping nginx/HTTPS. The app is reachable on port 4000 for now."
fi

echo "== Done. Check status with: systemctl status erp =="
