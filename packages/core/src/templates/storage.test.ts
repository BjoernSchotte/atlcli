import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GlobalTemplateStorage,
  ProfileTemplateStorage,
  SpaceTemplateStorage,
  getTemplatesBaseDir,
} from "./storage.js";
import { TemplateResolver } from "./resolver.js";
import type { Template } from "./types.js";

describe("storage", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-templates-test-"));
    originalEnv = process.env.ATLCLI_TEMPLATES_DIR;
    process.env.ATLCLI_TEMPLATES_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.ATLCLI_TEMPLATES_DIR;
    } else {
      process.env.ATLCLI_TEMPLATES_DIR = originalEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function createTemplate(name: string, level: "global" | "profile" | "space" = "global"): Template {
    return {
      metadata: {
        name,
        description: `${name} template`,
        tags: ["test"],
      },
      content: `# {{title}}\n\nContent for ${name}`,
      source: { level, path: "" },
    };
  }

  describe("GlobalTemplateStorage", () => {
    test("save and get template", async () => {
      const storage = new GlobalTemplateStorage();
      const template = createTemplate("test-global");

      await storage.save(template);
      const retrieved = await storage.get("test-global");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.metadata.name).toBe("test-global");
      expect(retrieved!.metadata.description).toBe("test-global template");
      expect(retrieved!.content).toContain("Content for test-global");
    });

    test("list templates", async () => {
      const storage = new GlobalTemplateStorage();
      await storage.save(createTemplate("template-a"));
      await storage.save(createTemplate("template-b"));

      const list = await storage.list();
      expect(list).toHaveLength(2);
      expect(list.map((t) => t.name).sort()).toEqual(["template-a", "template-b"]);
    });

    test("list with tag filter", async () => {
      const storage = new GlobalTemplateStorage();
      const t1 = createTemplate("with-tag");
      t1.metadata.tags = ["meeting"];
      const t2 = createTemplate("without-tag");
      t2.metadata.tags = ["other"];

      await storage.save(t1);
      await storage.save(t2);

      const filtered = await storage.list({ tags: ["meeting"] });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("with-tag");
    });

    test("list with search filter", async () => {
      const storage = new GlobalTemplateStorage();
      const t1 = createTemplate("meeting-notes");
      t1.metadata.description = "For team meetings";
      const t2 = createTemplate("other");
      t2.metadata.description = "Something else";

      await storage.save(t1);
      await storage.save(t2);

      const filtered = await storage.list({ search: "meeting" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("meeting-notes");
    });

    test("delete template", async () => {
      const storage = new GlobalTemplateStorage();
      await storage.save(createTemplate("to-delete"));

      expect(await storage.exists("to-delete")).toBe(true);
      await storage.delete("to-delete");
      expect(await storage.exists("to-delete")).toBe(false);
    });

    test("rename template", async () => {
      const storage = new GlobalTemplateStorage();
      await storage.save(createTemplate("old-name"));

      await storage.rename("old-name", "new-name");

      expect(await storage.exists("old-name")).toBe(false);
      expect(await storage.exists("new-name")).toBe(true);

      const renamed = await storage.get("new-name");
      expect(renamed!.metadata.name).toBe("new-name");
    });

    test("exists returns false for non-existent", async () => {
      const storage = new GlobalTemplateStorage();
      expect(await storage.exists("non-existent")).toBe(false);
    });
  });

  describe("ProfileTemplateStorage", () => {
    test("stores templates in profile directory", async () => {
      const storage = new ProfileTemplateStorage("work");
      await storage.save(createTemplate("work-template", "profile"));

      const retrieved = await storage.get("work-template");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.source.level).toBe("profile");
      expect(retrieved!.source.profile).toBe("work");
    });

    test("different profiles have separate storage", async () => {
      const workStorage = new ProfileTemplateStorage("work");
      const personalStorage = new ProfileTemplateStorage("personal");

      await workStorage.save(createTemplate("shared-name", "profile"));

      expect(await workStorage.exists("shared-name")).toBe(true);
      expect(await personalStorage.exists("shared-name")).toBe(false);
    });

    test("list returns profile in summary", async () => {
      const storage = new ProfileTemplateStorage("work");
      await storage.save(createTemplate("test", "profile"));

      const list = await storage.list();
      expect(list[0].profile).toBe("work");
      expect(list[0].level).toBe("profile");
    });
  });

  describe("SpaceTemplateStorage", () => {
    test("stores templates in space directory", async () => {
      const storage = new SpaceTemplateStorage("TEAM");
      await storage.save(createTemplate("space-template", "space"));

      const retrieved = await storage.get("space-template");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.source.level).toBe("space");
      expect(retrieved!.source.space).toBe("TEAM");
    });

    test("different spaces have separate storage", async () => {
      const teamStorage = new SpaceTemplateStorage("TEAM");
      const devStorage = new SpaceTemplateStorage("DEV");

      await teamStorage.save(createTemplate("shared-name", "space"));

      expect(await teamStorage.exists("shared-name")).toBe(true);
      expect(await devStorage.exists("shared-name")).toBe(false);
    });

    test("prefers docs folder over config folder", async () => {
      const docsDir = join(tempDir, "docs");
      const storage = new SpaceTemplateStorage("TEAM", docsDir);

      await storage.save(createTemplate("in-docs", "space"));

      // Should be saved in docs folder
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(docsDir, ".atlcli", "templates", "in-docs.md"))).toBe(true);
    });
  });
});

describe("resolver", () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlcli-resolver-test-"));
    originalEnv = process.env.ATLCLI_TEMPLATES_DIR;
    process.env.ATLCLI_TEMPLATES_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.ATLCLI_TEMPLATES_DIR;
    } else {
      process.env.ATLCLI_TEMPLATES_DIR = originalEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function createTemplate(name: string, level: "global" | "profile" | "space"): Template {
    return {
      metadata: {
        name,
        description: `${name} at ${level}`,
      },
      content: `# ${name} (${level})`,
      source: { level, path: "" },
    };
  }

  test("resolve returns global template when only global exists", async () => {
    const global = new GlobalTemplateStorage();
    await global.save(createTemplate("test", "global"));

    const resolver = new TemplateResolver(global);
    const template = await resolver.resolve("test");

    expect(template).not.toBeNull();
    expect(template!.source.level).toBe("global");
  });

  test("resolve prefers profile over global", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");

    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));

    const resolver = new TemplateResolver(global, profile);
    const template = await resolver.resolve("shared");

    expect(template).not.toBeNull();
    expect(template!.source.level).toBe("profile");
  });

  test("resolve prefers space over profile and global", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");
    const space = new SpaceTemplateStorage("TEAM");

    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));
    await space.save(createTemplate("shared", "space"));

    const resolver = new TemplateResolver(global, profile, space);
    const template = await resolver.resolve("shared");

    expect(template).not.toBeNull();
    expect(template!.source.level).toBe("space");
  });

  test("resolve returns null for non-existent template", async () => {
    const global = new GlobalTemplateStorage();
    const resolver = new TemplateResolver(global);

    const template = await resolver.resolve("non-existent");
    expect(template).toBeNull();
  });

  test("findAllByName returns all matches", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");
    const space = new SpaceTemplateStorage("TEAM");

    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));
    await space.save(createTemplate("shared", "space"));

    const resolver = new TemplateResolver(global, profile, space);
    const templates = await resolver.findAllByName("shared");

    expect(templates).toHaveLength(3);
    expect(templates.map((t) => t.source.level).sort()).toEqual([
      "global",
      "profile",
      "space",
    ]);
  });

  test("listAll returns unique templates by default", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");

    await global.save(createTemplate("global-only", "global"));
    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));
    await profile.save(createTemplate("profile-only", "profile"));

    const resolver = new TemplateResolver(global, profile);
    const list = await resolver.listAll();

    expect(list).toHaveLength(3);
    const names = list.map((t) => t.name).sort();
    expect(names).toEqual(["global-only", "profile-only", "shared"]);

    // "shared" should be the profile version
    const shared = list.find((t) => t.name === "shared");
    expect(shared!.level).toBe("profile");
  });

  test("listAll with includeOverridden shows all", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");

    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));

    const resolver = new TemplateResolver(global, profile);
    const list = await resolver.listAll({ includeOverridden: true });

    expect(list).toHaveLength(2);
    expect(list.some((t) => t.level === "global")).toBe(true);
    expect(list.some((t) => t.level === "profile")).toBe(true);
  });

  test("exists checks all levels", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");

    await global.save(createTemplate("in-global", "global"));
    await profile.save(createTemplate("in-profile", "profile"));

    const resolver = new TemplateResolver(global, profile);

    expect(await resolver.exists("in-global")).toBe(true);
    expect(await resolver.exists("in-profile")).toBe(true);
    expect(await resolver.exists("nowhere")).toBe(false);
  });

  test("getStorage returns correct storage", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");
    const space = new SpaceTemplateStorage("TEAM");

    const resolver = new TemplateResolver(global, profile, space);

    expect(resolver.getStorage("global")).toBe(global);
    expect(resolver.getStorage("profile")).toBe(profile);
    expect(resolver.getStorage("space")).toBe(space);
  });

  test("getTemplateLocations returns all locations", async () => {
    const global = new GlobalTemplateStorage();
    const profile = new ProfileTemplateStorage("work");

    await global.save(createTemplate("shared", "global"));
    await profile.save(createTemplate("shared", "profile"));

    const resolver = new TemplateResolver(global, profile);
    const locations = await resolver.getTemplateLocations("shared");

    expect(locations).toHaveLength(2);
    expect(locations.some((l) => l.level === "global")).toBe(true);
    expect(locations.some((l) => l.level === "profile")).toBe(true);
  });
});
