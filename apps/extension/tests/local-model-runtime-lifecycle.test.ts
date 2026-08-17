import { describe, expect, it } from "bun:test";
import {
  disposeLocalModelInputsV1,
  disposeLocalModelRuntimeHandleV1,
  disposeLocalModelValueV1,
} from "../utils/local-model/runtime-lifecycle.js";

describe("local Gemma native tensor lifecycle", () => {
  it("disposes direct outputs and wrapped output data exactly once", () => {
    let direct = 0;
    let wrapped = 0;
    disposeLocalModelValueV1({ dispose: () => { direct += 1; } });
    disposeLocalModelValueV1({ data: { dispose: () => { wrapped += 1; } } });
    expect({ direct, wrapped }).toEqual({ direct: 1, wrapped: 1 });
  });

  it("disposes every native input while ignoring scalar metadata", () => {
    const disposed: string[] = [];
    disposeLocalModelInputsV1({
      input_ids: { dispose: () => { disposed.push("input_ids"); } },
      attention_mask: { dispose: () => { disposed.push("attention_mask"); } },
      metadata: 4,
    });
    expect(disposed).toEqual(["input_ids", "attention_mask"]);
  });

  it("releases one loaded runtime and treats an absent runtime as already idle", async () => {
    let disposed = 0;
    expect(await disposeLocalModelRuntimeHandleV1(undefined)).toBe(false);
    expect(await disposeLocalModelRuntimeHandleV1(Promise.resolve({
      model: { dispose: () => { disposed += 1; } },
    }))).toBe(true);
    expect(disposed).toBe(1);
  });
});
