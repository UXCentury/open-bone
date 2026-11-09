import type { OpenBoneDocument } from "./types.ts";

/**
 * Folders (like Spine's): slots, skins, animations, events, constraints and state machines can carry a `folder`
 * path such as "body/arms". Folders only organise the editor's lists; drawing, posing and exports ignore them.
 * A folder exists while something is in it (the editor keeps empty ones on its side).
 */
export type FolderKind = "slot" | "skin" | "animation" | "event" | "constraint" | "stateMachine";
export const FOLDER_KINDS: FolderKind[] = ["slot", "skin", "animation", "event", "constraint", "stateMachine"];

export interface Foldered {
  id: string;
  name: string;
  folder?: string;
}

/** "  body//arms/ " → "body/arms"; empty → undefined. */
export function normalizeFolder(path: string | null | undefined): string | undefined {
  if (path == null) return undefined;
  const parts = path
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts.join("/") : undefined;
}

/** "body/arms" → "body"; "body" → undefined. */
export function parentFolder(path: string): string | undefined {
  const i = path.lastIndexOf("/");
  return i < 0 ? undefined : path.slice(0, i);
}

/** True when `path` is `folder` itself or inside it. */
export function inFolder(path: string | undefined, folder: string): boolean {
  return !!path && (path === folder || path.startsWith(`${folder}/`));
}

/** Every item of one kind that can have a folder (constraints: IK, transform, path, physics and sliders). */
export function folderItems(doc: OpenBoneDocument, kind: FolderKind): Foldered[] {
  const sk = doc.skeleton;
  switch (kind) {
    case "slot":
      return sk.slots;
    case "skin":
      return sk.skins;
    case "animation":
      return doc.animations;
    case "event":
      return doc.events;
    case "stateMachine":
      return doc.stateMachines;
    case "constraint":
      return [...sk.ik, ...sk.transform, ...sk.path, ...sk.physics, ...(sk.sliders ?? [])];
  }
}

/** Every folder path in use for a kind, with their parents ("a/b" also gives "a"), sorted. */
export function folderPaths(items: readonly { folder?: string }[]): string[] {
  const out = new Set<string>();
  for (const it of items) for (let f = it.folder; f; f = parentFolder(f)) out.add(f);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The folder path after renaming `from` to `to` (to undefined = move its contents to the top level). */
export function renamedFolder(path: string | undefined, from: string, to: string | undefined): string | undefined {
  if (!inFolder(path, from)) return path;
  const rest = path!.slice(from.length).replace(/^\//, "");
  return normalizeFolder([to ?? "", rest].filter(Boolean).join("/"));
}

export interface FolderNode<T> {
  /** Full path ("body/arms"); "" for the top level. */
  path: string;
  name: string;
  folders: FolderNode<T>[];
  items: T[];
}

/**
 * Group items into a folder tree, keeping their order inside each folder. `extra` adds (empty) folders that have
 * no items yet. Folders are sorted by name.
 */
export function folderTree<T extends { folder?: string }>(items: readonly T[], extra: readonly string[] = []): FolderNode<T> {
  const root: FolderNode<T> = { path: "", name: "", folders: [], items: [] };
  const nodes = new Map<string, FolderNode<T>>([["", root]]);
  const node = (path: string): FolderNode<T> => {
    let n = nodes.get(path);
    if (n) return n;
    const parent = node(parentFolder(path) ?? "");
    n = { path, name: path.slice(path.lastIndexOf("/") + 1), folders: [], items: [] };
    nodes.set(path, n);
    parent.folders.push(n);
    return n;
  };
  for (const f of extra) {
    const p = normalizeFolder(f);
    if (p) node(p);
  }
  for (const it of items) node(normalizeFolder(it.folder) ?? "").items.push(it);
  const sort = (n: FolderNode<T>) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}
