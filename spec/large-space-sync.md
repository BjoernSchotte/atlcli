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

Handles partial failures gracefully with retry support:

```typescript
interface BatchResult<T> {
  successes: Array<{ id: string; value: T }>;
  failures: Array<{ id: string; error: Error; retryable: boolean }>;
  skipped: string[];  // 404s when skipOn404=true
}

async batchOperation<T>(
  ids: string[],
  operation: (id: string) => Promise<T>,
  options: {
    concurrency?: number;
    onProgress?: (done: number, succeeded: number, failed: number, total: number) => void;
    skipOn404?: boolean;
    signal?: AbortSignal;  // For cancellation
  } = {}
): Promise<BatchResult<T>> {
  const { concurrency = 5, onProgress, skipOn404 = true, signal } = options;
  const successes: Array<{ id: string; value: T }> = [];
  const failures: Array<{ id: string; error: Error; retryable: boolean }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < ids.length; i += concurrency) {
    // Check for cancellation
    if (signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    const chunk = ids.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(id => operation(id))
    );

    results.forEach((result, idx) => {
      const id = chunk[idx];
      if (result.status === 'fulfilled') {
        successes.push({ id, value: result.value });
      } else {
        const error = result.reason;
        const is404 = error?.message?.includes('404');
        const is429 = error?.message?.includes('429');
        const is5xx = /5\d{2}/.test(error?.message || '');

        if (is404 && skipOn404) {
          skipped.push(id);
        } else {
          failures.push({
            id,
            error,
            retryable: is429 || is5xx  // Can retry rate limits and server errors
          });
        }
      }
    });

    onProgress?.(
      i + chunk.length,
      successes.length,
      failures.length,
      ids.length
    );
  }

  return { successes, failures, skipped };
}
```

**1.2 Retry failed items**

```typescript
async batchWithRetry<T>(
  ids: string[],
  operation: (id: string) => Promise<T>,
  options: BatchOptions & { maxRetries?: number } = {}
): Promise<BatchResult<T>> {
  const { maxRetries = 1, ...batchOptions } = options;

  let result = await this.batchOperation(ids, operation, batchOptions);
  let retryCount = 0;

  while (retryCount < maxRetries && result.failures.some(f => f.retryable)) {
    const retryIds = result.failures.filter(f => f.retryable).map(f => f.id);

    // Wait before retry with exponential backoff
    await sleep(1000 * Math.pow(2, retryCount));

    const retryResult = await this.batchOperation(
      retryIds,
      operation,
      { ...batchOptions, concurrency: Math.max(1, (batchOptions.concurrency ?? 5) - 2) }
    );

    // Merge results
    result.successes.push(...retryResult.successes);
    result.skipped.push(...retryResult.skipped);
    result.failures = [
      ...result.failures.filter(f => !f.retryable),
      ...retryResult.failures
    ];

    retryCount++;
  }

  return result;
}
```

**1.3 Specific batch methods**

```typescript
// Page details
async getPageDetailsBatch(
  ids: string[],
  options?: BatchOptions
): Promise<BatchResult<ConfluencePageDetails>> {
  return this.batchWithRetry(ids, id => this.getPageDetails(id), options);
}

// Folders - use Map for O(1) lookup
async getFoldersBatch(
  ids: string[],
  options?: BatchOptions
): Promise<BatchResult<ConfluenceFolder>> {
  return this.batchWithRetry(ids, id => this.getFolder(id), options);
}

// Comments
async getCommentsBatch(
  pageIds: string[],
  options?: BatchOptions
): Promise<BatchResult<{ pageId: string; comments: PageComments }>> {
  return this.batchWithRetry(
    pageIds,
    async (pageId) => {
      const comments = await this.getAllComments(pageId);
      return { pageId, comments };
    },
    options
  );
}
```

**1.4 Attachment batching - preserve page context**

Don't batch all attachments globally. Instead, parallelize at page level:

```typescript
interface PageAttachmentJob {
  pageId: string;
  pageDir: string;
  attachments: AttachmentInfo[];
}

async downloadAttachmentsForPages(
  jobs: PageAttachmentJob[],
  options?: {
    pageConcurrency?: number;      // How many pages to process in parallel
    attachmentConcurrency?: number; // How many attachments per page in parallel
    onProgress?: (pagesComplete: number, total: number) => void;
  }
): Promise<{
  succeeded: number;
  failed: Array<{ pageId: string; attachment: string; error: Error }>
}> {
  const { pageConcurrency = 3, attachmentConcurrency = 2, onProgress } = options ?? {};
  const failed: Array<{ pageId: string; attachment: string; error: Error }> = [];
  let succeeded = 0;
  let pagesComplete = 0;

  // Process pages in parallel (limited concurrency)
  for (let i = 0; i < jobs.length; i += pageConcurrency) {
    const pageChunk = jobs.slice(i, i + pageConcurrency);

    await Promise.all(pageChunk.map(async (job) => {
      // For each page, process its attachments with limited concurrency
      for (let j = 0; j < job.attachments.length; j += attachmentConcurrency) {
        const attChunk = job.attachments.slice(j, j + attachmentConcurrency);

        const results = await Promise.allSettled(
          attChunk.map(async (att) => {
            const data = await this.downloadAttachment(att);
            await writeFile(join(job.pageDir, att.filename), data);
            return att;
          })
        );

        results.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            succeeded++;
          } else {
            failed.push({
              pageId: job.pageId,
              attachment: attChunk[idx].filename,
              error: result.reason
            });
          }
        });
      }

      pagesComplete++;
    }));

    onProgress?.(pagesComplete, jobs.length);
  }

  return { succeeded, failed };
}
```

**1.5 Update handlePull() to use batch operations**

```typescript
// Replace sequential page details loop
const { successes, failures, skipped } = await client.getPageDetailsBatch(
  pages.map(p => p.id),
  {
    concurrency: getFlag(flags, "concurrency") ?? 5,
    onProgress: (done, succeeded, failed, total) => {
      if (!opts.json && total > 10 && done % Math.floor(total / 10) === 0) {
        output(`Fetching page details... ${done}/${total} (${failed} failed)`, opts);
      }
    }
  }
);

const pageDetails = successes.map(s => s.value);

if (skipped.length > 0 && !opts.json) {
  output(`Skipped ${skipped.length} inaccessible pages (deleted or no permission)`, opts);
}

if (failures.length > 0) {
  if (!opts.json) {
    output(`Warning: ${failures.length} pages failed to fetch`, opts);
  }
  // Include in JSON output for automation
  if (opts.json) {
    // Add to result object
  }
}

// Clean up state for skipped (deleted) pages
for (const pageId of skipped) {
  if (state?.pages[pageId]) {
    delete state.pages[pageId];
    // Optionally delete local file
  }
}
```

**1.6 Add CLI flags**

```
atlcli wiki docs pull [dir] --concurrency 5        # Page/folder operations
atlcli wiki docs pull [dir] --attachment-concurrency 2  # Attachment downloads (lower default)
```

Attachments are larger payloads, so default to lower concurrency.

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

**2.3 Cancellation support**

```typescript
// In CLI command handler
const controller = new AbortController();

process.on('SIGINT', () => {
  output('Cancelling... (saving progress)', opts);
  controller.abort();
});

try {
  await client.getPageDetailsBatch(ids, { signal: controller.signal });
} catch (err) {
  if (err.message === 'Operation cancelled') {
    // Save checkpoint before exit
    await writeState(atlcliDir, { ...state, checkpoint: currentCheckpoint });
    process.exit(130);  // Standard SIGINT exit code
  }
  throw err;
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

**3.2 Use lastModified filter with deletion detection**

```typescript
if (state?.lastFullSync && !flags.full) {
  const sinceDate = state.lastFullSync.split('T')[0];  // Date only for CQL

  // Fetch modified pages
  const modifiedCql = `${baseCql} AND lastModified >= "${sinceDate}"`;
  const modifiedPages = await client.searchPages(modifiedCql);

  // Detect deletions: compare state with current remote
  // Only do this periodically or when --check-deletions flag is set
  if (flags['check-deletions']) {
    const allRemotePages = await client.searchPages(baseCql);
    const remoteIds = new Set(allRemotePages.map(p => p.id));

    const deletedIds = Object.keys(state.pages).filter(id => !remoteIds.has(id));
    if (deletedIds.length > 0) {
      output(`Found ${deletedIds.length} deleted pages`, opts);
      for (const id of deletedIds) {
        await handleDeletedPage(id, state, outDir, opts);
      }
    }
  }

  pages = modifiedPages;
} else {
  pages = await client.searchPages(baseCql);
}

// After successful sync
await writeState(atlcliDir, { ...state, lastFullSync: new Date().toISOString() });
```

**3.3 Handle deleted pages**

```typescript
async function handleDeletedPage(
  pageId: string,
  state: AtlcliState,
  outDir: string,
  opts: OutputOptions
): Promise<void> {
  const pageState = state.pages[pageId];
  if (!pageState) return;

  const filePath = join(outDir, pageState.relativePath);

  if (existsSync(filePath)) {
    if (!opts.json) {
      output(`Removing deleted page: ${pageState.relativePath}`, opts);
    }
    await unlink(filePath);

    // Also remove attachments directory if exists
    const attDir = join(dirname(filePath), getAttachmentsDirName(basename(filePath)));
    if (existsSync(attDir)) {
      await rm(attDir, { recursive: true });
    }
  }

  delete state.pages[pageId];
}
```

**3.4 CLI flags**

```
atlcli wiki docs pull [dir]                    # Delta sync (if lastFullSync exists)
atlcli wiki docs pull [dir] --full             # Force full sync
atlcli wiki docs pull [dir] --check-deletions  # Also detect deleted pages (slower)
```

### Phase 4: Checkpointing (Resume)

**4.1 Simplified checkpoint (no phase tracking)**

```typescript
interface SyncCheckpoint {
  scope: string;           // Stringified scope for matching
  processedCount: number;  // For progress display
  totalCount?: number;     // If known
  startedAt: string;       // For stale detection (24h TTL)
  failedIds?: string[];    // Track failures for retry on resume
}
```

**4.2 Resume strategy**

On resume, re-fetch page list but skip pages already in state with matching version:

```typescript
const scopeKey = scopeToString(scope);

if (state?.checkpoint?.scope === scopeKey) {
  const age = Date.now() - new Date(state.checkpoint.startedAt).getTime();

  if (age < 24 * 60 * 60 * 1000) {  // Less than 24h old
    // Skip pages already synced (exist in state with same version)
    const originalCount = pages.length;
    pages = pages.filter(p => {
      const existing = state.pages[p.id];
      // Skip if exists and version matches (or if version unavailable, trust state)
      return !existing || (p.version && existing.remoteVersion !== p.version);
    });

    // Also retry previously failed pages
    if (state.checkpoint.failedIds?.length) {
      const failedToRetry = state.checkpoint.failedIds.filter(id =>
        !pages.some(p => p.id === id)
      );
      // Add failed pages back for retry
      const failedPages = await client.searchPages(`id in (${failedToRetry.join(',')})`);
      pages.push(...failedPages);
    }

    if (!opts.json) {
      output(`Resuming: ${originalCount - pages.length} already synced, ${pages.length} remaining`, opts);
    }
  } else {
    // Checkpoint too old, start fresh
    if (!opts.json) {
      output(`Checkpoint expired (>24h), starting fresh sync`, opts);
    }
    state.checkpoint = undefined;
  }
}
```

**4.3 Update checkpoint during sync**

```typescript
// After each batch of pages
state.checkpoint = {
  scope: scopeKey,
  processedCount: successCount,
  totalCount: totalPages,
  startedAt: state.checkpoint?.startedAt ?? new Date().toISOString(),
  failedIds: failures.map(f => f.id)
};
await writeState(atlcliDir, state);
```

**4.4 Clear checkpoint on completion**

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

For extremely large spaces (50k+ pages), streaming requires architectural changes because path computation needs ancestor information. Two approaches:

**Option A: Two-pass approach**
1. First pass: fetch all page metadata (id, title, ancestors) - lightweight
2. Build path map from metadata
3. Second pass: stream full page content and write directly

**Option B: Deferred path computation**
1. Stream pages with full content
2. Write to temp location with page ID as filename
3. After all pages fetched, compute paths and move files

Option A is recommended as it's less disruptive:

```typescript
// Phase 1: Lightweight metadata fetch
const pageMetadata = await client.searchPages(cql, { detail: 'minimal' });

// Build hierarchy map
const pathMap = buildPathMap(pageMetadata);

// Phase 2: Stream full content with known paths
for await (const page of client.fetchPagesStream(pageMetadata.map(p => p.id), 5)) {
  const path = pathMap.get(page.id);
  await writePageToDisk(page, path);
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

# Test attachment concurrency
time atlcli wiki docs pull ~/test --attachment-concurrency 1
time atlcli wiki docs pull ~/test --attachment-concurrency 3

# Test delta sync
atlcli wiki docs pull ~/test              # Full sync, note time
sleep 60                                   # Wait
atlcli wiki docs pull ~/test              # Should be faster (delta)
atlcli wiki docs pull ~/test --full       # Force full sync

# Test deletion detection
atlcli wiki docs pull ~/test --check-deletions

# Test resume
atlcli wiki docs pull ~/test &
sleep 10 && kill -INT %1                   # Interrupt mid-sync (SIGINT)
atlcli wiki docs pull ~/test              # Should resume

# Test cancellation saves state
atlcli wiki docs pull ~/test &
sleep 5 && kill -INT %1
cat ~/test/.atlcli/state.json | jq '.checkpoint'  # Should have checkpoint

# Memory profiling
node --max-old-space-size=256 $(which atlcli) wiki docs pull ~/test
```

## Priority Matrix

| Phase | Feature | Effort | Impact | Priority |
|-------|---------|--------|--------|----------|
| 1 | Generic `batchOperation()` with retry | 3h | Foundation | Critical |
| 1 | `getPageDetailsBatch()` | 1h | 5-10x faster | Critical |
| 1 | `getFoldersBatch()` | 1h | Faster folder detection | High |
| 1 | `downloadAttachmentsForPages()` | 2h | Major for attachment-heavy | High |
| 1 | `--concurrency` flag | 1h | User control | High |
| 1 | `--attachment-concurrency` flag | 0.5h | Fine-grained control | Medium |
| 2 | Jittered backoff | 1h | Better 429 handling | High |
| 2 | Rate limit monitoring | 2h | Visibility | Medium |
| 2 | Cancellation support (AbortController) | 2h | Clean interrupts | Medium |
| 3 | Delta sync | 2h | 10-50x faster repeats | High |
| 3 | Deletion detection | 2h | Data consistency | Medium |
| 4 | Checkpointing with failure tracking | 3h | Resume interrupted | Medium |
| 5 | Adaptive concurrency | 3h | Auto-optimization | Low |
| 6 | Streaming (two-pass) | 6h | Memory for 50k+ | Low |

## Files to Modify

| File | Changes |
|------|---------|
| `packages/confluence/src/client.ts` | Add `batchOperation()`, `batchWithRetry()`, batch methods, jittered backoff, header monitoring |
| `apps/cli/src/commands/docs.ts` | Use batch fetch, CLI flags, delta sync, deletion handling, checkpointing, cancellation |
| `packages/confluence/src/index.ts` | Export `BatchResult`, `BatchOptions` types |
| `packages/confluence/src/types.ts` | Add `SyncCheckpoint`, `BatchResult` interfaces |

## Resolved Questions

| Question | Decision |
|----------|----------|
| Store concurrency in config? | No, CLI flag only. Different operations need different values. |
| Checkpoint TTL | 24h, not configurable (simple is better) |
| Delta sync verification | CQL `lastModified` works with cursor pagination (verified) |
| Progress display | Percentage with success/fail counts: `50/100 (2 failed)` |
| Attachment parallelization | Per-page batching (preserves context), separate concurrency flag |

## Open Questions

1. Should `--check-deletions` be default behavior? (adds extra API call for full page list)
2. Streaming: Is two-pass approach acceptable for 50k+ page spaces?
3. Should failed pages be automatically retried on next `pull`, or require `--retry-failed` flag?
