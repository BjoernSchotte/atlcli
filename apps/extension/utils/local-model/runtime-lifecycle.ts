interface DisposableValueV1 {
  dispose: () => unknown;
}

function disposableV1(value: unknown): value is DisposableValueV1 {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { dispose?: unknown }).dispose === "function"
    : false;
}

/** Release the native ORT/WebGPU allocation held by one Transformers.js value. */
export function disposeLocalModelValueV1(value: unknown): void {
  if (disposableV1(value)) {
    value.dispose();
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const data = (value as { data?: unknown }).data;
  if (disposableV1(data)) data.dispose();
}

/** Inputs are fresh for every generation and must not survive a tool-call turn. */
export function disposeLocalModelInputsV1(inputs: Record<string, unknown>): void {
  for (const value of Object.values(inputs)) disposeLocalModelValueV1(value);
}

export async function disposeLocalModelRuntimeHandleV1(
  runtime: Promise<{ model: { dispose: () => unknown } }> | undefined,
): Promise<boolean> {
  if (!runtime) return false;
  const { model } = await runtime;
  await model.dispose();
  return true;
}
