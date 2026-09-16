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

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function nfsMountCommandFor(os: NodeJS.Platform, port: number, mountpoint: string):
  { run: string[] } | { instructions: string } {
  parseMountTransport("nfs", os);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid NFS port");
  // RO prototype: bounded retry avoids a hung reader after helper death. RW must
  // revisit soft mounts before enabling writes; they can lose application data.
  const options = `vers=3,tcp,ro,soft,timeo=10,retrans=2,port=${port},mountport=${port}`;
  if (os === "darwin") return { run: ["mount_nfs", "-o", `${options},nolocks`, "127.0.0.1:/", mountpoint] };
  return { instructions: "The experimental NFS server is listening. Attach it with the Linux NFS client:\n\n" +
    `    sudo mount -t nfs -o ${quote(`${options},nolock`)} 127.0.0.1:/ ${quote(mountpoint)}\n\n` +
    "The volume is read-only. Ctrl-C attempts a normal unmount before stopping the server.\n" };
}
