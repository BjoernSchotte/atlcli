/**
 * Schema migrations for SQLite sync database.
 *
 * Migrations are embedded in code and executed sequentially by version.
 * Each migration has an up() SQL statement and optional down() for rollback.
 */

import { Database } from "bun:sqlite";

/**
 * Migration definition.
 */
export interface Migration {
  version: number;
  description: string;
  up: string; // SQL to apply migration
  down?: string; // SQL to rollback (optional, for development)
}

/**
 * Current schema version. Increment when adding new migrations.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * All migrations in order.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema with all tables",
    up: `
      -- Schema versioning for migrations
      CREATE TABLE IF NOT EXISTS schema_info (
          version INTEGER PRIMARY KEY,
          migrated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Pages table (replaces state.json pages + pathIndex)
      CREATE TABLE IF NOT EXISTS pages (
          page_id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          space_key TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          last_synced_at TEXT NOT NULL,
          local_hash TEXT NOT NULL,
          remote_hash TEXT NOT NULL,
          base_hash TEXT NOT NULL,
          sync_state TEXT NOT NULL DEFAULT 'synced'
              CHECK(sync_state IN ('synced','local-modified','remote-modified','conflict','untracked')),
          parent_id TEXT,
          ancestors TEXT NOT NULL DEFAULT '[]',
          has_attachments INTEGER NOT NULL DEFAULT 0,

          -- Author and timestamps from Confluence
          created_by TEXT,
          created_at TEXT,
          last_modified_by TEXT,
          last_modified TEXT,

          -- Content metadata from Confluence
          content_status TEXT DEFAULT 'current'
              CHECK(content_status IN ('current','draft','trashed','archived','historical')),
          version_count INTEGER DEFAULT 1,
          word_count INTEGER,
          is_restricted INTEGER NOT NULL DEFAULT 0,

          -- Sync tracking
          sync_created_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_updated_at TEXT NOT NULL DEFAULT (datetime('now')),

          -- Remote accessibility tracking
          remote_inaccessible_at TEXT,
          remote_inaccessible_reason TEXT
              CHECK(remote_inaccessible_reason IN ('not_found','forbidden','unknown'))
      );

      CREATE INDEX IF NOT EXISTS idx_pages_path ON pages(path);
      CREATE INDEX IF NOT EXISTS idx_pages_space_key ON pages(space_key);
      CREATE INDEX IF NOT EXISTS idx_pages_parent_id ON pages(parent_id);
      CREATE INDEX IF NOT EXISTS idx_pages_sync_state ON pages(sync_state);
      CREATE INDEX IF NOT EXISTS idx_pages_last_modified ON pages(last_modified);
      CREATE INDEX IF NOT EXISTS idx_pages_created_by ON pages(created_by);
      CREATE INDEX IF NOT EXISTS idx_pages_content_status ON pages(content_status);
      CREATE INDEX IF NOT EXISTS idx_pages_is_restricted ON pages(is_restricted);
      CREATE INDEX IF NOT EXISTS idx_pages_inaccessible ON pages(remote_inaccessible_at)
          WHERE remote_inaccessible_at IS NOT NULL;

      -- Attachments table
      CREATE TABLE IF NOT EXISTS attachments (
          attachment_id TEXT PRIMARY KEY,
          page_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          local_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          file_size INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          local_hash TEXT NOT NULL,
          remote_hash TEXT NOT NULL,
          base_hash TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          sync_state TEXT NOT NULL DEFAULT 'synced'
              CHECK(sync_state IN ('synced','local-modified','remote-modified','conflict','untracked')),
          FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_attachments_page_id ON attachments(page_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_sync_state ON attachments(sync_state);

      -- Links table (for graph/audit features)
      CREATE TABLE IF NOT EXISTS links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_page_id TEXT NOT NULL,
          target_page_id TEXT,
          target_path TEXT,
          link_type TEXT NOT NULL DEFAULT 'internal'
              CHECK(link_type IN ('internal','external','attachment','anchor')),
          link_text TEXT,
          line_number INTEGER,
          is_broken INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (source_page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_page_id);
      CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_page_id);
      CREATE INDEX IF NOT EXISTS idx_links_broken ON links(is_broken) WHERE is_broken = 1;

      -- Users table (for audit/author tracking)
      CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          email TEXT,
          is_active INTEGER,
          last_checked_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active);
      CREATE INDEX IF NOT EXISTS idx_users_last_checked ON users(last_checked_at);

      -- Labels table (page labels/tags from Confluence)
      CREATE TABLE IF NOT EXISTS labels (
          page_id TEXT NOT NULL,
          label TEXT NOT NULL,
          PRIMARY KEY (page_id, label),
          FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_labels_label ON labels(label);

      -- Contributors table (page edit history)
      CREATE TABLE IF NOT EXISTS contributors (
          page_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          contribution_count INTEGER NOT NULL DEFAULT 1,
          last_contributed_at TEXT,
          PRIMARY KEY (page_id, user_id),
          FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_contributors_user ON contributors(user_id);
      CREATE INDEX IF NOT EXISTS idx_contributors_count ON contributors(contribution_count DESC);

      -- Content properties table (key-value metadata from Confluence apps/macros)
      CREATE TABLE IF NOT EXISTS content_properties (
          page_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          last_synced_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (page_id, key),
          FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_content_properties_key ON content_properties(key);

      -- Sync metadata (replaces top-level state.json fields)
      CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
      );

      -- Record this migration
      INSERT INTO schema_info (version, migrated_at) VALUES (1, datetime('now'));
    `,
    down: `
      DROP TABLE IF EXISTS sync_meta;
      DROP TABLE IF EXISTS content_properties;
      DROP TABLE IF EXISTS contributors;
      DROP TABLE IF EXISTS labels;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS links;
      DROP TABLE IF EXISTS attachments;
      DROP TABLE IF EXISTS pages;
      DROP TABLE IF EXISTS schema_info;
    `,
  },
  {
    version: 2,
    description: "Add content_type column for folder support",
    up: `
      -- Add content_type column to distinguish pages from folders
      -- 'page' = regular Confluence page with content
      -- 'folder' = Confluence Cloud folder (container only, no content)
      ALTER TABLE pages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'page'
          CHECK(content_type IN ('page', 'folder'));

      -- Index for filtering by content type
      CREATE INDEX IF NOT EXISTS idx_pages_content_type ON pages(content_type);

      -- Record this migration
      INSERT INTO schema_info (version, migrated_at) VALUES (2, datetime('now'));
    `,
    down: `
      DROP INDEX IF EXISTS idx_pages_content_type;
      -- SQLite doesn't support DROP COLUMN directly, would need table recreation
      -- For development rollback, just drop and recreate the database
    `,
  },
  // Future migrations will be added here:
  // {
  //   version: 3,
  //   description: "Add embeddings table for vector search",
  //   up: `
  //     CREATE TABLE IF NOT EXISTS embeddings (
  //       page_id TEXT PRIMARY KEY,
  //       embedding BLOB NOT NULL,
  //       model TEXT NOT NULL,
  //       dimensions INTEGER NOT NULL,
  //       created_at TEXT NOT NULL,
  //       updated_at TEXT NOT NULL,
  //       FOREIGN KEY (page_id) REFERENCES pages(page_id) ON DELETE CASCADE
  //     );
  //     INSERT INTO schema_info (version, migrated_at) VALUES (3, datetime('now'));
  //   `,
  //   down: `DROP TABLE IF EXISTS embeddings;`,
  // },
];

/**
 * Get the current schema version from database.
 */
export function getCurrentSchemaVersion(db: Database): number {
  try {
    const result = db
      .prepare(`SELECT MAX(version) as version FROM schema_info`)
      .get() as { version: number | null } | undefined;
    return result?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Run all pending migrations.
 */
export function runMigrations(db: Database): { applied: number; version: number } {
  const currentVersion = getCurrentSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return { applied: 0, version: currentVersion };
  }

  // Run all pending migrations in a single transaction
  db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.up);
    }
  })();

  const newVersion = getCurrentSchemaVersion(db);
  return { applied: pending.length, version: newVersion };
}

/**
 * Rollback to a specific version (for development/testing only).
 */
export function rollbackTo(db: Database, targetVersion: number): void {
  const currentVersion = getCurrentSchemaVersion(db);

  if (targetVersion >= currentVersion) {
    throw new Error(
      `Cannot rollback from ${currentVersion} to ${targetVersion} (not a rollback)`
    );
  }

  // Find migrations to rollback (in reverse order)
  const toRollback = migrations
    .filter((m) => m.version > targetVersion && m.version <= currentVersion)
    .reverse();

  db.transaction(() => {
    for (const migration of toRollback) {
      if (!migration.down) {
        throw new Error(
          `Migration ${migration.version} has no rollback SQL (down property)`
        );
      }
      db.exec(migration.down);
      db.prepare(`DELETE FROM schema_info WHERE version = ?`).run(migration.version);
    }
  })();
}

/**
 * Create trigger for auto-updating sync_updated_at on page modifications.
 * Note: SQLite doesn't support updating the same table in an AFTER UPDATE trigger,
 * so we need to handle this at the application level instead.
 */
export function createUpdateTrigger(db: Database): void {
  // Note: This trigger pattern causes issues in SQLite.
  // Instead, we update sync_updated_at explicitly in the adapter's upsertPage method.
  // Keeping this function for documentation purposes.
  //
  // The problematic trigger was:
  // CREATE TRIGGER IF NOT EXISTS pages_sync_updated_at
  //     AFTER UPDATE ON pages
  //     FOR EACH ROW
  // BEGIN
  //     UPDATE pages SET sync_updated_at = datetime('now') WHERE page_id = NEW.page_id;
  // END;
}
