# JSONL Logging System Spec

## Overview

Add comprehensive JSONL logging for observability and enterprise audit requirements. Logs all operations (API calls, CLI commands, sync events, auth changes, errors) to both global and project-level directories.

## User Requirements

- **Log locations**: Both `~/.atlcli/logs/` (global) AND `.atlcli/logs/` (per-project)
- **Log scope**: All operations (API calls, CLI commands, sync events, auth changes, errors)
- **Sensitive data**: Redact tokens/passwords only (keep content, titles, emails)
- **Retention**: Unlimited (no auto-delete)
- **API detail**: Full request/response bodies
- **Querying**: CLI query command + plain JSONL files for standard tools
- **Configuration**: Configurable log levels (off/error/warn/info/debug) + `--no-log` flag

---

## Log Entry Schema

```typescript
interface BaseLogEntry {
  id: string;           // UUID v4
  timestamp: string;    // ISO 8601
  level: "error" | "warn" | "info" | "debug";
  type: "api.request" | "api.response" | "cli.command" | "cli.result" | "sync.event" | "auth.change" | "error";
  pid: number;
  sessionId: string;    // Unique per CLI invocation
}

// Types: api.request, api.response, cli.command, cli.result, sync.event, auth.change, error
// Each with specific `data` fields (see implementation)
```

## Configuration Schema

```typescript
// ~/.atlcli/config.json extension
{
  "logging": {
    "level": "info",      // off | error | warn | info | debug
    "global": true,       // Enable ~/.atlcli/logs/
    "project": true       // Enable .atlcli/logs/
  }
}
```

---

## CLI Interface

```bash
# Query commands
atlcli log list [--since <date>] [--until <date>] [--level <level>] [--type <type>] [--limit <n>]
atlcli log tail [-f] [--level <level>]
atlcli log show <id>
atlcli log clear [--before <date>] --confirm

# Global flag to disable logging
atlcli docs push ./docs --no-log
```

---

## Files to Create

| File | Purpose |
|------|---------|
| `packages/core/src/logger.ts` | Logger class, JSONL writing, level filtering |
| `packages/core/src/redact.ts` | Token/password redaction utilities |
| `packages/core/src/logger.test.ts` | Logger unit tests |
| `apps/cli/src/commands/log.ts` | Query command (list/tail/show/clear) |

## Files to Modify

| File | Changes |
|------|---------|
| `packages/core/src/index.ts` | Export logger and redact modules |
| `packages/core/src/config.ts` | Add LoggingConfig type to Config |
| `apps/cli/src/index.ts` | Add --no-log flag, init logging, add log command, wrap command execution |
| `packages/confluence/src/client.ts` | Log API requests/responses in request(), requestV2(), requestMultipart(), requestBinary() |
| `apps/cli/src/commands/sync.ts` | Log sync events in emit() |
| `apps/cli/src/commands/auth.ts` | Log auth changes (login, logout, switch, delete) |
| `packages/core/src/utils.ts` | Log errors in fail() |

---

## Log File Structure

```
~/.atlcli/
└── logs/
    ├── 2026-01-12.jsonl    # Daily log files
    ├── 2026-01-11.jsonl
    └── ...

./project/.atlcli/
└── logs/
    ├── 2026-01-12.jsonl    # Project-specific logs
    └── ...
```

Each `.jsonl` file: one JSON object per line, machine-parseable.

---

## Redaction Strategy

**Redacted** (replaced with `[REDACTED]`):
- `token`, `apiToken`, `api_token`
- `password`, `secret`
- `Authorization` header values
- Any key containing "token", "password", "secret"

**NOT redacted** (per user requirement):
- `email` - User identification for audit
- `title` - Page titles
- `content` - Page content/body
- `displayName` - User names

---

## Implementation Order

### Phase 1: Core Logger Infrastructure
1. Create `packages/core/src/redact.ts` with `redactSensitive()` function
2. Create `packages/core/src/logger.ts` with:
   - `Logger` class (singleton pattern)
   - JSONL file writing (daily rotation)
   - Level filtering
   - Request ID generation for correlation
3. Add unit tests
4. Export from `packages/core/src/index.ts`

### Phase 2: Configuration
1. Add `LoggingConfig` interface to `packages/core/src/config.ts`
2. Update Config type with optional `logging` field

### Phase 3: CLI Integration
1. Add `--no-log` global flag parsing in `apps/cli/src/index.ts`
2. Initialize logger on CLI startup
3. Log command start (cli.command) and end (cli.result)
4. Add error logging in `packages/core/src/utils.ts` fail()

### Phase 4: API Client Logging
1. Add logging to `ConfluenceClient.request()` (lines 96-165)
2. Add logging to `ConfluenceClient.requestV2()` (lines 171-238)
3. Add logging to `ConfluenceClient.requestMultipart()` (lines 988-1046)
4. Add logging to `ConfluenceClient.requestBinary()` (lines 1051-1092)
5. Track request IDs for request/response correlation

### Phase 5: Event Logging
1. Add sync event logging in `apps/cli/src/commands/sync.ts` emit()
2. Add auth change logging in `apps/cli/src/commands/auth.ts`

### Phase 6: Query Command
1. Create `apps/cli/src/commands/log.ts` with:
   - `list` - Filter/query logs
   - `tail` - Stream logs (with -f follow)
   - `show` - Show single entry details
   - `clear` - Clear old logs
2. Add to command routing in `apps/cli/src/index.ts`
3. Update help text

---

## Key Implementation Details

### Logger Singleton

```typescript
export class Logger {
  private static instance: Logger | null = null;
  private level: LogLevel = "info";
  private globalDir: string | null = null;
  private projectDir: string | null = null;
  private sessionId: string;
  private disabled = false;

  static getInstance(): Logger;
  static configure(options: LoggerOptions): void;
  static disable(): void;  // For --no-log

  api(type: "request" | "response", data: ApiData): void;
  command(data: CommandData): void;
  result(data: ResultData): void;
  sync(data: SyncData): void;
  auth(data: AuthData): void;
  error(error: Error, context?: object): void;
}
```

### API Logging Pattern

```typescript
// In client.ts request() method
const requestId = crypto.randomUUID();
const startTime = Date.now();

logger.api("request", {
  requestId,
  method,
  url: url.toString(),
  path,
  headers: redactSensitive(headers),
  body: redactSensitive(body),
});

// ... fetch ...

logger.api("response", {
  requestId,
  status: res.status,
  body: data,
  durationMs: Date.now() - startTime,
});
```

---

## Verification

After implementation:

```bash
# 1. Run a command and check logs created
atlcli page list --space DOCSY
ls ~/.atlcli/logs/
cat ~/.atlcli/logs/$(date +%Y-%m-%d).jsonl | head -5

# 2. Test --no-log flag
atlcli page list --space DOCSY --no-log
# Should not add new entries

# 3. Test query commands
atlcli log list --limit 10
atlcli log list --type api.request --since "1h"
atlcli log show <id-from-list>

# 4. Verify redaction
cat ~/.atlcli/logs/*.jsonl | grep -i token
# Should only show [REDACTED]

# 5. Run tests
bun test packages/core/src/logger.test.ts
```
