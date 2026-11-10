---
title: "Creating Plugins"
description: "Creating Plugins - atlcli documentation"
---

# Creating Plugins

A plugin is a TypeScript or JavaScript module that adds top-level commands to atlcli and can run code before and after every command.

## Prerequisites

- atlcli installed
- TypeScript or JavaScript knowledge

A plugin runs inside the atlcli process with your user's rights and sees every command line. Install only plugins you trust.

## Plugin Structure

```
my-plugin/
├── package.json
└── index.ts
```

### package.json

```json
{
  "name": "atlcli-plugin-hello",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./index.ts" },
  "atlcli": { "plugin": true }
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `exports["."]` or `main` | Optional | Entry file, relative to the plugin directory. Default: `src/index.ts`. A directory without `package.json` loads `index.ts` |
| `atlcli.plugin` | Optional | `true` lets atlcli load a directory that you copied to `~/.atlcli/plugins/` by hand. `atlcli plugin install` does not need it |

atlcli loads the entry file itself, so TypeScript needs no build step. `plugin install` copies the directory and does not install dependencies: import only your own files and Node built-ins (`node:fs`, `node:path`, ...).

### index.ts (minimal)

The default export is the plugin. `name` and `version` are required.

```typescript
export default {
  name: "hello",
  version: "1.0.0",
  description: "Says hello",
  commands: [
    {
      name: "hello",
      description: "Greetings",
      subcommands: [
        {
          name: "world",
          description: "Say hello world",
          handler: async (ctx) => {
            if (ctx.output.json) console.log(JSON.stringify({ message: "Hello, World!" }));
            else console.log("Hello, World!");
          },
        },
      ],
    },
  ],
};
```

## Install and Test

```bash
atlcli plugin install ./my-plugin   # copies to ~/.atlcli/plugins/hello and enables it
atlcli plugin list
atlcli hello world
atlcli hello --help
```

`plugin install` copies the directory. After you edit the source, run `atlcli plugin remove hello` and install again.

## Plugin API

The types live in the `@atlcli/plugin-api` package of the atlcli repository. The package is not published to npm. Inside the atlcli repository, import the types with `import type { AtlcliPlugin } from "@atlcli/plugin-api"`; a type-only import is erased when atlcli loads the plugin. An installed plugin outside the repository exports a plain object as shown above.

### Plugin

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `name` | string | Required | Unique plugin name, used by `plugin enable`, `disable` and `remove` |
| `version` | string | Required | Plugin version |
| `description` | string | Optional | Shown by `plugin list` |
| `commands` | array | Optional | Top-level commands to add |
| `hooks` | object | Optional | `beforeCommand`, `afterCommand`, `onError` |
| `initialize` | async function | Optional | Runs once when atlcli loads the plugin |
| `cleanup` | async function | Optional | Runs when the plugin is disabled or removed |

### Commands

A command adds `atlcli <name>`. Use lowercase letters, digits and hyphens for the name. A name that another plugin already registered fails the load, and a built-in atlcli command always wins over a plugin command with the same name.

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `name` | string | Required | Command name |
| `description` | string | Required | Shown in `atlcli --help` and the command help |
| `subcommands` | array | Optional | Each has `name`, `description`, `handler` and optional `flags` |
| `flags` | array | Optional | Flags that apply to the command and all its subcommands |
| `handler` | async function | Optional | Runs when the first argument names no subcommand. Without it, a bare `atlcli <name>` prints the help and an unknown subcommand is a usage error (exit code 1) |

Subcommands are one level deep. For `atlcli git hook install`, the `hook` handler reads `ctx.args[0]` itself.

### Flags

atlcli applies a flag definition before it calls the handler.

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `name` | string | Required | Flag name without `--`. The key in `ctx.flags` |
| `description` | string | Required | Shown in the command help |
| `alias` | string | none | One letter. `-f` sets `ctx.flags.force` when the flag `force` has the alias `f` |
| `hasValue` | boolean | `false` | `false`: a switch, `ctx.flags[name]` is `true`, and the argument after it stays positional. `true`: the flag takes a value; without one the command fails with a usage error |
| `default` | string, boolean or string array | none | Value of `ctx.flags[name]` when the flag is not given |
| `required` | boolean | `false` | A missing flag fails with a usage error and the handler does not run |

A flag that is given several times arrives as a string array. Flags without a definition still reach `ctx.flags`, parsed by the general rules: a long flag takes the next argument as its value unless that argument starts a flag.

### Context

Handlers and hooks receive one context object:

| Field | Type | Meaning |
|-------|------|---------|
| `command` | string array | Handler: `[command, subcommand]`. Hook: the full command line without flags, such as `["wiki", "docs", "pull", "./docs"]` |
| `args` | string array | Positional arguments after the command (handler: after the subcommand) |
| `flags` | object | Parsed flags: `true`, a string, or a string array |
| `output.json` | boolean | `true` when the user passed `--json`. Print exactly one JSON document to stdout then |

To report a failure, throw an error or set `process.exitCode`.

### Hooks

Hooks run for every atlcli command, built-in or plugin. Check `ctx.command` to pick the ones you care about.

| Hook | When | Effect of a thrown error |
|------|------|--------------------------|
| `beforeCommand(ctx)` | Before the command runs | The command does not run |
| `afterCommand(ctx)` | After the command succeeded | The command fails |
| `onError(ctx, error)` | After the command threw | Replaces the original error |

There are no per-command hook names such as `docs:push:before`.

## Example: Flags and a Hook

```typescript
export default {
  name: "greeter",
  version: "1.0.0",
  commands: [
    {
      name: "greet",
      description: "Greet someone",
      subcommands: [
        {
          name: "person",
          description: "Greet one person",
          flags: [
            { name: "name", alias: "n", description: "Who to greet", hasValue: true, required: true },
            { name: "greeting", description: "Greeting word", hasValue: true, default: "Hello" },
            { name: "loud", alias: "l", description: "Use uppercase" },
          ],
          handler: async (ctx) => {
            let message = `${ctx.flags.greeting}, ${ctx.flags.name}!`;
            if (ctx.flags.loud) message = message.toUpperCase();
            console.log(ctx.output.json ? JSON.stringify({ message }) : message);
          },
        },
      ],
    },
  ],
  hooks: {
    afterCommand: async (ctx) => {
      if (ctx.command[0] === "wiki" && ctx.command[1] === "docs" && ctx.command[2] === "pull") {
        console.error("[greeter] docs pulled");
      }
    },
  },
};
```

```bash
atlcli greet person -n Ada -l        # HELLO, ADA!
atlcli greet person --loud           # usage error: --name is required.
```

## Troubleshooting

- **`Failed to load plugin`**: the entry file threw on import, or its default export has no `name` or `version`. A missing module usually means the plugin imports an npm package; installed plugins get no `node_modules`.
- **`Command "x" from plugin "a" conflicts with plugin "b"`**: two plugins register the same command name. Rename one.
- **The command does not appear**: check `atlcli plugin list`. A disabled plugin registers nothing, and a built-in command with the same name takes precedence.
- **Changes do not show up**: `plugin install` made a copy. Remove and install again.

## Related Topics

- [Using Plugins](using-plugins.md) - Install and manage plugins
- [Git Plugin](plugin-git.md) - A bundled plugin with a command and a hook
- [CLI Commands](../reference/cli-commands.md) - `atlcli plugin` reference
