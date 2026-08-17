#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/tcpmm}
DATA_DIR=${DATA_DIR:-/var/lib/tcpmm}
ENV_FILE=${ENV_FILE:-/etc/tcpmm.env}
SERVICE_NAME=${SERVICE_NAME:-tcpmm}
APP_USER=${APP_USER:-tcpmm}
APP_GROUP=${APP_GROUP:-tcpmm}
REPO_URL=${1:-${REPO_URL:-}}
GIT_REF=${2:-${GIT_REF:-}}
ADMIN_USERNAME=${ADMIN_USERNAME:-admin}
PORT=${PORT:-3030}
PROXY_IP=${PROXY_IP:-}

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "Run this installer as root (sudo)."

if [[ -z ${REPO_URL} ]] && git -C "$(dirname "$0")/.." remote get-url origin >/dev/null 2>&1; then
  REPO_URL=$(git -C "$(dirname "$0")/.." remote get-url origin)
fi
[[ -n ${REPO_URL} ]] || die "Usage: sudo bash deploy/install-fedora.sh <git-repository-url> [branch-or-tag]"
[[ ! -e ${APP_DIR} ]] || die "${APP_DIR} already exists. Use deploy/update-fedora.sh to update an installation."

log "Installing Fedora packages"
dnf install -y git nodejs npm gcc-c++ make python3 curl openssl
if ! command -v ffmpeg >/dev/null 2>&1; then
  dnf install -y ffmpeg || dnf install -y ffmpeg-free
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])")
(( NODE_MAJOR >= 20 )) || die "Node.js 20 or newer is required; Fedora installed $(node --version)."

log "Creating service account and data directory"
getent group "${APP_GROUP}" >/dev/null || groupadd --system "${APP_GROUP}"
id "${APP_USER}" >/dev/null 2>&1 || useradd --system --gid "${APP_GROUP}" --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 0750 "${DATA_DIR}"

log "Cloning application"
if [[ -n ${GIT_REF} ]]; then
  git clone --branch "${GIT_REF}" --single-branch "${REPO_URL}" "${APP_DIR}"
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

log "Installing dependencies and compiling TypeScript"
cd "${APP_DIR}"
npm ci
npm run build
npm prune --omit=dev
chown -R root:"${APP_GROUP}" "${APP_DIR}"
chmod -R o-rwx "${APP_DIR}"
chmod 0755 "${APP_DIR}/deploy/install-fedora.sh" "${APP_DIR}/deploy/update-fedora.sh"

if [[ -e ${ENV_FILE} ]]; then
  log "Keeping existing ${ENV_FILE}"
  INITIAL_PASSWORD=''
else
  INITIAL_PASSWORD=$(openssl rand -hex 24)
  GENERATED_PASSWORD=1
  umask 077
  cat >"${ENV_FILE}" <<EOF
HOST=0.0.0.0
PORT=${PORT}
TRUST_PROXY=1
DATA_DIR=${DATA_DIR}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_INITIAL_PASSWORD=${INITIAL_PASSWORD}
EOF
fi
chmod 0600 "${ENV_FILE}"
chown root:root "${ENV_FILE}"

log "Installing and starting systemd service"
install -o root -g root -m 0644 "${APP_DIR}/deploy/tcpmm.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

for _ in {1..20}; do
  if curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/content" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ ${READY:-0} != 1 ]]; then
  systemctl status "${SERVICE_NAME}.service" --no-pager || true
  journalctl -u "${SERVICE_NAME}.service" -n 50 --no-pager || true
  die "The service did not become ready."
fi

# The bootstrap password is no longer needed after the first administrator exists.
if grep -q '^ADMIN_INITIAL_PASSWORD=' "${ENV_FILE}"; then
  sed -i '/^ADMIN_INITIAL_PASSWORD=/d' "${ENV_FILE}"
fi

if [[ -n ${PROXY_IP} ]]; then
  if systemctl is-active --quiet firewalld; then
    log "Allowing the Nginx proxy through firewalld"
    firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${PROXY_IP} port port=${PORT} protocol=tcp accept"
    firewall-cmd --reload
  else
    printf 'WARNING: firewalld is not active; restrict TCP %s to %s using the host firewall.\n' "${PORT}" "${PROXY_IP}" >&2
  fi
else
  printf '\nWARNING: TCP %s was not opened. Set PROXY_IP when installing or add a firewall rule limited to the Nginx VM.\n' "${PORT}" >&2
fi

log "Installation complete"
printf 'Service: systemctl status %s\n' "${SERVICE_NAME}"
printf 'Admin:   https://YOUR_HOST/admin/\n'
if [[ ${GENERATED_PASSWORD:-0} == 1 ]]; then
  printf 'User:    %s\nPassword: %s\n' "${ADMIN_USERNAME}" "${INITIAL_PASSWORD}"
  printf 'Save this password now; it is not retained in %s.\n' "${ENV_FILE}"
fi
