/**
 * Markdown links and images are written site-relative (`/guides/first-rig/`, `/screenshots/x.webp`); this prefixes
 * the deploy base (`/open-bone`) so the same content works on GitHub Pages and on a custom domain.
 */
interface Node {
  type: string;
  url?: string;
  value?: string;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: Node[];
}

export function remarkBase(opts: { base: string }) {
  const base = opts.base.replace(/\/+$/, "");
  const fix = (u: string) => (base && u.startsWith("/") && !u.startsWith("//") && !u.startsWith(`${base}/`) ? base + u : u);
  const walk = (n: Node) => {
    if ((n.type === "link" || n.type === "image" || n.type === "definition") && n.url) n.url = fix(n.url);
    // MDX components: <LinkCard href="/guides/x/" />
    if ((n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") && n.attributes)
      for (const a of n.attributes) if (a.type === "mdxJsxAttribute" && (a.name === "href" || a.name === "src") && typeof a.value === "string") a.value = fix(a.value);
    if (n.type === "html" && n.value) n.value = n.value.replace(/(\s(?:href|src)=")(\/[^"]*)"/g, (_m, a: string, u: string) => `${a}${fix(u)}"`);
    n.children?.forEach(walk);
  };
  return (tree: Node) => walk(tree);
}
