# === ATHENA-001 Deployment System - Common Utilities ===
# Colors, logging, error handling, SSH helpers

RESET='\033[0m'; BOLD='\033[1m'
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
BLUE='\033[0;34m'; MAGENTA='\033[0;35m'; CYAN='\033[0;36m'; GRAY='\033[0;90m'

log_silent()  { :; }
log_info()    { echo -e "${BLUE}ℹ${RESET}  $*"; }
log_success() { echo -e "${GREEN}✔${RESET}  $*"; }
log_warn()    { echo -e "${YELLOW}⚠${RESET}  $*" >&2; }
log_error()   { echo -e "${RED}✘${RESET}  $*" >&2; }
log_step()    { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }
log_debug()   { [[ "${VERBOSE:-false}" == true ]] && echo -e "${GRAY}∙${RESET}  $*"; }
log_detail()  { echo -e "   ${GRAY}$*${RESET}"; }
log_banner()  { echo -e "${BOLD}${MAGENTA}═══════════════════════════════════════${RESET}"; echo -e "${BOLD}${MAGENTA}  $*${RESET}"; echo -e "${BOLD}${MAGENTA}═══════════════════════════════════════${RESET}"; }

DEPLOY_START_SECONDS=$SECONDS
deploy_elapsed() { echo "$((SECONDS - DEPLOY_START_SECONDS))s"; }

die() { log_error "$*"; exit 1; }

check_cmd() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  if ! check_cmd "$1"; then
    die "'$1' is required but not found. Install it and try again."
  fi
}

confirm() {
  local prompt="$1"
  if [[ "${FORCE:-false}" == true || "${DRY_RUN:-false}" == true ]]; then
    [[ "${DRY_RUN:-false}" == true ]] && log_detail "[dry-run] confirm: $prompt → yes"
    return 0
  fi
  read -p "$(echo -e "${YELLOW}?${RESET}  ${prompt} [y/N] ")" -n 1 -r
  echo
  [[ "$REPLY" =~ ^[Yy]$ ]]
}

run_cmd() {
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] $*"
    return 0
  fi
  "$@"
}

run_cmd_quiet() {
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] $*"
    return 0
  fi
  "$@" >/dev/null 2>&1
}

with_retry() {
  local attempts=$1; shift
  local delay=$1; shift
  local n=0
  until [[ $n -ge $attempts ]]; do
    n=$((n + 1))
    if "$@"; then
      return 0
    fi
    if [[ $n -lt $attempts ]]; then
      log_warn "Attempt $n/$attempts failed, retrying in ${delay}s..."
      sleep "$delay"
    fi
  done
  return 1
}

# === SSH Helpers ===

SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

ssh_exec() {
  local host="$1"; shift
  ssh $SSH_OPTS "$host" -- "$@"
}

ssh_exec_quiet() {
  local host="$1"; shift
  ssh $SSH_OPTS "$host" -- "$@" 2>/dev/null
}

ssh_pipe() {
  local host="$1"; shift
  ssh $SSH_OPTS "$host" -- "$@"
}

ssh_copy() {
  local src="$1" dest="$2"
  scp $SSH_OPTS -r "$src" "$dest"
}

ssh_test() {
  local host="$1"
  ssh_exec_quiet "$host" "echo ok" >/dev/null 2>&1
}

ssh_path_exists() {
  local host="$1" path="$2"
  ssh_exec_quiet "$host" "test -e '$path'" >/dev/null 2>&1
}

ssh_mkdir() {
  local host="$1" path="$2"
  ssh_exec "$host" "mkdir -p '$path'"
}

ssh_rm() {
  local host="$1" path="$2"
  ssh_exec "$host" "rm -rf '$path'"
}

ssh_read_file() {
  local host="$1" path="$2"
  ssh_exec_quiet "$host" "cat '$path' 2>/dev/null || true"
}

ssh_check_disk() {
  local host="$1" remote_path="$2" min_gb="${3:-1}"
  local avail
  avail=$(ssh_exec_quiet "$host" "df --output=avail -BG '$remote_path' 2>/dev/null | tail -1 | tr -d 'G '")
  if [[ -z "$avail" || "$avail" -lt "$min_gb" ]]; then
    die "Insufficient disk space: ${avail:-0}GB available, need ${min_gb}GB"
  fi
  log_success "Disk space: ${avail}GB available"
}

ssh_total_memory_mb() {
  local host="$1"
  ssh_exec_quiet "$host" "awk '/MemTotal/ {print int(\$2/1024)}' /proc/meminfo 2>/dev/null || echo 1024"
}

ssh_available_memory_mb() {
  local host="$1"
  ssh_exec_quiet "$host" "awk '/MemAvailable/ {print int(\$2/1024)}' /proc/meminfo 2>/dev/null || awk '/MemFree/ {print int(\$2/1024)}' /proc/meminfo 2>/dev/null || echo 512"
}

ssh_detect_os() {
  local host="$1"
  ssh_exec_quiet "$host" "
    if [ -f /etc/os-release ]; then
      . /etc/os-release && echo \"\$ID\"
    elif [ -f /etc/debian_version ]; then
      echo debian
    elif command -v apk >/dev/null 2>&1; then
      echo alpine
    else
      echo unknown
    fi
  " || echo "unknown"
}

ssh_arch() {
  local host="$1"
  ssh_exec_quiet "$host" "uname -m" || echo "unknown"
}

remote_temp() {
  local host="$1"
  ssh_exec_quiet "$host" "mktemp -d /tmp/athena-deploy-XXXXXX" || die "Cannot create temp dir on remote"
}

remote_file_exists() {
  local host="$1" path="$2"
  ssh_exec_quiet "$host" "test -f '$path'" >/dev/null 2>&1
}

remote_is_running() {
  local host="$1" process_name="${2:-athena}"
  ssh_exec_quiet "$host" "pgrep -f '$process_name' >/dev/null 2>&1"
}

# Smart RAM-based memory limit calculation
# Reads total RAM from remote, applies tiered formula
calculate_memory_limit_mb() {
  local total_mb=$1

  local limit_mb
  if (( total_mb < 1536 )); then
    limit_mb=$(( total_mb * 36 / 100 ))
  elif (( total_mb < 3072 )); then
    limit_mb=$(( total_mb * 25 / 100 ))
  elif (( total_mb < 6144 )); then
    limit_mb=$(( total_mb * 20 / 100 ))
  elif (( total_mb < 12288 )); then
    limit_mb=$(( total_mb * 15 / 100 ))
  else
    limit_mb=1024
  fi

  (( limit_mb < 256 )) && limit_mb=256
  (( limit_mb > 1024 )) && limit_mb=1024

  echo "$limit_mb"
}

# Determine number of CPU cores on remote for cluster mode
ssh_cpu_cores() {
  local host="$1"
  ssh_exec_quiet "$host" "nproc 2>/dev/null || lscpu 2>/dev/null | awk '/^CPU\(s\):/{print \$2}' || echo 1"
}

# Atomic symlink swap
atomic_symlink() {
  local host="$1" target="$2" link_path="$3"
  local tmp_link="${link_path}.${RANDOM}.tmp"
  ssh_exec "$host" "ln -sfn '$target' '$tmp_link' && mv -Tf '$tmp_link' '$link_path'"
}

# Find npm/npx on remote
ssh_find_node_bin() {
  local host="$1"
  ssh_exec_quiet "$host" "
    command -v node 2>/dev/null ||
    (export NVM_DIR=\"\$HOME/.nvm\" && [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" && command -v node 2>/dev/null) ||
    (export PATH=\"\$HOME/.local/bin:\$PATH\" && command -v node 2>/dev/null) ||
    echo ''
  "
}

ssh_ensure_node() {
  local host="$1" version="${2:-20}"
  local node_path
  node_path=$(ssh_find_node_bin "$host")
  if [[ -n "$node_path" ]]; then
    local current_version
    current_version=$(ssh_exec_quiet "$host" "$node_path --version 2>/dev/null | sed 's/v//' | cut -d. -f1")
    log_success "Node.js found: v$(ssh_exec_quiet "$host" "$node_path --version 2>/dev/null")"
    if [[ -n "$current_version" && "$current_version" -ge "$version" ]]; then
      return 0
    fi
    log_info "Node.js version too old (v${current_version}), upgrading..."
  fi

  log_info "Installing Node.js v${version}..."
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would install Node.js v${version}"
    return 0
  fi

  ssh_exec "$host" "
    set -e
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_${version}.x | bash -
      apt-get install -y nodejs
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
      dnf module install -y nodejs:${version}
    elif command -v yum >/dev/null 2>&1; then
      curl -fsSL https://rpm.nodesource.com/setup_${version}.x | bash -
      yum install -y nodejs
    else
      # Install via nvm as universal fallback
      export NVM_DIR=\"\$HOME/.nvm\"
      [ -s \"\$NVM_DIR/nvm.sh\" ] || curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
      [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\"
      nvm install ${version}
      nvm alias default ${version}
    fi
  " || die "Failed to install Node.js"

  log_success "Node.js v${version} installed"
}
