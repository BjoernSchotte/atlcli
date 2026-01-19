# Large Space Sync Optimization Spec

## Problem

Pulling large Confluence spaces (1k+ pages) is slow due to multiple sequential bottlenecks.

**Sequential bottlenecks in current pull flow:**

| Step | Location | Issue |
|------|----------|-------|
| 1. Search pages | `searchPages()` | FIXED (cursor pagination) |
| 2. Fetch page details | docs.ts:544-580 | Sequential `getPageDetails()` loop |
| 3. Fetch folders | docs.ts:603-652 | Sequential `getFolder()` loops |
| 4. Download attachments | docs.ts:939-951 | Sequential `downloadAttachment()` per page |
| 5. Fetch comments | docs.ts:1098 | Sequential `getAllComments()` per page |

**Impact for 10k pages with 5 attachments avg:**
- 10k page detail requests (sequential)
- ~500 folder requests (sequential)
- 50k attachment downloads (sequential)
- 10k comment requests if enabled (sequential)

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
| Current (all sequential) | 50-100 min |
| Parallel page details (concurrency 5) | 10-20 min |
| Parallel all operations (concurrency 5) | 5-10 min |
| Delta sync (2% changed) | 1-2 min |

*Note: Estimates need validation with actual timing.*

## Implementation Plan

### Phase 1: Core Batch Infrastructure

**1.1 Generic batch operation helper**

Handles partial failures gracefully (unlike `Promise.all` which fails entirely):

```typescript
interface BatchResult<T> {
  successes: T[];
  failures: Array<{ id: string; error: Error }>;
}

async batchOperation<T>(
  ids: string[],
  operation: (id: string) => Promise<T>,
  options: {
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
    skipOn404?: boolean;
  } = {}
): Promise<BatchResult<T>> {
  const { concurrency = 5, onProgress, skipOn404 = true } = options;
  const successes: T[] = [];
  const failures: Array<{ id: string; error: Error }> = [];

  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(id => operation(id))
    );

    results.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        successes.push(result.value);
      } else {
        const error = result.reason;
        const is404 = error?.message?.includes('404');
        if (is404 && skipOn404) {
          // Skip silently (matches current behavior)
        } else {
          failures.push({ id: chunk[idx], error });
        }
      }
    });

    onProgress?.(i + chunk.length, ids.length);
  }

  return { successes, failures };
}
```

**1.2 Specific batch methods**

```typescript
// Page details
async getPageDetailsBatch(
  ids: string[],
  options?: { concurrency?: number; onProgress?: ProgressCallback }
): Promise<BatchResult<ConfluencePageDetails>> {
  return this.batchOperation(ids, id => this.getPageDetails(id), options);
}

// Folders
async getFoldersBatch(
  ids: string[],
  options?: { concurrency?: number }
): Promise<BatchResult<ConfluenceFolder>> {
  return this.batchOperation(ids, id => this.getFolder(id), options);
}

// Attachments (per page, then batch download)
async downloadAttachmentsBatch(
  attachments: AttachmentInfo[],
  options?: { concurrency?: number; onProgress?: ProgressCallback }
): Promise<BatchResult<{ attachment: AttachmentInfo; data: Buffer }>> {
  return this.batchOperation(
    attachments.map(a => a.id),
    async (id) => {
      const attachment = attachments.find(a => a.id === id)!;
      const data = await this.downloadAttachment(attachment);
      return { attachment, data };
    },
    options
  );
}

// Comments
async getCommentsBatch(
  pageIds: string[],
  options?: { concurrency?: number }
): Promise<BatchResult<{ pageId: string; comments: PageComments }>> {
  return this.batchOperation(
    pageIds,
    async (pageId) => {
      const comments = await this.getAllComments(pageId);
      return { pageId, comments };
    },
    options
  );
}
```

**1.3 Update handlePull() to use batch operations**

```typescript
// Replace sequential page details loop
const { successes: pageDetails, failures } = await client.getPageDetailsBatch(
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

if (failures.length > 0 && !opts.json) {
  output(`Warning: ${failures.length} pages could not be fetched`, opts);
}

// Replace sequential folder fetching
const { successes: folders } = await client.getFoldersBatch(
  Array.from(potentialFolderIds),
  { concurrency: 5 }
);
```

**1.4 Add CLI flag**

```
atlcli wiki docs pull [dir] --concurrency 5
```

Default: 5 (safe for all tiers)

### Phase 2: Resilience

**2.1 Jittered exponential backoff**

Current (client.ts):
```typescript
delay = baseDelayMs * Math.pow(2, attempt);  // Deterministic - thundering herd
```

Recommended:
```typescript
// Full jitter formula (AWS best practice)
delay = Math.random() * Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
```

Locations to update:
- `request()` retry logic (~line 197)
- `requestV2()` retry logic (~line 230)

**2.2 Rate limit header monitoring**

```typescript
private checkRateLimitHeaders(headers: Headers): void {
  const remaining = headers.get('x-ratelimit-remaining');
  const nearLimit = headers.get('x-ratelimit-nearlimit');

  if (nearLimit === 'true') {
    this.logger?.warn(`Rate limit warning: ${remaining} points remaining`);
  }
}
```

### Phase 3: Delta Sync

**3.1 Track last sync time**

```typescript
interface AtlcliState {
  // existing fields...
  lastFullSync?: string;  // ISO timestamp
}
```

**3.2 Use lastModified filter**

```typescript
if (state?.lastFullSync && !flags.force) {
  // Incremental: only changed pages since last sync
  const sinceDate = state.lastFullSync.split('T')[0];  // Date only for CQL
  const cql = `${baseCql} AND lastModified >= "${sinceDate}"`;
  pages = await client.searchPages(cql);
} else {
  pages = await client.searchPages(baseCql);
}

// After successful sync
await writeState(atlcliDir, { ...state, lastFullSync: new Date().toISOString() });
```

**3.3 Add --force flag**

```
atlcli wiki docs pull [dir] --force  # Ignore lastFullSync, do full pull
```

**3.4 Verification needed**

- [ ] Test `lastModified >= "date"` with cursor pagination
- [ ] Verify timezone handling (use UTC)
- [ ] Handle deleted pages (separate query or local cleanup)

### Phase 4: Checkpointing (Resume)

**4.1 Lightweight checkpoint (cursor + count only)**

Don't store all processedIds (bloats state.json for large spaces).

```typescript
interface SyncCheckpoint {
  scope: string;           // Stringified scope for matching
  phase: 'pages' | 'folders' | 'attachments' | 'comments';
  cursor?: string;         // Pagination cursor (if mid-pagination)
  processedCount: number;  // For progress display
  totalCount?: number;     // If known
  startedAt: string;       // For stale detection (24h TTL)
}
```

**4.2 Resume strategy**

On resume, re-fetch page list but skip processing for pages already in state:

```typescript
if (state.checkpoint?.scope === scopeKey) {
  const age = Date.now() - new Date(state.checkpoint.startedAt).getTime();
  if (age < 24 * 60 * 60 * 1000) {  // Less than 24h old
    // Skip pages that already exist in state with matching version
    const existingPageIds = new Set(Object.keys(state.pages));
    pages = pages.filter(p => {
      const existing = state.pages[p.id];
      return !existing || existing.remoteVersion !== p.version;
    });
    output(`Resuming: skipping ${existingPageIds.size} already synced pages`, opts);
  }
}
```

**4.3 Clear checkpoint on completion**

```typescript
await writeState(atlcliDir, {
  ...state,
  checkpoint: undefined,
  lastFullSync: new Date().toISOString()
});
```

### Phase 5: Adaptive Concurrency (Optional)

```typescript
class AdaptiveConcurrency {
  private concurrency: number;
  private readonly min = 1;
  private readonly max = 10;

  constructor(initial = 5) {
    this.concurrency = initial;
  }

  adjust(headers: Headers): number {
    const remaining = parseInt(headers.get('x-ratelimit-remaining') || '65000');
    const limit = parseInt(headers.get('x-ratelimit-limit') || '65000');
    const ratio = remaining / limit;

    if (ratio < 0.2) {
      this.concurrency = Math.max(this.min, this.concurrency - 1);
    } else if (ratio > 0.8) {
      this.concurrency = Math.min(this.max, this.concurrency + 1);
    }

    return this.concurrency;
  }
}
```

### Phase 6: Streaming (Memory Optimization)

For extremely large spaces (50k+ pages), process and write incrementally:

```typescript
async* fetchPagesStream(
  ids: string[],
  concurrency = 5
): AsyncGenerator<ConfluencePageDetails> {
  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(id => this.getPageDetails(id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        yield result.value;  // Process immediately, don't accumulate
      }
    }
  }
}

// Usage: write to disk as pages arrive
for await (const page of client.fetchPagesStream(pageIds, 5)) {
  await writePageToDisk(page);
  processedCount++;
}
```

## Testing

```bash
# Baseline timing (before optimization)
time bun run --cwd apps/cli src/index.ts wiki docs pull ~/wikisynctest/large --space LARGE

# Test parallelization
time atlcli wiki docs pull ~/test --concurrency 3
time atlcli wiki docs pull ~/test --concurrency 5
time atlcli wiki docs pull ~/test --concurrency 10

# Test delta sync
atlcli wiki docs pull ~/test              # Full sync, note time
sleep 60                                   # Wait
atlcli wiki docs pull ~/test              # Should be faster (delta)
atlcli wiki docs pull ~/test --force      # Full sync again

# Test resume
atlcli wiki docs pull ~/test &
sleep 10 && kill %1                        # Interrupt mid-sync
atlcli wiki docs pull ~/test              # Should resume

# Memory profiling
node --max-old-space-size=256 $(which atlcli) wiki docs pull ~/test
```

## Priority Matrix

| Phase | Feature | Effort | Impact | Priority |
|-------|---------|--------|--------|----------|
| 1 | Generic `batchOperation()` helper | 2h | Foundation | Critical |
| 1 | `getPageDetailsBatch()` | 1h | 5-10x faster | Critical |
| 1 | `getFoldersBatch()` | 1h | Faster folder detection | High |
| 1 | `downloadAttachmentsBatch()` | 2h | Major for attachment-heavy spaces | High |
| 1 | `--concurrency` flag | 1h | User control | High |
| 2 | Jittered backoff | 1h | Better 429 handling | High |
| 2 | Rate limit monitoring | 2h | Visibility | Medium |
| 3 | Delta sync | 3h | 10-50x faster repeats | High |
| 4 | Lightweight checkpointing | 3h | Resume interrupted | Medium |
| 5 | Adaptive concurrency | 3h | Auto-optimization | Low |
| 6 | Streaming fetch | 4h | Memory for 50k+ | Low |

## Files to Modify

| File | Changes |
|------|---------|
| `packages/confluence/src/client.ts` | Add `batchOperation()`, batch methods, jittered backoff, header monitoring |
| `apps/cli/src/commands/docs.ts` | Use batch fetch, `--concurrency` flag, delta sync, checkpointing |
| `packages/confluence/src/index.ts` | Export `BatchResult` type |
| `packages/confluence/src/types.ts` | Add `SyncCheckpoint`, `BatchResult` interfaces |

## Open Questions

1. Should `--concurrency` be stored in project config for persistence?
2. Checkpoint TTL: 24h reasonable? Make configurable?
3. Delta sync: Verify CQL `lastModified` works with cursor pagination
4. Progress display: percentage, ETA, or progress bar?
5. Attachment parallelization: per-page or global pool?
