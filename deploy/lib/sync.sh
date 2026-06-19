# === Sync System ===
# Hash-manifest-driven incremental file transfer

# Build a tar of only changed files, pipe over SSH and extract
# Usage: sync_incremental <host> <project_dir> <remote_dir> <changed_paths_csv>
sync_incremental() {
  local host="$1" project_dir="$2" remote_dir="$3" changed_csv="$4"
  local tmp_dir

  if [[ -z "$changed_csv" ]]; then
    log_info "No files to sync"
    return 0
  fi

  tmp_dir=$(remote_temp "$host") || die "Cannot create remote temp"

  log_info "Syncing changed files..."
  local elapsed=$SECONDS
  local file_count=0
  local total_bytes=0

  IFS=':' read -ra paths <<< "$changed_csv"
  for relpath in "${paths[@]}"; do
    [[ -z "$relpath" ]] && continue
    local full_path="$project_dir/$relpath"
    if [[ ! -f "$full_path" ]]; then
      log_debug "  (deleted) $relpath"
      ssh_exec "$host" "rm -f '${remote_dir}/${relpath}' 2>/dev/null; rmdir '$(dirname "${remote_dir}/${relpath}")' 2>/dev/null || true" || true
      continue
    fi

    local remote_parent
    remote_parent=$(dirname "${remote_dir}/${relpath}")
    ssh_exec "$host" "mkdir -p '$remote_parent'" 2>/dev/null || true

    log_debug "  → $relpath"
  done

  # Efficient bulk transfer: tar changed files, pipe over SSH, extract
  # Build include patterns for tar
  local include_args=()
  IFS=':' read -ra paths <<< "$changed_csv"
  for relpath in "${paths[@]}"; do
    [[ -z "$relpath" ]] && continue
    local full_path="$project_dir/$relpath"
    if [[ -f "$full_path" ]]; then
      include_args+=("$relpath")
      file_count=$((file_count + 1))
      local size
      size=$(stat -c%s "$full_path" 2>/dev/null || echo 0)
      total_bytes=$((total_bytes + size))
    fi
  done

  if [[ ${#include_args[@]} -eq 0 ]]; then
    log_info "No files to transfer (all deletions)"
    ssh_rm "$host" "$tmp_dir"
    return 0
  fi

  log_detail "Packing ${file_count} files (${total_bytes} bytes)..."

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would tar and pipe ${file_count} files"
    ssh_rm "$host" "$tmp_dir"
    return 0
  fi

  # Tar and pipe over SSH
  (
    cd "$project_dir" || die "Cannot cd to project dir"
    tar cf - "${include_args[@]}" 2>/dev/null
  ) | ssh_exec "$host" "cd '$remote_dir' && tar xf - 2>/dev/null" || {
    local exit_code=$?
    log_warn "tar pipe failed (exit ${exit_code}), falling back to rsync..."
    sync_rsync_fallback "$host" "$project_dir" "$remote_dir" "$changed_csv"
    ssh_rm "$host" "$tmp_dir"
    return 0
  }

  local sync_time=$((SECONDS - elapsed))
  local sync_size_hr
  if (( total_bytes > 1048576 )); then
    sync_size_hr="$(( total_bytes / 1048576 )).$(( total_bytes % 1048576 * 10 / 1048576 ))MB"
  elif (( total_bytes > 1024 )); then
    sync_size_hr="$(( total_bytes / 1024 )).$(( total_bytes % 1024 * 10 / 1024 ))KB"
  else
    sync_size_hr="${total_bytes}B"
  fi
  log_success "Synced ${file_count} files (${sync_size_hr}) in ${sync_time}s"

  ssh_rm "$host" "$tmp_dir"
}

# Fallback sync using rsync for bulk/large transfers
sync_rsync_fallback() {
  local host="$1" project_dir="$2" remote_dir="$3" changed_csv="$4"

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would rsync changed files"
    return 0
  fi

  local include_args=()
  IFS=':' read -ra paths <<< "$changed_csv"
  for relpath in "${paths[@]}"; do
    [[ -z "$relpath" ]] && continue
    include_args+=("--include=$relpath")
  done

  rsync -az --relative \
    --delete \
    --include='*/' \
    "${include_args[@]}" \
    --exclude='*' \
    -e "ssh $SSH_OPTS" \
    "$project_dir/" "${host}:${remote_dir}/" || {
    log_warn "rsync failed, trying full sync..."
    rsync -az --delete \
      -e "ssh $SSH_OPTS" \
      --exclude='node_modules' \
      --exclude='.git' \
      --exclude='dist' \
      --exclude='data' \
      --exclude='deploy' \
      "$project_dir/" "${host}:${remote_dir}/"
  }
}

# Full initial sync of all deployable files
sync_full() {
  local host="$1" project_dir="$2" remote_dir="$3"

  log_info "Performing initial full sync..."

  if [[ "${DRY_RUN:-false}" == true ]]; then
    log_detail "[dry-run] Would full sync project to ${host}:${remote_dir}"
    return 0
  fi

  local elapsed=$SECONDS

  # Exclude patterns for rsync
  rsync -az --delete \
    -e "ssh $SSH_OPTS" \
    --include='server/***' \
    --include='smart-routing-core/***' \
    --include='package.json' \
    --include='package-lock.json' \
    --include='tsconfig*.json' \
    --include='vite.config.*' \
    --include='.env.production' \
    --include='.npmrc' \
    --exclude='*' \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='data' \
    --exclude='deploy' \
    --exclude='.env*' \
    --exclude='*.png' \
    --exclude='*.webp' \
    "$project_dir/" "${host}:${remote_dir}/" || die "Initial sync failed"

  local sync_time=$((SECONDS - elapsed))
  log_success "Initial sync completed in ${sync_time}s"
}

# List release versions on remote
list_remote_releases() {
  local host="$1" remote_dir="$2"
  ssh_exec_quiet "$host" "
    ls -1d '${remote_dir}/releases/'*/ 2>/dev/null | sort -r | head -10
  "
}

# Count releases on remote
count_remote_releases() {
  local host="$1" remote_dir="$2"
  ssh_exec_quiet "$host" "
    ls -1d '${remote_dir}/releases/'*/ 2>/dev/null | wc -l
  " || echo 0
}

# Get current release symlink target
get_current_release() {
  local host="$1" remote_dir="$2"
  ssh_exec_quiet "$host" "readlink '${remote_dir}/current' 2>/dev/null || echo ''"
}

# Create a release directory and sync files into it
create_release() {
  local host="$1" remote_dir="$2" release_name="$3" project_dir="$4"

  local release_path="${remote_dir}/releases/${release_name}"
  ssh_mkdir "$host" "$release_path"

  log_info "Creating release: ${release_name}"

  # Sync all deployable files into the release directory
  rsync -az \
    -e "ssh $SSH_OPTS" \
    --include='server/***' \
    --include='smart-routing-core/***' \
    --include='package.json' \
    --include='package-lock.json' \
    --include='tsconfig*.json' \
    --include='vite.config.*' \
    --include='.env.production' \
    --include='.npmrc' \
    --exclude='*' \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='data' \
    --exclude='deploy' \
    "$project_dir/" "${host}:${release_path}/" || die "Release sync failed"

  # Create shared data directory symlinks
  ssh_exec "$host" "
    mkdir -p '${remote_dir}/shared/data' '${remote_dir}/shared/logs'
    ln -sfn '${remote_dir}/shared/data' '${release_path}/server/data'
  " || log_warn "Could not create data symlinks (non-fatal)"

  log_success "Release ${release_name} created"
  echo "$release_path"
}

# Activate a release with atomic symlink swap
activate_release() {
  local host="$1" release_path="$2" remote_dir="$3"

  log_info "Activating release: $(basename "$release_path")"
  atomic_symlink "$host" "$release_path" "${remote_dir}/current"
  log_success "Release activated"
}

# Rollback to a previous release
rollback_release() {
  local host="$1" remote_dir="$2" steps="${3:-1}"

  local current
  current=$(get_current_release "$host" "$remote_dir")
  if [[ -z "$current" ]]; then
    die "No current release to rollback from"
  fi

  local target
  target=$(ssh_exec_quiet "$host" "
    ls -1d '${remote_dir}/releases/'*/ 2>/dev/null | sort -r | tail -n +$((steps + 1)) | head -1
  ")

  if [[ -z "$target" ]]; then
    die "No previous release found to rollback to (${steps} steps back)"
  fi

  log_info "Rolling back from $(basename "$current") to $(basename "$target")"
  atomic_symlink "$host" "$target" "${remote_dir}/current"
  log_success "Rolled back to $(basename "$target")"
}

# Clean up old releases, keep N most recent
cleanup_releases() {
  local host="$1" remote_dir="$2" keep="${3:-5}"

  log_info "Cleaning old releases (keeping ${keep})..."

  local removed=0
  local total_size=0

  while IFS= read -r release; do
    local size
    size=$(ssh_exec_quiet "$host" "du -sb '$release' 2>/dev/null | cut -f1" || echo 0)
    ssh_rm "$host" "$release"
    total_size=$((total_size + size))
    removed=$((removed + 1))
    log_detail "Removed: $(basename "$release") ($(( size / 1048576 )).$(( size % 1048576 * 10 / 1048576 ))MB)"
  done < <(ssh_exec_quiet "$host" "
    ls -1d '${remote_dir}/releases/'*/ 2>/dev/null | sort -r | tail -n +$((keep + 1))
  ")

  if [[ $removed -gt 0 ]]; then
    local size_hr="$(( total_size / 1048576 )).$(( total_size % 1048576 * 10 / 1048576 ))MB"
    log_success "Cleaned ${removed} releases (${size_hr}MB freed)"
  else
    log_info "Nothing to clean"
  fi
}
