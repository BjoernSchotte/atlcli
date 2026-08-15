import type { ActionModuleV1 } from "../contracts.js";

/**
 * Compile-time-only fixture used to prove that a contribution module is data,
 * not a palette-shell import or executable plugin bundle.
 */
export const syntheticContributionModuleV1 = {
  schemaVersion: 1,
  id: "example.synthetic-contribution",
  actions: [
    {
      schemaVersion: 1,
      id: "example.synthetic.inspect-context",
      moduleId: "example.synthetic-contribution",
      title: {
        key: "example.synthetic.inspect-context.title",
        fallback: "Inspect context kind",
      },
      subtitle: {
        key: "example.synthetic.inspect-context.subtitle",
        fallback: "Synthetic contribution fixture",
      },
      keywords: ["fixture", "context"],
      group: "atlcli.group.navigation",
      icon: "extension",
      intent: {
        kind: "contribution.example.synthetic-inspect",
        payload: { projection: "product" },
      },
      requirements: [
        { kind: "capability", capability: "example.capability.inspect" },
      ],
      effect: "read",
      order: 900,
    },
  ],
} as const satisfies ActionModuleV1;
