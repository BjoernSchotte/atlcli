---
title: "Creating Plugins"
description: "Creating Plugins - atlcli documentation"
---

# Creating Plugins

Build custom plugins for atlcli.

## Prerequisites

- Node.js or Bun runtime
- TypeScript knowledge
- atlcli installed

## Plugin Structure

```
my-plugin/
├── package.json
├── index.ts
└── README.md
```

### package.json

```json
{
  "name": "@atlcli/plugin-example",
  "version": "1.0.0",
  "main": "index.ts",
  "atlcli": {
    "name": "example",
    "description": "Example plugin"
  }
}
```

### index.ts

```typescript
import type { Plugin, PluginContext } from '@atlcli/core';

const plugin: Plugin = {
  name: 'example',
  version: '1.0.0',

  // Called when plugin loads
  async init(ctx: PluginContext) {
    console.log('Example plugin loaded');
  },

  // Register commands
  commands: [
    {
      name: 'hello',
      description: 'Say hello',
      async handler(args, flags, ctx) {
        console.log('Hello from plugin!');
      }
    }
  ],

  // Hook into existing commands
  hooks: {
    'docs:push:before': async (ctx) => {
      console.log('About to push docs...');
    },
    'docs:push:after': async (ctx, result) => {
      console.log('Docs pushed successfully');
    }
  }
};

export default plugin;
```

## Plugin API

### Context

Plugins receive a context object:

```typescript
interface PluginContext {
  config: Config;          // atlcli configuration
  credentials: Credentials; // Auth credentials
  logger: Logger;          // Logging utilities
  confluence: ConfluenceClient;
  jira: JiraClient;
}
```

### Commands

Register custom commands:

```typescript
commands: [
  {
    name: 'my-command',
    description: 'Does something',
    options: [
      { name: 'verbose', alias: 'v', type: 'boolean' }
    ],
    async handler(args, flags, ctx) {
      if (flags.verbose) {
        ctx.logger.debug('Verbose mode');
      }
      // Implementation
    }
  }
]
```

### Hooks

Hook into command lifecycle:

| Hook | When |
|------|------|
| `docs:pull:before` | Before pulling docs |
| `docs:pull:after` | After pulling docs |
| `docs:push:before` | Before pushing docs |
| `docs:push:after` | After pushing docs |
| `jira:create:before` | Before creating issue |
| `jira:create:after` | After creating issue |

## Testing

Test your plugin locally:

```bash
# Install locally
atlcli plugin install ./my-plugin

# Enable
atlcli plugin enable example

# Test command
atlcli hello
```

## Publishing

Publish to npm:

```bash
npm publish --access public
```

Users can then install:

```bash
atlcli plugin install @atlcli/plugin-example
```

## Related Topics

- [Using Plugins](using-plugins.md) - Install and manage plugins
- [Git Plugin](plugin-git.md) - Example of a bundled plugin
- [Configuration](../configuration.md) - Plugin configuration options
