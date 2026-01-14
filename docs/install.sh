#!/bin/bash
set -e

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

install_atlcli() {
  local version="${1:-$(get_latest_version)}"
  local target=$(detect_platform)
  local url="https://github.com/$REPO/releases/download/$version/atlcli-$target.tar.gz"

  info "Installing atlcli $version ($target)..."

  mkdir -p "$BIN_DIR"

  if ! curl -fsSL "$url" | tar -xz -C "$BIN_DIR"; then
    error "Failed to download from $url"
  fi

  chmod +x "$BIN_DIR/atlcli"
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
