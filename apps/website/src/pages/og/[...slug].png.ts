/** /og/<page>.png: the social card of every docs page (see src/lib/og.ts). */
import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { renderOg, sectionOf } from "../../lib/og";

const SHOTS = path.resolve(process.cwd(), "src/assets/screenshots");

/** Pages whose picture is not a <Shot> in their body. */
const PICTURE: Record<string, string> = { index: "editor-overview", examples: "editor-examples" };

export const getStaticPaths = (async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => {
    const id = entry.id === "" ? "index" : entry.id;
    const shot = PICTURE[id] ?? /<Shot\s+name="([^"]+)"/.exec(entry.body ?? "")?.[1] ?? null;
    return {
      params: { slug: id },
      props: {
        title: id === "index" ? "Open-source 2D skeletal animation" : entry.data.title,
        description: id === "index" ? "Rig it like Spine, make it interactive like Rive, play it in every engine, and let an AI agent animate it for you." : entry.data.description,
        section: id === "index" ? "Rig · Animate · Ship everywhere" : sectionOf(id),
        screenshot: shot ? path.join(SHOTS, `${shot}.webp`) : null,
      },
    };
  });
}) satisfies GetStaticPaths;

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOg(props as Parameters<typeof renderOg>[0]);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
};
