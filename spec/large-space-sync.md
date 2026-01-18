# Large Space Sync Optimization Spec

## Problem

Pulling large Confluence spaces (1k+ pages) is slow due to sequential page fetching.

**Current behavior** (docs.ts lines 544-580):
```typescript
for (let i = 0; i < pages.length; i++) {
  const detail = await client.getPageDetails(page.id);  // Sequential!
}
```

- 1257 pages = 1257 sequential HTTP requests
- `getPagesBatch()` exists but uses `getPage()`, not `getPageDetails()`
- No parallelization in the pull workflow

## Confluence Cloud Rate Limits

| Tier | Points/Hour | Burst Limit |
|------|-------------|-------------|
| Free/Standard | 65,000 | ~10-20 req/sec |
| Premium | 130,000 + (20 × users) | Higher |
| Enterprise | 150,000 + (30 × users) | Up to 500k cap |

**Point costs**: Most reads = 1 point

**Headers to monitor**:
```
X-RateLimit-Remaining: Points left
X-RateLimit-NearLimit: true if <20% quota
Retry-After: Seconds to wait (on 429)
```

## Time Estimates for 10k Pages

| Approach | Time (est.) |
|----------|-------------|
| Current (sequential) | 50-100 min |
| Parallel (concurrency 5) | 10-20 min |
| Parallel (concurrency 10) | 5-10 min |
| Delta sync (2% changed) | 1-2 min |

## Implementation Plan

### Phase 1: Parallelization (Critical)

**1.1 Add `getPageDetailsBatch()` to client.ts**

```typescript
async getPageDetailsBatch(
  ids: string[],
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<ConfluencePageDetails[]> {
  const { concurrency = 5, onProgress } = options;
  const results: ConfluencePageDetails[] = [];

  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const pages = await Promise.all(chunk.map(id => this.getPageDetails(id)));
    results.push(...pages);
    onProgress?.(results.length, ids.length);
  }

  return results;
}
```

**1.2 Update handlePull() in docs.ts**

Replace sequential loop (lines 544-580) with:

```typescript
const pageDetails = await client.getPageDetailsBatch(
  pages.map(p => p.id),
  {
    concurrency: getFlag(flags, "concurrency") ?? 5,
    onProgress: (done, total) => {
      if (!opts.json && total > 10 && done % Math.floor(total / 10) === 0) {
        output(`Fetching page details... ${done}/${total}`, opts);
      }
    }
  }
);
```

**1.3 Add CLI flag**

```
atlcli wiki docs pull [dir] --concurrency 5
```

Default: 5 (safe for all tiers)

### Phase 2: Resilience

**2.1 Jittered exponential backoff**

Current (client.ts):
```typescript
delay = baseDelayMs * Math.pow(2, attempt);  // Deterministic
```

Recommended:
```typescript
delay = Math.random() * Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
```

Locations to update:
- `request()` retry logic (~line 197)
- `requestV2()` retry logic (~line 230)

**2.2 Rate limit header monitoring**

Extract headers after each request:
```typescript
const remaining = response.headers.get('x-ratelimit-remaining');
const nearLimit = response.headers.get('x-ratelimit-nearlimit');

if (nearLimit === 'true') {
  this.logger?.warn(`Rate limit warning: ${remaining} points remaining`);
}
```

### Phase 3: Delta Sync

**3.1 Track last sync time**

Add to state.json:
```typescript
interface AtlcliState {
  // existing fields...
  lastFullSync?: string;  // ISO timestamp
}
```

**3.2 Use lastModified filter**

```typescript
async handlePull(...) {
  const state = await readState(atlcliDir);

  if (state?.lastFullSync && !flags.force) {
    // Incremental: only changed pages
    const cql = `${baseCql} AND lastModified >= "${state.lastFullSync}"`;
    pages = await client.searchPages(cql);
  } else {
    // Full sync
    pages = await client.searchPages(baseCql);
  }

  // After successful sync
  await writeState(atlcliDir, { ...state, lastFullSync: new Date().toISOString() });
}
```

**3.3 Add --force flag**

```
atlcli wiki docs pull [dir] --force  # Ignore lastFullSync, do full pull
```

### Phase 4: Checkpointing (Resume)

**4.1 Store progress in state**

```typescript
interface SyncCheckpoint {
  scope: string;           // Stringified scope
  cursor?: string;         // Pagination cursor (if mid-pagination)
  processedIds: string[];  // Pages already fetched
  startedAt: string;       // For stale detection
}
```

**4.2 Resume logic**

```typescript
if (state.checkpoint?.scope === scopeKey) {
  const age = Date.now() - new Date(state.checkpoint.startedAt).getTime();
  if (age < 24 * 60 * 60 * 1000) {  // Less than 24h old
    // Resume: skip already processed pages
    const remaining = pages.filter(p => !state.checkpoint.processedIds.includes(p.id));
    output(`Resuming sync: ${state.checkpoint.processedIds.length} already done, ${remaining.length} remaining`, opts);
    pages = remaining;
  }
}
```

**4.3 Clear checkpoint on completion**

```typescript
await writeState(atlcliDir, { ...state, checkpoint: undefined, lastFullSync: new Date().toISOString() });
```

### Phase 5: Adaptive Concurrency (Optional)

Monitor rate limit headers and adjust:

```typescript
class AdaptiveConcurrency {
  private concurrency = 5;

  adjust(headers: Headers): void {
    const remaining = parseInt(headers.get('x-ratelimit-remaining') || '65000');
    const limit = parseInt(headers.get('x-ratelimit-limit') || '65000');
    const ratio = remaining / limit;

    if (ratio < 0.2) {
      this.concurrency = Math.max(1, this.concurrency - 1);
    } else if (ratio > 0.8 && this.concurrency < 10) {
      this.concurrency++;
    }
  }
}
```

## Testing

```bash
# Test parallelization
time bun run --cwd apps/cli src/index.ts wiki docs pull ~/wikisynctest/large --space LARGE

# Test with different concurrency
time atlcli wiki docs pull ~/test --concurrency 3
time atlcli wiki docs pull ~/test --concurrency 10

# Test delta sync
atlcli wiki docs pull ~/test              # Full sync
# ... make changes in Confluence ...
atlcli wiki docs pull ~/test              # Should be faster (delta)
atlcli wiki docs pull ~/test --force      # Full sync again

# Test resume
atlcli wiki docs pull ~/test &
kill %1                                    # Interrupt
atlcli wiki docs pull ~/test              # Should resume
```

## Priority Matrix

| Phase | Feature | Effort | Impact | Priority |
|-------|---------|--------|--------|----------|
| 1 | Parallel `getPageDetailsBatch()` | 2h | 5-10x faster | Critical |
| 1 | `--concurrency` flag | 1h | User control | High |
| 2 | Jittered backoff | 1h | Better 429 handling | High |
| 2 | Rate limit monitoring | 2h | Visibility | Medium |
| 3 | Delta sync | 3h | 10-50x faster repeats | High |
| 4 | Checkpointing | 4h | Resume interrupted | Medium |
| 5 | Adaptive concurrency | 3h | Auto-optimization | Low |

## Files to Modify

| File | Changes |
|------|---------|
| `packages/confluence/src/client.ts` | Add `getPageDetailsBatch()`, jittered backoff, header monitoring |
| `apps/cli/src/commands/docs.ts` | Use batch fetch, add `--concurrency`, delta sync, checkpointing |
| `packages/confluence/src/index.ts` | Export new types if needed |
| `packages/confluence/src/types.ts` | Add `SyncCheckpoint` interface |

## Open Questions

1. Should `--concurrency` be stored in config for persistence?
2. Checkpoint TTL: 24h reasonable? Make configurable?
3. Delta sync: Use `lastModified` CQL or fetch all and filter locally?
4. Show progress bar (with total ETA) or just percentage?
