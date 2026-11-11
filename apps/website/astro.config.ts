import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";
import { remarkBase } from "./src/remark-base.ts";
import { DOCS, syncAll } from "./scripts/sync.ts";

/**
 * Hosted on GitHub Pages at https://uxcentury.github.io/open-bone/ by default. For a custom domain, build with
 * SITE_URL=https://docs.example.com SITE_BASE=/ .
 */
const siteUrl = process.env.SITE_URL ?? "https://uxcentury.github.io";
const base = process.env.SITE_BASE ?? "/open-bone";
const GITHUB = "https://github.com/UXCentury/open-bone";

const imported = (prefix: string) => DOCS.filter((d) => d.slug.startsWith(`${prefix}/`)).map((d) => d.slug);

export default defineConfig({
  site: siteUrl,
  base,
  trailingSlash: "always",
  // Sätteri (Astro 7's default Markdown engine) takes no remark plugins; the unified processor does.
  markdown: { processor: unified({ remarkPlugins: [[remarkBase, { base }]] }) },
  integrations: [
    {
      // Pull the repository's docs, examples and web player in before Astro reads the content.
      name: "openbone-sync",
      hooks: {
        "astro:config:setup": async ({ logger }) => {
          await syncAll();
          logger.info("imported the repository docs, the examples and the web player");
        },
      },
    },
    starlight({
      title: "OpenBone",
      description: "Open-source 2D skeletal animation: rig it like Spine, make it interactive like Rive, play it in every engine, and let an AI agent animate it for you.",
      logo: { src: "../../brand/logo.svg", alt: "OpenBone" },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: `${base.replace(/\/$/, "")}/apple-touch-icon.png` } },
        { tag: "meta", attrs: { property: "og:image", content: `${siteUrl}${base.replace(/\/$/, "")}/og.webp` } },
        { tag: "meta", attrs: { name: "theme-color", content: "#190826" } },
      ],
      social: [{ icon: "github", label: "GitHub", href: GITHUB }],
      editLink: { baseUrl: `${GITHUB}/edit/main/apps/website/` },
      lastUpdated: false,
      customCss: ["./src/styles/theme.css"],
      components: { Footer: "./src/components/Footer.astro", PageTitle: "./src/components/PageTitle.astro" },
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true })],
      sidebar: [
        {
          label: "Start here",
          items: ["getting-started/introduction", "getting-started/install", "getting-started/quick-start", "getting-started/editor-tour", { label: "Live examples", link: "/examples/", badge: { text: "live", variant: "tip" } }],
        },
        {
          label: "Guides",
          items: [
            "guides/first-rig",
            "guides/animating",
            "guides/state-machines",
            "guides/audio-lip-sync",
            "guides/particles",
            "guides/physics",
            "guides/exporting",
            "guides/mcp-agent",
            "guides/cli",
          ],
        },
        {
          label: "Engine quick starts",
          items: ["engines/web", "engines/unity", "engines/godot", "engines/flutter", "engines/swift", "engines/android-libgdx", "engines/monogame", "engines/cpp"],
        },
        { label: "Runtimes", collapsed: true, items: imported("runtimes") },
        { label: "Web packages", collapsed: true, items: imported("packages") },
        { label: "Reference", items: imported("reference") },
      ],
    }),
  ],
});
