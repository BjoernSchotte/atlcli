/** @jsxImportSource @opentui/react */
/**
 * `atlcli tui` (spike): a fullscreen Jira issue browser on OpenTUI + React.
 * Loaded only by `atlcli tui`, so the rest of the CLI never imports OpenTUI.
 */
import { createCliRenderer, RGBA, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { adfToMarkdown, type JiraClient, type JiraIssue } from "@atlcli/jira";
import { initialState, keyFor, reduce, type Action, type Pane } from "./state.js";

const C = {
  border: "#4b5563",
  focus: "#7aa2f7",
  dim: "#9ca3af",
  selectedBg: "#2f3449",
  key: "#7dcfff",
  status: "#e0af68",
  error: "#f7768e",
};

type Detail = { markdown: string } | { error: string };

export type TuiOptions = {
  client: JiraClient;
  jql: string;
  openUrl: (url: string) => Promise<void>;
};

function App({ client, jql, openUrl, syntaxStyle, onQuit }: TuiOptions & { syntaxStyle: SyntaxStyle; onQuit: () => void }) {
  const { width, height } = useTerminalDimensions();
  // Keys can arrive in one batch (fast typing, paste, tmux), before React re-renders,
  // so the state advances synchronously in a ref and React only renders the result.
  const stateRef = useRef(initialState);
  const [state, setState] = useState(initialState);
  const dispatch = useCallback((action: Action) => {
    stateRef.current = reduce(stateRef.current, action);
    setState(stateRef.current);
  }, []);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [status, setStatus] = useState("Loading…");
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const listRef = useRef<ScrollBoxRenderable>(null);
  const detailRef = useRef<ScrollBoxRenderable>(null);
  const issue = issues[state.selected];

  const load = useCallback(async () => {
    setStatus("Loading…");
    try {
      const result = await client.search(jql, {
        maxResults: 100,
        fields: ["summary", "status", "assignee", "issuetype", "priority", "updated"],
      });
      setIssues(result.issues);
      setDetails({});
      dispatch({ type: "loaded", count: result.issues.length });
      setStatus(`${result.issues.length} issues`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [client, jql, dispatch]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetch the selected issue's description once; the list search leaves it out.
  useEffect(() => {
    if (!issue || details[issue.key]) return;
    const key = issue.key;
    client
      .getIssue(key, { fields: ["description"] })
      .then((full) => adfToMarkdown(full.fields.description, { baseUrl: client.siteUrl }) || "_No description._")
      .then(
        (markdown) => setDetails((d) => ({ ...d, [key]: { markdown } })),
        (err) => setDetails((d) => ({ ...d, [key]: { error: err instanceof Error ? err.message : String(err) } }))
      );
  }, [client, issue, details]);

  useEffect(() => {
    if (issue) listRef.current?.scrollChildIntoView(`row-${issue.key}`);
    detailRef.current?.scrollTo(0);
  }, [issue]);

  useKeyboard((key) => {
    const what = keyFor(key, stateRef.current.pane);
    if (!what) return;
    if (typeof what === "object") return dispatch(what);
    const detail = detailRef.current;
    switch (what) {
      case "quit":
        return onQuit();
      case "refresh":
        return void load();
      case "open": {
        const current = issues[stateRef.current.selected];
        if (current) void openUrl(`${client.siteUrl}/browse/${current.key}`);
        return;
      }
      case "scroll-down":
        return detail?.scrollBy(1);
      case "scroll-up":
        return detail?.scrollBy(-1);
      case "page-down":
        return detail?.scrollBy(1, "viewport");
      case "page-up":
        return detail?.scrollBy(-1, "viewport");
    }
  });

  const listWidth = Math.max(30, Math.floor(width * 0.45));
  const focus = (pane: Pane) => (state.pane === pane ? C.focus : C.border);
  const detail = issue ? details[issue.key] : undefined;

  return (
    <box style={{ flexDirection: "column", width, height }}>
      <box style={{ height: 1, flexDirection: "row", paddingLeft: 1 }}>
        <text fg={C.focus} content="atlcli tui" />
        <text fg={C.dim} content={`  ${jql}`} truncate wrapMode="none" />
      </box>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <scrollbox
          ref={listRef}
          title={` Issues · ${status} `}
          style={{ width: listWidth, border: true, borderColor: focus("list") }}
          onMouseDown={() => dispatch({ type: "focus", pane: "list" })}
        >
          {issues.map((it, i) => (
            <box
              key={it.key}
              id={`row-${it.key}`}
              style={{ height: 1, flexDirection: "row", backgroundColor: i === state.selected ? C.selectedBg : undefined }}
              onMouseDown={() => dispatch({ type: "select", index: i })}
            >
              <text fg={C.key} content={it.key.padEnd(11)} wrapMode="none" style={{ flexShrink: 0 }} />
              <text fg={C.status} content={(it.fields.status?.name ?? "").slice(0, 12).padEnd(13)} wrapMode="none" style={{ flexShrink: 0 }} />
              <text content={it.fields.summary ?? ""} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
          ))}
        </scrollbox>
        <scrollbox
          ref={detailRef}
          title={issue ? ` ${issue.key} ` : " "}
          style={{ flexGrow: 1, border: true, borderColor: focus("detail"), paddingLeft: 1, paddingRight: 1 }}
          onMouseDown={() => dispatch({ type: "focus", pane: "detail" })}
        >
          {issue ? (
            <box style={{ flexDirection: "column" }}>
              <text content={issue.fields.summary ?? ""} attributes={1} />
              <text
                fg={C.dim}
                content={[
                  issue.fields.issuetype?.name,
                  issue.fields.status?.name,
                  issue.fields.priority?.name,
                  issue.fields.assignee?.displayName ?? "unassigned",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
              <text content="" />
              {!detail ? (
                <text fg={C.dim} content="Loading…" />
              ) : "error" in detail ? (
                <text fg={C.error} content={detail.error} />
              ) : (
                <markdown content={detail.markdown} syntaxStyle={syntaxStyle} conceal />
              )}
            </box>
          ) : (
            <text fg={C.dim} content={status} />
          )}
        </scrollbox>
      </box>
      <text
        fg={C.dim}
        style={{ height: 1, paddingLeft: 1 }}
        content="j/k move · g/G top/bottom · tab/enter/esc switch pane · space page · o open · r reload · q quit · mouse: click, wheel"
        wrapMode="none"
        truncate
      />
    </box>
  );
}

/** Runs the TUI until the user quits; restores the terminal on the way out. */
export async function runTui(options: TuiOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, screenMode: "alternate-screen" });
  const syntaxStyle = SyntaxStyle.fromStyles(
    {
      "markup.heading": { fg: RGBA.fromHex("#7aa2f7"), bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.raw": { fg: RGBA.fromHex("#9ece6a") },
      "markup.link": { fg: RGBA.fromHex("#7dcfff"), underline: true },
      "markup.list": { fg: RGBA.fromHex("#e0af68") },
      default: { fg: RGBA.fromHex("#c0caf5") },
    },
    renderer.nativeScene!
  );
  try {
    await new Promise<void>((resolve) => {
      createRoot(renderer).render(<App {...options} syntaxStyle={syntaxStyle} onQuit={resolve} />);
    });
  } finally {
    renderer.destroy();
    await renderer.closed;
    syntaxStyle.destroy();
  }
}
