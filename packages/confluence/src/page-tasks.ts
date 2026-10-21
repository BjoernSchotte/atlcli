/**
 * Confluence task items (`<ac:task>`) in storage format: read them, and edit
 * them in place. Functional core for `wiki page tasks-to-issues` (spec
 * jira-content-workflows A2). Browser-safe.
 *
 * Tasks are addressed by their position in the document (`index`), not by
 * `<ac:task-id>`: atlcli's own markdown push numbers ids per list, so ids
 * repeat on one page. Edits splice the original string at recorded offsets
 * instead of re-serialising, so every byte outside the edited spots survives.
 */
import { parseXml, type XmlNode } from "./export-blocks.js";
import { sha256HexOfUtf8 } from "./sha256.js";

export interface PageTask {
  /** Position among all tasks on the page, document order. */
  index: number;
  /** `<ac:task-id>` as written; not unique per page. */
  taskId: string;
  status: "complete" | "incomplete";
  /** Body text without mentions, dates and Jira links, whitespace collapsed. */
  text: string;
  /** Raw `<ac:task-body>` inner storage (nested task lists included). */
  bodyStorage: string;
  /** First mentioned user. */
  assigneeAccountId?: string;
  mentionAccountIds: string[];
  /** First `<time datetime>` (YYYY-MM-DD). */
  dueDate?: string;
  /** Issue keys already linked from the body (Jira macro or /browse/KEY link). */
  linkedIssueKeys: string[];
  /** Offsets into the storage string the task was extracted from. */
  bodyStart: number;
  statusStart: number;
  statusEnd: number;
}

const TASK_OPEN = /<ac:task(?:\s[^>]*)?>/g;
const BROWSE_KEY = /\/browse\/([A-Z][A-Z0-9_]*-\d+)\b/;

/** All tasks on a page, in document order. */
export function extractPageTasks(storage: string): PageTask[] {
  const tasks: PageTask[] = [];
  TASK_OPEN.lastIndex = 0;
  for (let match = TASK_OPEN.exec(storage); match; match = TASK_OPEN.exec(storage)) {
    const from = match.index + match[0].length;
    const id = /<ac:task-id>([^<]*)<\/ac:task-id>/.exec(storage.slice(from));
    const status = /<ac:task-status>([^<]*)<\/ac:task-status>/.exec(storage.slice(from));
    const bodyOpen = /<ac:task-body(?:\s[^>]*)?>/.exec(storage.slice(from));
    // Status and id belong to this task only if they come before its body.
    if (!status || !bodyOpen || status.index > bodyOpen.index) continue;
    // A self-closing or empty body still yields a task with empty text.
    const bodyStart = from + bodyOpen.index + bodyOpen[0].length;
    const bodyEnd = bodyOpen[0].endsWith("/>") ? bodyStart : findClose(storage, bodyStart, "ac:task-body");
    if (bodyEnd < 0) continue;
    const bodyStorage = storage.slice(bodyStart, bodyEnd);
    const statusStart = from + status.index + "<ac:task-status>".length;

    const facts = collectBodyFacts(parseXml(bodyStorage));
    tasks.push({
      index: tasks.length,
      taskId: id?.[1]?.trim() ?? "",
      status: status[1]!.trim() === "complete" ? "complete" : "incomplete",
      text: facts.text.replace(/\s+/g, " ").trim(),
      bodyStorage,
      assigneeAccountId: facts.mentions[0],
      mentionAccountIds: facts.mentions,
      dueDate: facts.dates[0],
      linkedIssueKeys: [...new Set(facts.keys)],
      bodyStart,
      statusStart,
      statusEnd: statusStart + status[1]!.length,
    });
  }
  return tasks;
}

/** Index of the `</name>` closing the element whose content starts at `from`. */
function findClose(storage: string, from: number, name: string): number {
  const tag = new RegExp(`<(/?)${name}(?:\\s[^>]*)?(/?)>`, "g");
  tag.lastIndex = from;
  let depth = 1;
  for (let m = tag.exec(storage); m; m = tag.exec(storage)) {
    if (m[2]) continue; // self-closing
    if (m[1]) {
      if (--depth === 0) return m.index;
    } else {
      depth++;
    }
  }
  return -1;
}

interface BodyFacts {
  text: string;
  mentions: string[];
  dates: string[];
  keys: string[];
}

function collectBodyFacts(nodes: XmlNode[]): BodyFacts {
  const facts: BodyFacts = { text: "", mentions: [], dates: [], keys: [] };
  const walk = (list: XmlNode[]) => {
    for (const node of list) {
      if (node.type === "text") {
        facts.text += node.text;
        continue;
      }
      switch (node.name) {
        case "ac:task-list": // nested tasks are their own tasks
          continue;
        case "ac:link": {
          // A mention: record the user, drop its link text from the summary.
          const user = node.children.find((child) => child.type === "element" && child.name === "ri:user");
          if (user?.type === "element") {
            const id = user.attrs["ri:account-id"];
            if (id) facts.mentions.push(id);
            continue;
          }
          walk(node.children);
          continue;
        }
        case "time": {
          const date = node.attrs.datetime;
          if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) facts.dates.push(date.slice(0, 10));
          continue;
        }
        case "ac:structured-macro": {
          if (node.attrs["ac:name"] === "jira") {
            const key = node.children.find(
              (child) => child.type === "element" && child.name === "ac:parameter" && child.attrs["ac:name"] === "key"
            );
            const text = key?.type === "element" ? textOf(key.children).trim() : "";
            if (text) facts.keys.push(text);
          }
          continue;
        }
        case "a": {
          const key = BROWSE_KEY.exec(node.attrs.href ?? "")?.[1];
          if (key) {
            facts.keys.push(key);
            continue; // the link text is the URL or key; keep it out of the summary
          }
          walk(node.children);
          facts.text += " ";
          continue;
        }
        case "br":
        case "p":
        case "li":
          walk(node.children);
          facts.text += " ";
          continue;
        default:
          walk(node.children);
      }
    }
  };
  walk(nodes);
  return facts;
}

function textOf(nodes: XmlNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : textOf(node.children))).join("");
}

/** Stable identity of a task across edits that keep its text (ids are not stable). */
export function taskFingerprint(task: Pick<PageTask, "text">): string {
  return sha256HexOfUtf8(task.text.toLowerCase());
}

/**
 * Prepend an inline smart link to each listed task's body. `links` maps task
 * index → issue URL. `tasks` must come from this exact `storage` string.
 */
export function annotateTasksWithIssueLinks(
  storage: string,
  tasks: readonly PageTask[],
  links: ReadonlyMap<number, string>
): string {
  return splice(
    storage,
    [...links].map(([index, url]) => {
      const task = requireTask(tasks, index);
      const href = escapeAttr(url);
      return { at: task.bodyStart, end: task.bodyStart, text: `<a href="${href}" data-card-appearance="inline">${href}</a> ` };
    })
  );
}

/** Set task status (`complete` / `incomplete`) by task index. */
export function setTaskStatuses(
  storage: string,
  tasks: readonly PageTask[],
  statuses: ReadonlyMap<number, PageTask["status"]>
): string {
  return splice(
    storage,
    [...statuses].map(([index, status]) => {
      const task = requireTask(tasks, index);
      return { at: task.statusStart, end: task.statusEnd, text: status };
    })
  );
}

function requireTask(tasks: readonly PageTask[], index: number): PageTask {
  const task = tasks[index];
  if (!task || task.index !== index) throw new Error(`Task #${index} is not on the page (it changed while we worked).`);
  return task;
}

function splice(storage: string, edits: Array<{ at: number; end: number; text: string }>): string {
  let out = storage;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.end);
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
