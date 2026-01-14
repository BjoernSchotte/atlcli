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

## Sections

- [Using Plugins](using-plugins.md) - Install, enable, configure plugins
- [Creating Plugins](creating-plugins.md) - Build your own plugins
- [Git Plugin](plugin-git.md) - Git integration documentation
