/**
 * The website's Worker: one canonical URL per page. www.openbone.io and paths without their trailing slash answer
 * with a permanent redirect (same query), so search engines index one copy; everything else is served from the
 * static assets (dist/).
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const CANONICAL_HOST = "openbone.io";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === `www.${CANONICAL_HOST}`) {
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }
    // Pages live at /path/ (the canonical URLs): add the slash with a permanent redirect, not the assets' 307.
    // A last segment with a dot is a file (pagefind.en_1a2b.pf_meta, app.js): leave it alone.
    if (!url.pathname.endsWith("/") && !/\.[^/]+$/.test(url.pathname.slice(url.pathname.lastIndexOf("/")))) {
      url.pathname += "/";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
