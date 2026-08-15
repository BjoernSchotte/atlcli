export const PUBLISHED_KNOWLEDGE_SIDEBAR_V1 = [
  {
    label: "Knowledge",
    items: [
      { label: "Release notes", link: "/" },
      {
        label: "Guides",
        collapsed: false,
        items: [
          { label: "Publishing guide", link: "/guide/" },
          {
            label: "Architecture",
            items: [{
              label: "Static publishing",
              items: [{
                label: "A deliberately long deep-tree page title for a responsive navigation proof",
                link: "/guides/deep/",
              }],
            }],
          },
        ],
      },
    ],
  },
] as const;
