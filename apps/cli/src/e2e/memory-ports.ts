/**
 * In-memory implementations of the E2E ports.
 *
 * These are real implementations of the designed port interfaces, not mocks:
 * they hold state, enforce the same not-found errors the REST adapters surface,
 * and can be driven end to end. Tests use them to exercise the tracker and the
 * sweeper without a tenant; nothing here stubs `fetch`.
 *
 * @module
 */

import {
  E2E_RUN_ID_PROPERTY,
  type E2eConfluencePort,
  type E2eIssueRecord,
  type E2eJiraPort,
  type E2ePageRecord,
} from "./resources.js";

export interface MemoryPage {
  id: string;
  title: string;
  spaceKey: string;
  storage: string;
  parentId?: string;
  properties: Map<string, string>;
}

export interface MemoryIssue {
  id: string;
  key: string;
  summary: string;
  projectKey: string;
  issueType: string;
  properties: Map<string, string>;
}

/** An in-memory Confluence, with hooks for forcing the failure paths. */
export class MemoryConfluence implements E2eConfluencePort {
  readonly pages = new Map<string, MemoryPage>();
  /** Every deletePage call in order, including ones that threw. */
  readonly deleteLog: string[] = [];
  /** Set to make the next property write fail (orphan-marker path). */
  failNextPropertyWrite = false;
  /** Page IDs whose deletion should fail. */
  readonly failDeletesFor = new Set<string>();

  private nextId = 1000;

  /** Seed a page directly, e.g. a retained fixture that must never be swept. */
  seed(page: {
    id?: string;
    title: string;
    spaceKey: string;
    runId?: string;
    properties?: Record<string, string>;
  }): MemoryPage {
    const id = page.id ?? String(this.nextId++);
    const properties = new Map(Object.entries(page.properties ?? {}));
    if (page.runId !== undefined) properties.set(E2E_RUN_ID_PROPERTY, page.runId);
    const record: MemoryPage = {
      id,
      title: page.title,
      spaceKey: page.spaceKey,
      storage: "",
      properties,
    };
    this.pages.set(id, record);
    return record;
  }

  async createPage(input: { spaceKey: string; title: string; storage: string; parentId?: string }) {
    const id = String(this.nextId++);
    this.pages.set(id, {
      id,
      title: input.title,
      spaceKey: input.spaceKey,
      storage: input.storage,
      parentId: input.parentId,
      properties: new Map(),
    });
    return { id, title: input.title };
  }

  async deletePage(pageId: string): Promise<void> {
    this.deleteLog.push(pageId);
    if (this.failDeletesFor.has(pageId)) throw new Error(`HTTP 500 deleting page ${pageId}`);
    if (!this.pages.has(pageId)) throw new Error(`Page ${pageId} not found`);
    this.pages.delete(pageId);
  }

  async setPageProperty(pageId: string, key: string, value: string): Promise<void> {
    if (this.failNextPropertyWrite) {
      this.failNextPropertyWrite = false;
      throw new Error(`HTTP 403 setting content property ${key} on page ${pageId}`);
    }
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Page ${pageId} not found`);
    page.properties.set(key, value);
  }

  async getPageProperty(pageId: string, key: string): Promise<string | undefined> {
    return this.pages.get(pageId)?.properties.get(key);
  }

  async listPages(spaceKey: string): Promise<E2ePageRecord[]> {
    return [...this.pages.values()]
      .filter((page) => page.spaceKey === spaceKey)
      .map((page) => ({
        id: page.id,
        title: page.title,
        spaceKey: page.spaceKey,
        runId: page.properties.get(E2E_RUN_ID_PROPERTY),
      }));
  }
}

/** An in-memory Jira, with the same failure hooks. */
export class MemoryJira implements E2eJiraPort {
  readonly issues = new Map<string, MemoryIssue>();
  readonly deleteLog: string[] = [];
  failNextPropertyWrite = false;
  readonly failDeletesFor = new Set<string>();

  private nextId = 5000;

  seed(issue: { key?: string; summary: string; projectKey: string; runId?: string }): MemoryIssue {
    const id = String(this.nextId++);
    const key = issue.key ?? `${issue.projectKey}-${id}`;
    const properties = new Map<string, string>();
    if (issue.runId !== undefined) properties.set(E2E_RUN_ID_PROPERTY, issue.runId);
    const record: MemoryIssue = {
      id,
      key,
      summary: issue.summary,
      projectKey: issue.projectKey,
      issueType: "Task",
      properties,
    };
    this.issues.set(key, record);
    return record;
  }

  async createIssue(input: { projectKey: string; summary: string; issueType: string }) {
    const id = String(this.nextId++);
    const key = `${input.projectKey}-${id}`;
    this.issues.set(key, {
      id,
      key,
      summary: input.summary,
      projectKey: input.projectKey,
      issueType: input.issueType,
      properties: new Map(),
    });
    return { id, key };
  }

  async deleteIssue(issueKey: string): Promise<void> {
    this.deleteLog.push(issueKey);
    if (this.failDeletesFor.has(issueKey)) throw new Error(`HTTP 500 deleting issue ${issueKey}`);
    if (!this.issues.has(issueKey)) throw new Error(`Issue ${issueKey} not found`);
    this.issues.delete(issueKey);
  }

  async setIssueProperty(issueKey: string, key: string, value: string): Promise<void> {
    if (this.failNextPropertyWrite) {
      this.failNextPropertyWrite = false;
      throw new Error(`HTTP 403 setting issue property ${key} on ${issueKey}`);
    }
    const issue = this.issues.get(issueKey);
    if (!issue) throw new Error(`Issue ${issueKey} not found`);
    issue.properties.set(key, value);
  }

  async getIssueProperty(issueKey: string, key: string): Promise<string | undefined> {
    return this.issues.get(issueKey)?.properties.get(key);
  }

  async listIssues(projectKey: string): Promise<E2eIssueRecord[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.projectKey === projectKey)
      .map((issue) => ({
        key: issue.key,
        summary: issue.summary,
        projectKey: issue.projectKey,
        runId: issue.properties.get(E2E_RUN_ID_PROPERTY),
      }));
  }
}
