# Using Plugins

Install, enable, and configure atlcli plugins.

## Plugin Location

Plugins are stored at `~/.atlcli/plugins/`.

## Installing Plugins

### From npm (future)

```bash
atlcli plugin install @atlcli/plugin-git
```

### From Local File

```bash
atlcli plugin install ./my-plugin
```

### From Git Repository

```bash
atlcli plugin install https://github.com/user/atlcli-plugin-custom.git
```

## Managing Plugins

### List Installed

```bash
atlcli plugin list
```

Output:

```
Name     Version  Status   Description
git      1.0.0    enabled  Git integration
custom   0.1.0    disabled Custom workflow
```

### Enable Plugin

```bash
atlcli plugin enable git
```

### Disable Plugin

```bash
atlcli plugin disable git
```

### Remove Plugin

```bash
atlcli plugin remove custom
```

## Configuration

### Global Config

Enable plugins in `~/.atlcli/config.json`:

```json
{
  "plugins": {
    "enabled": ["git"],
    "path": "~/.atlcli/plugins"
  }
}
```

### Plugin-Specific Config

Some plugins have their own configuration:

```json
{
  "plugins": {
    "git": {
      "autoCommit": true,
      "branch": "main"
    }
  }
}
```

## Plugin Commands

Plugins can add new commands:

```bash
# Git plugin adds commit command
atlcli wiki docs commit -m "Update documentation"
```

List available commands from a plugin:

```bash
atlcli plugin commands git
```

## Troubleshooting

### Plugin Not Loading

1. Check plugin is enabled: `atlcli plugin list`
2. Verify plugin path exists
3. Check for syntax errors in plugin code

### Command Conflicts

If two plugins define the same command, the first enabled wins. Disable conflicting plugins or use namespaced commands:

```bash
atlcli git:commit  # Namespaced command
```
