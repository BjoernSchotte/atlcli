import { describe, expect, test } from "bun:test";
import { markdownToStorage, storageToMarkdown } from "./markdown.js";
import { annotateTasksWithIssueLinks, extractPageTasks, setTaskStatuses, taskFingerprint } from "./page-tasks.js";

/** Shape the Cloud editor writes: task-uuid, placeholder span, mention, date. */
const CLOUD_STORAGE =
  `<p>Meeting notes</p>` +
  `<ac:task-list>` +
  `<ac:task><ac:task-id>7</ac:task-id><ac:task-uuid>u-1</ac:task-uuid><ac:task-status>incomplete</ac:task-status>` +
  `<ac:task-body><span class="placeholder-inline-tasks">Draft the &amp; release plan <ac:link><ri:user ri:account-id="557058:abc" /></ac:link> <time datetime="2026-11-30" /></span></ac:task-body></ac:task>` +
  `<ac:task><ac:task-id>8</ac:task-id><ac:task-uuid>u-2</ac:task-uuid><ac:task-status>complete</ac:task-status>` +
  `<ac:task-body><span class="placeholder-inline-tasks">Already done</span></ac:task-body></ac:task>` +
  `<ac:task><ac:task-id>9</ac:task-id><ac:task-uuid>u-3</ac:task-uuid><ac:task-status>incomplete</ac:task-status>` +
  `<ac:task-body><span class="placeholder-inline-tasks"><ac:structured-macro ac:name="jira" ac:schema-version="1"><ac:parameter ac:name="key">AB-12</ac:parameter></ac:structured-macro> Linked by hand</span></ac:task-body></ac:task>` +
  `</ac:task-list><p>After</p>`;

describe("extractPageTasks", () => {
  test("reads status, text, mention, date and linked keys from Cloud storage", () => {
    const tasks = extractPageTasks(CLOUD_STORAGE);
    expect(tasks.map((t) => [t.index, t.taskId, t.status, t.text])).toEqual([
      [0, "7", "incomplete", "Draft the & release plan"],
      [1, "8", "complete", "Already done"],
      [2, "9", "incomplete", "Linked by hand"],
    ]);
    expect(tasks[0]).toMatchObject({ assigneeAccountId: "557058:abc", dueDate: "2026-11-30", linkedIssueKeys: [] });
    expect(tasks[2]!.linkedIssueKeys).toEqual(["AB-12"]);
  });

  test("works on atlcli's own markdown push, where task ids repeat per list", () => {
    const storage = markdownToStorage("- [ ] one\n- [x] two\n\ntext\n\n- [ ] three\n");
    const tasks = extractPageTasks(storage);
    expect(tasks.map((t) => t.taskId)).toEqual(["1", "2", "1"]);
    expect(tasks.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(tasks.map((t) => t.text)).toEqual(["one", "two", "three"]);
  });

  test("a page without tasks yields none", () => {
    expect(extractPageTasks("<p>nothing</p>")).toEqual([]);
  });
});

describe("annotateTasksWithIssueLinks", () => {
  test("only inserts the links; every other byte is unchanged", () => {
    const tasks = extractPageTasks(CLOUD_STORAGE);
    const url = "https://x.atlassian.net/browse/AB-99";
    const out = annotateTasksWithIssueLinks(CLOUD_STORAGE, tasks, new Map([[0, url]]));
    const inserted = `<a href="${url}" data-card-appearance="inline">${url}</a> `;
    expect(out.replace(inserted, "")).toBe(CLOUD_STORAGE);
    expect(extractPageTasks(out)[0]!.linkedIssueKeys).toEqual(["AB-99"]);
    expect(extractPageTasks(out)[0]!.text).toBe("Draft the & release plan");
  });

  test("throws when the task is gone", () => {
    expect(() => annotateTasksWithIssueLinks(CLOUD_STORAGE, [], new Map([[0, "u"]]))).toThrow(/changed/);
  });

  test("the link survives a docs pull/push round trip (regression: ids renumber on push)", () => {
    const storage = markdownToStorage("- [ ] alpha\n- [ ] beta\n");
    const linked = annotateTasksWithIssueLinks(
      storage,
      extractPageTasks(storage),
      new Map([[1, "https://x.atlassian.net/browse/AB-5"]])
    );
    const roundTripped = markdownToStorage(storageToMarkdown(linked));
    const tasks = extractPageTasks(roundTripped);
    expect(tasks.map((t) => t.linkedIssueKeys)).toEqual([[], ["AB-5"]]);
    expect(tasks[1]!.text).toBe("beta");
  });
});

describe("setTaskStatuses", () => {
  test("changes only the status element", () => {
    const tasks = extractPageTasks(CLOUD_STORAGE);
    const out = setTaskStatuses(CLOUD_STORAGE, tasks, new Map([[0, "complete"], [1, "incomplete"]]));
    expect(extractPageTasks(out).map((t) => t.status)).toEqual(["complete", "incomplete", "incomplete"]);
    expect(out.length).toBe(CLOUD_STORAGE.length);
  });
});

describe("taskFingerprint", () => {
  test("ignores case and is stable", () => {
    expect(taskFingerprint({ text: "Do It" })).toBe(taskFingerprint({ text: "do it" }));
    expect(taskFingerprint({ text: "a" })).not.toBe(taskFingerprint({ text: "b" }));
  });
});
