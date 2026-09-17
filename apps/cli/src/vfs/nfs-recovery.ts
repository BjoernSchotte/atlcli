import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";

/** Offline inspection/export never opens the journal through its migrating writer. */
export function recoverNfsJournal(path: string, options: { id?: string; output?: string; image?: string } = {}) {
  const image = options.image ?? "current";
  if (!["current", "intent", "base"].includes(image) ||
      Boolean(options.id) !== Boolean(options.output) || (options.image !== undefined && !options.id)) {
    throw new Error("Use a journal path to list records, or --id <id> --output <new-file> [--image current|intent|base]");
  }
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    if (schema !== 8 && schema !== 9 && schema !== 10 && schema !== 11 && schema !== 12) {
      throw new Error("Recovery requires NFS journal schema 8–12; keep the original journal and use its matching CLI version");
    }
    if (!options.id) {
      return db.query(`SELECT files.id,files.path,files.baseVersion,files.revision,publishedRevision,error,
        ${schema >= 9 ? "creations.path AS creationPath,creations.spaceKey AS creationSpace,creations.parentId AS creationParent,creations.pageId AS createdPageId,creations.version AS createdVersion," : ""}
        ${schema >= 12 ? "trash.path AS trashPath,trash.spaceKey AS trashSpace,trash.completed AS trashCompleted," : ""}
        length(files.bytes) AS size, COALESCE(locals.kind,'page') AS kind,
        displaced.path AS displacedPath, intents.revision AS intentRevision,
        EXISTS(SELECT 1 FROM bases WHERE bases.id=files.id) AS hasBase
        FROM files LEFT JOIN locals USING(id) LEFT JOIN displaced USING(id)
        LEFT JOIN intents USING(id) ${schema >= 9 ? "LEFT JOIN creations USING(id)" : ""} ${schema >= 12 ? "LEFT JOIN trash USING(id)" : ""} ORDER BY files.id`).all();
    }
    // Only this fixed table allowlist is interpolated; IDs remain SQL parameters.
    const table = image === "intent" ? "intents" : image === "base" ? "bases" : "files";
    const row = db.query<{ bytes: Uint8Array }, [string]>(`SELECT bytes FROM ${table} WHERE id=?`).get(options.id);
    if (!row) throw new Error("No such recovery image");
    // Exclusive creation refuses existing files and symlinks, including the journal itself.
    const fd = openSync(options.output!, "wx", 0o600);
    try { writeFileSync(fd, row.bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    return { exported: options.output, id: options.id, image, bytes: row.bytes.byteLength };
  } finally { db.close(); }
}
