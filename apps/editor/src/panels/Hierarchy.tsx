import { type BoneData, defaultSkin } from "@openbone/core";
import { For, Show } from "solid-js";
import {
  animationId,
  apply,
  doc,
  selection,
  setAnimationId,
  setBottomTab,
  setMode,
  setSelection,
  setStateMachineId,
  setTime,
  stateMachineId,
  selectedBoneId,
} from "../state.ts";
import { Section } from "./fields.tsx";

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
          const atts = () => Object.keys(defaultSkin(doc()).attachments[s.id] ?? {});
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
                    classList={{ selected: sel()?.kind === "slot" && sel()!.id === s.id && (sel() as { attachment?: string }).attachment === a }}
                    style={{ "padding-left": `${34 + p.depth * 12}px` }}
                    onClick={() => setSelection({ kind: "slot", id: s.id, attachment: a })}
                  >
                    <span class="icon">{defaultSkin(doc()).attachments[s.id][a].type === "boundingBox" ? "⬚" : "◇"}</span> {a}
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

export function Hierarchy() {
  const roots = () => doc().skeleton.bones.filter((b) => b.parent === null);
  const newAnimation = () => {
    const name = prompt("Animation name", `anim${doc().animations.length + 1}`);
    if (!name) return;
    const r = apply("createAnimation", { name }) as { id: string } | undefined;
    if (r) {
      setAnimationId(r.id);
      setMode("animate");
      setBottomTab("timeline");
      setTime(0);
    }
  };
  const newSM = () => {
    const name = prompt("State machine name", `State Machine ${doc().stateMachines.length + 1}`);
    if (!name) return;
    const r = apply("createStateMachine", { name }) as { id: string } | undefined;
    if (r) {
      setStateMachineId(r.id);
      setBottomTab("statemachine");
    }
  };
  return (
    <aside class="panel left">
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
      <Show when={doc().skeleton.ik.length + doc().skeleton.transform.length > 0}>
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
        </Section>
      </Show>
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
                setBottomTab("timeline");
              }}
              onDblClick={() => {
                const name = prompt("Rename animation", a.name);
                if (name) apply("updateAnimation", { animation: a.id, name });
              }}
            >
              <span class="icon">▶</span> {a.name}
              <button class="row-del" title="Delete" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${a.name}?`)) apply("deleteAnimation", { animation: a.id }); }}>×</button>
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
                setBottomTab("statemachine");
              }}
            >
              <span class="icon">◈</span> {s.name}
              <button class="row-del" title="Delete" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${s.name}?`)) apply("deleteStateMachine", { stateMachine: s.id }); }}>×</button>
            </div>
          )}
        </For>
      </Section>
    </aside>
  );
}
