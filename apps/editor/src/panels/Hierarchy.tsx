import { type BoneData, type SlotData, slotAttachments } from "@openbone/core";
import { For, Show, createEffect, createMemo, createRoot, createSignal, untrack } from "solid-js";
import {
  activeSkin,
  activeSkinId,
  animationId,
  apply,
  setActiveSkinId,
  doc,
  selection,
  setAnimationId,
  setMode,
  setSelection,
  setStateMachineId,
  setTime,
  stateMachineId,
  selectedBoneId,
  multiBones,
} from "../state.ts";
import { showPanel } from "../layout.ts";
import { Section } from "./fields.tsx";
import { askConfirm, askText, uniqueName } from "../dialogs.tsx";
import { AudioSection } from "./AudioPanel.tsx";
import { cycleVis, visOf } from "../visibility.ts";
import { resolveImageUrl } from "../images.ts";
import { StatsSection } from "./Stats.tsx";
import { Foldered, allFolderPaths, draggableItem, newFolder, setAllFolders } from "./Folders.tsx";

// ---- skeleton tree: guide lines and collapsible nodes (bones and slots), like Spine's tree ----
const [collapsedNodes, setCollapsedNodes] = createSignal<Set<string>>(new Set());
const isCollapsed = (id: string) => collapsedNodes().has(id);
function setNodes(ids: string[], collapse: boolean) {
  const s = new Set(collapsedNodes());
  for (const id of ids) {
    if (collapse) s.add(id);
    else s.delete(id);
  }
  setCollapsedNodes(s);
}
/** A bone and every bone and slot under it (for Alt-click: open or close a whole branch). */
function subtreeIds(boneId: string): string[] {
  const d = doc();
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const s of d.skeleton.slots) if (s.bone === id) out.push(s.id);
    for (const b of d.skeleton.bones) if (b.parent === id) walk(b.id);
  };
  walk(boneId);
  return out;
}
/** Every bone and slot that has something under it. */
function allParentIds(): string[] {
  const d = doc();
  return [
    ...d.skeleton.bones.filter((b) => d.skeleton.bones.some((c) => c.parent === b.id) || d.skeleton.slots.some((s) => s.bone === b.id)).map((b) => b.id),
    ...d.skeleton.slots.map((s) => s.id),
  ];
}

// ---- search: show matching bones, slots and attachments with their parents ----
const [treeQuery, setTreeQuery] = createSignal("");
const query = () => treeQuery().trim().toLowerCase();
const matches = (name: string) => name.toLowerCase().includes(query());
/** Ids shown while searching (bones, slots, and "slotId/attachment" keys), or null when not searching. */
const searchHits = createRoot(() =>
  createMemo((): Set<string> | null => {
    if (!query()) return null;
    const d = doc();
    const vis = new Set<string>();
    const parentOf = new Map(d.skeleton.bones.map((b) => [b.id, b.parent]));
    const withAncestors = (boneId: string | null | undefined) => {
      for (let b = boneId; b; b = parentOf.get(b) ?? null) vis.add(b);
    };
    for (const b of d.skeleton.bones) if (matches(b.name)) withAncestors(b.id);
    for (const sl of d.skeleton.slots) {
      const atts = slotAttachments(d, sl.id, activeSkin()?.id).filter((a) => matches(a.name));
      if (!matches(sl.name) && !atts.length) continue;
      vis.add(sl.id);
      for (const a of atts) vis.add(`${sl.id}/${a.name}`);
      withAncestors(sl.bone);
    }
    return vis;
  }),
);
const shown = (id: string) => {
  const hits = searchHits();
  return !hits || hits.has(id);
};
/** While searching every matching branch is open, whatever was collapsed. */
const isOpen = (id: string) => !!query() || !isCollapsed(id);

/** A name with the search match highlighted. */
function Name(p: { text: string }) {
  const parts = () => {
    const q = query();
    const i = q ? p.text.toLowerCase().indexOf(q) : -1;
    return i < 0 ? null : [p.text.slice(0, i), p.text.slice(i, i + q.length), p.text.slice(i + q.length)];
  };
  return (
    <span class="tname">
      <Show when={parts()} fallback={p.text}>
        {(x) => (
          <>
            {x()[0]}
            <mark class="tree-hit">{x()[1]}</mark>
            {x()[2]}
          </>
        )}
      </Show>
    </span>
  );
}

/** Keep a selected row visible: scroll it into view when it becomes selected (e.g. picked in the viewport). */
function scrollWhenSelected(el: HTMLElement, selected: () => boolean) {
  createEffect(() => {
    if (selected()) queueMicrotask(() => el.isConnected && el.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });
}

function Twisty(p: { id: string; has: boolean; subtree?: () => string[] }) {
  return (
    <span
      class="twisty"
      classList={{ leaf: !p.has }}
      title={p.has ? "Collapse / expand (Alt: the whole branch)" : undefined}
      onClick={(e) => {
        if (!p.has) return;
        e.stopPropagation();
        const collapse = !isCollapsed(p.id);
        setNodes(e.altKey && p.subtree ? p.subtree() : [p.id], collapse);
      }}
    >
      {p.has ? (isOpen(p.id) ? "▾" : "▸") : ""}
    </span>
  );
}

/** Eye button: shown → dimmed → hidden in the viewport (editor only). Alt-click goes the other way. */
function EyeBtn(p: { id: string; name: string }) {
  const v = () => visOf(p.id);
  const path = () =>
    v() === "hidden"
      ? "M2 8c1.6-2.6 3.6-4 6-4s4.4 1.4 6 4c-1.6 2.6-3.6 4-6 4s-4.4-1.4-6-4zM3 13L13 3"
      : "M2 8c1.6-2.6 3.6-4 6-4s4.4 1.4 6 4c-1.6 2.6-3.6 4-6 4s-4.4-1.4-6-4zM8 6.2a1.8 1.8 0 1 0 0.01 0z";
  return (
    <button
      class="eye-btn"
      classList={{ off: v() !== "shown" }}
      title={`${p.name}: ${v() === "shown" ? "shown" : v() === "dim" ? "dimmed" : "hidden"} in the viewport. Click: ${v() === "shown" ? "dim" : v() === "dim" ? "hide" : "show"} (editor only; Alt-click goes back)`}
      onClick={(e) => {
        e.stopPropagation();
        cycleVis(p.id, e.altKey);
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" style={{ opacity: v() === "dim" ? 0.5 : 1 }}>
        <path d={path()} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  );
}

/** Small preview of an attachment's image (regions, meshes, sequences), from wherever the editor loads it. */
function Thumb(p: { image?: string }) {
  const img = () => doc().images.find((i) => i.id === p.image);
  return (
    <Show when={img()?.src}>
      <img class="tree-thumb" src={resolveImageUrl(img()!)} alt="" loading="lazy" draggable={false} />
    </Show>
  );
}

/** Sounds a slot's listeners play (click, hover…), so they can be found and edited from the slot. */
function slotSounds(slotId: string) {
  const d = doc();
  const ids = new Set<string>();
  for (const sm of d.stateMachines)
    for (const l of sm.listeners) if (l.slot === slotId) for (const a of l.actions) if (a.type === "playSound" || a.type === "stopSound") ids.add(a.sound);
  return (d.audio?.sounds ?? []).filter((x) => ids.has(x.id) || ids.has(x.name));
}

function BoneNode(p: { bone: BoneData }) {
  const children = () => doc().skeleton.bones.filter((b) => b.parent === p.bone.id && shown(b.id));
  const slots = () => doc().skeleton.slots.filter((s) => s.bone === p.bone.id && shown(s.id));
  const sel = () => selection();
  const has = () => children().length + slots().length > 0;
  const boneSelected = () => (sel()?.kind === "bone" && sel()!.id === p.bone.id) || multiBones().includes(p.bone.id);
  return (
    <div class="tnode">
      <div class="tree-row" ref={(el) => scrollWhenSelected(el, boneSelected)} classList={{ selected: boneSelected(), "vis-off": visOf(p.bone.id) !== "shown" }} onClick={() => setSelection({ kind: "bone", id: p.bone.id })}>
        <Twisty id={p.bone.id} has={has()} subtree={() => subtreeIds(p.bone.id)} />
        <span class="icon bone-icon">🦴</span> <Name text={p.bone.name} />
        <EyeBtn id={p.bone.id} name={p.bone.name} />
      </div>
      <Show when={has() && isOpen(p.bone.id)}>
        <div class="tchildren">
          <Foldered kind="slot" scope={p.bone.id} items={slots} tree forceOpen={() => !!query()}>
            {(s) => <SlotNode s={s} />}
          </Foldered>
          <For each={children()}>{(c) => <BoneNode bone={c} />}</For>
        </div>
      </Show>
    </div>
  );
}


function SlotNode(p: { s: SlotData }) {
  const s = p.s;
  const sel = () => selection();
  const atts = () => slotAttachments(doc(), s.id, activeSkin()?.id).filter((a) => shown(`${s.id}/${a.name}`) || (!!searchHits() && matches(s.name)));
  const slotSelected = () => sel()?.kind === "slot" && sel()!.id === s.id && !(sel() as { attachment?: string }).attachment;
  const sounds = () => slotSounds(s.id);
  return (
    <div class="tnode">
      <div
        {...draggableItem("slot", s.id, s.bone)}
        class="tree-row slot-row"
        ref={(el) => scrollWhenSelected(el, slotSelected)}
        classList={{ selected: sel()?.kind === "slot" && sel()!.id === s.id, "vis-off": visOf(s.id) !== "shown" }}
        onClick={() => setSelection({ kind: "slot", id: s.id })}
      >
        <Twisty id={s.id} has={atts().length + sounds().length > 0} />
        <span class="icon">▣</span> <Name text={s.name} />
        <span class="muted"> {s.attachment ? `· ${s.attachment}` : "· hidden"}</span>
        <EyeBtn id={s.id} name={s.name} />
      </div>
      <Show when={sounds().length > 0 && isOpen(s.id)}>
        <div class="tchildren">
          <For each={sounds()}>
            {(snd) => (
              <div class="tnode">
    <div
      class="tree-row sound-row"
      classList={{ selected: sel()?.kind === "sound" && sel()!.id === snd.id }}
      title="Played by this slot's listeners: click to edit the sound"
      onClick={() => setSelection({ kind: "sound", id: snd.id })}
    >
      <span class="icon">♪</span> {snd.name}
      <span class="muted"> · sound</span>
    </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={atts().length > 0 && isOpen(s.id)}>
        <div class="tchildren">
          <For each={atts()}>
            {(a) => (
              <div class="tnode">
    <div
      class="tree-row att-row"
      ref={(el) => scrollWhenSelected(el, () => sel()?.kind === "slot" && sel()!.id === s.id && (sel() as { attachment?: string }).attachment === a.name)}
      classList={{ selected: sel()?.kind === "slot" && sel()!.id === s.id && (sel() as { attachment?: string }).attachment === a.name }}
      title={a.skin.id === doc().skeleton.skins[0].id ? "In the default skin" : `In skin “${a.skin.name}”${a.overrides ? " (overrides the default skin)" : ""}`}
      onClick={() => setSelection({ kind: "slot", id: s.id, attachment: a.name })}
    >
      <span class="icon">{({ boundingBox: "⬚", clipping: "✂", sequence: "🎞", particles: "✺" } as Record<string, string>)[a.attachment.type] ?? "◇"}</span> <Name text={a.name} />
      <Thumb image={(a.attachment as { image?: string; frames?: { image: string }[] }).image ?? (a.attachment as { frames?: (string | { image: string })[] }).frames?.map((f) => (typeof f === "string" ? f : f.image))[0]} />
      <Show when={a.skin.id !== doc().skeleton.skins[0].id}>
        <span class="skin-badge">{a.skin.name}</span>
      </Show>
    </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Open the collapsed ancestors of the selected bone or slot, so selecting in the viewport shows it in the tree. */
/** "3 matches" / "no match" for the search box. */
function searchCount(): string {
  const d = doc();
  let n = 0;
  for (const b of d.skeleton.bones) if (matches(b.name)) n++;
  for (const sl of d.skeleton.slots) {
    if (matches(sl.name)) n++;
    n += slotAttachments(d, sl.id, activeSkin()?.id).filter((a) => matches(a.name)).length;
  }
  return n ? `${n} match${n === 1 ? "" : "es"}` : "no match";
}
/** Enter in the search box: select the first match (bones first, then slots, then attachments). */
function selectFirstHit() {
  const d = doc();
  const b = d.skeleton.bones.find((x) => matches(x.name));
  if (b) return setSelection({ kind: "bone", id: b.id });
  const sl = d.skeleton.slots.find((x) => matches(x.name));
  if (sl) return setSelection({ kind: "slot", id: sl.id });
  for (const x of d.skeleton.slots) {
    const a = slotAttachments(d, x.id, activeSkin()?.id).find((y) => matches(y.name));
    if (a) return setSelection({ kind: "slot", id: x.id, attachment: a.name });
  }
}

function useRevealSelection() {
  createEffect(() => {
    const sel = selection();
    if (!sel || (sel.kind !== "bone" && sel.kind !== "slot")) return;
    const d = doc();
    const open: string[] = [];
    let boneId: string | undefined;
    if (sel.kind === "slot") {
      const slot = d.skeleton.slots.find((x) => x.id === sel.id);
      boneId = slot?.bone;
      if ((sel as { attachment?: string }).attachment && slot) open.push(slot.id);
      if (boneId) open.push(boneId);
    } else boneId = d.skeleton.bones.find((b) => b.id === sel.id)?.parent ?? undefined;
    for (let b = d.skeleton.bones.find((x) => x.id === boneId); b; b = d.skeleton.bones.find((x) => x.id === b!.parent)) open.push(b.id);
    // Untracked: collapsing an ancestor by hand must not reopen it right away.
    untrack(() => {
      if (open.some((id) => isCollapsed(id))) setNodes(open, false);
    });
  });
}

function SkinsSection() {
  const skins = () => doc().skeleton.skins;
  const nextName = (base: string) => {
    let i = 1;
    while (skins().some((k) => k.name === `${base}${i}`)) i++;
    return `${base}${i}`;
  };
  const newSkin = async (from?: { id: string; name: string }) => {
    const name = await askText({
      title: from ? `Duplicate skin “${from.name}”` : "New skin",
      message: from ? undefined : "A skin is an alternative set of attachments, e.g. an outfit.",
      value: from ? `${from.name} copy` : nextName("skin"),
      confirmLabel: from ? "Duplicate" : "Create",
      validate: uniqueName(skins().map((k) => k.name)),
    });
    if (!name) return;
    const r = (from ? apply("duplicateSkin", { skin: from.id, name }) : apply("addSkin", { name })) as { id: string } | undefined;
    if (r) setActiveSkinId(r.id);
  };
  const rename = async (id: string, current: string) => {
    const name = await askText({ title: "Rename skin", value: current, confirmLabel: "Rename", validate: uniqueName(skins().map((k) => k.name), current) });
    if (name && name !== current) apply("renameSkin", { skin: id, name });
  };
  return (
    <Section
      title="Skins"
      actions={
        <>
          <button title="New folder for skins" onClick={() => void newFolder("skin")}>🗀</button>
          <button title="New empty skin" onClick={() => newSkin()}>+</button>
        </>
      }
    >
      <Foldered kind="skin" items={skins}>
        {(k) => {
          const i = () => (skins()[0]?.id === k.id ? 0 : 1);
          // The store mutates skins in place, so read through doc() to re-render on every change.
          const name = () => (doc(), k.name);
          const count = () => (doc(), Object.values(k.attachments).reduce((n, m) => n + Object.keys(m).length, 0));
          return (
            <div
              class="tree-row"
              classList={{ selected: i() === 0 ? !activeSkin() : activeSkinId() === k.id }}
              title={i() === 0 ? "Default skin: attachments every skin shares" : "Click to show · double-click to rename"}
              onClick={() => setActiveSkinId(i() === 0 ? null : k.id)}
              onDblClick={() => i() > 0 && rename(k.id, name())}
            >
              <span class="icon">{(i() === 0 ? !activeSkin() : activeSkinId() === k.id) ? "●" : "○"}</span> {name()}
              <span class="muted" title="Attachments in this skin"> {count()}</span>
              <span class="row-actions">
                <button class="row-btn" title="Duplicate" onClick={(e) => { e.stopPropagation(); newSkin(k); }}>⧉</button>
                <Show when={i() > 0}>
                  <button class="row-btn" title="Rename" onClick={(e) => { e.stopPropagation(); rename(k.id, name()); }}>✎</button>
                  <button class="row-btn" title="Delete" onClick={(e) => { e.stopPropagation(); void askConfirm({ title: `Delete skin “${name()}”?`, message: "Its attachments are removed too. You can undo this.", confirmLabel: "Delete", danger: true }).then((ok) => ok && apply("deleteSkin", { skin: k.id })); }}>×</button>
                </Show>
              </span>
            </div>
          );
        }}
      </Foldered>
      <Show when={activeSkin()} fallback={<div class="hint pad">Add a skin for each outfit. Attachments you add while it is active go into it.</div>}>
        <div class="hint pad">
          New attachments go into “{activeSkin()!.name}”. Copy a default attachment into it from the Inspector to override it.
        </div>
      </Show>
    </Section>
  );
}

type ConstraintKind = "ik" | "transform" | "path" | "physics" | "slider";
const CONSTRAINT_ICONS: Record<ConstraintKind, string> = { ik: "⤳", transform: "⇉", path: "〰", physics: "≋", slider: "⇆" };
const constraintItems = () => {
  const sk = doc().skeleton;
  return [...sk.ik, ...sk.transform, ...sk.path, ...sk.physics, ...(sk.sliders ?? [])] as { id: string; name: string; folder?: string }[];
};
function constraintKind(id: string): ConstraintKind {
  const sk = doc().skeleton;
  if (sk.ik.some((c) => c.id === id)) return "ik";
  if (sk.transform.some((c) => c.id === id)) return "transform";
  if (sk.path.some((c) => c.id === id)) return "path";
  if (sk.physics.some((c) => c.id === id)) return "physics";
  return "slider";
}
function ConstraintRow(p: { c: { id: string; name: string } }) {
  const kind = () => constraintKind(p.c.id);
  const slider = () => doc().skeleton.sliders?.find((x) => x.id === p.c.id);
  return (
    <div class="tree-row" classList={{ selected: selection()?.kind === kind() && selection()!.id === p.c.id }} onClick={() => setSelection({ kind: kind(), id: p.c.id })}>
      <span class="icon">{CONSTRAINT_ICONS[kind()]}</span> {(doc(), p.c.name)}
      <Show when={slider()}>
        <span class="muted"> · {doc().animations.find((a) => a.id === slider()!.animation)?.name ?? "?"}</span>
      </Show>
    </div>
  );
}

function EventsSection() {
  const newEvent = async () => {
    const name = await askText({
      title: "New event",
      message: "Events are keyed in animations and fired by listeners; scripts, the host app and sounds react to them.",
      value: `event${doc().events.length + 1}`,
      confirmLabel: "Create",
      validate: uniqueName(doc().events.map((e) => e.name)),
    });
    if (name) apply("addEvent", { name });
  };
  return (
    <Section
      title="Events"
      actions={
        <>
          <button title="New folder for events" onClick={() => void newFolder("event")}>🗀</button>
          <button title="New event" onClick={newEvent}>+</button>
        </>
      }
    >
      <Foldered kind="event" items={() => doc().events} fallback={<div class="muted pad">No events yet</div>}>
        {(e) => (
          <div class="tree-row" title={`int ${e.int} · float ${e.float}${e.string ? ` · “${e.string}”` : ""}${e.audio ? " · plays a sound" : ""}`}>
            <span class="icon">⚡</span> {(doc(), e.name)}
            <Show when={e.audio}>
              <span class="muted"> ♪</span>
            </Show>
          </div>
        )}
      </Foldered>
    </Section>
  );
}

export function Hierarchy() {
  useRevealSelection();
  const roots = () => doc().skeleton.bones.filter((b) => b.parent === null);
  const newAnimation = async () => {
    const name = await askText({
      title: "New animation",
      value: `anim${doc().animations.length + 1}`,
      confirmLabel: "Create",
      validate: uniqueName(doc().animations.map((a) => a.name)),
    });
    if (!name) return;
    const r = apply("createAnimation", { name }) as { id: string } | undefined;
    if (r) {
      setAnimationId(r.id);
      setMode("animate");
      showPanel("timeline");
      setTime(0);
    }
  };
  const newSM = async () => {
    const name = await askText({
      title: "New state machine",
      message: "State machines make the rig interactive: inputs, states and transitions.",
      value: `State Machine ${doc().stateMachines.length + 1}`,
      confirmLabel: "Create",
      validate: uniqueName(doc().stateMachines.map((s) => s.name)),
    });
    if (!name) return;
    const r = apply("createStateMachine", { name }) as { id: string } | undefined;
    if (r) {
      setStateMachineId(r.id);
      showPanel("statemachine");
    }
  };
  return (
    <div class="panel hierarchy">
      <Section
        title="Skeleton"
        actions={
          <>
          <button title="Expand every bone, slot and folder" onClick={() => { setCollapsedNodes(new Set<string>()); setAllFolders("slot", false); }}>
            ⊞
          </button>
          <button title="Collapse every bone, slot and folder" onClick={() => { setNodes(allParentIds(), true); setAllFolders("slot", true, doc().skeleton.bones.flatMap((b) => allFolderPaths(doc().skeleton.slots.filter((x) => x.bone === b.id), "slot", b.id))); }}>
            ⊟
          </button>
          <button
            title="New slot folder under the selected bone (drag slots onto it)"
            onClick={() => {
              const b = selectedBoneId() ?? doc().skeleton.bones[0].id;
              setNodes([b], false);
              void newFolder("slot", b, undefined, `New slot folder in “${doc().skeleton.bones.find((x) => x.id === b)?.name ?? "bone"}”`);
            }}
          >
            🗀
          </button>
          <button
            title="Add child bone to selection"
            onClick={() => {
              const r = apply("addBone", { parent: selectedBoneId() ?? doc().skeleton.bones[0].id, x: 50, length: 50 }) as { id: string } | undefined;
              if (r) setSelection({ kind: "bone", id: r.id });
            }}
          >
            +
          </button>
          </>
        }
      >
        <div class="tree-search">
          <input
            type="search"
            placeholder="Search bones, slots, attachments"
            aria-label="Search the skeleton"
            value={treeQuery()}
            onInput={(e) => setTreeQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setTreeQuery("");
              else if (e.key === "Enter") selectFirstHit();
            }}
          />
          <Show when={query()}>
            <span class="muted small">{searchCount()}</span>
          </Show>
        </div>
        <div class="tree">
          <For each={roots().filter((b) => shown(b.id))}>{(b) => <BoneNode bone={b} />}</For>
          <Show when={query() && searchCount() === "no match"}>
            <div class="muted pad">Nothing named “{treeQuery().trim()}”.</div>
          </Show>
        </div>
      </Section>
      <Show when={doc().skeleton.ik.length + doc().skeleton.transform.length + doc().skeleton.path.length + doc().skeleton.physics.length + (doc().skeleton.sliders?.length ?? 0) > 0}>
        <Section title="Constraints" actions={<button title="New folder for constraints" onClick={() => void newFolder("constraint")}>🗀</button>}>
          <Foldered kind="constraint" items={constraintItems}>
            {(c) => <ConstraintRow c={c} />}
          </Foldered>
        </Section>
      </Show>
      <SkinsSection />
      <Section title="Images">
        <For each={doc().images} fallback={<div class="muted pad">Drop PNGs on the viewport or use + Image</div>}>
          {(img) => (
            <div class="tree-row" classList={{ selected: selection()?.kind === "image" && selection()!.id === img.id }} onClick={() => setSelection({ kind: "image", id: img.id })}>
              <span class="icon">🖼</span> {img.name} <span class="muted">{img.width}×{img.height}</span>
            </div>
          )}
        </For>
      </Section>
      <AudioSection />
      <Section
        title="Animations"
        actions={
          <>
            <button title="New folder for animations" onClick={() => void newFolder("animation")}>🗀</button>
            <button title="New animation" onClick={newAnimation}>+</button>
          </>
        }
      >
        <Foldered kind="animation" items={() => doc().animations} fallback={<div class="muted pad">No animations yet</div>}>
          {(a) => (
            <div
              class="tree-row"
              classList={{ selected: animationId() === a.id }}
              onClick={() => {
                setAnimationId(a.id);
                setMode("animate");
                showPanel("timeline");
              }}
              title="Double-click to rename"
              onDblClick={async () => {
                const name = await askText({
                  title: "Rename animation",
                  value: a.name,
                  confirmLabel: "Rename",
                  validate: uniqueName(doc().animations.map((x) => x.name), a.name),
                });
                if (name && name !== a.name) apply("updateAnimation", { animation: a.id, name });
              }}
            >
              <span class="icon" style={a.color ? { color: a.color } : {}}>▶</span> <span classList={{ muted: a.export === false }}>{a.name}</span>
              <Show when={a.export === false}>
                <span class="skin-badge" title="Not exported unless picked in the export dialog">no export</span>
              </Show>
              <button class="row-del" title="Delete" onClick={(e) => { e.stopPropagation(); void askConfirm({ title: `Delete animation "${a.name}"?`, message: "Its keys are removed and state machine states that play it are left empty. You can undo this.", confirmLabel: "Delete", danger: true }).then((ok) => ok && apply("deleteAnimation", { animation: a.id })); }}>×</button>
            </div>
          )}
        </Foldered>
      </Section>
      <EventsSection />
      <Section
        title="State machines"
        actions={
          <>
            <button title="New folder for state machines" onClick={() => void newFolder("stateMachine")}>🗀</button>
            <button title="New state machine" onClick={newSM}>+</button>
          </>
        }
      >
        <Foldered kind="stateMachine" items={() => doc().stateMachines} fallback={<div class="muted pad">Add one to make it interactive</div>}>
          {(s) => (
            <div
              class="tree-row"
              classList={{ selected: stateMachineId() === s.id }}
              onClick={() => {
                setStateMachineId(s.id);
                showPanel("statemachine");
              }}
            >
              <span class="icon">◈</span> {s.name}
              <button class="row-del" title="Delete" onClick={(e) => { e.stopPropagation(); void askConfirm({ title: `Delete state machine "${s.name}"?`, message: "Its inputs, states, transitions and listeners are removed. You can undo this.", confirmLabel: "Delete", danger: true }).then((ok) => ok && apply("deleteStateMachine", { stateMachine: s.id })); }}>×</button>
            </div>
          )}
        </Foldered>
      </Section>
      <StatsSection />
    </div>
  );
}
