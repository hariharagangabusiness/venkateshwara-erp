#!/usr/bin/env bash
# Pulls the latest code and restarts the service. Run as: sudo bash redeploy.sh
# (or as the erp user for the git/npm steps, then sudo systemctl restart erp).
set -euo pipefail
APP_DIR="/opt/venkateshwara-erp"

cd "$APP_DIR"
sudo -u erp git pull
sudo -u erp npm install --omit=dev
systemctl restart erp
systemctl status erp --no-pager -l | head -20
