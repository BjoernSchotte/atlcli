/**
 * Unit tests for the panel detection pull (spec 003, finding: detection after an
 * extension reload without F5). The mount pull and the visibility/focus re-pull
 * both go through {@link pullCurrentEntity}; here we drive it with a mocked
 * transport (`chrome.runtime.sendMessage` stand-in) and a dispatch spy.
 */
import { describe, expect, it, mock } from "bun:test";
import { pullCurrentEntity } from "../utils/detection-pull.js";
import type { PanelEvent } from "../utils/panel-state.js";
import type { EntityDetection } from "../utils/messages.js";

const detection: EntityDetection = {
  url: "https://myco.atlassian.net/wiki/spaces/RCM/pages/1031503874/Page",
  entity: { product: "confluence", type: "page", pageId: "1031503874", spaceKey: "RCM" },
  seq: 4,
};

describe("pullCurrentEntity", () => {
  it("dispatches a `detected` event carrying the SW detection (url/entity/seq)", async () => {
    const events: PanelEvent[] = [];
    const send = mock(async () => ({ kind: "current-entity", detection }));

    await pullCurrentEntity(send, (e) => events.push(e));

    expect(send).toHaveBeenCalledWith({ kind: "get-current-entity" });
    expect(events).toEqual([
      { type: "detected", url: detection.url, entity: detection.entity, seq: detection.seq },
    ]);
  });

  it("re-pulling (visibility/focus) re-dispatches with the latest seq", async () => {
    const events: PanelEvent[] = [];
    const later: EntityDetection = { ...detection, seq: 9 };
    const send = mock(async () => ({ kind: "current-entity", detection: later }));

    await pullCurrentEntity(send, (e) => events.push(e)); // simulates onVisible re-pull

    expect(events[0]).toMatchObject({ type: "detected", seq: 9 });
  });

  it("dispatches nothing when the SW answers with an unrelated response", async () => {
    const events: PanelEvent[] = [];
    const send = mock(async () => ({ kind: "pong" }));
    await pullCurrentEntity(send, (e) => events.push(e));
    expect(events).toEqual([]);
  });

  it("swallows a rejected send (SW asleep) and dispatches nothing", async () => {
    const events: PanelEvent[] = [];
    const send = mock(async () => {
      throw new Error("no receiving end");
    });
    await pullCurrentEntity(send, (e) => events.push(e));
    expect(events).toEqual([]);
  });

  it("dispatches nothing for an undefined response", async () => {
    const events: PanelEvent[] = [];
    const send = mock(async () => undefined);
    await pullCurrentEntity(send, (e) => events.push(e));
    expect(events).toEqual([]);
  });
});
