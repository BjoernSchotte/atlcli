import { describe, expect, it } from "bun:test";
import { assertNotStructurallyReadOnly, assertWritable, isWritable, type WriteOp } from "./mode.js";
import type { ModeGuard } from "./mode.js";

const ALL_OPS: WriteOp[] = [
  "create",
  "update",
  "mkdir",
  "rename",
  "move",
  "copy",
  "delete",
  "upload-attachment",
  "delete-attachment",
];

const DELETE_OPS: WriteOp[] = ["delete", "delete-attachment"];
const NON_DELETE_OPS = ALL_OPS.filter((op) => !DELETE_OPS.includes(op));

const ro: ModeGuard = { mode: "ro", allowDelete: false };
const roWithDelete: ModeGuard = { mode: "ro", allowDelete: true };
const rw: ModeGuard = { mode: "rw", allowDelete: false };
const rwDelete: ModeGuard = { mode: "rw", allowDelete: true };

describe("assertWritable in ro mode", () => {
  for (const op of ALL_OPS) {
    it(`refuses ${op} with EROFS`, () => {
      expect(() => assertWritable(ro, op, "/DOCSY/a-1.md")).toThrow(
        expect.objectContaining({ code: "EROFS" }),
      );
    });
  }

  it("names the flag that would grant the write", () => {
    try {
      assertWritable(ro, "update", "/DOCSY/a-1.md");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("--mode rw");
      expect((error as Error).message).toContain("/DOCSY/a-1.md");
    }
  });

  it("stays EROFS even when allowDelete is set, because the mode decides first", () => {
    expect(() => assertWritable(roWithDelete, "delete")).toThrow(
      expect.objectContaining({ code: "EROFS" }),
    );
  });
});

describe("assertWritable in rw mode", () => {
  for (const op of NON_DELETE_OPS) {
    it(`allows ${op}`, () => {
      expect(() => assertWritable(rw, op)).not.toThrow();
    });
  }

  for (const op of DELETE_OPS) {
    it(`refuses ${op} with EACCES until allowDelete is set`, () => {
      expect(() => assertWritable(rw, op, "/DOCSY/a-1.md")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
      expect(() => assertWritable(rwDelete, op, "/DOCSY/a-1.md")).not.toThrow();
    });
  }

  it("explains that deletion is the trash, not a purge", () => {
    try {
      assertWritable(rw, "delete", "/DOCSY/a-1.md");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("--allow-delete");
      expect((error as Error).message).toContain("trash");
    }
  });
});

describe("isWritable", () => {
  it("mirrors assertWritable without throwing", () => {
    for (const op of ALL_OPS) {
      for (const guard of [ro, roWithDelete, rw, rwDelete]) {
        let threw = false;
        try {
          assertWritable(guard, op);
        } catch {
          threw = true;
        }
        expect(isWritable(guard, op)).toBe(!threw);
      }
    }
  });
});

describe("assertNotStructurallyReadOnly", () => {
  it("always throws EROFS and carries the reason", () => {
    expect(() =>
      assertNotStructurallyReadOnly("/DOCSY/x-1/.versions/3.md", "page versions are immutable"),
    ).toThrow(expect.objectContaining({ code: "EROFS" }));
  });
});
