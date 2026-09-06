#!/usr/bin/env bash
# Build the demo-mode UI and publish it to Cloudflare Pages.
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… tools/preview/deploy-pages.sh [project] [branch]
# The token needs "Cloudflare Pages: Edit". The first run creates the project; every run
# prints the deployment URL (branch deployments get their own *.pages.dev alias).
set -euo pipefail
cd "$(dirname "$0")/../.."
PROJECT="${1:-tripmaker-preview}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')}"
node tools/preview/build.js
npx --yes wrangler@4 pages project list 2>/dev/null | grep -q "^│ $PROJECT " \
  || npx --yes wrangler@4 pages project create "$PROJECT" --production-branch main
npx --yes wrangler@4 pages deploy dist/pages --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true
