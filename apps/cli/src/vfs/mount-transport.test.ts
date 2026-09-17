import { expect, it } from "bun:test";
import { parseMountTransport, nfsMountCommandFor, nfsMountOptionsFor, findNfsHelper } from "./mount-transport.js";

it("keeps WebDAV as default and rejects unsupported selection before startup", () => {
  for (const os of ["darwin", "linux", "win32"] as const) expect(parseMountTransport(undefined, os)).toBe("webdav");
  expect(parseMountTransport("nfs", "darwin")).toBe("nfs");
  expect(parseMountTransport("nfs", "linux")).toBe("nfs");
  expect(() => parseMountTransport("nfs", "win32")).toThrow("webdav");
  expect(() => parseMountTransport("ftp", "linux")).toThrow("webdav|nfs");
  expect(() => parseMountTransport(true, "linux")).toThrow();
});

it("uses explicit loopback ports and tested client options", () => {
  const mac = nfsMountCommandFor("darwin", 12345, "/tmp/wiki docs");
  expect("run" in mac && mac.run).toEqual(["mount_nfs", "-o",
    "vers=3,tcp,ro,soft,timeo=10,retrans=2,actimeo=1,port=12345,mountport=12345,locallocks,nonegnamecache,dumbtimer", "127.0.0.1:/", "/tmp/wiki docs"]);
  const linux = nfsMountCommandFor("linux", 12345, "/tmp/wiki's docs");
  expect("instructions" in linux && linux.instructions).toContain("'/tmp/wiki'\\''s docs'");
  expect("instructions" in linux && linux.instructions).toContain("nolock,lookupcache=positive");
  expect(() => nfsMountCommandFor("darwin", 0, "/tmp/wiki")).toThrow("port");
  expect(() => nfsMountCommandFor("win32", 12345, "X:")).toThrow("webdav");
});

it("requires an explicit executable helper instead of searching PATH", () => {
  expect(findNfsHelper(process.execPath)).toBe(process.execPath);
  expect(() => findNfsHelper("/no-such-directory/atlcli-confluence-nfs")).toThrow("NFS helper missing");
  expect(() => findNfsHelper(undefined, "/no-such-directory/atlcli")).toThrow("NFS helper missing");
});


it("uses hard retries for writable mounts on both platforms without changing RO defaults", () => {
  for (const os of ["darwin", "linux"] as const) {
    const writable = nfsMountOptionsFor(os, 12345, "rw").split(",");
    expect(writable).toContain("rw");
    expect(writable).toContain("hard");
    expect(writable).not.toContain("soft");
    expect(writable).not.toContain("ro");
    expect(nfsMountOptionsFor(os, 12345)).toBe(nfsMountOptionsFor(os, 12345, "ro"));
    const command = nfsMountCommandFor(os, 12345, "/tmp/wiki docs", "rw");
    if ("run" in command) expect(command.run[2]).toBe(writable.join(","));
    else {
      expect(command.instructions).toContain(writable.join(","));
      expect(command.instructions).toContain("writable volume uses hard retries");
      expect(command.instructions).not.toContain("read-only");
    }
  }
  expect(() => nfsMountOptionsFor("linux", 12345, "invalid" as "rw")).toThrow("mode");
});
