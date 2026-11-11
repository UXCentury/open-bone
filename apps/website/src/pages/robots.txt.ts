/** robots.txt: everything is public; point crawlers at the sitemap and AI tools at llms.txt. */
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const root = new URL(import.meta.env.BASE_URL, site ?? "https://openbone.io/");
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /404",
    "",
    `Sitemap: ${new URL("sitemap-index.xml", root).href}`,
    `# Docs as Markdown for AI assistants: ${new URL("llms.txt", root).href}`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
