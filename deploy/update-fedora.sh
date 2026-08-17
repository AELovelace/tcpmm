#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/tcpmm}
SERVICE_NAME=${SERVICE_NAME:-tcpmm}
APP_GROUP=${APP_GROUP:-tcpmm}
PORT=${PORT:-3030}
REMOTE=${REMOTE:-origin}
TARGET_REF=${1:-${GIT_REF:-}}
OLD_REVISION=''
UPDATED=0

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ ${UPDATED} == 1 && -n ${OLD_REVISION} ]]; then
    printf '\nUpdate failed; restoring %s...\n' "${OLD_REVISION}" >&2
    cd "${APP_DIR}"
    git reset --hard "${OLD_REVISION}" || true
    npm ci || true
    npm run build || true
    npm prune --omit=dev || true
      chown -R root:"${APP_GROUP}" "${APP_DIR}" || true
      chmod -R o-rwx "${APP_DIR}" || true
      chmod 0755 "${APP_DIR}/deploy/install-fedora.sh" "${APP_DIR}/deploy/update-fedora.sh" || true
    systemctl restart "${SERVICE_NAME}.service" || true
  fi
  exit "${exit_code}"
}
trap rollback ERR

[[ ${EUID} -eq 0 ]] || die "Run this updater as root (sudo)."
[[ -d ${APP_DIR}/.git ]] || die "${APP_DIR} is not a Git checkout."
[[ -f ${APP_DIR}/package-lock.json ]] || die "package-lock.json is missing."
systemctl cat "${SERVICE_NAME}.service" >/dev/null 2>&1 || die "${SERVICE_NAME}.service is not installed."

cd "${APP_DIR}"
[[ -z $(git status --porcelain --untracked-files=no) ]] || die "Tracked files in ${APP_DIR} have local changes. Commit or discard them before updating."
OLD_REVISION=$(git rev-parse HEAD)

log "Fetching application update"
git fetch --prune "${REMOTE}"
UPDATED=1
if [[ -n ${TARGET_REF} ]]; then
  git rev-parse --verify "${REMOTE}/${TARGET_REF}^{commit}" >/dev/null 2>&1 || die "Remote branch ${REMOTE}/${TARGET_REF} does not exist."
  git checkout "${TARGET_REF}" 2>/dev/null || git checkout -b "${TARGET_REF}" --track "${REMOTE}/${TARGET_REF}"
  git merge --ff-only "${REMOTE}/${TARGET_REF}"
else
  BRANCH=$(git symbolic-ref --quiet --short HEAD) || die "The checkout is detached; pass a branch name to this script."
  git merge --ff-only "${REMOTE}/${BRANCH}"
fi

if [[ $(git rev-parse HEAD) == "${OLD_REVISION}" ]]; then
  log "Already up to date; rebuilding anyway"
fi

log "Installing build dependencies"
npm ci

log "Compiling TypeScript and building production assets"
npm run build

log "Removing development-only packages"
npm prune --omit=dev
chown -R root:"${APP_GROUP}" "${APP_DIR}"
chmod -R o-rwx "${APP_DIR}"
chmod 0755 "${APP_DIR}/deploy/install-fedora.sh" "${APP_DIR}/deploy/update-fedora.sh"

log "Updating systemd unit and restarting service"
install -o root -g root -m 0644 "${APP_DIR}/deploy/tcpmm.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl restart "${SERVICE_NAME}.service"

for _ in {1..20}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/content" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
[[ ${READY:-0} == 1 ]] || { journalctl -u "${SERVICE_NAME}.service" -n 50 --no-pager; false; }

UPDATED=0
trap - ERR
log "Updated $(git rev-parse --short "${OLD_REVISION}") -> $(git rev-parse --short HEAD)"
