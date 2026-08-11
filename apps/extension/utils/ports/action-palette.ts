export interface ShortcutAssignmentV1 {
  readonly commandId: string;
  readonly status: "assigned" | "unbound";
  readonly value: string | null;
}

/** Portable Settings-facing shortcut status; hosts own command APIs. */
export interface ShortcutPort {
  getAssignment(): Promise<ShortcutAssignmentV1>;
  openSettings(): Promise<void>;
}

export interface SurfaceNavigationRequestV1 {
  readonly id: string;
  readonly screen: "export" | "research" | "activity" | "settings";
  readonly continuationId?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Delivers both a retained cold-open request and requests received while mounted. */
export interface SurfaceNavigationPort {
  subscribe(onRequest: (request: SurfaceNavigationRequestV1) => void): () => void;
  acknowledge(id: string): Promise<boolean>;
}
