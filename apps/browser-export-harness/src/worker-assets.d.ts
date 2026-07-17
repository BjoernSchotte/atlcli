declare module "*.ttf?url" {
  const url: string;
  export default url;
}

declare module "*.wasm?url" {
  const url: string;
  export default url;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?url&no-inline" {
  const url: string;
  export default url;
}
