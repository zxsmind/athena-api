# === Service Management ===
# PM2-based process management with auto-recovery, smart RAM, and health checks

# Check if PM2 is available on remote
pm2_available() {
  local host="$1"
  ssh_exec_quiet "$host" "command -v pm2 >/dev/null 2>&1 || npx pm2 --version >/dev/null 2>&1" >/dev/null 2>&1
}

# Ensure PM2 is installed globally
ensure_pm2() {
  local host="$1"

  log_step "Ensuring PM2"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would ensure PM2 is installed"
    return 0
  fi

  if pm2_available "$host"; then
    local pm2_ver
    pm2_ver=$(ssh_exec_quiet "$host" "pm2 --version 2>/dev/null || npx pm2 --version 2>/dev/null || echo '?'")
    log_success "PM2 v${pm2_ver} is available"
    return 0
  fi

  log_info "Installing PM2 globally..."
  ssh_exec "$host" "npm install -g pm2 2>&1" || die "Failed to install PM2"
  log_success "PM2 installed"

  # Setup PM2 startup
  log_info "Configuring PM2 startup..."
  ssh_exec "$host" "pm2 startup systemd -u $(ssh_exec_quiet "$host" "whoami") --hp \$HOME 2>&1 || pm2 startup 2>&1 || true" || log_warn "PM2 startup setup may require manual intervention"
}

# Generate and upload PM2 ecosystem config
generate_ecosystem_config() {
  local host="$1" remote_dir="$2"

  log_step "Generating PM2 ecosystem config"

  # Calculate memory limit from actual server RAM
  local total_mb
  total_mb=$(ssh_total_memory_mb "$host")
  local memory_limit
  memory_limit=$(calculate_memory_limit_mb "$total_mb")
  local cpu_cores
  cpu_cores=$(ssh_cpu_cores "$host")
  local instances="${cpu_cores}"
  (( instances > 4 )) && instances=4  # Cap at 4 instances for stability

  log_detail "CPU cores: ${cpu_cores}, PM2 instances: ${instances}"
  log_detail "Memory limit: ${memory_limit}MB per process"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would generate PM2 config"
    return 0
  fi

  # Generate ecosystem.config.cjs on remote with heredoc
  ssh_exec "$host" "cat > '${remote_dir}/ecosystem.config.cjs' << 'PM2EOF'
module.exports = {
  apps: [{
    name: 'athena',
    cwd: '${remote_dir}/current/server',
    script: 'dist/index.js',
    instances: ${instances},
    exec_mode: 'cluster',
    max_memory_restart: '${memory_limit}M',
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
    },
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '${remote_dir}/shared/logs/athena-error.log',
    out_file: '${remote_dir}/shared/logs/athena-out.log',
    pid_file: '${remote_dir}/shared/logs/athena.pid',
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

  log_success "PM2 ecosystem config created (${instances} instances, ${memory_limit}MB limit)"
}

# Start/restart the PM2 application
restart_service() {
  local host="$1" remote_dir="$2"

  log_step "Restarting service"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would restart PM2 service"
    return 0
  fi

  local elapsed=$SECONDS

  # Reload with zero-downtime (if in cluster mode)
  if ssh_exec_quiet "$host" "pm2 list 2>/dev/null | grep -q athena"; then
    log_info "Reloading PM2 application..."
    ssh_exec "$host" "cd '${remote_dir}/current/server' && pm2 reload ecosystem.config.cjs --update-env 2>&1" || {
      log_warn "PM2 reload failed, trying restart..."
      ssh_exec "$host" "cd '${remote_dir}/current/server' && pm2 startOrRestart ecosystem.config.cjs --update-env 2>&1" || {
        log_warn "Restart failed, trying start..."
        ssh_exec "$host" "cd '${remote_dir}/current/server' && pm2 start ecosystem.config.cjs 2>&1"
      }
    }
  else
    log_info "Starting PM2 application..."
    ssh_exec "$host" "cd '${remote_dir}/current/server' && pm2 start ecosystem.config.cjs 2>&1" || die "Failed to start PM2 application"
  fi

  # Save PM2 process list for reboot recovery
  ssh_exec "$host" "pm2 save --force 2>&1" || log_warn "pm2 save failed (non-fatal)"

  local restart_time=$((SECONDS - elapsed))
  log_success "Service restarted in ${restart_time}s"
}

# Stop service
stop_service() {
  local host="$1"

  log_info "Stopping service..."
  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would stop PM2 service"
    return 0
  fi

  ssh_exec "$host" "pm2 stop athena 2>&1" || log_warn "Failed to stop service (may not be running)"
  log_success "Service stopped"
}

# Get service status
get_service_status() {
  local host="$1"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    echo "DRY-RUN"
    return 0
  fi

  local status
  status=$(ssh_exec_quiet "$host" "pm2 show athena 2>/dev/null" || echo "Not running")
  echo "$status"
}

# Check application health via HTTP endpoint
check_health() {
  local host="$1" remote_dir="$2"
  local retries="${HEALTH_RETRIES:-5}"
  local timeout="${HEALTH_TIMEOUT:-5000}"
  local port="${CONFIG_APP_PORT:-3001}"

  log_step "Health check"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would check health at port ${port}"
    return 0
  fi

  local elapsed=$SECONDS

  # Give the service a moment to start
  sleep 2

  local healthy=false
  local response=""
  local attempt

  for ((attempt = 1; attempt <= retries; attempt++)); do
    log_detail "Attempt ${attempt}/${retries}..."

    response=$(ssh_exec_quiet "$host" "curl -s --max-time 5 'http://localhost:${port}/health'" 2>/dev/null || echo "")

    if [[ -n "$response" ]]; then
      local status_field
      status_field=$(echo "$response" | jq -r '.status // empty' 2>/dev/null || echo "")
      if [[ "$status_field" == "ok" ]]; then
        healthy=true
        break
      fi
    fi

    if [[ $attempt -lt $retries ]]; then
      sleep 2
    fi
  done

  local health_time=$((SECONDS - elapsed))

  if [[ "$healthy" == true ]]; then
    log_success "Health check passed (${health_time}s)"

    # Also check memory usage
    local mem_usage
    mem_usage=$(ssh_exec_quiet "$host" "
      pm2 jlist 2>/dev/null | jq -r '.[] | select(.name == \"athena\") | .monit.memory // empty' | awk '{printf \"%.0fMB\", \$1/1048576}' 2>/dev/null || echo 'N/A'
    ")
    log_detail "Memory usage: ${mem_usage:-N/A}"

    return 0
  else
    log_error "Health check FAILED after ${retries} attempts (${health_time}s)"
    log_detail "Last response: ${response:-empty}"

    # Diagnostics
    log_info "Running diagnostics..."
    ssh_exec "$host" "
      echo '=== PM2 Status ==='
      pm2 list 2>/dev/null || echo 'PM2 not available'
      echo '=== Last logs ==='
      pm2 logs athena --lines 20 --nostream 2>/dev/null || true
      echo '=== Port check ==='
      ss -tlnp 2>/dev/null | grep -E '${port}|3001' || netstat -tlnp 2>/dev/null | grep -E '${port}|3001' || echo 'Not listening'
    " || true

    return 1
  fi
}

# Stream logs from remote
stream_logs() {
  local host="$1" lines="${2:-50}" follow="${3:-false}"

  local follow_flag=""
  [[ "$follow" == true ]] && follow_flag="--nostream"

  log_info "Fetching logs (last ${lines} lines)..."
  ssh_exec "$host" "pm2 logs athena --lines ${lines} ${follow_flag} 2>&1" || {
    log_error "Failed to fetch logs"
    log_detail "Trying journalctl fallback..."
    ssh_exec "$host" "journalctl -u athena -n ${lines} --no-pager 2>&1" || true
  }
}

# Monitor PM2 processes
monitor_service() {
  local host="$1"

  log_info "PM2 process list:"
  ssh_exec "$host" "pm2 list 2>&1" || log_error "Cannot get process list"

  log_info "PM2 process details:"
  ssh_exec "$host" "pm2 show athena 2>&1" || log_error "Cannot get process details"
}

# Verify PM2 startup is configured for reboot resilience
verify_startup() {
  local host="$1"

  log_step "Verifying reboot auto-start"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would verify PM2 startup"
    return 0
  fi

  local startup_status
  startup_status=$(ssh_exec_quiet "$host" "pm2 startup 2>&1" || echo "unknown")

  if echo "$startup_status" | grep -q "already"; then
    log_success "PM2 startup already configured"
  else
    log_info "Configuring PM2 startup..."
    ssh_exec "$host" "pm2 startup systemd -u $(ssh_exec_quiet "$host" "whoami") --hp \$HOME 2>&1" || {
      log_warn "PM2 startup failed (may need sudo)"
      ssh_exec "$host" "sudo pm2 startup systemd -u $(ssh_exec_quiet "$host" "whoami") --hp \$HOME 2>&1" || log_warn "PM2 startup setup failed"
    }
  fi

  # Ensure process list is saved
  ssh_exec "$host" "pm2 save --force 2>&1" || log_warn "pm2 save failed"

  log_success "Reboot resilience configured"
}

# Full service setup: install PM2, generate config, start, save, verify startup
setup_service() {
  local host="$1" remote_dir="$2"

  ensure_pm2 "$host"
  generate_ecosystem_config "$host" "$remote_dir"
  restart_service "$host" "$remote_dir"
  sleep 2
  verify_startup "$host"
}

# Reload environment variables without restart
reload_env() {
  local host="$1" remote_dir="$2"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would reload PM2 env"
    return 0
  fi

  log_info "Reloading environment..."
  ssh_exec "$host" "cd '${remote_dir}/current/server' && pm2 restart athena --update-env 2>&1" || log_warn "Failed to reload env"
  log_success "Environment reloaded"
}

# Get PM2 log file paths
get_log_paths() {
  local host="$1" remote_dir="$2"

  ssh_exec_quiet "$host" "
    echo 'Error log: ${remote_dir}/shared/logs/athena-error.log'
    echo 'Output log: ${remote_dir}/shared/logs/athena-out.log'
  "
}
