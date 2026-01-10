declare module "markdown-it-task-lists" {
  import MarkdownIt from "markdown-it";

  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  function taskLists(md: MarkdownIt, options?: TaskListsOptions): void;
  export = taskLists;
}

declare module "turndown-plugin-gfm" {
  import TurndownService from "turndown";

  export function gfm(turndownService: TurndownService): void;
  export function strikethrough(turndownService: TurndownService): void;
  export function tables(turndownService: TurndownService): void;
  export function taskListItems(turndownService: TurndownService): void;
}
