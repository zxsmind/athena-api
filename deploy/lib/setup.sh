# === Remote Setup System ===
# Environment detection, dependency installation, build orchestration

# Detect OS on remote and install required system packages
setup_system_packages() {
  local host="$1"
  local os
  os=$(ssh_detect_os "$host")

  log_step "Setting up system packages (OS: ${os})"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would install system packages for ${os}"
    return 0
  fi

  # Required tools list
  local packages=()

  # Check and add each needed package
  if ! ssh_exec_quiet "$host" "command -v jq >/dev/null 2>&1"; then
    packages+=("jq")
  fi
  if ! ssh_exec_quiet "$host" "command -v curl >/dev/null 2>&1"; then
    packages+=("curl")
  fi
  if ! ssh_exec_quiet "$host" "command -v rsync >/dev/null 2>&1"; then
    packages+=("rsync")
  fi
  if ! ssh_exec_quiet "$host" "command -v git >/dev/null 2>&1"; then
    packages+=("git")
  fi

  if [[ ${#packages[@]} -eq 0 ]]; then
    log_success "All system packages already installed"
    return 0
  fi

  log_info "Installing missing packages: ${packages[*]}"

  case "$os" in
    ubuntu|debian)
      ssh_exec "$host" "
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq ${packages[*]}
      " || die "Failed to install packages on ${os}"
      ;;
    alpine)
      ssh_exec "$host" "apk add --no-cache ${packages[*]}" || die "Failed to install packages on alpine"
      ;;
    centos|rhel|fedora|rocky|almalinux)
      ssh_exec "$host" "
        if command -v dnf >/dev/null 2>&1; then
          dnf install -y ${packages[*]}
        else
          yum install -y ${packages[*]}
        fi
      " || die "Failed to install packages on ${os}"
      ;;
    *)
      log_warn "Unknown OS (${os}), attempting package installation..."
      ssh_exec "$host" "
        if command -v apt-get >/dev/null 2>&1; then
          export DEBIAN_FRONTEND=noninteractive
          apt-get update -qq && apt-get install -y -qq ${packages[*]}
        elif command -v apk >/dev/null 2>&1; then
          apk add --no-cache ${packages[*]}
        elif command -v dnf >/dev/null 2>&1; then
          dnf install -y ${packages[*]}
        elif command -v yum >/dev/null 2>&1; then
          yum install -y ${packages[*]}
        else
          echo 'Cannot install packages, please install manually: ${packages[*]}'
          exit 1
        fi
      " || die "Failed to install packages"
      ;;
  esac

  log_success "System packages installed"
}

# Setup Node.js on remote (if not present or wrong version)
setup_nodejs() {
  local host="$1" node_version="${CONFIG_NODE_VERSION:-20}"

  log_step "Setting up Node.js"

  local node_path
  node_path=$(ssh_find_node_bin "$host")

  if [[ -n "$node_path" ]]; then
    local version
    version=$(ssh_exec_quiet "$host" "$node_path --version 2>/dev/null" | sed 's/v//')
    local major
    major=$(echo "$version" | cut -d. -f1)
    log_success "Node.js v${version} found at ${node_path}"

    if [[ -n "$major" && "$major" -ge "$node_version" ]]; then
      log_detail "Version ${major}.x meets requirement (>= ${node_version})"
      return 0
    fi
    log_info "Upgrading Node.js from v${version} to v${node_version}..."
  else
    log_info "Node.js not found, installing v${node_version}..."
  fi

  ssh_ensure_node "$host" "$node_version"
}

# Install npm dependencies using npm ci (faster, deterministic)
install_dependencies() {
  local host="$1" remote_dir="$2"

  log_step "Installing dependencies"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would run npm ci in ${remote_dir}/server"
    return 0
  fi

  # First, install smart-routing-core dependencies
  if ssh_path_exists "$host" "${remote_dir}/smart-routing-core/package.json"; then
    log_info "Installing smart-routing-core dependencies..."
    ssh_exec "$host" "cd '${remote_dir}/smart-routing-core' && npm ci --no-audit --no-fund 2>&1" || {
      log_warn "npm ci failed for smart-routing-core, trying npm install..."
      ssh_exec "$host" "cd '${remote_dir}/smart-routing-core' && npm install --no-audit --no-fund 2>&1"
    }
    log_detail "smart-routing-core dependencies installed"
  fi

  # Build smart-routing-core first
  if ssh_path_exists "$host" "${remote_dir}/smart-routing-core/package.json"; then
    log_info "Building smart-routing-core..."
    ssh_exec "$host" "cd '${remote_dir}/smart-routing-core' && npx tsc -p tsconfig.json 2>&1" || {
      log_warn "smart-routing-core build failed, continuing..."
    }
    log_detail "smart-routing-core built"
  fi

  # Install server dependencies
  log_info "Installing server dependencies..."
  if ssh_path_exists "$host" "${remote_dir}/server/package-lock.json"; then
    ssh_exec "$host" "cd '${remote_dir}/server' && npm ci --no-audit --no-fund 2>&1" || {
      log_warn "npm ci failed, trying npm install..."
      ssh_exec "$host" "cd '${remote_dir}/server' && npm install --no-audit --no-fund 2>&1"
    }
  else
    ssh_exec "$host" "cd '${remote_dir}/server' && npm install --no-audit --no-fund 2>&1"
  fi

  log_success "Dependencies installed"
}

# Build the project on remote
build_project() {
  local host="$1" remote_dir="$2"

  log_step "Building project"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would build in ${remote_dir}/server"
    return 0
  fi

  local elapsed=$SECONDS

  # Ensure smart-routing-core is built
  if ssh_path_exists "$host" "${remote_dir}/smart-routing-core/package.json"; then
    local src_dir="${remote_dir}/smart-routing-core/src"
    if ssh_path_exists "$host" "${src_dir}"; then
      log_info "Building smart-routing-core..."
      ssh_exec "$host" "cd '${remote_dir}/smart-routing-core' && npx tsc -p tsconfig.json 2>&1" || {
        log_warn "smart-routing-core build failed"
      }
    fi
  fi

  # Build server
  log_info "Building server (tsc)..."
  ssh_exec "$host" "cd '${remote_dir}/server' && npx tsc -p tsconfig.json 2>&1" || {
    log_warn "tsc build failed, checking for errors..."
    die "TypeScript compilation failed"
  }

  local build_time=$((SECONDS - elapsed))
  log_success "Build completed in ${build_time}s"
}

# Calculate and apply optimal memory limit for the Node process
setup_memory_limit() {
  local host="$1"

  local total_mb
  total_mb=$(ssh_total_memory_mb "$host")

  if [[ -z "$total_mb" || "$total_mb" -eq 0 ]]; then
    log_warn "Cannot detect total memory, using default 512MB limit"
    MEMORY_LIMIT_MB=512
    return
  fi

  MEMORY_LIMIT_MB=$(calculate_memory_limit_mb "$total_mb")

  log_detail "Total RAM: ${total_mb}MB → Node memory limit: ${MEMORY_LIMIT_MB}MB"
}

# Setup the remote directory structure
setup_directory_structure() {
  local host="$1" remote_dir="$2"

  log_step "Setting up directory structure"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would create dirs in ${remote_dir}"
    return 0
  fi

  ssh_exec "$host" "
    mkdir -p '${remote_dir}/releases'
    mkdir -p '${remote_dir}/shared/data'
    mkdir -p '${remote_dir}/shared/logs'
  " || die "Failed to create directory structure"

  log_success "Directory structure ready"
}

# Read meta info from remote .deploy-meta.json
fetch_remote_meta() {
  local host="$1" remote_dir="$2"
  local meta_path="${remote_dir}/.deploy-meta.json"

  if ssh_path_exists "$host" "$meta_path"; then
    ssh_read_file "$host" "$meta_path"
  else
    echo "{}"
  fi
}

# Write meta info to remote
write_remote_meta() {
  local host="$1" remote_dir="$2" version="$3" commit="$4" duration="$5"
  local meta_path="${remote_dir}/.deploy-meta.json"
  local tmp="${meta_path}.${RANDOM}.tmp"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would write meta: version=${version}"
    return 0
  fi

  local user
  user=$(whoami 2>/dev/null || echo "unknown")
  local node_ver
  node_ver=$(ssh_exec_quiet "$host" "node --version 2>/dev/null || echo 'unknown'")
  local pm2_ver
  pm2_ver=$(ssh_exec_quiet "$host" "npx pm2 --version 2>/dev/null || echo 'unknown'")

  jq -n \
    --arg version "$version" \
    --arg commit "$commit" \
    --arg branch "${CONFIG_BRANCH:-main}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg duration "$duration" \
    --arg user "$user" \
    --arg node "$node_ver" \
    --arg pm2 "$pm2_ver" \
    --arg host "$(hostname)" \
    '{version:$version,gitCommit:$commit,gitBranch:$branch,timestamp:$ts,deployDuration:$duration,deployedBy:$user,nodeVersion:$node,pm2Version:$pm2,deployerHost:$host}' \
    | ssh_exec "$host" "cat > '$tmp' && mv '$tmp' '$meta_path'" || log_warn "Failed to write deploy meta"

  log_debug "Deploy meta written"
}
