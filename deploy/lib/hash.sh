# === Hash Manifest System ===
# SHA256-based file change detection and manifest management

MANIFEST_NAME=".deploy-manifest.json"

# Strip trailing slash
_clean_path() { echo "${1%/}"; }

# Core deployable files relative to project root
get_deployable_files() {
  local project_dir="$1"
  project_dir=$(_clean_path "$project_dir")

  find "$project_dir" \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/data/*' \
    -not -path '*/__pycache__/*' \
    -not -path '*.log' \
    -not -path '*/deploy/*' \
    -not -name 'deploy.sh' \
    -not -name '.env*' \
    -not -name '*.png' \
    -not -name '*.webp' \
    -not -name 'photo-*' \
    -type f \
    \( \
      -path '*/server/*' -o \
      -path '*/smart-routing-core/*' -o \
      -name 'package.json' -o \
      -name 'package-lock.json' -o \
      -name 'tsconfig*' -o \
      -name 'vite.config.*' -o \
      -name '.env.production' -o \
      -name '.npmrc' \
    \) 2>/dev/null || true
}

# Generate SHA256 manifest as JSON
generate_manifest() {
  local project_dir="$1"
  project_dir=$(_clean_path "$project_dir")
  local manifest_file

  manifest_file=$(mktemp /tmp/athena-manifest-XXXXXX.json) || die "Cannot create temp file"

  local file_count=0
  local first=true

  echo '{' > "$manifest_file"
  echo '  "version": "2.0",' >> "$manifest_file"
  printf '  "timestamp": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$manifest_file"
  echo '  "files": [' >> "$manifest_file"

  while IFS= read -r -d '' file; do
    local relpath="${file#$project_dir/}"
    local hash
    hash=$(sha256sum "$file" | awk '{print $1}')
    local size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)

    $first || echo ',' >> "$manifest_file"
    first=false
    printf '    {"path":%s,"hash":"%s","size":%d}' \
      "$(echo "$relpath" | jq -R .)" "$hash" "$size" >> "$manifest_file"
    file_count=$((file_count + 1))
  done < <(get_deployable_files "$project_dir")

  echo '' >> "$manifest_file"
  echo '  ]' >> "$manifest_file"
  echo '}' >> "$manifest_file"

  local combined_hash
  combined_hash=$(sha256sum "$manifest_file" | awk '{print $1}')

  # Add combined hash at the end using temporary file manipulation
  sed -i 's/}$/},/' "$manifest_file" 2>/dev/null || true
  printf '"combinedHash": "%s"\n}' "$combined_hash" >> "$manifest_file"

  log_debug "Generated manifest: ${file_count} files, hash=${combined_hash}"

  echo "$manifest_file"
}

# Get remote manifest path
remote_manifest_path() {
  local remote_dir="$1"
  echo "${remote_dir}/${MANIFEST_NAME}"
}

# Read remote manifest and save to local temp file
fetch_remote_manifest() {
  local host="$1" remote_dir="$2"
  local tmp_file
  tmp_file=$(mktemp /tmp/athena-remote-manifest-XXXXXX.json) || die "Cannot create temp file"

  if ssh_path_exists "$host" "$(remote_manifest_path "$remote_dir")"; then
    ssh_exec_quiet "$host" "cat '$(remote_manifest_path "$remote_dir")'" > "$tmp_file" 2>/dev/null || \
      echo '{"version":"2.0","files":[],"combinedHash":""}' > "$tmp_file"
  else
    echo '{"version":"2.0","files":[],"combinedHash":""}' > "$tmp_file"
  fi

  echo "$tmp_file"
}

# Compare manifests and return changed/new files as JSON array
# Returns: JSON array of {path, hash, size} objects that differ
compare_manifests() {
  local local_manifest="$1" remote_manifest="$2"

  if [[ ! -f "$local_manifest" ]]; then
    die "Local manifest not found: $local_manifest"
  fi

  if [[ ! -f "$remote_manifest" ]]; then
    cat "$local_manifest"
    return
  fi

  local tmp_file
  tmp_file=$(mktemp /tmp/athena-diff-XXXXXX.json)

  # Use jq to find files that are different
  jq -n --argjson local "$(cat "$local_manifest")" --argjson remote "$(cat "$remote_manifest")" '
    [
      $local.files[] | . as $lf |
      if (
        $remote.files[] | select(.path == $lf.path) | .hash == $lf.hash
      ) then empty else $lf end
    ]
  ' > "$tmp_file" 2>/dev/null || {
    # Fallback: if jq fails, return all files from local
    log_warn "jq comparison failed, returning all files"
    jq '{files: .files}' "$local_manifest" > "$tmp_file" 2>/dev/null || cat "$local_manifest" > "$tmp_file"
  }

  echo "$tmp_file"
}

# Get list of changed file paths from a diff manifest
get_changed_paths() {
  local diff_manifest="$1"
  jq -r '.[] | .path' "$diff_manifest" 2>/dev/null | tr '\n' ':' | sed 's/:$//'
}

# Count changed files
count_changes() {
  local diff_manifest="$1"
  jq 'length' "$diff_manifest" 2>/dev/null || echo 0
}

# Get total size of changed files in bytes
total_changed_size() {
  local diff_manifest="$1"
  jq '[.[] | .size] | add // 0' "$diff_manifest" 2>/dev/null || echo 0
}

# Upload manifest to remote atomically
upload_manifest() {
  local host="$1" local_manifest="$2" remote_dir="$3"
  local remote_manifest
  remote_manifest=$(remote_manifest_path "$remote_dir")
  local tmp_remote="${remote_manifest}.${RANDOM}.tmp"

  ssh_copy "$local_manifest" "${host}:${tmp_remote}" || die "Failed to upload manifest"
  ssh_exec "$host" "mv '$tmp_remote' '$remote_manifest'" || die "Failed to finalize manifest upload"
  log_debug "Manifest uploaded to ${remote_manifest}"
}

# Check if package-lock.json has changed between manifests
has_lock_changed() {
  local local_manifest="$1" remote_manifest="$2"

  local local_lock
  local_lock=$(jq -r '.files[] | select(.path == "server/package-lock.json") | .hash' "$local_manifest" 2>/dev/null || echo "")
  local remote_lock
  remote_lock=$(jq -r '.files[] | select(.path == "server/package-lock.json") | .hash' "$remote_manifest" 2>/dev/null || echo "")

  [[ "$local_lock" != "$remote_lock" ]]
}

# Check if node_modules should be invalidated (package.json or lock changes)
has_deps_changed() {
  local local_manifest="$1" remote_manifest="$2"

  local local_pkg
  local_pkg=$(jq -r '.files[] | select(.path == "server/package.json") | .hash' "$local_manifest" 2>/dev/null || echo "")
  local remote_pkg
  remote_pkg=$(jq -r '.files[] | select(.path == "server/package.json") | .hash' "$remote_manifest" 2>/dev/null || echo "")
  local local_lock
  local_lock=$(jq -r '.files[] | select(.path == "server/package-lock.json") | .hash' "$local_manifest" 2>/dev/null || echo "")
  local remote_lock
  remote_lock=$(jq -r '.files[] | select(.path == "server/package-lock.json") | .hash' "$remote_manifest" 2>/dev/null || echo "")

  [[ "$local_pkg" != "$remote_pkg" || "$local_lock" != "$remote_lock" ]]
}
