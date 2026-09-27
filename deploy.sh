#!/usr/bin/env bash
# Run on the production server (instance-20260924-2316) by
# .github/workflows/deploy.yml over SSH on every push to main. Can also be
# run by hand for a manual deploy: `bash /opt/venkateshwara-erp/deploy.sh`.
#
# The checkout at /opt/venkateshwara-erp is owned by the `erp` user (the
# same account systemd runs the app as - see erp.service), not by whichever
# user SSHes in to run this script - so git/npm need to act as `erp` via
# sudo rather than the caller's own account, or they'd fail to write into
# it (or worse, silently change its ownership).
set -euo pipefail
APP_DIR=/opt/venkateshwara-erp

echo "==> Pulling latest main..."
sudo -u erp git -C "$APP_DIR" fetch origin main
sudo -u erp git -C "$APP_DIR" reset --hard origin/main

echo "==> Installing dependencies..."
sudo -u erp npm --prefix "$APP_DIR" install --omit=dev

echo "==> Restarting erp.service..."
sudo systemctl restart erp

echo "==> Deploy finished."
