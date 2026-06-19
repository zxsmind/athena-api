#!/usr/bin/env bash
# ============================================================================
# ATHENA-001 Deployment System
# ============================================================================
# SSH-based deployment with hash-incremental sync,
# automatic PM2 management, smart RAM limits,
# versioned releases, and health checks.
#
# Usage:
#   ./deploy.sh <command> [options]
#
# Commands:
#   init        First-time setup (dirs, Node.js, PM2)
#   deploy      Full deploy (sync, build, restart)
#   status      Show service status
#   logs        Show application logs
#   rollback    Rollback to previous release
#   restart     Restart service only
#   cleanup     Clean old releases
#   doctor      Run diagnostics
#   config      Show current configuration
#
# Options:
#   --host      Target host (user@hostname)
#   --port      SSH port (default: 22)
#   --path      Remote path (default: /opt/athena)
#   --config    Config file path (default: ./deploy.json)
#   --dry-run   Show what would happen without doing it
#   --verbose   More output
#   --force     Skip confirmations
# ============================================================================

set -euo pipefail

# --- Bootstrap ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$LIB_DIR/common.sh"
source "$LIB_DIR/hash.sh"
source "$LIB_DIR/sync.sh"
source "$LIB_DIR/setup.sh"
source "$LIB_DIR/service.sh"

# --- Default Configuration ---
CONFIG_FILE="$SCRIPT_DIR/deploy.json"
CONFIG_HOST=""
CONFIG_PORT=22
CONFIG_REMOTE_PATH="/opt/athena"
CONFIG_BRANCH=""
CONFIG_NODE_VERSION="20"
CONFIG_APP_PORT=3001
CONFIG_KEEP_RELEASES=5
CONFIG_SSH_KEY=""
CONFIG_HEALTH_RETRIES=5
CONFIG_HEALTH_TIMEOUT=5000
CONFIG_PRE_DEPLOY=""
CONFIG_POST_DEPLOY=""

# --- Default PM2 Config ---
CONFIG_PM2_INSTANCES="auto"
CONFIG_PM2_MAX_MEMORY_RESTART=""

DRY_RUN=false
VERBOSE=false
FORCE=false
COMMAND=""
COMMAND_ARGS=()

# --- Resolve Git Info ---
GIT_COMMIT=""
GIT_VERSION=""
GIT_BRANCH=""

resolve_git_info() {
  GIT_COMMIT=$(cd "$PROJECT_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
  GIT_BRANCH=$(cd "$PROJECT_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  GIT_VERSION=$(cd "$PROJECT_DIR" && git describe --tags --always --dirty 2>/dev/null || echo "$GIT_COMMIT")
}

# --- Config File Loading ---
load_config_file() {
  local cfg="$1"

  if [[ ! -f "$cfg" ]]; then
    return 0
  fi

  log_debug "Loading config: $cfg"

  if ! check_cmd jq; then
    die "jq is required for config parsing. Install it: sudo apt-get install jq"
  fi

  local host
  host=$(jq -r '.host // empty' "$cfg" 2>/dev/null)
  [[ -n "$host" ]] && CONFIG_HOST="$host"

  local port
  port=$(jq -r '.port // empty' "$cfg" 2>/dev/null)
  [[ -n "$port" && "$port" != "null" ]] && CONFIG_PORT="$port"

  local path
  path=$(jq -r '.remotePath // empty' "$cfg" 2>/dev/null)
  [[ -n "$path" ]] && CONFIG_REMOTE_PATH="$path"

  local branch
  branch=$(jq -r '.branch // empty' "$cfg" 2>/dev/null)
  [[ -n "$branch" ]] && CONFIG_BRANCH="$branch"

  local node_ver
  node_ver=$(jq -r '.nodeVersion // empty' "$cfg" 2>/dev/null)
  [[ -n "$node_ver" && "$node_ver" != "null" ]] && CONFIG_NODE_VERSION="$node_ver"

  local app_port
  app_port=$(jq -r '.appPort // empty' "$cfg" 2>/dev/null)
  [[ -n "$app_port" && "$app_port" != "null" ]] && CONFIG_APP_PORT="$app_port"

  local keep
  keep=$(jq -r '.keepReleases // empty' "$cfg" 2>/dev/null)
  [[ -n "$keep" && "$keep" != "null" ]] && CONFIG_KEEP_RELEASES="$keep"

  local ssh_key
  ssh_key=$(jq -r '.sshKey // empty' "$cfg" 2>/dev/null)
  [[ -n "$ssh_key" ]] && CONFIG_SSH_KEY="$ssh_key"

  local health_retries
  health_retries=$(jq -r '.healthCheck.retries // empty' "$cfg" 2>/dev/null)
  [[ -n "$health_retries" && "$health_retries" != "null" ]] && CONFIG_HEALTH_RETRIES="$health_retries"

  local health_timeout
  health_timeout=$(jq -r '.healthCheck.timeout // empty' "$cfg" 2>/dev/null)
  [[ -n "$health_timeout" && "$health_timeout" != "null" ]] && CONFIG_HEALTH_TIMEOUT="$health_timeout"

  local pre_d
  pre_d=$(jq -r '.preDeploy // empty' "$cfg" 2>/dev/null)
  [[ -n "$pre_d" ]] && CONFIG_PRE_DEPLOY="$pre_d"

  local post_d
  post_d=$(jq -r '.postDeploy // empty' "$cfg" 2>/dev/null)
  [[ -n "$post_d" ]] && CONFIG_POST_DEPLOY="$post_d"

  local pm2_inst
  pm2_inst=$(jq -r '.pm2.instances // empty' "$cfg" 2>/dev/null)
  [[ -n "$pm2_inst" && "$pm2_inst" != "null" ]] && CONFIG_PM2_INSTANCES="$pm2_inst"

  local pm2_mem
  pm2_mem=$(jq -r '.pm2.maxMemoryRestart // empty' "$cfg" 2>/dev/null)
  [[ -n "$pm2_mem" ]] && CONFIG_PM2_MAX_MEMORY_RESTART="$pm2_mem"
}

# --- CLI Argument Parsing ---
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host) CONFIG_HOST="$2"; shift 2 ;;
      --port) CONFIG_PORT="$2"; shift 2 ;;
      --path) CONFIG_REMOTE_PATH="$2"; shift 2 ;;
      --config) CONFIG_FILE="$2"; shift 2 ;;
      --dry-run) DRY_RUN=true; shift ;;
      --verbose) VERBOSE=true; shift ;;
      --force) FORCE=true; shift ;;
      --help|-h)
        show_help
        exit 0
        ;;
      -*)
        if [[ $# -ge 2 && ! "$2" =~ ^- ]]; then
          COMMAND_ARGS+=("$1" "$2")
          shift 2
        else
          COMMAND_ARGS+=("$1")
          shift
        fi
        ;;
      *)
        if [[ -z "$COMMAND" ]]; then
          COMMAND="$1"
        else
          COMMAND_ARGS+=("$1")
        fi
        shift
        ;;
    esac
  done
}

# --- Help ---
show_help() {
  cat <<'EOF'
ATHENA-001 Deployment System

USAGE:
  deploy.sh <command> [options]

COMMANDS:
  init              First-time setup (directories, Node.js, PM2)
  deploy            Deploy or update application
  status            Show remote service status
  logs [--lines N]  Show application logs
  rollback [N]      Rollback N releases (default: 1)
  restart           Restart service only (no build)
  cleanup           Remove old releases
  doctor            Run system diagnostics
  config            Show current configuration

OPTIONS:
  --host <host>     SSH target (user@hostname)
  --port <port>     SSH port (default: 22)
  --path <path>     Remote path (default: /opt/athena)
  --config <file>   Config file path
  --dry-run         Show what would happen without doing it
  --verbose         Enable verbose output
  --force           Skip all confirmations
  --help, -h        Show this help

EXAMPLES:
  deploy.sh init --host ubuntu@192.168.1.100
  deploy.sh deploy --host ubuntu@10.0.0.5 --verbose
  deploy.sh deploy --dry-run
  deploy.sh status
  deploy.sh logs --lines 100
  deploy.sh rollback 2
  deploy.sh doctor
EOF
}

# --- Pre-flight Checks ---
pre_flight() {
  log_banner "ATHENA-001 Deploy System v2.0"

  resolve_git_info

  # Check local dependencies
  local missing=()
  check_cmd jq        || missing+=("jq")
  check_cmd ssh       || missing+=("ssh (openssh-client)")
  check_cmd scp       || missing+=("scp")
  check_cmd sha256sum || missing+=("sha256sum (coreutils)")
  check_cmd rsync     || missing+=("rsync (optional, for fallback)")

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required local tools: ${missing[*]}"
    return 1
  fi

  # Verify we're in the project root
  if [[ ! -f "$PROJECT_DIR/package.json" || ! -d "$PROJECT_DIR/server" ]]; then
    die "Must be run from the ATHENA-001 project root (parent of deploy/)"
  fi

  # Verify host is set
  if [[ -z "$CONFIG_HOST" ]]; then
    die "No host specified. Use --host <user@host> or set in deploy.json"
  fi

  # Load SSH key if specified
  if [[ -n "$CONFIG_SSH_KEY" ]]; then
    SSH_OPTS="-o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i $CONFIG_SSH_KEY"
  fi

  log_detail "Host: ${CONFIG_HOST}"
  log_detail "Port: ${CONFIG_PORT}"
  log_detail "Remote path: ${CONFIG_REMOTE_PATH}"
  log_detail "Branch: ${GIT_BRANCH}"
  log_detail "Commit: ${GIT_COMMIT}"
  [[ "${DRY_RUN:-false}" == true ]] && log_detail "Mode: DRY RUN (no changes will be made)"
}

# --- SSH Connection Test ---
test_connection() {
  log_step "Testing SSH connection"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would test SSH to ${CONFIG_HOST}"
    return 0
  fi

  if ssh_test "$CONFIG_HOST"; then
    log_success "SSH connection to ${CONFIG_HOST} successful"
  else
    die "Cannot connect to ${CONFIG_HOST}. Check: hostname, SSH key, network"
  fi
}

# --- Version string generation ---
generate_version() {
  local ts
  ts=$(date -u +%Y%m%d%H%M%S)
  echo "v${ts}-${GIT_COMMIT:0:8}"
}

# ============================================================================
# COMMANDS
# ============================================================================

# --- INIT ---
cmd_init() {
  pre_flight
  test_connection

  log_step "Initial setup on ${CONFIG_HOST}"

  # Create directory structure
  setup_directory_structure "$CONFIG_HOST" "$CONFIG_REMOTE_PATH"

  # System packages
  setup_system_packages "$CONFIG_HOST"

  # Node.js
  setup_nodejs "$CONFIG_HOST" "$CONFIG_NODE_VERSION"

  # PM2
  ensure_pm2 "$CONFIG_HOST"
  verify_startup "$CONFIG_HOST"

  log_banner "✅ Init complete"
  log_info "Now run: ./deploy.sh deploy"
}

# --- DEPLOY ---
cmd_deploy() {
  pre_flight

  resolve_git_info
  test_connection

  # Pre-deploy hook
  if [[ -n "$CONFIG_PRE_DEPLOY" ]]; then
    log_step "Running pre-deploy hook"
    eval "$CONFIG_PRE_DEPLOY" || log_warn "Pre-deploy hook failed (continuing)"
  fi

  # Create release name
  local version
  version=$(generate_version)
  local release_name="${version}"

  log_step "Starting deploy ${version}"

  # Generate local manifest
  log_step "Generating file manifest"
  local local_manifest
  local_manifest=$(generate_manifest "$PROJECT_DIR")
  log_success "Local manifest generated"

  # Fetch remote manifest for comparison
  log_step "Comparing with remote"
  local remote_manifest
  remote_manifest=$(fetch_remote_manifest "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")

  # Find changed files
  local diff_manifest
  diff_manifest=$(compare_manifests "$local_manifest" "$remote_manifest")
  local changed_count
  changed_count=$(count_changes "$diff_manifest")
  local changed_paths
  changed_paths=$(get_changed_paths "$diff_manifest")

  log_detail "Changed files: ${changed_count}"

  # Ensure remote directory structure exists
  ssh_mkdir "$CONFIG_HOST" "${CONFIG_REMOTE_PATH}/releases"
  ssh_mkdir "$CONFIG_HOST" "${CONFIG_REMOTE_PATH}/shared/data"
  ssh_mkdir "$CONFIG_HOST" "${CONFIG_REMOTE_PATH}/shared/logs"

  # Create release directory
  local release_path="${CONFIG_REMOTE_PATH}/releases/${release_name}"
  ssh_mkdir "$CONFIG_HOST" "$release_path"

  # Sync files
  if [[ "$changed_count" -gt 0 ]]; then
    log_step "Syncing ${changed_count} changed files"

    if [[ "${DRY_RUN:-false}" == true ]]; then
      log_detail "[dry-run] Would sync ${changed_count} files to ${release_path}"
    else
      # Build tar of changed files and pipe to remote
      local include_args=()
      IFS=':' read -ra paths <<< "$changed_paths"
      for relpath in "${paths[@]}"; do
        [[ -z "$relpath" ]] && continue
        local full_path="$PROJECT_DIR/$relpath"
        if [[ -f "$full_path" ]]; then
          include_args+=("$relpath")
        fi
      done

      if [[ ${#include_args[@]} -gt 0 ]]; then
        local total_bytes=0
        for relpath in "${include_args[@]}"; do
          local size
          size=$(stat -c%s "$PROJECT_DIR/$relpath" 2>/dev/null || echo 0)
          total_bytes=$((total_bytes + size))
        done
        local size_hr
        if (( total_bytes > 1048576 )); then
          size_hr="$(echo "scale=1; $total_bytes / 1048576" | bc)MB"
        else
          size_hr="$(echo "scale=1; $total_bytes / 1024" | bc)KB"
        fi

        log_info "Transferring ${#include_args[@]} files (${size_hr})..."

        local sync_elapsed=$SECONDS
        (
          cd "$PROJECT_DIR" || die "Cannot cd to project"
          tar cf - "${include_args[@]}"
        ) | ssh_exec "$CONFIG_HOST" "cd '$release_path' && tar xf -"

        local sync_time=$((SECONDS - sync_elapsed))
        log_success "Files transferred in ${sync_time}s"
      fi

      # Create symlink to shared data
      ssh_exec "$CONFIG_HOST" "
        mkdir -p '${release_path}/server'
        ln -sfn '${CONFIG_REMOTE_PATH}/shared/data' '${release_path}/server/data'
      " 2>/dev/null || true
    fi
  else
    log_info "No files changed"

    if [[ "${DRY_RUN:-false}" == true ]]; then
      log_detail "[dry-run] Would clone from current release"
    else
      # Clone from current release (rsync from current to new)
      local current_target
      current_target=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
      if [[ -n "$current_target" && "$current_target" != "$release_path" ]]; then
        log_info "Cloning from current release..."
        ssh_exec "$CONFIG_HOST" "
          rsync -a --delete '${current_target}/' '${release_path}/' \
            --exclude='node_modules' --exclude='dist' --exclude='data'
        " 2>/dev/null || true
      fi
    fi
  fi

  # Install / update dependencies if needed
  local needs_deps=false
  if has_deps_changed "$local_manifest" "$remote_manifest"; then
    needs_deps=true
    log_step "Dependencies changed, updating..."
  elif ! ssh_path_exists "$CONFIG_HOST" "${release_path}/server/node_modules"; then
    needs_deps=true
    log_step "Dependencies not installed yet..."
  else
    log_detail "Dependencies unchanged, skipping install"
  fi

  if [[ "$needs_deps" == true ]]; then
    if [[ "${DRY_RUN:-false}" == true ]]; then
      log_detail "[dry-run] Would install dependencies"
    else
      # Install smart-routing-core deps
      if ssh_path_exists "$CONFIG_HOST" "${release_path}/smart-routing-core/package.json"; then
        log_info "Installing smart-routing-core deps..."
        ssh_exec "$CONFIG_HOST" "cd '${release_path}/smart-routing-core' && npm ci --no-audit --no-fund 2>&1" || \
          ssh_exec "$CONFIG_HOST" "cd '${release_path}/smart-routing-core' && npm install --no-audit --no-fund 2>&1"
      fi

      # Build smart-routing-core
      if ssh_path_exists "$CONFIG_HOST" "${release_path}/smart-routing-core/src/index.ts"; then
        log_info "Building smart-routing-core..."
        ssh_exec "$CONFIG_HOST" "cd '${release_path}/smart-routing-core' && npx tsc -p tsconfig.json 2>&1" || log_warn "smart-routing-core build failed"
      fi

      # Install server deps
      log_info "Installing server dependencies..."
      ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && npm ci --no-audit --no-fund 2>&1" || \
        ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && npm install --no-audit --no-fund 2>&1"
    fi
  fi

  # Build
  log_step "Building project"
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would build server"
  else
    local build_elapsed=$SECONDS
    ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && npx tsc -p tsconfig.json 2>&1" || {
      log_error "TypeScript build failed"
      log_detail "Check build errors above"
      ssh_rm "$CONFIG_HOST" "$release_path"
      die "Build failed, release aborted"
    }
    local build_time=$((SECONDS - build_elapsed))
    log_success "Build completed in ${build_time}s"
  fi

  # Calculate memory limit
  setup_memory_limit "$CONFIG_HOST"
  MEMORY_LIMIT_MB="${MEMORY_LIMIT_MB:-512}"
  local cpu_cores
  cpu_cores=$(ssh_cpu_cores "$CONFIG_HOST")
  local instances="${cpu_cores}"
  (( instances > 4 )) && instances=4

  # Override with config if set
  if [[ -n "$CONFIG_PM2_INSTANCES" && "$CONFIG_PM2_INSTANCES" != "auto" ]]; then
    instances="$CONFIG_PM2_INSTANCES"
  fi
  if [[ -n "$CONFIG_PM2_MAX_MEMORY_RESTART" ]]; then
    MEMORY_LIMIT_MB="$CONFIG_PM2_MAX_MEMORY_RESTART"
  fi

  # Generate PM2 ecosystem config
  log_step "Configuring service"
  if [[ "${DRY_RUN:-false}" == false ]]; then
    # Remove existing ecosystem if present
    ssh_exec "$CONFIG_HOST" "rm -f '${release_path}/ecosystem.config.cjs'" 2>/dev/null || true

    # Generate config
    ssh_exec "$CONFIG_HOST" "cat > '${release_path}/ecosystem.config.cjs' << 'PM2EOF'
module.exports = {
  apps: [{
    name: 'athena',
    cwd: '${release_path}/server',
    script: 'dist/index.js',
    instances: ${instances},
    exec_mode: 'cluster',
    max_memory_restart: '${MEMORY_LIMIT_MB}M',
    env: {
      NODE_ENV: 'production',
      PORT: '${CONFIG_APP_PORT}',
    },
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '${CONFIG_REMOTE_PATH}/shared/logs/athena-error.log',
    out_file: '${CONFIG_REMOTE_PATH}/shared/logs/athena-out.log',
    pid_file: '${CONFIG_REMOTE_PATH}/shared/logs/athena.pid',
    max_restarts: 10,
    restart_delay: 1000,
    autorestart: true,
    min_uptime: '10s',
    listen_timeout: 3000,
    kill_timeout: 5000,
    shutdown_with_message: true,
    watch: false,
  }]
};
PM2EOF" || die "Failed to generate ecosystem.config.cjs"
    log_success "PM2 config generated (${instances} instances, ${MEMORY_LIMIT_MB}MB limit)"
  fi

  # Activate release (atomic symlink swap)
  log_step "Activating release"
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would activate: ${release_name}"
  else
    local current_target
    current_target=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
    atomic_symlink "$CONFIG_HOST" "$release_path" "${CONFIG_REMOTE_PATH}/current"
    log_success "Release ${release_name} activated"
  fi

  # Restart service
  log_step "Restarting service"
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would restart PM2"
    log_detail "[dry-run] Would run: pm2 startOrReload ecosystem.config.cjs --update-env"
  else
    # Ensure PM2 is available
    if ! pm2_available "$CONFIG_HOST"; then
      log_info "Installing PM2..."
      ssh_exec "$CONFIG_HOST" "npm install -g pm2"
      ssh_exec "$CONFIG_HOST" "pm2 startup systemd -u \$(whoami) --hp \$HOME 2>&1" || true
    fi

    local restart_elapsed=$SECONDS
    health_check_scheduled=false

    # Try graceful reload first, then fallback to restart/start
    if ssh_exec_quiet "$CONFIG_HOST" "pm2 list 2>/dev/null | grep -q athena"; then
      log_info "Reloading PM2 with new config..."
      ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && pm2 reload '${release_path}/ecosystem.config.cjs' --update-env 2>&1" || {
        log_warn "Reload failed, trying restart..."
        ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && pm2 restart athena --update-env 2>&1" || {
          log_warn "Restart failed, trying start..."
          ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && pm2 start '${release_path}/ecosystem.config.cjs' 2>&1"
        }
      }
    else
      log_info "Starting PM2 application..."
      ssh_exec "$CONFIG_HOST" "cd '${release_path}/server' && pm2 start '${release_path}/ecosystem.config.cjs' 2>&1" || die "Failed to start PM2 application"
    fi

    # Save process list for reboot recovery
    ssh_exec "$CONFIG_HOST" "pm2 save --force 2>&1" || log_warn "pm2 save failed (non-fatal)"

    # Verify startup config
    ssh_exec_quiet "$CONFIG_HOST" "pm2 startup 2>&1 | grep -q 'already'" || \
      ssh_exec "$CONFIG_HOST" "pm2 startup systemd -u \$(ssh_exec_quiet "$CONFIG_HOST" "whoami") --hp \$HOME 2>&1" || true

    local restart_time=$((SECONDS - restart_elapsed))
    log_success "Service restarted in ${restart_time}s"
  fi

  # Health check
  log_step "Running health check"
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would check health endpoint at port ${CONFIG_APP_PORT}"
    log_success "[dry-run] Health check would pass"
  else
    sleep 2
    local healthy=false
    local health_elapsed=$SECONDS
    local attempt

    for ((attempt = 1; attempt <= CONFIG_HEALTH_RETRIES; attempt++)); do
      local response
      response=$(ssh_exec_quiet "$CONFIG_HOST" "curl -s --max-time 5 'http://localhost:${CONFIG_APP_PORT}/health'" 2>/dev/null || echo "")
      if echo "$response" | jq -e '.status == "ok"' >/dev/null 2>&1; then
        healthy=true
        break
      fi
      [[ $attempt -lt $CONFIG_HEALTH_RETRIES ]] && sleep 2
    done

    local health_time=$((SECONDS - health_elapsed))

    if [[ "$healthy" == true ]]; then
      local mem_usage
      mem_usage=$(ssh_exec_quiet "$CONFIG_HOST" "pm2 jlist 2>/dev/null | jq -r '.[] | select(.name == \"athena\") | .monit.memory'" | awk '{printf "%.0fMB", $1/1048576}' 2>/dev/null || echo "N/A")
      log_success "Health check passed (${health_time}s, memory: ${mem_usage})"
    else
      log_error "Health check FAILED after ${CONFIG_HEALTH_RETRIES} attempts"
      log_error "Running diagnostics..."

      ssh_exec "$CONFIG_HOST" "
        echo '=== PM2 Status ==='
        pm2 list 2>&1 || true
        echo '=== PM2 Logs (last 20 lines) ==='
        pm2 logs athena --lines 20 --nostream 2>&1 || true
        echo '=== Port ${CONFIG_APP_PORT} check ==='
        ss -tlnp 2>/dev/null | grep -E ':${CONFIG_APP_PORT}\b' || netstat -tlnp 2>/dev/null | grep -E ':${CONFIG_APP_PORT}\b' || echo 'Not listening'
        echo '=== Node process ==='
        ps aux | grep -E 'node.*athena' | head -5 || true
      " || true

      log_warn "Rolling back to previous release..."

      local previous
      previous=$(ssh_exec_quiet "$CONFIG_HOST" "ls -1d '${CONFIG_REMOTE_PATH}/releases/'*/ 2>/dev/null | sort -r | tail -n +2 | head -1")
      if [[ -n "$previous" ]]; then
        atomic_symlink "$CONFIG_HOST" "$previous" "${CONFIG_REMOTE_PATH}/current"
        ssh_exec "$CONFIG_HOST" "cd '${CONFIG_REMOTE_PATH}/current/server' && pm2 restart athena --update-env 2>&1" || true
        log_warn "Rolled back to $(basename "$previous")"
      else
        log_error "No previous release to rollback to"
      fi

      die "Deploy failed at health check"
    fi
  fi

  # Write deploy meta
  if [[ "${DRY_RUN:-false}" == false ]]; then
    local deploy_duration
    deploy_duration=$(deploy_elapsed)
    write_remote_meta "$CONFIG_HOST" "$CONFIG_REMOTE_PATH" "$version" "$GIT_COMMIT" "$deploy_duration"
  fi

  # Cleanup old releases
  log_step "Cleaning old releases"
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would clean releases, keeping ${CONFIG_KEEP_RELEASES}"
  else
    local removed=0
    while IFS= read -r release; do
      if [[ "$release" != "$release_path/" ]]; then
        ssh_rm "$CONFIG_HOST" "$release"
        removed=$((removed + 1))
        log_detail "Removed: $(basename "$release")"
      fi
    done < <(ssh_exec_quiet "$CONFIG_HOST" "ls -1d '${CONFIG_REMOTE_PATH}/releases/'*/ 2>/dev/null | sort -r | tail -n +$((CONFIG_KEEP_RELEASES + 1))")

    [[ $removed -gt 0 ]] && log_success "Cleaned ${removed} old releases" || log_detail "Nothing to clean"
  fi

  # Post-deploy hook
  if [[ -n "$CONFIG_POST_DEPLOY" ]]; then
    log_step "Running post-deploy hook"
    eval "$CONFIG_POST_DEPLOY" || log_warn "Post-deploy hook failed (continuing)"
  fi

  # Done
  local total_time
  total_time=$(deploy_elapsed)
  log_banner "✅ Deploy ${version} successful (${total_time})"
  log_info "Host: ${CONFIG_HOST}"
  log_info "Path: ${CONFIG_REMOTE_PATH}"
  log_info "Commit: ${GIT_COMMIT}"
  log_info "Release: ${release_name}"
  log_info "Instances: ${instances} × ${MEMORY_LIMIT_MB}MB"
}

# --- STATUS ---
cmd_status() {
  pre_flight
  test_connection

  log_step "Service Status"

  local current
  current=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  if [[ -z "$current" ]]; then
    log_info "No deployment found"
    return 0
  fi
  log_detail "Current release: $(basename "$current")"

  # PM2 status
  echo ""
  ssh_exec "$CONFIG_HOST" "pm2 show athena 2>&1" || log_warn "PM2 process 'athena' not found"

  # Health check
  local health
  health=$(ssh_exec_quiet "$CONFIG_HOST" "curl -s --max-time 5 'http://localhost:${CONFIG_APP_PORT}/health' 2>/dev/null || echo 'unreachable'")
  log_detail "Health endpoint: ${health}"

  # Disk usage
  log_detail "Release count: $(count_remote_releases "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")"
  log_detail "Disk usage: $(ssh_exec_quiet "$CONFIG_HOST" "du -sh '${CONFIG_REMOTE_PATH}' 2>/dev/null | cut -f1")"

  # Meta
  local meta
  meta=$(fetch_remote_meta "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  if [[ -n "$meta" && "$meta" != "{}" ]]; then
    echo ""
    echo "Deploy Meta:"
    echo "$meta" | jq -r '
      "  Version:     \(.version // "N/A")",
      "  Commit:      \(.gitCommit // "N/A")",
      "  Branch:      \(.gitBranch // "N/A")",
      "  Deployed:    \(.timestamp // "N/A")",
      "  By:          \(.deployedBy // "N/A")",
      "  Duration:    \(.deployDuration // "N/A")",
      "  Node:        \(.nodeVersion // "N/A")",
      "  PM2:         \(.pm2Version // "N/A")"
    ' 2>/dev/null || true
  fi
}

# --- LOGS ---
cmd_logs() {
  pre_flight
  test_connection

  local lines=50
  local follow=false

  # Parse command args
  local i=0
  while [[ $i -lt ${#COMMAND_ARGS[@]} ]]; do
    case "${COMMAND_ARGS[$i]}" in
      --lines) lines="${COMMAND_ARGS[$((i+1))]}"; i=$((i+2)) ;;
      --follow|-f) follow=true; i=$((i+1)) ;;
      *) i=$((i+1)) ;;
    esac
  done

  log_info "Fetching logs (last ${lines} lines)..."
  echo ""

  if [[ "$follow" == true ]]; then
    ssh_exec "$CONFIG_HOST" "pm2 logs athena --lines ${lines} 2>&1"
  else
    ssh_exec "$CONFIG_HOST" "pm2 logs athena --lines ${lines} --nostream 2>&1" || {
      log_warn "PM2 logs not available, trying journal..."
      ssh_exec "$CONFIG_HOST" "journalctl -u athena -n ${lines} --no-pager 2>&1" || true
    }
  fi
}

# --- ROLLBACK ---
cmd_rollback() {
  pre_flight
  test_connection

  local steps=1

  # Parse command args for rollback step count
  if [[ ${#COMMAND_ARGS[@]} -gt 0 ]]; then
    local arg="${COMMAND_ARGS[0]}"
    if [[ "$arg" =~ ^[0-9]+$ ]]; then
      steps="$arg"
    fi
  fi

  log_step "Rolling back ${steps} release(s)"

  if ! confirm "Rollback ${steps} release(s) on ${CONFIG_HOST}?"; then
    log_info "Rollback cancelled"
    return 0
  fi

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would rollback ${steps} releases"
    return 0
  fi

  local current
  current=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  if [[ -z "$current" ]]; then
    die "No current release found"
  fi
  log_detail "Current: $(basename "$current")"

  local target
  target=$(ssh_exec_quiet "$CONFIG_HOST" "ls -1d '${CONFIG_REMOTE_PATH}/releases/'*/ 2>/dev/null | sort -r | tail -n +$((steps + 1)) | head -1")

  if [[ -z "$target" ]]; then
    die "No release found ${steps} steps back"
  fi
  log_detail "Target: $(basename "$target")"

  atomic_symlink "$CONFIG_HOST" "$target" "${CONFIG_REMOTE_PATH}/current"
  log_success "Rolled back to $(basename "$target")"

  # Restart service
  log_info "Restarting service..."
  ssh_exec "$CONFIG_HOST" "cd '${target}/server' && pm2 restart athena --update-env 2>&1" || log_warn "Restart failed"
  sleep 2

  # Health check
  local health
  health=$(ssh_exec_quiet "$CONFIG_HOST" "curl -s --max-time 5 'http://localhost:${CONFIG_APP_PORT}/health' 2>/dev/null || echo 'fail'")
  if echo "$health" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    log_success "Health check passed after rollback"
  else
    log_warn "Health check failed after rollback (${health})"
  fi

  log_banner "✅ Rollback complete"
}

# --- RESTART ---
cmd_restart() {
  pre_flight
  test_connection

  log_step "Restarting service"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would restart PM2 service"
    return 0
  fi

  if ! confirm "Restart service on ${CONFIG_HOST}?"; then
    log_info "Restart cancelled"
    return 0
  fi

  ssh_exec "$CONFIG_HOST" "pm2 restart athena --update-env 2>&1" || {
    log_warn "Restart failed, trying start..."
    local current
    current=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
    if [[ -n "$current" && -f "${current}/ecosystem.config.cjs" ]]; then
      ssh_exec "$CONFIG_HOST" "cd '${current}/server' && pm2 start '${current}/ecosystem.config.cjs' 2>&1" || die "Failed to start service"
    else
      die "Cannot find ecosystem config"
    fi
  }

  sleep 2

  local health
  health=$(ssh_exec_quiet "$CONFIG_HOST" "curl -s --max-time 5 'http://localhost:${CONFIG_APP_PORT}/health' 2>/dev/null || echo 'fail'")
  if echo "$health" | jq -e '.status == "ok"' >/dev/null 2>&1; then
    log_success "Restart successful, health check passed"
  else
    log_warn "Service restarted but health check failed"
  fi
}

# --- CLEANUP ---
cmd_cleanup() {
  pre_flight
  test_connection

  log_step "Cleaning old releases"

  local current
  current=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  local keep="${CONFIG_KEEP_RELEASES}"

  log_detail "Keeping: ${keep} releases"
  log_detail "Current release count: $(count_remote_releases "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")"

  if ! confirm "Remove releases older than the last ${keep}?"; then
    log_info "Cleanup cancelled"
    return 0
  fi

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would clean releases, keeping ${keep}"
    return 0
  fi

  local removed=0
  while IFS= read -r release; do
    if [[ "$release" != "${current}/" ]]; then
      local size
      size=$(ssh_exec_quiet "$CONFIG_HOST" "du -sb '$release' 2>/dev/null | cut -f1" || echo 0)
      ssh_rm "$CONFIG_HOST" "$release"
      local size_hr
      size_hr=$(echo "scale=1; $size / 1048576" | bc)
      log_detail "Removed: $(basename "$release") (${size_hr}MB)"
      removed=$((removed + 1))
    fi
  done < <(ssh_exec_quiet "$CONFIG_HOST" "ls -1d '${CONFIG_REMOTE_PATH}/releases/'*/ 2>/dev/null | sort -r | tail -n +$((keep + 1))")

  if [[ $removed -gt 0 ]]; then
    log_success "Cleaned ${removed} old releases"
  else
    log_info "Nothing to clean"
  fi
}

# --- DOCTOR ---
cmd_doctor() {
  pre_flight
  test_connection

  log_step "System Diagnostics"
  echo ""

  # OS
  local os
  os=$(ssh_detect_os "$CONFIG_HOST")
  log_detail "OS: ${os:-unknown}"

  # Architecture
  local arch
  arch=$(ssh_arch "$CONFIG_HOST")
  log_detail "Architecture: ${arch:-unknown}"

  # Memory
  local total_mem
  total_mem=$(ssh_total_memory_mb "$CONFIG_HOST")
  local avail_mem
  avail_mem=$(ssh_available_memory_mb "$CONFIG_HOST")
  local mem_limit
  mem_limit=$(calculate_memory_limit_mb "$total_mem")
  log_detail "Memory: ${total_mem}MB total, ${avail_mem}MB available"
  log_detail "Recommended Node limit: ${mem_limit}MB"

  # CPU
  local cores
  cores=$(ssh_cpu_cores "$CONFIG_HOST")
  log_detail "CPU cores: ${cores:-unknown}"

  # Disk
  local disk
  disk=$(ssh_exec_quiet "$CONFIG_HOST" "df -h '${CONFIG_REMOTE_PATH}' 2>/dev/null | tail -1 | awk '{print \$4 \" available, \" \$5 \" used\"}'")
  log_detail "Disk: ${disk:-unknown}"

  # Node
  local node_path
  node_path=$(ssh_find_node_bin "$CONFIG_HOST")
  if [[ -n "$node_path" ]]; then
    local node_ver
    node_ver=$(ssh_exec_quiet "$CONFIG_HOST" "$node_path --version")
    log_detail "Node.js: ${node_ver:-not found} at ${node_path}"
  else
    log_warn "Node.js: NOT INSTALLED"
  fi

  # NPM
  log_detail "npm: $(ssh_exec_quiet "$CONFIG_HOST" "npm --version 2>/dev/null || echo 'not installed'")"

  # PM2
  if pm2_available "$CONFIG_HOST"; then
    local pm2_ver
    pm2_ver=$(ssh_exec_quiet "$CONFIG_HOST" "pm2 --version 2>/dev/null || echo '?'")
    log_detail "PM2: v${pm2_ver}"

    # PM2 processes
    echo ""
    log_info "PM2 processes:"
    ssh_exec "$CONFIG_HOST" "pm2 list 2>&1" || log_warn "No PM2 processes"
  else
    log_warn "PM2: NOT INSTALLED"
  fi

  # Deployment
  local current
  current=$(get_current_release "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  if [[ -n "$current" ]]; then
    log_detail "Current release: $(basename "$current")"
    log_detail "Release count: $(count_remote_releases "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")"
  else
    log_warn "No deployment found at ${CONFIG_REMOTE_PATH}"
  fi

  # Meta
  local meta
  meta=$(fetch_remote_meta "$CONFIG_HOST" "$CONFIG_REMOTE_PATH")
  if [[ -n "$meta" && "$meta" != "{}" ]]; then
    echo ""
    log_info "Last deploy info:"
    echo "$meta" | jq -r '
      "  Version:  \(.version // "N/A")",
      "  Commit:   \(.gitCommit // "N/A")",
      "  When:     \(.timestamp // "N/A")",
      "  Node:     \(.nodeVersion // "N/A")"
    ' 2>/dev/null || true
  fi

  # Port check
  echo ""
  log_info "Port ${CONFIG_APP_PORT} check:"
  ssh_exec "$CONFIG_HOST" "ss -tlnp 2>/dev/null | grep -E ':${CONFIG_APP_PORT}\b' || netstat -tlnp 2>/dev/null | grep -E ':${CONFIG_APP_PORT}\b' || echo 'Not listening on port ${CONFIG_APP_PORT}'"

  # System load
  echo ""
  log_info "System load:"
  ssh_exec "$CONFIG_HOST" "uptime && free -h | head -2" || true

  log_banner "✅ Diagnostics complete"
}

# --- CONFIG ---
cmd_config() {
  echo ""
  log_banner "ATHENA-001 Deployment Configuration"
  echo ""
  echo "  Host:            ${CONFIG_HOST:-<not set>}"
  echo "  SSH Port:        ${CONFIG_PORT}"
  echo "  Remote Path:     ${CONFIG_REMOTE_PATH}"
  echo "  Branch:          ${CONFIG_BRANCH:-<not set>}"
  echo "  Node Version:    ${CONFIG_NODE_VERSION}"
  echo "  App Port:        ${CONFIG_APP_PORT}"
  echo "  Keep Releases:   ${CONFIG_KEEP_RELEASES}"
  echo "  Health Retries:  ${CONFIG_HEALTH_RETRIES}"
  echo "  SSH Key:         ${CONFIG_SSH_KEY:-<default>}"
  echo ""
  echo "  PM2 Instances:   ${CONFIG_PM2_INSTANCES}"
  echo "  Memory Limit:    ${CONFIG_PM2_MAX_MEMORY_RESTART:-auto}"
  echo ""
  echo "  Pre-deploy:      ${CONFIG_PRE_DEPLOY:-<none>}"
  echo "  Post-deploy:     ${CONFIG_POST_DEPLOY:-<none>}"
  echo ""
  echo "  Config File:     ${CONFIG_FILE}"
  echo "  Project Dir:     ${PROJECT_DIR}"
  echo "  Dry Run:         ${DRY_RUN}"
  echo "  Verbose:         ${VERBOSE}"
  echo ""
}

# ============================================================================
# MAIN
# ============================================================================

main() {
  parse_args "$@"

  if [[ -z "$COMMAND" ]]; then
    show_help
    exit 1
  fi

  # Load config file if it exists
  if [[ -f "$CONFIG_FILE" ]]; then
    load_config_file "$CONFIG_FILE"
  fi

  # Export variables for sub-scripts
  export CONFIG_HOST CONFIG_PORT CONFIG_REMOTE_PATH CONFIG_BRANCH
  export CONFIG_NODE_VERSION CONFIG_APP_PORT CONFIG_KEEP_RELEASES
  export CONFIG_SSH_KEY CONFIG_HEALTH_RETRIES CONFIG_HEALTH_TIMEOUT
  export CONFIG_PM2_INSTANCES CONFIG_PM2_MAX_MEMORY_RESTART
  export DRY_RUN VERBOSE FORCE

  case "$COMMAND" in
    init)
      cmd_init
      ;;
    deploy)
      cmd_deploy
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs
      ;;
    rollback)
      cmd_rollback
      ;;
    restart)
      cmd_restart
      ;;
    cleanup)
      cmd_cleanup
      ;;
    doctor)
      cmd_doctor
      ;;
    config)
      cmd_config
      ;;
    help|--help|-h)
      show_help
      ;;
    *)
      log_error "Unknown command: ${COMMAND}"
      echo ""
      show_help
      exit 1
      ;;
  esac
}

main "$@"
