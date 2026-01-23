# Plugins

Extend atlcli with custom functionality.

## Overview

The plugin system allows you to:

- Add custom commands
- Hook into existing commands
- Integrate with external tools
- Automate workflows

## Available Plugins

- [Git Plugin](plugin-git.md) - Git integration for Confluence sync

## Quick Start

### Enable a Plugin

```bash
atlcli plugin enable git
```

### Disable a Plugin

```bash
atlcli plugin disable git
```

### List Plugins

```bash
atlcli plugin list
```

## Related Topics

- [CLI Commands](../reference/cli-commands.md) - Plugin commands reference
- [Configuration](../configuration.md) - Plugin configuration
