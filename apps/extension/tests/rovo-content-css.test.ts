import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { ROVO_HIDDEN_ATTRIBUTE } from "../utils/rovo-visibility.js";

const css = readFileSync(
  new URL("../entrypoints/confluence-rovo.content/style.css", import.meta.url),
  "utf8"
);

let window: Window | null = null;

afterEach(async () => {
  await window?.happyDOM.close();
  window = null;
});

describe("Rovo content CSS", () => {
  it("hides only the requested entry points, including late mounts", () => {
    window = new Window({
      url: "https://example.atlassian.net/wiki/spaces/DOCSY/pages/42/Handbook",
    });
    const { document } = window;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);

    const top = document.createElement("span");
    top.dataset.testid = "app-navigation-ai-mate";
    document.body.append(top);

    const unrelated = document.createElement("button");
    unrelated.textContent = "Rovo documentation";
    document.body.append(unrelated);

    document.documentElement.setAttribute(ROVO_HIDDEN_ATTRIBUTE, "");
    expect(window.getComputedStyle(top).display).toBe("none");
    expect(window.getComputedStyle(unrelated).display).not.toBe("none");

    const floating = document.createElement("button");
    floating.dataset.testid = "platform-ai-button";
    document.body.append(floating);
    expect(window.getComputedStyle(floating).display).toBe("none");

    document.documentElement.removeAttribute(ROVO_HIDDEN_ATTRIBUTE);
    expect(window.getComputedStyle(top).display).not.toBe("none");
  });

  it("covers both current top-navigation test-id variants", () => {
    expect(css).toContain('[data-testid="app-navigation-ai-mate"]');
    expect(css).toContain(
      '[data-testid="atlassian-navigation.ui.conversation-assistant.app-navigation-ai-mate"]'
    );
  });
});
