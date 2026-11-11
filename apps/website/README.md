# OpenBone website

The documentation site at https://openbone.io/: a landing page, live examples, guides with
screenshots of the real editor, engine quick starts, and the repository's reference docs.

Built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build) (both MIT): static output,
built-in Pagefind search, dark and light themes and a mobile layout, with MDX for the live players. A build fails on any
broken internal link ([starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator), MIT).

## Run it

Astro 7 needs Node.js 22.23 or newer (CI uses 24; `devEngines` in `package.json` lets pnpm fetch it).

```bash
pnpm --filter @openbone/website dev       # http://127.0.0.1:5195/
pnpm --filter @openbone/website build     # dist/
pnpm --filter @openbone/website preview   # http://127.0.0.1:5196/
```

`SITE_URL` and `SITE_BASE` change where it is hosted (default `https://openbone.io` and `/`).
It is served by a Cloudflare static-assets Worker (`wrangler.jsonc`) on `openbone.io` and `www.openbone.io`.
`.github/workflows/website.yml` builds it on every push to `main` and deploys it with `wrangler deploy` when the
`CLOUDFLARE_API_TOKEN` secret is set (Workers Scripts: Edit, and Workers Routes: Edit on the zone). By hand:
`pnpm --filter @openbone/website build && pnpm --filter @openbone/website deploy`.

## What comes from where

Nothing from the rest of the repository is copied by hand. `scripts/sync.ts` runs at the start of every build and dev
server (an integration in `astro.config.ts`) and writes these git-ignored files:

| Generated | From |
|---|---|
| `src/content/docs/reference/`, `runtimes/`, `packages/` | `docs/*.md`, `CHANGELOG.md`, `SECURITY.md`, `conformance/README.md`, the runtime READMEs and the package READMEs (the `DOCS` list in `sync.ts`), with links rewritten to site pages or GitHub, GitHub alerts turned into asides and Mermaid diagrams rendered in the browser |
| `public/projects/` | `examples/*.obone` and `examples/assets/` |
| `public/player/` | The real web player, built from `packages/player` with `buildWebBundle` (plus the lazily loaded script sandbox) |

To add a repository document to the site, add it to `DOCS`. Hand-written pages (the landing page, guides, engine
quick starts) are in `src/content/docs/`.

## SEO

- Every page has its own title, description (imported pages use the README's first paragraph), canonical URL and
  last-updated date (from git; CI checks out the full history).
- `src/pages/og/[...slug].png.ts` draws a 1200 × 630 social card per page (`src/lib/og.ts`): brand, section, title,
  description and the page's first screenshot. `src/components/Head.astro` adds the Open Graph and Twitter image tags,
  robots tags (`noindex` on the 404 page), the web manifest and icons, and JSON-LD: `Organization`, `WebSite`,
  `SoftwareApplication` and `SoftwareSourceCode` on the home page, `TechArticle` and `BreadcrumbList` on docs pages.
- `/robots.txt`, `/sitemap-index.xml`, and `/llms.txt` (plus `llms-full.txt`, `llms-small.txt` and per-section sets)
  for AI assistants and AI search ([starlight-llms-txt](https://github.com/delucis/starlight-llms-txt), MIT).
- The Worker (`worker/index.ts`) redirects `www.openbone.io` and slash-less paths to the canonical URL with a 301;
  `public/_headers` sets long caching for fingerprinted files and security headers.

## Live players

`<LivePlayer example="knight" />` (in `src/components/`) embeds `<openbone-player>` with buttons for the example's
state-machine inputs, read from the `.obone` file at build time. Players start when scrolled into view, pause off
screen, and wait on their first frame behind a **Play with sound** button: that click is the gesture browsers need for audio, so they start with sound (the speaker mutes them). `src/lib/examples.ts` has each example's copy and which
inputs get a control.

## Screenshots

Every image in `src/assets/screenshots/` is captured from the real editor by `scripts/screenshots.ts`, driving it in
headless Chrome at 1440 × 900 and 2× scale and saving WebP. The shots are listed in `scripts/shots.ts`: each opens an
example, runs steps (clicks, and code run against the editor's own modules, such as `s.setMode("animate")`) and
captures the window or one dialog. The CLI shots are images the `openbone` CLI renders itself, and `mcp-live` starts an
MCP server of its own and makes real tool calls while the editor is connected.

```bash
pnpm --filter @openbone/website screenshots               # all of them
pnpm --filter @openbone/website screenshots 'export-*'    # a glob
pnpm --filter @openbone/website screenshots --list
```

It starts the editor's dev server on `127.0.0.1:5199` (or uses one running there, or `EDITOR_URL`). Chrome comes from
`CHROME_PATH`, a system Chrome or Chromium, or `npx playwright-core install chromium`. Use a screenshot in a page with
`<Shot name="rig-weights" alt="…" caption="…" />`.
