import { type BoneData, slotAttachments } from "@openbone/core";
import { For, Show } from "solid-js";
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
} from "../state.ts";
import { showPanel } from "../layout.ts";
import { Section } from "./fields.tsx";
import { askConfirm, askText, uniqueName } from "../dialogs.tsx";

function BoneNode(p: { bone: BoneData; depth: number }) {
  const children = () => doc().skeleton.bones.filter((b) => b.parent === p.bone.id);
  const slots = () => doc().skeleton.slots.filter((s) => s.bone === p.bone.id);
  const sel = () => selection();
  return (
    <>
      <div
        class="tree-row"
        classList={{ selected: sel()?.kind === "bone" && sel()!.id === p.bone.id }}
        style={{ "padding-left": `${8 + p.depth * 12}px` }}
        onClick={() => setSelection({ kind: "bone", id: p.bone.id })}
      >
        <span class="icon bone-icon">🦴</span> {p.bone.name}
      </div>
      <For each={slots()}>
        {(s) => {
          const atts = () => slotAttachments(doc(), s.id, activeSkin()?.id);
          return (
            <>
              <div
                class="tree-row slot-row"
                classList={{ selected: sel()?.kind === "slot" && sel()!.id === s.id }}
                style={{ "padding-left": `${20 + p.depth * 12}px` }}
                onClick={() => setSelection({ kind: "slot", id: s.id })}
              >
                <span class="icon">▣</span> {s.name}
                <span class="muted"> {s.attachment ? `· ${s.attachment}` : "· hidden"}</span>
              </div>
              <For each={atts()}>
                {(a) => (
                  <div
                    class="tree-row att-row"
                    classList={{ selected: sel()?.kind === "slot" && sel()!.id === s.id && (sel() as { attachment?: string }).attachment === a.name }}
                    style={{ "padding-left": `${34 + p.depth * 12}px` }}
                    title={a.skin.id === doc().skeleton.skins[0].id ? "In the default skin" : `In skin “${a.skin.name}”${a.overrides ? " (overrides the default skin)" : ""}`}
                    onClick={() => setSelection({ kind: "slot", id: s.id, attachment: a.name })}
                  >
                    <span class="icon">{({ boundingBox: "⬚", clipping: "✂", sequence: "🎞" } as Record<string, string>)[a.attachment.type] ?? "◇"}</span> {a.name}
                    <Show when={a.skin.id !== doc().skeleton.skins[0].id}>
                      <span class="skin-badge">{a.skin.name}</span>
                    </Show>
                  </div>
                )}
              </For>
            </>
          );
        }}
      </For>
      <For each={children()}>{(c) => <BoneNode bone={c} depth={p.depth + 1} />}</For>
    </>
  );
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
    <Section title="Skins" actions={<button title="New empty skin" onClick={() => newSkin()}>+</button>}>
      <For each={skins()}>
        {(k, i) => {
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
      </For>
      <Show when={activeSkin()} fallback={<div class="hint pad">Add a skin for each outfit. Attachments you add while it is active go into it.</div>}>
        <div class="hint pad">
          New attachments go into “{activeSkin()!.name}”. Copy a default attachment into it from the Inspector to override it.
        </div>
      </Show>
    </Section>
  );
}

export function Hierarchy() {
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
          <button
            title="Add child bone to selection"
            onClick={() => {
              const r = apply("addBone", { parent: selectedBoneId() ?? doc().skeleton.bones[0].id, x: 50, length: 50 }) as { id: string } | undefined;
              if (r) setSelection({ kind: "bone", id: r.id });
            }}
          >
            +
          </button>
        }
      >
        <div class="tree">
          <For each={roots()}>{(b) => <BoneNode bone={b} depth={0} />}</For>
        </div>
      </Section>
      <Show when={doc().skeleton.ik.length + doc().skeleton.transform.length + doc().skeleton.path.length + doc().skeleton.physics.length > 0}>
        <Section title="Constraints">
          <For each={doc().skeleton.ik}>
            {(c) => (
              <div class="tree-row" classList={{ selected: selection()?.kind === "ik" && selection()!.id === c.id }} onClick={() => setSelection({ kind: "ik", id: c.id })}>
                <span class="icon">⤳</span> {c.name}
              </div>
            )}
          </For>
          <For each={doc().skeleton.transform}>
            {(c) => (
              <div class="tree-row" classList={{ selected: selection()?.kind === "transform" && selection()!.id === c.id }} onClick={() => setSelection({ kind: "transform", id: c.id })}>
                <span class="icon">⇉</span> {c.name}
              </div>
            )}
          </For>
          <For each={doc().skeleton.path}>
            {(c) => (
              <div class="tree-row" classList={{ selected: selection()?.kind === "path" && selection()!.id === c.id }} onClick={() => setSelection({ kind: "path", id: c.id })}>
                <span class="icon">〰</span> {c.name}
              </div>
            )}
          </For>
          <For each={doc().skeleton.physics}>
            {(c) => (
              <div class="tree-row" classList={{ selected: selection()?.kind === "physics" && selection()!.id === c.id }} onClick={() => setSelection({ kind: "physics", id: c.id })}>
                <span class="icon">≋</span> {c.name}
              </div>
            )}
          </For>
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
      <Section title="Animations" actions={<button onClick={newAnimation}>+</button>}>
        <For each={doc().animations} fallback={<div class="muted pad">No animations yet</div>}>
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
              <span class="icon">▶</span> {a.name}
              <button class="row-del" title="Delete" onClick={(e) => { e.stopPropagation(); void askConfirm({ title: `Delete animation "${a.name}"?`, message: "Its keys are removed and state machine states that play it are left empty. You can undo this.", confirmLabel: "Delete", danger: true }).then((ok) => ok && apply("deleteAnimation", { animation: a.id })); }}>×</button>
            </div>
          )}
        </For>
      </Section>
      <Section title="State machines" actions={<button onClick={newSM}>+</button>}>
        <For each={doc().stateMachines} fallback={<div class="muted pad">Add one to make it interactive</div>}>
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
        </For>
      </Section>
    </div>
  );
}
