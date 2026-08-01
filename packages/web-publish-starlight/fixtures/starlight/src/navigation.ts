export const PUBLISHED_KNOWLEDGE_SIDEBAR_V1 = [
  {
    label: "Knowledge",
    items: [
      { label: "Release notes", link: "/" },
      {
        label: "Guides",
        collapsed: false,
        items: [{ label: "Publishing guide", link: "/guide/" }],
      },
    ],
  },
] as const;
