#!/usr/bin/env bash
set -euo pipefail

APP="/var/www/wms-pro"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$APP/Backup-performance-$STAMP"

if [ ! -d "$APP/.git" ]; then
  echo "AZI git repository not found: $APP" >&2
  exit 1
fi

FILES=(
  "server/src/controllers/dashboardController.js"
  "server/src/controllers/representativeController.js"
  "client/src/pages/DashboardPage.jsx"
  "client/src/components/layout/Sidebar.jsx"
  "client/src/components/dashboard/DashboardStockDistribution.jsx"
  "client/src/routes/AppRoutes.jsx"
  "client/src/pages/WarehousePage.jsx"
)

cd "$APP"

for file in "${FILES[@]}"; do
  mkdir -p "$BACKUP/$(dirname "$file")"
  if [ -f "$APP/$file" ]; then
    cp "$APP/$file" "$BACKUP/$file"
  fi
  mkdir -p "$(dirname "$APP/$file")"
  git show "origin/main:$file" > "$APP/$file.new"
  mv "$APP/$file.new" "$APP/$file"
done

node --check "$APP/server/src/controllers/dashboardController.js"
node --check "$APP/server/src/controllers/representativeController.js"

npm --prefix "$APP/client" run build

pm2 restart azi-wms-api --update-env
sleep 5

curl -fsS "http://127.0.0.1:5000/api/health"
echo
curl -fsSI "https://azizbusiness.com" | head -n 1

echo "AZI performance deployment completed."
echo "Backup: $BACKUP"
