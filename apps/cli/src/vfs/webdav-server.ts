/**
 * The loopback WebDAV server (WP7.4).
 *
 * ## The binding rule
 *
 * On `127.0.0.1` the server is unauthenticated, because anything that can reach
 * it can already read the user's own files. **Any other binding requires a
 * bearer token**, and asking for one without a token is refused rather than
 * silently downgraded — a Confluence tenant reachable on `0.0.0.0` with no
 * auth is precisely the accident this rule exists to prevent.
 */
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { v2 as webdav } from "webdav-server";
import type { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import {
  ConfluenceWebdavFileSystem,
  RootFileSystem,
  SweepDetector,
  type SweepReport,
} from "./webdav-fs.js";

export interface WebdavServerOptions {
  vfs: ConfluenceVfsImpl;
  spaces: string[];
  /** 0 picks a free port. */
  port?: number;
  /** Defaults to 127.0.0.1. Anything else demands a token. */
  hostname?: string;
  /** Required for a non-loopback binding; generated when asked for. */
  bearerToken?: string;
  onSweep?: (report: SweepReport) => void;
  onLog?: (line: string) => void;
}

export interface RunningWebdavServer {
  url: string;
  port: number;
  hostname: string;
  bearerToken: string | undefined;
  /** Flushes pending writes, then stops listening. */
  stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

export function generateBearerToken(): string {
  return randomBytes(24).toString("base64url");
}

async function mount(
  server: webdav.WebDAVServer,
  path: string,
  filesystem: webdav.FileSystem,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.setFileSystem(path, filesystem, (ok) =>
      ok ? resolve() : reject(new Error(`could not mount the Confluence filesystem at ${path}`)),
    );
  });
}

export async function startWebdavServer(
  options: WebdavServerOptions,
): Promise<RunningWebdavServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const loopback = isLoopback(hostname);
  if (!loopback && !options.bearerToken) {
    throw new Error(
      `Refusing to serve Confluence on ${hostname} without authentication. ` +
        `Bind to 127.0.0.1, or pass --token to require a bearer token.`,
    );
  }
  const bearerToken = loopback ? options.bearerToken : options.bearerToken;

  const server = new webdav.WebDAVServer({
    hostname,
    port: options.port ?? 0,
    requireAuthentification: false,
    ...(bearerToken
      ? {
          // A bearer check in front of everything, before any backend call.
          httpAuthentication: new BearerAuthentication(bearerToken),
        }
      : {}),
  });

  // One sweep detector for the whole volume: an indexer walking three spaces
  // is one sweep, not three.
  const sweepDetector = new SweepDetector(50, 10_000, options.onSweep);

  await mount(server, "/", new RootFileSystem(options.vfs));
  for (const spaceKey of options.spaces) {
    await mount(
      server,
      `/${spaceKey}`,
      new ConfluenceWebdavFileSystem({ vfs: options.vfs, spaceKey, sweepDetector }),
    );
  }

  const port = await new Promise<number>((resolve) => {
    server.start((httpServer?: Server) => {
      const address = httpServer?.address();
      resolve(typeof address === "object" && address ? address.port : (options.port ?? 0));
    });
  });

  options.onLog?.(`webdav listening on http://${hostname}:${port}/`);

  return {
    url: `http://${hostname}:${port}/`,
    port,
    hostname,
    bearerToken,
    async stop(): Promise<void> {
      // Pending coalesced writes first: stopping the server must not be the
      // thing that loses an edit.
      await options.vfs.flush();
      await new Promise<void>((resolve) => server.stop(() => resolve()));
    },
  };
}

/**
 * Bearer authentication for a non-loopback binding.
 *
 * Deliberately minimal and constant-time: it exists so that binding beyond
 * loopback is *possible* under an explicit token, not to be a general auth
 * framework.
 */
class BearerAuthentication implements webdav.HTTPAuthentication {
  constructor(private readonly token: string) {}

  askForAuthentication(): Record<string, string> {
    return { "WWW-Authenticate": 'Bearer realm="atlcli"' };
  }

  getUser(
    ctx: webdav.HTTPRequestContext,
    callback: (error: Error, user?: webdav.IUser) => void,
  ): void {
    const header = ctx.headers.find("Authorization", "");
    const presented = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? "";
    if (!timingSafeEqual(presented, this.token)) {
      callback(webdav.Errors.BadAuthentication);
      return;
    }
    // The callback's error parameter is typed non-optional upstream, so a
    // success passes `undefined` through the same slot, as its own
    // implementations do.
    callback(undefined as unknown as Error, {
      uid: "atlcli",
      username: "atlcli",
      isAdministrator: false,
      isDefaultUser: false,
      password: undefined,
    } as unknown as webdav.IUser);
  }
}

/** Length-independent comparison, so a token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
