#!/usr/bin/env bash
# Run on the production server by .github/workflows/deploy.yml over SSH on
# every push to main. Can also be run by hand for a manual deploy - just
# `bash deploy.sh` from anywhere (it cd's to its own location first).
#
# Whoever sets this up needs to do exactly one thing before it works:
# uncomment ONE of the three restart blocks below, matching however this
# app is actually kept running today (pm2 / systemd / a plain background
# node process) - everything above that point works the same regardless.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Pulling latest main..."
git fetch origin main
git reset --hard origin/main

echo "==> Installing dependencies..."
npm install --omit=dev

# ---- Restart the app: uncomment exactly ONE of the three blocks below ----

# Option A: pm2 (recommended if you don't already have something else -
# survives reboots with `pm2 startup` + `pm2 save`, auto-restarts on crash)
#   First-time setup, once: pm2 start server.js --name venkateshwara-erp && pm2 save
# pm2 restart venkateshwara-erp

# Option B: systemd (if a unit file already exists, e.g.
# /etc/systemd/system/venkateshwara-erp.service)
# sudo systemctl restart venkateshwara-erp

# Option C: plain background process, no process manager (fragile - the
# app won't restart itself if it crashes, and this kills ANY node process
# matching "server.js" on the box, so don't use this if other node apps
# run on the same server)
# pkill -f "node server.js" || true
# sleep 1
# nohup node server.js > /var/log/venkateshwara-erp.log 2>&1 &
# disown

echo "==> Deploy finished. If nothing above restarted the app, edit deploy.sh and uncomment one restart option."
