import { type FolderKind, type FolderNode, folderTree, inFolder, normalizeFolder, parentFolder, renamedFolder } from "@openbone/core";
import { For, type JSX, Show, createMemo, createSignal } from "solid-js";
import { askConfirm, askForm, askText, count } from "../dialogs.tsx";
import { apply, store } from "../state.ts";

/**
 * Folders in the tree and the left-panel lists (Spine-style). An item's folder lives in the document (`folder`);
 * which folders are collapsed, and folders created but still empty, are remembered per browser.
 */

const KEY = "openbone.folders.v1";
interface Saved {
  collapsed: string[];
  /** "kind:scope" → empty folder paths the user created. */
  empty: Record<string, string[]>;
}
function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (v && Array.isArray(v.collapsed) && v.empty) return v;
  } catch {
    /* private mode / bad data */
  }
  return { collapsed: [], empty: {} };
}
const [saved, setSaved] = createSignal<Saved>(load());
function save(next: Saved) {
  setSaved(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

const listKey = (kind: FolderKind, scope = "") => `${kind}:${scope}`;
const nodeKey = (kind: FolderKind, scope: string, path: string) => `${kind}:${scope}:${path}`;

export const folderCollapsed = (kind: FolderKind, scope: string, path: string) => saved().collapsed.includes(nodeKey(kind, scope, path));
function setFolderCollapsed(kind: FolderKind, scope: string, path: string, collapse: boolean) {
  const k = nodeKey(kind, scope, path);
  const cur = saved().collapsed.filter((x) => x !== k);
  save({ ...saved(), collapsed: collapse ? [...cur, k] : cur });
}
/** Open or close every folder of a list (the tree's expand / collapse all). */
export function setAllFolders(kind: FolderKind, collapse: boolean, paths: { scope: string; path: string }[] = []) {
  const others = saved().collapsed.filter((k) => !k.startsWith(`${kind}:`));
  save({ ...saved(), collapsed: collapse ? [...others, ...paths.map((p) => nodeKey(kind, p.scope, p.path))] : others });
}

const emptyFolders = (kind: FolderKind, scope = "") => saved().empty[listKey(kind, scope)] ?? [];
function setEmptyFolders(kind: FolderKind, scope: string, paths: string[]) {
  const empty = { ...saved().empty, [listKey(kind, scope)]: [...new Set(paths)] };
  if (!paths.length) delete empty[listKey(kind, scope)];
  save({ ...saved(), empty });
}

/** "New folder…": ask for a path ("a/b" makes nested folders) and keep it (empty) until something is dropped in. */
export async function newFolder(kind: FolderKind, scope = "", parent?: string, label = "New folder") {
  const name = await askText({
    title: label,
    message: "Drag items onto the folder to move them in. Use / for folders inside folders (body/arms).",
    value: parent ? `${parent}/` : "",
    placeholder: "folder",
    confirmLabel: "Create",
  });
  const path = normalizeFolder(name);
  if (!path) return;
  setEmptyFolders(kind, scope, [...emptyFolders(kind, scope), path]);
  for (let p: string | undefined = path; p; p = parentFolder(p)) if (folderCollapsed(kind, scope, p)) setFolderCollapsed(kind, scope, p, false);
}

/** Items of `kind` in the folder (and its sub-folders), limited to `scope` (slots: the bone). */
function itemsIn(kind: FolderKind, scope: string, path: string, items: readonly { folder?: string }[]) {
  return items.filter((it) => inFolder(it.folder, path) && (kind !== "slot" || !scope || (it as { bone?: string }).bone === scope));
}

async function renameFolder(kind: FolderKind, scope: string, path: string, items: readonly { folder?: string }[]) {
  const name = await askText({ title: "Rename folder", message: "Use / to move it into another folder.", value: path, confirmLabel: "Rename" });
  const to = normalizeFolder(name);
  if (!to || to === path) return;
  if (itemsIn(kind, scope, path, items).length) {
    const ok = apply("renameFolder", { kind, from: path, to, ...(kind === "slot" && scope ? { bone: scope } : {}) });
    if (ok === undefined) return;
  }
  moveLocalState(kind, scope, path, to);
}

async function deleteFolder(kind: FolderKind, scope: string, path: string, items: readonly { folder?: string }[]) {
  const n = itemsIn(kind, scope, path, items).length;
  const up = parentFolder(path);
  if (n) {
    const ok = await askConfirm({
      title: `Delete folder “${path}”?`,
      message: `Its ${count(n, "item")} move up to ${up ? `“${up}”` : "the top level"}. Nothing else is deleted, and you can undo this.`,
      confirmLabel: "Delete folder",
    });
    if (!ok) return;
    if (apply("renameFolder", { kind, from: path, to: null, ...(kind === "slot" && scope ? { bone: scope } : {}) }) === undefined) return;
  }
  moveLocalState(kind, scope, path, up);
}

/** Keep empty sub-folders and collapsed state in step with a renamed (or removed: `to` undefined) folder. */
function moveLocalState(kind: FolderKind, scope: string, from: string, to: string | undefined) {
  setEmptyFolders(
    kind,
    scope,
    emptyFolders(kind, scope)
      .map((p) => renamedFolder(p, from, to))
      .filter((p): p is string => !!p),
  );
  const prefix = `${kind}:${scope}:`;
  save({
    ...saved(),
    collapsed: saved().collapsed.flatMap((k) => {
      if (!k.startsWith(prefix)) return [k];
      const p = renamedFolder(k.slice(prefix.length), from, to);
      return p ? [prefix + p] : [];
    }),
  });
}

// ---------- drag and drop ----------
const MIME = "application/x-openbone-item";
let dragging: { kind: FolderKind; id: string; scope: string } | null = null;

function dropInto(kind: FolderKind, scope: string, path: string | undefined, e: DragEvent) {
  const d = dragging;
  if (!d || d.kind !== kind || (kind === "slot" && d.scope !== scope)) return;
  e.preventDefault();
  e.stopPropagation();
  dragging = null;
  const item = findItem(kind, d.id) as { folder?: string } | undefined;
  if (!item || normalizeFolder(item.folder) === path) return;
  if (apply("setFolder", { kind, items: [d.id], folder: path ?? null }) === undefined) return;
  // A folder that now has something in it no longer needs keeping as an empty one.
  if (path) setEmptyFolders(kind, scope, emptyFolders(kind, scope).filter((p) => !inFolder(path, p)));
}
function findItem(kind: FolderKind, id: string) {
  const d = store.doc;
  const sk = d.skeleton;
  const lists: Record<FolderKind, { id: string }[]> = {
    slot: sk.slots,
    skin: sk.skins,
    animation: d.animations,
    event: d.events,
    stateMachine: d.stateMachines,
    constraint: [...sk.ik, ...sk.transform, ...sk.path, ...sk.physics, ...(sk.sliders ?? [])],
  };
  return lists[kind].find((x) => x.id === id);
}
const accepts = (kind: FolderKind, scope: string) => !!dragging && dragging.kind === kind && (kind !== "slot" || dragging.scope === scope);

/** Makes a row draggable into folders of its list. */
export function draggableItem(kind: FolderKind, id: string, scope = "") {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragging = { kind, id, scope };
      e.dataTransfer?.setData(MIME, id);
      e.dataTransfer?.setData("text/plain", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      e.stopPropagation();
    },
    onDragEnd: () => {
      dragging = null;
      document.querySelectorAll(".drop-into").forEach((el) => el.classList.remove("drop-into"));
    },
  };
}

function dropTarget(kind: FolderKind, scope: string, path: () => string | undefined) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!accepts(kind, scope)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      (e.currentTarget as HTMLElement).classList.add("drop-into");
    },
    onDragLeave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-into"),
    onDrop: (e: DragEvent) => {
      (e.currentTarget as HTMLElement).classList.remove("drop-into");
      dropInto(kind, scope, path(), e);
    },
  };
}

// ---------- the list ----------

export interface FolderedProps<T extends { id: string; folder?: string }> {
  kind: FolderKind;
  /** Slots: the bone whose slots these are (folders are per bone). */
  scope?: string;
  items: () => readonly T[];
  children: (item: T) => JSX.Element;
  /** Every folder is open (while searching), and empty ones are hidden. */
  forceOpen?: () => boolean;
  /** Tree style (guide lines, .tnode nesting) instead of a flat list. */
  tree?: boolean;
  fallback?: JSX.Element;
}

/**
 * A list grouped into collapsible folders. Folder rows can be renamed and deleted, and take drops of the list's
 * items; dropping on the list itself (outside any folder) moves an item to the top level.
 */
export function Foldered<T extends { id: string; folder?: string }>(p: FolderedProps<T>) {
  const scope = () => p.scope ?? "";
  const nodes = createMemo(() => {
    const extra = p.forceOpen?.() ? [] : emptyFolders(p.kind, scope());
    const root = folderTree(p.items(), extra);
    const map = new Map<string, FolderNode<T>>();
    const walk = (n: FolderNode<T>) => {
      map.set(n.path, n);
      n.folders.forEach(walk);
    };
    walk(root);
    return map;
  });
  const isOpen = (path: string) => !!p.forceOpen?.() || !folderCollapsed(p.kind, scope(), path);

  const Level = (lp: { path: string }) => {
    const node = () => nodes().get(lp.path);
    return (
      <>
        <For each={node()?.folders.map((f) => f.path) ?? []}>{(path) => <Folder path={path} />}</For>
        <For each={node()?.items ?? []}>{(it) => (p.tree ? p.children(it) : <div {...draggableItem(p.kind, it.id, scope())}>{p.children(it)}</div>)}</For>
      </>
    );
  };

  const Folder = (fp: { path: string }) => {
    const node = () => nodes().get(fp.path);
    const total = () => itemsIn(p.kind, scope(), fp.path, p.items()).length;
    return (
      <div class="tnode folder-node">
        <div
          class="tree-row folder-row"
          title={`Folder “${fp.path}”: drop items here · double-click to rename`}
          onClick={() => setFolderCollapsed(p.kind, scope(), fp.path, isOpen(fp.path))}
          onDblClick={() => void renameFolder(p.kind, scope(), fp.path, p.items())}
          {...dropTarget(p.kind, scope(), () => fp.path)}
        >
          <span class="twisty">{node()?.folders.length || node()?.items.length ? (isOpen(fp.path) ? "▾" : "▸") : ""}</span>
          <span class="icon folder-icon">{isOpen(fp.path) ? "📂" : "📁"}</span> <span class="tname">{node()?.name}</span>
          <span class="muted small"> {total() || "empty"}</span>
          <span class="row-actions">
            <button class="row-btn" title="New folder inside" onClick={(e) => { e.stopPropagation(); void newFolder(p.kind, scope(), fp.path); }}>+</button>
            <button class="row-btn" title="Rename folder" onClick={(e) => { e.stopPropagation(); void renameFolder(p.kind, scope(), fp.path, p.items()); }}>✎</button>
            <button class="row-btn" title="Delete folder (its items move up a level)" onClick={(e) => { e.stopPropagation(); void deleteFolder(p.kind, scope(), fp.path, p.items()); }}>×</button>
          </span>
        </div>
        <Show when={isOpen(fp.path)}>
          <div class="tchildren">
            <Level path={fp.path} />
          </div>
        </Show>
      </div>
    );
  };

  const empty = () => !p.items().length && !(nodes().get("")?.folders.length ?? 0);
  return (
    <div class="folder-list" classList={{ flat: !p.tree }} {...dropTarget(p.kind, scope(), () => undefined)}>
      <Show when={!empty()} fallback={p.fallback}>
        <Level path="" />
      </Show>
    </div>
  );
}

/** Every folder path in a list, for "collapse all". */
export function allFolderPaths(items: readonly { folder?: string }[], kind: FolderKind, scope = ""): { scope: string; path: string }[] {
  const out = new Set<string>(emptyFolders(kind, scope));
  for (const it of items) for (let f = normalizeFolder(it.folder); f; f = parentFolder(f)) out.add(f);
  return [...out].map((path) => ({ scope, path }));
}

/** "Move to folder…" for one item: ask for a path (empty = top level). */
export async function moveToFolder(kind: FolderKind, id: string, current?: string) {
  const r = await askForm({
    title: "Move to folder",
    message: "Folder path, / between levels. Leave empty for the top level.",
    fields: [{ key: "folder", label: "Folder", type: "text", value: current ?? "", placeholder: "body/arms", required: false }],
    confirmLabel: "Move",
  });
  if (r) apply("setFolder", { kind, items: [id], folder: normalizeFolder(r.folder) ?? null });
}
