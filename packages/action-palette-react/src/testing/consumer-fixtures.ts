export interface ActionPaletteConsumerFixtureV1 {
  readonly host: "extension" | "forge";
  readonly reactVersion: string;
  readonly runtimeMarker: string;
}

export const ACTION_PALETTE_CONSUMER_FIXTURES_V1: readonly ActionPaletteConsumerFixtureV1[] = [
  {
    host: "extension",
    reactVersion: "19.2.0",
    runtimeMarker: "extension-host-react-v19",
  },
  {
    host: "forge",
    reactVersion: "18.3.1",
    runtimeMarker: "forge-host-react-v18",
  },
];
