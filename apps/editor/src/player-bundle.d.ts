/** The self-contained WebView player bundle (see the playerBundle plugin in vite.config.ts). */
declare module "virtual:openbone-player-bundle" {
  const source: string;
  export default source;
}

declare module "virtual:openbone-web-player/*" {
  const code: string;
  export default code;
}
