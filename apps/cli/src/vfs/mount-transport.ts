import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";

export type MountTransport = "webdav" | "nfs";

export function parseMountTransport(value: unknown, os: NodeJS.Platform): MountTransport {
  const transport = value === undefined ? "webdav" : value;
  if (transport !== "webdav" && transport !== "nfs") throw new Error("Use --transport webdav|nfs");
  if (transport === "nfs" && os !== "darwin" && os !== "linux") {
    throw new Error("NFS mounts support macOS and Linux. Use --transport webdav on this platform.");
  }
  return transport;
}

/** Only explicit development override or adjacent distribution artifact; never PATH. */
export function findNfsHelper(override = process.env.ATLCLI_NFS_HELPER, executable = process.execPath): string {
  const helper = override ? resolve(override) : resolve(dirname(executable), "atlcli-confluence-nfs");
  try { accessSync(helper, constants.X_OK); }
  catch { throw new Error("NFS helper missing or not executable. Install the matching atlcli NFS helper, or set ATLCLI_NFS_HELPER to its path for development."); }
  return helper;
}

export function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Explicit kernel freshness bound; core metadata still has its separate 60s TTL. */
export function nfsMountOptionsFor(os: NodeJS.Platform, port: number, mode: "ro" | "rw" = "ro"): string {
  parseMountTransport("nfs", os);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid NFS port");
  if (mode !== "ro" && mode !== "rw") throw new Error("Use NFS mode ro|rw");
  // Soft retries bound RO reader waits. RW must keep retrying write
  // requests instead of returning timeout errors that can lose application data.
  const options = `vers=3,tcp,${mode},${mode === "rw" ? "hard" : "soft"},timeo=10,retrans=2,actimeo=1,port=${port},mountport=${port}`;
  return `${options},${os === "darwin" ? "locallocks,nonegnamecache" : "nolock,lookupcache=positive"}`;
}

export function nfsMountCommandFor(os: NodeJS.Platform, port: number, mountpoint: string, mode: "ro" | "rw" = "ro"):
  { run: string[] } | { instructions: string } {
  const options = nfsMountOptionsFor(os, port, mode);
  if (os === "darwin") return { run: ["mount_nfs", "-o", options, "127.0.0.1:/", mountpoint] };
  return { instructions: "The experimental NFS server is listening. Attach it with the Linux NFS client:\n\n" +
    `    sudo mount -t nfs -o ${quote(options)} 127.0.0.1:/ ${quote(mountpoint)}\n\n` +
    (mode === "ro" ? "The volume is read-only. " : "The writable volume uses hard retries; keep the server running until it is unmounted. ") +
    "Ctrl-C attempts a normal unmount before stopping the server.\n" };
}
