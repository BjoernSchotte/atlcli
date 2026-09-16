#!/bin/bash
set -eo pipefail

REPO="BjoernSchotte/atlcli"
INSTALL_DIR="${ATLCLI_INSTALL:-$HOME/.atlcli}"
BIN_DIR="$INSTALL_DIR/bin"

error() { echo -e "\033[0;31mError: $1\033[0m" >&2; exit 1; }
info() { echo -e "\033[0;32m$1\033[0m"; }
warn() { echo -e "\033[1;33m$1\033[0m"; }

detect_platform() {
  local os=$(uname -s)
  local arch=$(uname -m)

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) error "Unsupported OS: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac

  echo "${os}-${arch}"
}

get_latest_version() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep '"tag_name"' \
    | sed -E 's/.*"([^"]+)".*/\1/'
}

verify_checksum() {
  local file="$1"
  local checksums_url="$2"

  local checksums
  checksums=$(curl -fsSL "$checksums_url" 2>/dev/null) || {
    error "Could not download release checksums"
  }

  local expected
  expected=$(printf '%s\n' "$checksums" | awk -v name="$(basename "$file")" '$2 == name || $2 == "*" name {print $1}')
  if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then
    error "Missing, duplicate or invalid checksum for $(basename "$file")"
  fi

  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$file" | awk '{print $1}')
  else
    error "Install sha256sum or shasum to verify the release"
  fi

  if [ "$actual" != "$expected" ]; then
    rm -f "$file"
    error "Checksum mismatch (expected $expected, got $actual)"
  fi

  info "Checksum verified ✓"
}

install_atlcli() {
  local version="${1:-$(get_latest_version)}"
  local target=$(detect_platform)
  local asset="atlcli-$target.tar.gz"
  local base_url="https://github.com/$REPO/releases/download/$version"

  info "Installing atlcli $version ($target)..."

  mkdir -p "$BIN_DIR"

  local tmpdir
  tmpdir=$(mktemp -d)
  trap "rm -rf '$tmpdir'" EXIT

  if ! curl -fsSL -o "$tmpdir/$asset" "$base_url/$asset"; then
    error "Failed to download from $base_url/$asset"
  fi

  verify_checksum "$tmpdir/$asset" "$base_url/checksums.txt"

  # Inspect the exact flat file set before extraction; never follow archive links.
  local entries
  entries=$(tar -tzf "$tmpdir/$asset") || error "Invalid release archive"
  local expected_entries="atlcli"
  if printf '%s\n' "$entries" | grep -qx 'atlcli-confluence-nfs'; then
    expected_entries=$(printf '%s\n' LICENSE-nfsserve THIRD-PARTY-nfs.html atlcli atlcli-confluence-nfs nfs-helper-build.json)
  fi
  if [ "$(printf '%s\n' "$entries" | LC_ALL=C sort)" != "$expected_entries" ]; then
    error "Unexpected release archive files"
  fi
  tar -tvzf "$tmpdir/$asset" | awk 'substr($0, 1, 1) != "-" {exit 1}' || error "Release archive contains non-regular files"
  mkdir "$tmpdir/extracted"
  if ! tar -xzf "$tmpdir/$asset" -C "$tmpdir/extracted"; then
    error "Failed to extract archive"
  fi

  chmod +x "$tmpdir/extracted/atlcli"
  if [ -f "$tmpdir/extracted/atlcli-confluence-nfs" ]; then
    chmod +x "$tmpdir/extracted/atlcli-confluence-nfs"
    mv "$tmpdir/extracted/atlcli-confluence-nfs" "$BIN_DIR/atlcli-confluence-nfs"
    mv "$tmpdir/extracted/LICENSE-nfsserve" "$tmpdir/extracted/THIRD-PARTY-nfs.html" "$tmpdir/extracted/nfs-helper-build.json" "$BIN_DIR/"
  else
    # Older CLI-only releases must not discover an incompatible leftover helper.
    rm -f "$BIN_DIR/atlcli-confluence-nfs" "$BIN_DIR/LICENSE-nfsserve" "$BIN_DIR/THIRD-PARTY-nfs.html" "$BIN_DIR/nfs-helper-build.json"
  fi
  mv "$tmpdir/extracted/atlcli" "$BIN_DIR/atlcli"
  info "Installed to $BIN_DIR/atlcli"
}

update_shell_config() {
  local config_file=""
  local path_line=""

  case "${SHELL:-}" in
    */zsh)
      config_file="$HOME/.zshrc"
      path_line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    */bash)
      config_file="${HOME}/.bashrc"
      [ -f "$HOME/.bash_profile" ] && config_file="$HOME/.bash_profile"
      path_line="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    */fish)
      config_file="$HOME/.config/fish/config.fish"
      path_line="fish_add_path $BIN_DIR"
      ;;
  esac

  if [ -n "$config_file" ]; then
    if ! grep -q "atlcli" "$config_file" 2>/dev/null; then
      echo "" >> "$config_file"
      echo "# atlcli" >> "$config_file"
      echo "$path_line" >> "$config_file"
      warn "Added to PATH in $config_file"
      warn "Run: source $config_file"
    fi
  fi
}

verify_install() {
  if [ -x "$BIN_DIR/atlcli" ]; then
    info ""
    info "atlcli installed successfully!"
    info ""
    "$BIN_DIR/atlcli" --version 2>/dev/null || true
  else
    error "Installation failed"
  fi
}

main() {
  install_atlcli "$1"
  update_shell_config
  verify_install
}

main "$@"
