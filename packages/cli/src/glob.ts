import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const MAGIC = /[*?[{]/;

/** Glob pattern → RegExp for one path segment or a whole path (`**` matches any number of folders). */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches zero or more folders; a trailing "**" matches anything.
        const slash = pattern[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${pattern
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += pattern.slice(i, end + 1).replace("[!", "[^");
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function walk(dir: string, deep: boolean, out: string[]) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (deep) await walk(p, deep, out);
    } else out.push(p);
  }
}

/** Expand a file path or glob (`*`, `**`, `?`, `[ab]`, `{a,b}`) into existing files, sorted. */
export async function expandGlob(pattern: string, cwd = process.cwd()): Promise<string[]> {
  const norm = pattern.split(path.sep).join("/");
  if (!MAGIC.test(norm)) {
    const abs = path.resolve(cwd, pattern);
    return (await stat(abs).catch(() => null))?.isFile() ? [abs] : [];
  }
  // Walk from the longest folder prefix without wildcards.
  const parts = norm.split("/");
  const fixed: string[] = [];
  while (parts.length > 1 && !MAGIC.test(parts[0])) fixed.push(parts.shift()!);
  const root = path.resolve(cwd, fixed.join("/") || ".");
  const rest = parts.join("/");
  const re = globToRegExp(rest);
  const files: string[] = [];
  await walk(root, rest.includes("**") || parts.length > 1, files);
  return files.filter((f) => re.test(path.relative(root, f).split(path.sep).join("/"))).sort();
}
