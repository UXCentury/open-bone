/** The self-contained WebView player bundle (see the playerBundle plugin in vite.config.ts). */
declare module "virtual:openbone-player-bundle" {
  const source: string;
  export default source;
}

declare module "virtual:openbone-web-player/*" {
  const code: string;
  export default code;
}

/** Build info and credits for the About dialog (see the about plugin in vite.config.ts). */
declare module "virtual:openbone-about" {
  const info: {
    version: string;
    commit: string;
    dirty: boolean;
    buildDate: string;
    credits: { name: string; version: string; license: string; url: string; description: string; kind: "app" | "tool" | "desktop" }[];
  };
  export default info;
}
