#!/usr/bin/env bash
# Polls for new commits on main and deploys them automatically - meant to run
# via root's crontab every few minutes (see the crontab line in this repo's
# README/Oracle Cloud deployment notes). Only touches anything (npm install,
# restart) when there's actually a new commit, so most runs are a no-op.
#
# Runs git/npm as the erp user (which owns the checkout) via `sudo -u erp`,
# and restarts the service directly as root - no new sudoers rules needed
# since this script itself already runs as root under cron.
set -euo pipefail
APP_DIR="/opt/venkateshwara-erp"

cd "$APP_DIR"
BEFORE=$(sudo -u erp git rev-parse HEAD)
# --ff-only: if the checkout ever diverges from origin/main (should never
# happen in this workflow - all changes go through git), fail loudly here
# rather than silently creating a merge commit.
sudo -u erp git pull --ff-only -q
AFTER=$(sudo -u erp git rev-parse HEAD)

if [ "$BEFORE" != "$AFTER" ]; then
  echo "$(date -Iseconds) deploying $BEFORE -> $AFTER"
  sudo -u erp npm install --omit=dev
  systemctl restart erp
  echo "$(date -Iseconds) restarted erp"
fi
