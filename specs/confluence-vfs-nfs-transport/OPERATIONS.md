# VFS mount transports: operational notes

Behaviour notes for the WebDAV mount and the experimental NFS transport,
collected while implementing [PLAN.md](PLAN.md). The user documentation is
[Virtual Filesystem](../../src/content/docs/confluence/virtual-filesystem.md);
this file keeps the detail that is too low-level for it. Moved here from
`docs/agents/confluence-vfs.md`.

## WebDAV mounts and editors

WebDAV `--mode ro` mounts use the macOS kernel read-only option, so local
writes fail immediately rather than appearing saved in the client cache. Linux
attach instructions also include the selected `ro` or `rw` mode.

WebDAV mounts accept `vim newpage.md` without frontmatter. Vim `~` backups and
TextEdit `.sb-*` staging files stay local to the mount session; they do not rename
or create wiki pages. Subsequent saves to the original name update the same page.
On Linux, use the mount command printed by atlcli: its `conf=` option selects
an owned per-mount configuration with `delay_upload 0`. This removes davfs2's
additional ten-second upload delay; atlcli still buffers rapid saves for 500 ms.
Existing mounts need a normal unmount and remount with that command. A manually
configured mount must also set `delay_upload 0` in its davfs2 configuration.
The generated configuration stays beside the mount state for reuse in fstab;
it contains no credentials and does not change system-wide davfs2 settings.

Linux davfs2 uploads asynchronously and its local readback can lag behind a save;
the native editor tests wait for both backend content and mounted-file visibility.
Keep the mount running until outstanding uploads finish. Local WebDAV editor
backups are session data, not the durable recovery journal used by NFS.
TextEdit can create a plain-text `.md` document and save subsequent edits through
either transport. Repeated WebDAV safe-saves use the standard MOVE overwrite
default when the header is absent; explicit `Overwrite: F` still rejects an
occupied destination. TextEdit's macOS document-version history is unavailable
on these mounts; this is separate from Confluence page versions.


## Find recently changed pages without body downloads

```bash
find . -type f -name '*.md' -mtime -7
find . -type f -name '*.md' -newermt '2026-09-01T00:00:00Z'
```

This indexed fast path searches current page files only and returns stable
`.by-id` paths; attachments and generated virtual files are excluded, as the
command diagnostic states. `-newer FILE`, combined time predicates and
`-print0` are also supported. CQL date bounds are widened for account timezone
and minute precision, then checked against exact page metadata. No bodies are
fetched. Index lag can omit recent changes. Other find expressions retain the
filesystem-metadata walk; `--no-cql` on `wiki sh` disables acceleration.

Experimental NFS handles distinguish generated files in each selected space.
NFS exposes the same empty indexer marker files as WebDAV at the volume root,
plus an empty `.fseventsd` directory. These synthetic entries and common desktop
metadata probes at the root require no Confluence requests. They are local mount
entries, not wiki pages. This does not guarantee that every indexer honors them.
Both mount transports emit one warning per session after 50 distinct successful
file reads within 10 seconds without a recent listing of their parent directories.
Repeated NFS byte ranges count as one file; failed reads and marker files do not
count. Listings suppress the hint for 10 seconds (up to 4096 recent directories).
This heuristic reports possible indexing; it neither blocks reads nor detects
every crawler. The warning contains counts, not page names or contents.
Expired object handles also fail metadata/access probes with `ESTALE`.
NFS advertises a 255-byte filename-component limit and rejects longer UTF-8
names with `ENAMETOOLONG`; names are never silently truncated.
macOS mounts use `locallocks`; Linux uses `nolock`. Advisory locks are local
to the client: they coordinate processes on that client, not other clients or
Confluence edits. No NLM/NSM lock service runs. Native tests verify nonblocking
`flock` contention/release and shared POSIX read locks on the current RO mounts;
RW contention/release and editor saves are covered by native tests too.
Mount options reject malformed values before opening a cache or starting a
server: `--mode` accepts only `ro` or `rw`, and `--port` accepts decimal integers
from 0 to 65535 (0 chooses an available port). Missing option values are errors.
Experimental NFS accepts `--mode rw` and opt-in `--allow-delete`. It rejects
`--sync-writes`: stable local writes cannot promise immediate Confluence
publication. WebDAV remains the default transport.

Development tests now cover TextEdit safe-save and VS Code autosave on a native
macOS NFS mount, plus Vim/native saves and real DOCSY publication on Linux.
See the
[write evidence](EVIDENCE.md). NFS
RW shutdown reports counts of retained pending pages, interrupted replacements,
local editor entries and unresolved publications. Pending/failed page counts include
eligible new Markdown drafts before Confluence assigns their IDs; recorded backups
and hidden editor files are excluded. Local-entry counts overlap with those drafts
until creation is confirmed. Keep the staging journal when
this notice appears: locally durable bytes do not prove Confluence publication.
NFS removal of a page body requires deletion opt-in and a clean
published image. It records the page ID before sending the trash request and
blocks subsequent mutations to that page. Dirty pages and local child drafts
must be resolved first. An uncertain DELETE is never blindly retried: retain the
journal and inspect its trash metadata. Recovery exports retain the saved bytes
even after confirmed trash. On restart, an explicit trashed status for the same
page ID and space completes the retained intent without another DELETE. Missing,
inaccessible or still-current pages remain unresolved; a 404 is not confirmation.
Recursive OS removal can fail on generated read-only views before or after the
page body is trashed; it is not atomic. Prefer targeted removal of `_index.md`
when you intend to trash that page. Unprovable remote outcomes remain unresolved.
NFS publication waits for 500 ms without newer writes to a page.
If an editor sends a valid partial document and pauses longer, Confluence can
receive an intermediate version before later blocks arrive. Automatic publication
does not detect the end of an editor save; fsync confirms local durability only.
After restart, successful reconciliation of an interrupted publication also
schedules any newer durable edits, without requiring another editor save.
NFS publication processes one page at a time to bound retained page
images; a slow upload can delay other pages. Transient failures use bounded
exponential backoff with jitter and honor Retry-After. Offline journal inspection
and byte export preserve access to failed drafts. Clean staged pages refresh from newer
core-cache versions during access; dirty pages retain local bytes. This follows
the existing cache freshness window and does not provide immediate remote-edit
visibility. Conflicts detected during local publication preparation can be
corrected by another editor save. Persisted uncertain publication results remain
protected for reconciliation; this is not a general conflict-resolution UI.

Native RO and RW mounts use local advisory locks. Tests verify
that another process on the same host cannot acquire an exclusive lock until
it is released; this is not a cross-client lock service. Confluence version
checks remain responsible for remote edit conflicts.

NFS is not generally faster than WebDAV. The current synthetic native comparison
shows different results by OS and cache state; see the [measured results and
limits](PERFORMANCE.md).
Its per-run peak RSS and normal shutdown measurements include startup and cleanup.

NFS sets `actimeo=1` on both systems and disables negative-name caching
(`nonegnamecache` on macOS, `lookupcache=positive` on Linux). macOS also uses
`dumbtimer` so its adaptive loopback estimator cannot shorten the configured
retry timeout and cause directory walkers to skip entries. Remount to apply
changed kernel options. The core metadata
TTL remains 60 seconds by default: directly reopening a cached page checks its
version after that TTL, even without a directory listing. Warm reads within the
TTL make no additional API calls. Allow the core TTL, the one-second kernel
attribute cache and backend response time for external changes; this is not an
instantaneous-consistency promise. Native synthetic tests advance the core clock
past its TTL and verify updated bytes and a previously absent file through the
real OS client within five seconds, without flushing kernel caches.
NFS READDIR/READDIRPLUS entry attributes do not enumerate each child directory.
Listing a child directory fetches its children on demand. An explicit directory
GETATTR still refreshes its listing to validate pagination state.
Attachment directory listings and stat use exact Confluence size metadata without
downloading attachment contents. A read downloads the attachment through the
shared body cache; subsequent ranges reuse it.
An NFS attachment handle also survives a filename change within its owner page.
Recovery matches the attachment ID in that page's cached metadata listing; it
does not download sibling attachments or search the whole space. Reusing the
old filename for a different attachment never redirects the original handle.
If an attachment moves to another owner page, recovery uses its ID and fresh
owner metadata. The new owner must belong to a selected export space; moves
outside the export return `ESTALE` without downloading the attachment. No
whole-space search is used.
READ currently omits optional NFS attributes rather than combining bytes with
separately fetched attributes from another version. Clients can use GETATTR;
normal paths can refresh between READ requests when a page changes externally.
For a stable whole-document snapshot, read `.versions/<n>.md`: all ranges of
that file refer to the same historical version, even after a cache miss or a
page move within the export. For example, `cat page-123/.versions/7.md` reads
version 7; `cat page-123/_index.md` reads the current document.
For current Markdown pages and page aliases, GETATTR derives the modification
time from the same materialized Markdown used for its exact byte size when
Confluence supplies the version timestamp. A cold fetch therefore cannot pair
the newer body's size with the preceding metadata lookup's older timestamp.
Rendered Markdown cache entries carry a format revision as well as the
Confluence version. After this upgrade, older Markdown entries are refreshed
only when requested; cached attachments are retained. Offline reads of an old
Markdown format require one online read before becoming available again.
Mutable generated files such as `.comments.md` use a session-local observed-change
timestamp in NFS. It stays stable while the rendered bytes are unchanged and
advances on content changes, even when the page version and byte length stay the
same. This is not a Confluence authoring timestamp; existing metadata TTLs still
bound when external changes become visible.

Historic `.versions/<n>.md` uses that version's own timestamp in its Markdown
and NFS attributes, not the current page timestamp. If the historic response
omits it, the Markdown omits it and NFS reports an unknown time (Unix epoch).
Historical Markdown omits current parent IDs and location URLs, which could
otherwise change its bytes after a move. It has a separate cache representation
from editable current Markdown; both share the existing disk budget and cleanup.
After upgrading, visit a version path online once before using it offline, even
if the corresponding current page was already cached.
Handles for `.comments.md`, `.versions` and its version files follow their
owner page across rename/reparent operations within the export.

When a refreshed listing observes a moved page or folder, the shared tree index
removes its old parent association while retaining its already loaded children.
Refreshing the old parent afterwards therefore cannot erase the relocated subtree.

The internal RW implementation journals page/folder moves between selected
spaces and reconciles lost responses in the destination space. Public NFS RW
remains gated pending the full acceptance suite. After a move, generated
frontmatter reflects the current location; open OS descriptors may retain old
attributes for the documented one-second cache window.

Existing page/body handles also survive a page move after the changed hierarchy
is observed: the adapter resolves the same page ID within the selected spaces.
Attachment files and their `_attachments` directory also retain their handles
when the owning page moves, without requiring a lookup of its new location.
Moving outside the export or deleting the page expires these handles. Folder directory handles are recovered through space-checked folder and ancestor
metadata, including when an ancestor page moves. Inconsistent ancestry returns a
retryable error. The folder’s generated `_index.md` follows its owning folder
handle and keeps its identity after relocation. Attachment handles also follow
independent renames and owner changes within the selected export.
NFS ACCESS grants reading for regular files and reading/lookup for directories;
write operations remain rejected. Deleted or replaced identities report `ESTALE`; look up the path again, or remount
after a helper restart. Single-space and combined-space native reads are covered
by the [NFS evidence](EVIDENCE.md).

The NFS helper uses the pinned local nfsserve patch for correct multi-page
READDIR results. Rebuild the helper alongside source updates; an older helper
can repeat the first directory page. See its [patch notes](../../packages/confluence-nfs/vendor/nfsserve/PATCHES.md).

If a directory changes during NFS pagination, the server returns `BAD_COOKIE`;
restart the listing if the OS does not retry automatically. A kernel may finish
returning entries it buffered before a change; reopen the directory after the
metadata freshness window to obtain the updated listing. Directory timestamps
track changes observed by this mount. Source builds require bridge-version-3
helpers; rebuild an older companion binary before mounting.

Each NFS session retains at most 65,536 handles, including root and volume
markers. At capacity, new object lookups return `ENOSPC`; existing handles keep
working. Remount to reset the session, or select fewer spaces. Handles confirmed
stale release capacity, but their numeric IDs are never reused in that session.
Directory revisions retain fixed-size hashes rather than copies of listings.
Each directory request resolves at most 32 entries concurrently and drains a
failed batch before returning its error; large listings remain paginated.
Transport benchmarks distinguish local protocol requests from Confluence API
requests: NFS counts complete received RPC records (including mount calls and
retries), while WebDAV counts received HTTP requests. Counter queries use the
private helper pipe and do not themselves count as NFS traffic. Neither counter
retains filenames, credentials or content.

The experimental NFS listener rejects RPC records over 4 MiB, more than 1,024
fragments per record, and XDR arrays exceeding 4 MiB before allocating their
payload. Malformed connections are closed; reconnect with a valid request.

NFS accepts at most 32 simultaneous TCP connections and handles requests in order
within each connection. Idle or incomplete requests disconnect after 60 seconds;
clients can reconnect. Dispatch and response-write deadlines are 120 and 30
seconds. Cancelled bridge calls release their pending-response records and
concurrency permits; a still-running blocking pipe write retains its permit
until the write finishes, so cancellation cannot bypass the 32-call bound. Replay tracking is capped at 4,096 entries; exceeding capacity closes
the requesting connection. These limits do not change WebDAV or the VFS shell.

For a native release-mode development helper, run
`bun scripts/build-nfs-helper.ts /tmp/atlcli-nfs-helper` with Rust 1.92.0 installed.
Set `ATLCLI_NFS_HELPER` to the emitted executable. The adjacent build manifest
records checksums and protocol identity; see the [helper build guide](../../packages/confluence-nfs/README.md).

Unix CLI archives built with NFS include `atlcli-confluence-nfs` beside `atlcli`
and dependency notices. Keep both executables together. The shell installer
verifies the release checksum and accepts only the expected regular files before
installing them. A downgrade to an older CLI-only archive removes the previous
NFS companion, so it cannot be mistaken for a matching helper. If checksums cannot
be retrieved or verified, installation stops; retry once the release assets are
available. Homebrew companion support is prepared in [tap draft PR #1](https://github.com/BjoernSchotte/homebrew-tap/pull/1)
and is not available from the published tap until that change is merged.


## Recovery after a killed mount

After an NFS mount process is killed with SIGKILL, its helper exits when the
private pipe closes, but the OS volume can remain attached. `wiki mount list`
keeps that record and reports `orphaned`; it must not be mistaken for a working
server. Run `atlcli wiki mount unmount <mountpoint>` using the same `--cache-dir`
if one was specified. Once detached, start a fresh mount: old filehandles do not
survive a helper restart. Handles carry a fresh random session identity, so their
validity does not depend on the wall clock. The recovery command uses regular unmount, without
forced or lazy detachment. Close applications using the volume if it is busy.


### Recovering local NFS edits

The development journal explicitly finalizes its SQL statements at shutdown;
reopening it does not depend on garbage collection releasing SQLite locks.
Opening the journal synchronizes its containing directory and all ancestors,
including on retries after a failed startup. A directory-sync failure aborts
startup before the mount can acknowledge writes.
A hard RW mount may still issue requests during unmount after a helper crash.
If the CLI survives a helper crash, it makes one attempt to restart the endpoint
on the same port before normal unmount, then exits with an error so a fresh mount
can be started. A busy volume keeps the replacement serving; close viewers and
leave the directory, then retry Ctrl-C. The saved helper PID/identity is updated.
The native recovery test also proves this sequence with a durable RW journal;
the restarted helper rejects old handles with `ESTALE`. Public NFS RW remains
gated. A killed parent cannot run this recovery, and a failed endpoint restart
still requires manual recovery; no forced or lazy unmount is used.

Automatic NFS publication retries transient `EAGAIN` failures up to five times
with exponential backoff (starting at one second) and up to 25% jitter. Explicit
connection-reset/refused, timeout and temporary DNS transport errors are also
retryable. Cancellation, certificate errors and unclassified exceptions are not. A supplied
`Retry-After` is a minimum delay. New save events retain the current retry delay;
permission/validation errors and conflicts do not trigger this retry loop. After
exhaustion, bytes and publication intent remain in the journal for recovery.
The delay state is session-local; restarting resumes from the durable intent.
Markdown inside editor staging directories (hidden names, `#...`, `~...`,
backup/temporary suffixes and macOS `.sb-...` containers) stays local.
If storage fills after Confluence accepts a write, the local receipt can fail.
Free disk space and reopen the same journal: recovery reconciles the saved
intent with Confluence before sending another creation or update.


Use the journal path from your development mount setup. These commands need no
profile, authentication, or running server. Public NFS RW mounting is still gated.
Development NFS mounts automatically publish visible Markdown drafts after the
quiet window. For example, `vim newpage.md` needs no frontmatter: the filename
supplies the title and the containing directory supplies the space and parent.
An empty `.md` file is also a new page: CREATE alone starts the quiet window,
and later writes postpone publication. A long pause before the first content can
therefore produce an empty initial version, consistent with the accepted snapshot
publication contract.
Each new NFS creation sends its durable local identity as a content property in
the initial POST. After a lost reply, resume looks up the exact title directly
and verifies the marker, space, parent and title, then verifies the first version and its storage
body before promoting the local file. If the page has newer versions, the
confirmed first version becomes the merge base; recovery preserves the current
remote content and merges later local edits through normal conflict handling. It never issues another POST to guess the
outcome. Missing markers (including older attempts), ambiguous matches or pages
retitled or moved since creation stay pending with their bytes retained. Missing
historical proof also retains the pending image. Marker reads use REST v2 on
Cloud and the context-path-aware REST v1 property endpoint on Data Center.
Data Center reconciliation is covered by mocked transport tests but is not yet
live-verified.

The create-only guard prevents overwriting an occupied page. Confirmed creations
retain their original filehandle and a durable virtual filename alias, so later
saves to `newpage.md` update the same page as its canonical name containing the
page ID. This is not an OS symlink that an atomic editor save could replace.
Confirmed trash releases that original filename for a new page with a new ID;
old filehandles cannot write to the replacement. Uncertain trash retains the
alias until the remote outcome is confirmed. Saved recovery bytes remain in the
journal after the alias is released.
Hidden drafts, swap suffixes and recorded page backups are not published.
An uncertain create response is retained for reconciliation without blindly
retrying the POST. Full editor coverage and automatic reconciliation remain open.

```bash
atlcli wiki mount recovery /path/to/journal.sqlite --json
atlcli wiki mount recovery /path/to/journal.sqlite --id 12345 --output ./recovered.md
```

The listing includes frozen creation targets and confirmed creation receipts
when present (journal schemas 9–16), local editor entries, interrupted replacements, revision
numbers, safe error codes and available publication images, without page bodies.
Schema 12 and later also list the trash target and whether remote trash was
confirmed. Schemas 13–15 include move/retitle receipts even when no page body was
staged: `moveSource`, `moveTarget`, parent IDs, target title and `moveCompleted`.
`moveKind` distinguishes pages and folders; `moveSourceTitle` is null for older
journals that did not record it. `hasCurrent: 0` means there is no local byte
image to export for that ID. A move sharing an ID with a staged image appears
in the same record. `moveCompleted: 0` means the outcome needs reconciliation;
offline inspection cannot determine which remote steps succeeded.
To compare an unresolved publication with the bytes currently saved by an editor:

```bash
atlcli wiki mount recovery /path/to/journal.sqlite --id 12345 --image intent --output ./sent.md
atlcli wiki mount recovery /path/to/journal.sqlite --id 12345 --image current --output ./current.md
diff -u ./sent.md ./current.md
```

`--image` accepts `current` (default), `intent` (an unresolved publication), or
`base` (the last published local source used for merging). The base is not
necessarily an exact remote snapshot after conflict merging. Exports preserve
all bytes, including incomplete UTF-8, and create private files without replacing
existing paths. Journal inspection/export never publishes, clears, or migrates
records. Keep the original journal until remote publication is verified.

A missing image is an error; inspect the listing before choosing an ID/image.
A journal permits only one writer process. SQLite releases its ownership lock
on close or process death; no stale PID lock file needs removal. Stop the owning
mount normally before offline recovery inspection/export. Unsupported
schemas require the CLI matching that journal; do not edit its schema version.


Confluence Cloud folders cannot currently be retitled through the supported REST
API. The VFS rejects folder retitles with `EROFS` before any accompanying move,
so a combined move/rename cannot leave a partially moved folder. This restriction
concerns actual Confluence folders, not pages represented as directories.

Moving a page using its unchanged canonical directory name preserves its exact
Confluence title, including case, punctuation and Unicode. A move does not infer
a new title from the lossy filename slug or upload the body just to retitle it.

NFS directory enumeration checks the parent once per listing and validates child
identities in bounded batches. Name lookups do not enumerate all siblings just
to supply optional parent attributes; explicit attribute and listing requests
still refresh directory revisions. Large listings still scale with their entry count;
core metadata TTL and kernel caching both affect external-change visibility.

Development RW NFS mounts use hard retries through the shared mount-option
builder; RO mounts retain soft retries. A hard mount can wait when the daemon is
unavailable, so unmount normally before stopping it. NFS stable-write replies
still confirm local journal durability, not completed Confluence publication.
Public CLI RW mode remains gated pending full acceptance.

Managed NFS staging uses `<cache-dir>/nfs-journals/<scope-hash>.sqlite`. The scope
includes site, profile, authenticated account and selected spaces; changing their
order does not change the journal. A changed identity or export gets a separate
journal. These files contain durable edits, not disposable body-cache entries;
keep them until publication/recovery is verified. The CLI RW startup wiring is
prepared but remains behind the existing acceptance gate.

The managed NFS server owns the journal lock until its publisher and helper have
stopped. Failed startup releases the lock; normal stop retains the database and
its last recovery counts for inspection. Caller-supplied test journals remain
caller-owned. Pending or newly requested statistics during shutdown fail with
`NFS helper stopped`; queued replies do not write to a closed helper pipe.
This does not enable the gated public RW mode.

Development RW NFS supports moving an existing page or Confluence-folder directory beneath another
page or folder in the same space while retaining its canonical name and page
ID. Pending local editor data blocks the move. Its durable journal records the
source and destination before the API call; a lost reply is reconciled from
fresh remote metadata on replay or restart, without blindly repeating the move.
Both trees remain reserved while the result is uncertain. Open handles follow
the page identity. A real Confluence move can update version and frontmatter;
the page body is preserved. Page directories can also be retitled in place: keep the ID suffix and use the
canonical lowercase slug, for example `mv old-title-123 new-title-123`. NFS
exposes only the current directory name; open handles continue to address the
same page. Retitles use the durable move journal and reconcile lost API replies
without issuing a second title update. A page can be retitled and reparented in one `mv`. Confluence performs this in
two steps, so interruption can leave it temporarily at the destination under
its old title. The journal reserves that intermediate path as well. Recovery
confirms the page ID, destination parent and original title before completing
the title update, preserving concurrent body edits. A conflicting external title
leaves the intent unresolved. Names without an ID and cross-space moves still
require implementation.
Folder moves use the positional REST endpoint and verify numeric space identity
against folder metadata; journal migration preserves existing page move intents.
Public NFS RW remains gated.
