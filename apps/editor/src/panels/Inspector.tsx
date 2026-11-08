import { animationDuration, type Attachment, attachmentOwner, type BindingTarget, type BoneProperty, type ClippingAttachment, CONSTRAINT_PROPERTIES, defaultSkin, descendantIds, estimateTextBox, getAttachment, type SequenceAttachment, shapeOutline, type SkinData, slotAttachments, templateInputs } from "@openbone/core";
import { regionGridMesh, retraceMesh, traceRegion } from "../mesh-trace.ts";
import { lastBackground, setBackground } from "../background.ts";
import { reorderSlot } from "../visibility.ts";
import { tip } from "../shortcuts/index.ts";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { commitBone, keyBoneProperty, keyConstraint, keySlot } from "../edit.ts";
import { imageFor } from "../images.ts";
import { activeSkin, apply, currentAnimation, doc, mode, selection, setSelection, skinArg, store, time, transaction } from "../state.ts";
import { askConfirm } from "../dialogs.tsx";
import { ColorField, NumberField, Section, SelectField, TextField } from "./fields.tsx";
import { AudioAssetInspector, BusInspector, SoundInspector } from "./AudioPanel.tsx";
import { SequenceEditor } from "./SequenceEditor.tsx";
import { PRESET_NAMES, ParticlesEditor } from "./ParticlesInspector.tsx";
import { BindingList } from "./Bindings.tsx";

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

function isKeyed(target: string, id: string, property: string) {
  const a = currentAnimation();
  const tl = a?.timelines.find((t) => t.target === target && t.id === id && t.property === property);
  return !!tl?.keys.some((k) => near(k.time, time()));
}

function BoneInspector(p: { id: string }) {
  const bone = () => doc().skeleton.bones.find((b) => b.id === p.id);
  const [ikTarget, setIkTarget] = createSignal("");
  const animate = () => mode() === "animate";
  const field = (label: string, prop: BoneProperty, step = 1) => (
    <NumberField
      label={label}
      step={step}
      value={bone()![prop]}
      onCommit={(v) => commitBone(p.id, { [prop]: v })}
      onKey={animate() ? () => keyBoneProperty(p.id, prop, bone()![prop]) : undefined}
      keyed={animate() && isKeyed("bone", p.id, prop)}
    />
  );
  return (
    <Show when={bone()}>
      <Section title="Bone">
        <TextField label="Name" value={bone()!.name} onCommit={(v) => apply("updateBone", { bone: p.id, name: v })} />
        <SelectField
          label="Parent"
          value={bone()!.parent ?? ""}
          options={[{ value: "", label: "(none)" }, ...doc().skeleton.bones.filter((b) => b.id !== p.id).map((b) => ({ value: b.id, label: b.name }))]}
          onCommit={(v) => apply("updateBone", { bone: p.id, parent: v || null })}
        />
        <Show when={animate()}>
          <div class="hint">Animate mode: edits set keys at {time().toFixed(2)}s{currentAnimation() ? ` in “${currentAnimation()!.name}”` : ""}. Values shown are setup values.</div>
        </Show>
        {field("Rotation", "rotation")}
        {field("X", "x")}
        {field("Y", "y")}
        {field("Scale X", "scaleX", 0.01)}
        {field("Scale Y", "scaleY", 0.01)}
        {field("Shear X", "shearX")}
        {field("Shear Y", "shearY")}
        <NumberField label="Length" value={bone()!.length} onCommit={(v) => apply("updateBone", { bone: p.id, length: Math.max(0, v) })} />
        <SelectField
          label="Inherit"
          value={bone()!.inherit}
          options={["normal", "onlyTranslation", "noRotation", "noScale"].map((v) => ({ value: v, label: v }))}
          onCommit={(v) => apply("updateBone", { bone: p.id, inherit: v })}
        />
        <div class="btn-row">
          <button
            onClick={() => {
              const r = apply("addBone", { parent: p.id, x: bone()!.length || 50, length: 50 }) as { id: string } | undefined;
              if (r) setSelection({ kind: "bone", id: r.id });
            }}
          >
            + Child bone
          </button>
          <button
            onClick={() => {
              const r = apply("addSlot", { bone: p.id }) as { id: string } | undefined;
              if (r) setSelection({ kind: "slot", id: r.id });
            }}
          >
            + Slot
          </button>
          <button class="danger" onClick={() => apply("deleteBone", { bone: p.id }) !== undefined && setSelection(null)}>
            Delete
          </button>
        </div>
      </Section>
      <Section title="Constraints">
        <div class="field">
          <span>Target bone</span>
          <select value={ikTarget()} onChange={(e) => setIkTarget(e.currentTarget.value)}>
            <option value="" selected={!(ikTarget())}>choose bone…</option>
            <For each={doc().skeleton.bones.filter((b) => b.id !== p.id)}>{(b) => <option value={b.id} selected={b.id === (ikTarget())}>{b.name}</option>}</For>
          </select>
        </div>
        <div class="btn-row">
          <button disabled={!ikTarget()} onClick={() => addAndSelect("ik", "addIkConstraint", { bones: [p.id], target: ikTarget() })}>
            1-bone IK
          </button>
          <button
            disabled={!ikTarget() || !bone()!.parent}
            title="Uses this bone and its parent"
            onClick={() => addAndSelect("ik", "addIkConstraint", { bones: [bone()!.parent!, p.id], target: ikTarget() })}
          >
            2-bone IK (with parent)
          </button>
        </div>
        <div class="btn-row">
          <button
            disabled={!ikTarget()}
            title="This bone copies the target bone's world rotation and position"
            onClick={() => addAndSelect("transform", "addTransformConstraint", { bones: [p.id], target: ikTarget(), name: `${bone()!.name}-copy` })}
          >
            Copy transform
          </button>
          <button title="Spring secondary motion on this bone" onClick={() => addAndSelect("physics", "addPhysicsConstraint", { bone: p.id })}>
            + Physics
          </button>
          <button
            disabled={descendantIds(doc(), p.id).size < 2}
            title="Physics on this bone and every bone below it (hair, cloth, tails)"
            onClick={() =>
              transaction("physics chain", () => {
                for (const b of doc().skeleton.bones) if (descendantIds(doc(), p.id).has(b.id)) store.apply("addPhysicsConstraint", { bone: b.id });
              })
            }
          >
            + Physics chain
          </button>
          <button
            disabled={!doc().animations.length}
            title={doc().animations.length ? "Slider: this bone's rotation scrubs an animation (e.g. a corrective or shadow animation)" : "Create an animation first"}
            onClick={() => {
              const anim = doc().animations[0];
              const r = apply("addSlider", { animation: anim.id, bone: p.id, property: "rotation", from: 0, to: 90 }) as { id: string } | undefined;
              if (r) setSelection({ kind: "slider", id: r.id });
            }}
          >
            + Slider
          </button>
        </div>
        <For each={constraintsOf(p.id)}>
          {(c) => (
            <div class="tree-row" onClick={() => setSelection({ kind: c.kind, id: c.id } as never)}>
              <span class="icon">{ICONS[c.kind]}</span> {c.name} <span class="muted">{c.kind}</span>
            </div>
          )}
        </For>
      </Section>
    </Show>
  );
}

function SkinControls(p: { slotId: string; att: Attachment; owner: SkinData }) {
  const skins = () => doc().skeleton.skins;
  const isDefault = () => p.owner.id === skins()[0].id;
  const overrides = () => !isDefault() && !!skins()[0].attachments[p.slotId]?.[p.att.name];
  const others = () => skins().filter((k) => k.id !== p.owner.id);
  const [target, setTarget] = createSignal("");
  const targetSkin = () => others().find((k) => k.id === target()) ?? others()[0];
  const copy = async (move: boolean) => {
    const to = targetSkin();
    if (!to) return;
    if (
      to.attachments[p.slotId]?.[p.att.name] &&
      !(await askConfirm({ title: `Replace “${p.att.name}” in “${to.name}”?`, message: "That skin already has an attachment with this name on this slot.", confirmLabel: "Replace", danger: true }))
    )
      return;
    transaction(move ? "move attachment to skin" : "copy attachment to skin", () => {
      store.apply("copyAttachment", { slot: p.slotId, attachment: p.att.name, fromSkin: p.owner.id, toSkin: to.id });
      if (move) store.apply("deleteAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id });
    });
  };
  return (
    <>
      <div class="field">
        <span>Skin</span>
        <span class="skin-row">
          <b>{p.owner.name}</b>
          <Show when={overrides()}>
            <span class="muted">overrides default</span>
          </Show>
        </span>
      </div>
      <Show when={isDefault() && activeSkin()}>
        <button
          title="Copy this attachment into the active skin so the outfit can change it without affecting other skins"
          onClick={() => apply("copyAttachment", { slot: p.slotId, attachment: p.att.name, toSkin: activeSkin()!.id })}
        >
          Override in “{activeSkin()!.name}”
        </button>
      </Show>
      <Show when={overrides()}>
        <button title="Delete this skin's version and show the default skin's again" onClick={() => apply("deleteAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id })}>
          Revert to default
        </button>
      </Show>
      <Show when={others().length > 0}>
        <div class="field">
          <span>To skin</span>
          <select value={targetSkin()?.id ?? ""} onChange={(e) => setTarget(e.currentTarget.value)}>
            <For each={others()}>{(k) => <option value={k.id}>{k.name}</option>}</For>
          </select>
        </div>
        <div class="btn-row">
          <button onClick={() => copy(false)}>Copy</button>
          <button onClick={() => copy(true)}>Move</button>
        </div>
      </Show>
    </>
  );
}

type ConstraintKind = "ik" | "transform" | "path" | "physics";
const ICONS: Record<ConstraintKind, string> = { ik: "⤳", transform: "⇉", path: "〰", physics: "≋" };
const UPDATE_OP: Record<ConstraintKind, string> = {
  ik: "updateIkConstraint",
  transform: "updateTransformConstraint",
  path: "updatePathConstraint",
  physics: "updatePhysicsConstraint",
};

function addAndSelect(kind: ConstraintKind, op: string, args: Record<string, unknown>) {
  const r = apply(op, args) as { id: string } | undefined;
  if (r) setSelection({ kind, id: r.id });
}

/** Constraints that move or target a bone. */
function constraintsOf(boneId: string): { kind: ConstraintKind; id: string; name: string }[] {
  const sk = doc().skeleton;
  const slotBone = (id: string) => sk.slots.find((s) => s.id === id)?.bone;
  return [
    ...sk.ik.filter((c) => c.bones.includes(boneId) || c.target === boneId).map((c) => ({ kind: "ik" as const, ...c })),
    ...sk.transform.filter((c) => c.bones.includes(boneId) || c.target === boneId).map((c) => ({ kind: "transform" as const, ...c })),
    ...sk.path.filter((c) => c.bones.includes(boneId) || slotBone(c.target) === boneId).map((c) => ({ kind: "path" as const, ...c })),
    ...sk.physics.filter((c) => c.bone === boneId).map((c) => ({ kind: "physics" as const, ...c })),
  ];
}

/**
 * Numeric constraint field. In Animate mode keyable fields set keys at the current time
 * (the value shown is the setup value, as for bones); other fields always edit the setup.
 */
function CNumber(p: {
  kind: ConstraintKind;
  id: string;
  prop: string;
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
}) {
  const keyable = () => mode() === "animate" && (CONSTRAINT_PROPERTIES[p.kind] as string[]).includes(p.prop);
  const fix = (v: number) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
  return (
    <NumberField
      label={p.label}
      step={p.step}
      value={p.value}
      onCommit={(v) => (keyable() ? keyConstraint(p.kind, p.id, p.prop, fix(v)) : apply(UPDATE_OP[p.kind], { constraint: p.id, [p.prop]: fix(v) }))}
      onKey={keyable() ? () => keyConstraint(p.kind, p.id, p.prop, p.value) : undefined}
      keyed={keyable() && isKeyed(p.kind, p.id, p.prop)}
    />
  );
}

function Check(p: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label class="field" title={p.title}>
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.currentTarget.checked)} />
    </label>
  );
}

/** An IK on/off setting: a checkbox in Setup mode; in Animate mode it sets a stepped key (◆), like Spine's IK keys. */
function IkSwitch(p: { id: string; prop: "bend" | "stretch" | "compress"; label: string; title?: string; checked: boolean; onSetup: (v: boolean) => void; on?: number; off?: number }) {
  const animate = () => mode() === "animate";
  const value = (v: boolean) => (v ? (p.on ?? 1) : (p.off ?? 0));
  return (
    <label class="field" title={p.title}>
      <span>{p.label}</span>
      <input type="checkbox" checked={p.checked} onChange={(e) => (animate() ? keyConstraint("ik", p.id, p.prop, value(e.currentTarget.checked)) : p.onSetup(e.currentTarget.checked))} />
      <Show when={animate()}>
        <button class="key-btn" classList={{ keyed: isKeyed("ik", p.id, p.prop) }} title={`Key ${p.label} at this time (stepped)`} onClick={(e) => (e.preventDefault(), keyConstraint("ik", p.id, p.prop, value(p.checked)))}>
          ◆
        </button>
      </Show>
    </label>
  );
}

function AnimateHint() {
  return (
    <Show when={mode() === "animate"}>
      <div class="hint">Animate mode: ◆ fields set keys at {time().toFixed(2)}s. Values shown are setup values.</div>
    </Show>
  );
}

function BindBones(p: { slotId: string; attachment: string; skin?: string }) {
  const [weightBones, setWeightBones] = createSignal<string[]>([]);
  return (
    <>
      <div class="field col">
        <span>Bind to bones</span>
        <select multiple size={5} onChange={(e) => setWeightBones(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}>
          <For each={doc().skeleton.bones}>{(b) => <option value={b.id}>{b.name}</option>}</For>
        </select>
      </div>
      <button disabled={weightBones().length === 0} onClick={() => apply("autoWeights", { slot: p.slotId, attachment: p.attachment, skin: p.skin, bones: weightBones(), maxInfluences: 2 })}>
        Auto weights
      </button>
    </>
  );
}

function PathAttachmentEditor(p: { slotId: string; att: Extract<Attachment, { type: "path" }>; owner: SkinData }) {
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, props });
  const [chain, setChain] = createSignal<string[]>([]);
  const slotBone = () => doc().skeleton.slots.find((s) => s.id === p.slotId)?.bone;
  return (
    <>
      <div class="hint">
        {p.att.vertices.length / 6} knots · {p.att.weights ? "weighted (bend it by moving its bones)" : "unweighted (follows slot bone)"}. Edit knots via MCP/JSON (`vertices`).
      </div>
      <Check label="Closed" checked={p.att.closed} onChange={(v) => set({ closed: v })} />
      <ColorField label="Color" value={p.att.color} onCommit={(v) => set({ color: v })} />
      <BindBones slotId={p.slotId} attachment={p.att.name} skin={p.owner.id} />
      <div class="field col">
        <span>Bones to place along the path (parent first)</span>
        <select multiple size={5} onChange={(e) => setChain(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}>
          <For each={doc().skeleton.bones.filter((b) => b.id !== slotBone())}>{(b) => <option value={b.id}>{b.name}</option>}</For>
        </select>
      </div>
      <button disabled={chain().length === 0} onClick={() => addAndSelect("path", "addPathConstraint", { bones: chain(), target: p.slotId })}>
        Add path constraint
      </button>
    </>
  );
}

function AttachmentEditor(p: { slotId: string; att: Attachment; owner: SkinData }) {
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, props });
  return (
    <Section title={`Attachment · ${p.att.type}`}>
      <TextField label="Name" value={p.att.name} onCommit={(v) => set({ name: v })} />
      <SkinControls slotId={p.slotId} att={p.att} owner={p.owner} />
      <Switch>
        <Match when={p.att.type === "region" || p.att.type === "sequence" || p.att.type === "shape" || p.att.type === "point" || p.att.type === "text"}>
          <NumberField label="X" value={(p.att as { x: number }).x} onCommit={(v) => set({ x: v })} />
          <NumberField label="Y" value={(p.att as { y: number }).y} onCommit={(v) => set({ y: v })} />
          <NumberField label="Rotation" value={(p.att as { rotation: number }).rotation} onCommit={(v) => set({ rotation: v })} />
        </Match>
      </Switch>
      <Switch>
        <Match when={p.att.type === "region" && p.att}>
          {(_a) => {
            // Read through props so the fields follow selection changes and undo.
            const r = () => p.att as Extract<Attachment, { type: "region" }>;
            return (
              <>
                <NumberField label="Width" value={r().width} onCommit={(v) => set({ width: v })} />
                <NumberField label="Height" value={r().height} onCommit={(v) => set({ height: v })} />
                <NumberField label="Scale X" step={0.01} value={r().scaleX} onCommit={(v) => set({ scaleX: v })} />
                <NumberField label="Scale Y" step={0.01} value={r().scaleY} onCommit={(v) => set({ scaleY: v })} />
                <NumberField label="Skew X" step={1} value={r().skewX ?? 0} onCommit={(v) => set({ skewX: v })} />
                <NumberField label="Skew Y" step={1} value={r().skewY ?? 0} onCommit={(v) => set({ skewY: v })} />
                <ColorField label="Tint" value={r().color} onCommit={(v) => set({ color: v })} />
                <div class="btn-row">
                  <button title="Replace with a mesh that hugs the image's visible pixels (automatic outline)" onClick={() => void traceRegion(p.slotId, p.owner.id, r())}>
                    Trace mesh…
                  </button>
                  <button
                    title="Replace with a deformable 4×4 grid mesh using the same image"
                    onClick={() =>
                      transaction("convert to mesh", () => {
                        store.apply("deleteAttachment", { slot: p.slotId, attachment: r().name, skin: p.owner.id });
                        store.apply("addMesh", { slot: p.slotId, skin: p.owner.id, name: r().name, image: r().image, ...regionGridMesh(r()), color: r().color });
                      })
                    }
                  >
                    Grid mesh (4×4)
                  </button>
                </div>
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "shape" && p.att}>
          {(_a) => {
            // Read through props so the fields follow selection changes and undo.
            const s = () => p.att as Extract<Attachment, { type: "shape" }>;
            return (
              <>
                <SelectField label="Shape" value={s().shape} options={["rect", "ellipse", "polygon"].map((v) => ({ value: v, label: v }))} onCommit={(v) => set({ shape: v })} />
                <NumberField label="Width" value={s().width} onCommit={(v) => set({ width: v })} />
                <NumberField label="Height" value={s().height} onCommit={(v) => set({ height: v })} />
                <Show when={s().shape === "rect"}>
                  <NumberField label="Radius" value={s().radius} onCommit={(v) => set({ radius: v })} />
                </Show>
                <ColorField label="Fill" value={s().fill} onCommit={(v) => set({ fill: v })} />
                <ColorField label="Stroke" value={s().stroke ?? "#000000"} onCommit={(v) => set({ stroke: v, strokeWidth: s().strokeWidth || 2 })} />
                <NumberField label="Stroke W" value={s().strokeWidth ?? 0} onCommit={(v) => set({ strokeWidth: v })} />
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "text" && p.att}>
          {(_a) => <TextAttachmentEditor att={() => p.att as Extract<Attachment, { type: "text" }>} set={set} />}
        </Match>
        <Match when={p.att.type === "mesh" && p.att}>
          {(_a) => {
            // Read through props (follows selection and undo) and doc() (in-place edits keep the same object).
            const m = () => (doc(), p.att as Extract<Attachment, { type: "mesh" }>);
            return (
              <>
                <div class="hint">
                  {m().vertices.length / 2} vertices · {m().triangles.length / 3} triangles · {m().weights ? "weighted" : "unweighted (follows slot bone)"}
                </div>
                <BindBones slotId={p.slotId} attachment={m().name} skin={p.owner.id} />
                <button
                  disabled={!!m().weights?.length}
                  title={m().weights?.length ? "Weighted meshes cannot be re-traced (the weights would be lost)" : "Rebuild this mesh from the image's visible pixels, where it sits now"}
                  onClick={() => void retraceMesh(p.slotId, p.owner.id, m())}
                >
                  Re-trace outline…
                </button>
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "clipping" && p.att}>
          {(a) => <ClippingEditor slotId={p.slotId} att={a() as ClippingAttachment} set={set} />}
        </Match>
        <Match when={p.att.type === "path" && p.att}>
          {(a) => <PathAttachmentEditor slotId={p.slotId} att={a() as Extract<Attachment, { type: "path" }>} owner={p.owner} />}
        </Match>
        <Match when={p.att.type === "sequence" && p.att}>
          {(_a) => <SequenceEditor slotId={p.slotId} att={p.att as SequenceAttachment} owner={p.owner} />}
        </Match>
        <Match when={p.att.type === "particles" && p.att}>
          {(_a) => <ParticlesEditor slotId={p.slotId} att={p.att as Extract<Attachment, { type: "particles" }>} owner={p.owner} />}
        </Match>
        <Match when={p.att.type === "boundingBox"}>
          <div class="hint">Hit area for state-machine listeners. Edit vertices via MCP/JSON for now.</div>
        </Match>
      </Switch>
      <button class="danger" onClick={() => apply("deleteAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id })}>
        Delete attachment
      </button>
    </Section>
  );
}

function SlotInspector(p: { id: string; attachment?: string }) {
  const slot = () => doc().skeleton.slots.find((s) => s.id === p.id);
  const atts = () => slotAttachments(doc(), p.id, activeSkin()?.id).map((e) => e.name);
  const attName = () => p.attachment ?? slot()?.attachment ?? null;
  const att = () => getAttachment(doc(), p.id, attName(), activeSkin()?.id);
  const owner = () => attachmentOwner(doc(), p.id, attName(), activeSkin()?.id);
  const index = () => doc().skeleton.slots.findIndex((s) => s.id === p.id);
  const animate = () => mode() === "animate";
  return (
    <Show when={slot()}>
      <Section title="Slot">
        <TextField label="Name" value={slot()!.name} onCommit={(v) => apply("updateSlot", { slot: p.id, name: v })} />
        <SelectField label="Bone" value={slot()!.bone} options={doc().skeleton.bones.map((b) => ({ value: b.id, label: b.name }))} onCommit={(v) => apply("updateSlot", { slot: p.id, bone: v })} />
        <ColorField
          label="Color"
          value={slot()!.color}
          onCommit={(v) => (animate() ? keySlot(p.id, "color", v) : apply("updateSlot", { slot: p.id, color: v }))}
          onKey={animate() ? () => keySlot(p.id, "color", slot()!.color) : undefined}
          keyed={animate() && isKeyed("slot", p.id, "color")}
        />
        <SelectField
          label="Showing"
          value={slot()!.attachment ?? ""}
          options={[{ value: "", label: "(hidden)" }, ...atts().map((a) => ({ value: a, label: a }))]}
          onCommit={(v) => (animate() ? keySlot(p.id, "attachment", v || null) : apply("updateSlot", { slot: p.id, attachment: v || null }))}
        />
        <SelectField
          label="Blend"
          value={slot()!.blend}
          options={["normal", "additive", "multiply", "screen"].map((v) => ({ value: v, label: v }))}
          onCommit={(v) => apply("updateSlot", { slot: p.id, blend: v })}
        />
        <div class="field draw-order" title="Draw order: slots later in the list are drawn on top">
          <span>Draw order</span>
          <button title={tip("Send to back", "edit.sendToBack")} onClick={() => reorderSlot(p.id, "back")} disabled={index() === 0}>⤓</button>
          <button title={tip("Send backward", "edit.sendBackward")} onClick={() => reorderSlot(p.id, "backward")} disabled={index() === 0}>↓</button>
          <button title={tip("Bring forward", "edit.bringForward")} onClick={() => reorderSlot(p.id, "forward")} disabled={index() === doc().skeleton.slots.length - 1}>↑</button>
          <button title={tip("Bring to front", "edit.bringToFront")} onClick={() => reorderSlot(p.id, "front")} disabled={index() === doc().skeleton.slots.length - 1}>⤒</button>
          <span class="muted small">{index() + 1} / {doc().skeleton.slots.length}</span>
        </div>
        <div class="btn-row">
          <button class="danger" onClick={() => apply("deleteSlot", { slot: p.id }) !== undefined && setSelection(null)}>
            Delete
          </button>
        </div>
        <div class="btn-row">
          <button onClick={() => apply("addShape", { slot: p.id, name: `shape${atts().length + 1}`, shape: "ellipse", width: 50, height: 50, fill: "#ff9f43", ...skinArg() })}>+ Shape</button>
          <button
            title="Text; {input} or {input:0.00} shows a state machine input"
            onClick={() => apply("addText", { slot: p.id, name: atts().includes("text") ? `text${atts().length + 1}` : "text", text: "Text", ...skinArg() })}
          >
            + Text
          </button>
          <button onClick={() => apply("addBoundingBox", { slot: p.id, width: 100, height: 100, ...skinArg() })}>+ Hit box</button>
          <button onClick={() => apply("addPoint", { slot: p.id, ...skinArg() })}>+ Point</button>
          <button
            title="Add a clipping mask: slots after this one in draw order are drawn only inside its outline"
            onClick={() => apply("addClipping", { slot: p.id, name: atts().includes("mask") ? `mask${atts().length + 1}` : "mask", width: 120, height: 60, radius: 12, ...skinArg() })}
          >
            + Mask
          </button>
          <button title="Bezier path for path constraints" onClick={() => apply("addPath", { slot: p.id, name: `path${atts().length + 1}`, anchors: [0, 0, 80, 40, 160, 0], ...skinArg() })}>
            + Path
          </button>
          <select
            class="add-select"
            title="Add a particle emitter (emits from this slot's bone)"
            value=""
            onChange={(e) => {
              const preset = e.currentTarget.value;
              e.currentTarget.value = "";
              if (preset) apply("addParticles", { slot: p.id, preset, ...skinArg() });
            }}
          >
            <option value="">+ Particles…</option>
            <For each={PRESET_NAMES}>{(n) => <option value={n}>{n}</option>}</For>
          </select>
        </div>
        <Show when={activeSkin()}>
          <div class="hint">New attachments go into skin “{activeSkin()!.name}”.</div>
        </Show>
      </Section>
      <Show when={att() && owner()}>
        <AttachmentEditor slotId={p.id} att={att()!} owner={owner()!} />
      </Show>
    </Show>
  );
}

function IkInspector(p: { id: string }) {
  const c = () => doc().skeleton.ik.find((x) => x.id === p.id);
  const name = (id: string) => doc().skeleton.bones.find((b) => b.id === id)?.name ?? id;
  const set = (props: Record<string, unknown>) => apply("updateIkConstraint", { constraint: p.id, ...props });
  return (
    <Show when={c()}>
      <Section title="IK constraint">
        <TextField label="Name" value={c()!.name} onCommit={(v) => set({ name: v })} />
        <div class="hint">
          {c()!.bones.map(name).join(" → ")} reach for <b>{name(c()!.target)}</b>. Move the target bone to pose the chain.
        </div>
        <AnimateHint />
        <SelectField label="Target" value={c()!.target} options={doc().skeleton.bones.map((b) => ({ value: b.id, label: b.name }))} onCommit={(v) => set({ target: v })} />
        <CNumber kind="ik" id={p.id} prop="mix" label="Mix" step={0.01} min={0} max={1} value={c()!.mix} />
        <Show when={c()!.bones.length === 2}>
          <CNumber kind="ik" id={p.id} prop="softness" label="Softness" min={0} value={c()!.softness} />
        </Show>
        <IkSwitch id={p.id} prop="bend" label="Bend +" title="Which way the elbow/knee bends" checked={c()!.bendPositive} onSetup={(v) => set({ bendPositive: v })} on={1} off={-1} />
        <IkSwitch id={p.id} prop="stretch" label="Stretch" title="Scale bones up to reach a far target" checked={c()!.stretch} onSetup={(v) => set({ stretch: v })} />
        <Show when={c()!.bones.length === 1}>
          <IkSwitch id={p.id} prop="compress" label="Compress" title="Scale the bone down when the target is closer than its length" checked={c()!.compress} onSetup={(v) => set({ compress: v })} />
        </Show>
        <Show when={c()!.stretch || (c()!.bones.length === 1 && c()!.compress)}>
          <Check label="Uniform" title="Scale both axes when stretching or compressing, so the art keeps its proportions" checked={!!c()!.uniform} onChange={(v) => set({ uniform: v })} />
        </Show>
        <button class="danger" onClick={() => apply("deleteConstraint", { constraint: p.id }) !== undefined && setSelection(null)}>
          Delete
        </button>
      </Section>
    </Show>
  );
}

function BonesHint(p: { bones: string[]; verb: string; target: string }) {
  const name = (id: string) => doc().skeleton.bones.find((b) => b.id === id)?.name ?? doc().skeleton.slots.find((s) => s.id === id)?.name ?? id;
  return (
    <div class="hint">
      {p.bones.map(name).join(", ")} {p.verb} <b>{name(p.target)}</b>.
    </div>
  );
}

function TransformInspector(p: { id: string }) {
  const c = () => doc().skeleton.transform.find((x) => x.id === p.id);
  const set = (props: Record<string, unknown>) => apply("updateTransformConstraint", { constraint: p.id, ...props });
  const bones = () => doc().skeleton.bones.map((b) => ({ value: b.id, label: b.name }));
  return (
    <Show when={c()}>
      <Section title="Transform constraint">
        <TextField label="Name" value={c()!.name} onCommit={(v) => set({ name: v })} />
        <BonesHint bones={c()!.bones} verb={c()!.relative ? "add the changes of" : "copy"} target={c()!.target} />
        <AnimateHint />
        <SelectField label="Target" value={c()!.target} options={bones()} onCommit={(v) => set({ target: v })} />
        <div class="field col">
          <span>Constrained bones</span>
          <select multiple size={4} onChange={(e) => {
            const ids = Array.from(e.currentTarget.selectedOptions).map((o) => o.value);
            if (ids.length) set({ bones: ids });
          }}>
            <For each={doc().skeleton.bones.filter((b) => b.id !== c()!.target)}>
              {(b) => <option value={b.id} selected={c()!.bones.includes(b.id)}>{b.name}</option>}
            </For>
          </select>
        </div>
        <Check label="Local" title="Copy local (parent-space) values instead of world transforms" checked={c()!.local} onChange={(v) => set({ local: v })} />
        <Check label="Relative" title="Add the target's change from its setup pose instead of copying its value" checked={c()!.relative} onChange={(v) => set({ relative: v })} />
        <Show when={mode() === "animate"}>
          <CNumber kind="transform" id={p.id} prop="mix" label="Mix ×" step={0.01} min={0} max={1} value={1} />
        </Show>
        <CNumber kind="transform" id={p.id} prop="mixRotate" label="Rotate" step={0.01} min={0} max={1} value={c()!.mixRotate} />
        <CNumber kind="transform" id={p.id} prop="mixTranslate" label="Translate" step={0.01} min={0} max={1} value={c()!.mixTranslate} />
        <CNumber kind="transform" id={p.id} prop="mixScale" label="Scale" step={0.01} min={0} max={1} value={c()!.mixScale} />
        <CNumber kind="transform" id={p.id} prop="mixShear" label="Shear" step={0.01} min={0} max={1} value={c()!.mixShear} />
        <CNumber kind="transform" id={p.id} prop="offsetRotation" label="Offset rot" value={c()!.offsetRotation} />
        <CNumber kind="transform" id={p.id} prop="offsetX" label="Offset X" value={c()!.offsetX} />
        <CNumber kind="transform" id={p.id} prop="offsetY" label="Offset Y" value={c()!.offsetY} />
        <CNumber kind="transform" id={p.id} prop="offsetScaleX" label="Offset sX" step={0.01} value={c()!.offsetScaleX} />
        <CNumber kind="transform" id={p.id} prop="offsetScaleY" label="Offset sY" step={0.01} value={c()!.offsetScaleY} />
        <CNumber kind="transform" id={p.id} prop="offsetShear" label="Offset shear" value={c()!.offsetShear} />
        <button class="danger" onClick={() => apply("deleteConstraint", { constraint: p.id }) !== undefined && setSelection(null)}>
          Delete
        </button>
      </Section>
    </Show>
  );
}

function PathInspector(p: { id: string }) {
  const c = () => doc().skeleton.path.find((x) => x.id === p.id);
  const set = (props: Record<string, unknown>) => apply("updatePathConstraint", { constraint: p.id, ...props });
  const opts = (xs: string[]) => xs.map((v) => ({ value: v, label: v }));
  return (
    <Show when={c()}>
      <Section title="Path constraint">
        <TextField label="Name" value={c()!.name} onCommit={(v) => set({ name: v })} />
        <BonesHint bones={c()!.bones} verb="follow the path in slot" target={c()!.target} />
        <AnimateHint />
        <SelectField label="Path slot" value={c()!.target} options={doc().skeleton.slots.map((s) => ({ value: s.id, label: s.name }))} onCommit={(v) => set({ target: v })} />
        <SelectField label="Position" value={c()!.positionMode} options={opts(["percent", "fixed"])} onCommit={(v) => set({ positionMode: v })} />
        <SelectField label="Spacing" value={c()!.spacingMode} options={opts(["length", "fixed", "percent", "proportional"])} onCommit={(v) => set({ spacingMode: v })} />
        <SelectField label="Rotate" value={c()!.rotateMode} options={opts(["tangent", "chain", "chainScale"])} onCommit={(v) => set({ rotateMode: v })} />
        <CNumber kind="path" id={p.id} prop="position" label={c()!.positionMode === "percent" ? "Position %" : "Position"} step={c()!.positionMode === "percent" ? 0.01 : 1} value={c()!.position} />
        <CNumber kind="path" id={p.id} prop="spacing" label="Spacing" step={c()!.spacingMode === "percent" || c()!.spacingMode === "proportional" ? 0.01 : 1} value={c()!.spacing} />
        <CNumber kind="path" id={p.id} prop="mixRotate" label="Mix rotate" step={0.01} min={0} max={1} value={c()!.mixRotate} />
        <CNumber kind="path" id={p.id} prop="mixX" label="Mix X" step={0.01} min={0} max={1} value={c()!.mixX} />
        <CNumber kind="path" id={p.id} prop="mixY" label="Mix Y" step={0.01} min={0} max={1} value={c()!.mixY} />
        <CNumber kind="path" id={p.id} prop="offsetRotation" label="Offset rot" value={c()!.offsetRotation} />
        <button class="danger" onClick={() => apply("deleteConstraint", { constraint: p.id }) !== undefined && setSelection(null)}>
          Delete
        </button>
      </Section>
    </Show>
  );
}

function SliderInspector(p: { id: string }) {
  const c = () => doc().skeleton.sliders?.find((x) => x.id === p.id);
  const set = (props: Record<string, unknown>) => apply("updateSlider", { slider: p.id, ...props });
  const numberInputs = () =>
    doc().stateMachines.flatMap((m) => m.inputs.filter((i) => i.type === "number").map((i) => ({ value: `input:${i.id}`, label: `input ${m.name} · ${i.name}` })));
  const driver = () => (c()!.input ? `input:${c()!.input}` : `bone:${c()!.bone}`);
  const anim = () => doc().animations.find((a) => a.id === c()?.animation);
  return (
    <Show when={c()}>
      <Section title="Slider">
        <TextField label="Name" value={c()!.name} onCommit={(v) => set({ name: v })} />
        <div class="hint">
          The driver's value from <b>{c()!.from}</b> to <b>{c()!.to}</b> plays <b>{anim()?.name ?? "?"}</b> from {c()!.timeFrom ?? 0}s to {c()!.timeTo ?? (anim() ? animationDuration(anim()!) : 0)}s
          {c()!.additive ? ", added on top" : ""}. Applied before IK and the other constraints.
        </div>
        <SelectField label="Animation" value={c()!.animation} options={doc().animations.map((a) => ({ value: a.id, label: a.name }))} onCommit={(v) => set({ animation: v })} />
        <SelectField
          label="Driver"
          value={driver()}
          options={[...doc().skeleton.bones.map((b) => ({ value: `bone:${b.id}`, label: `bone ${b.name}` })), ...numberInputs()]}
          onCommit={(v) => set(v.startsWith("input:") ? { input: v.slice(6) } : { bone: v.slice(5) })}
        />
        <Show when={c()!.bone}>
          <SelectField
            label="Property"
            value={c()!.property ?? "rotation"}
            options={["rotation", "x", "y", "scaleX", "scaleY", "shearX", "shearY"].map((v) => ({ value: v, label: v }))}
            onCommit={(v) => set({ property: v })}
          />
        </Show>
        <NumberField label="From" value={c()!.from} onCommit={(v) => set({ from: v })} />
        <NumberField label="To" value={c()!.to} onCommit={(v) => set({ to: v })} />
        <NumberField label="Time from" step={0.01} value={c()!.timeFrom ?? 0} onCommit={(v) => set({ timeFrom: v })} />
        <NumberField label="Time to" step={0.01} value={c()!.timeTo ?? (anim() ? animationDuration(anim()!) : 0)} onCommit={(v) => set({ timeTo: v })} />
        <NumberField label="Mix" step={0.01} value={c()!.mix} onCommit={(v) => set({ mix: Math.min(1, Math.max(0, v)) })} />
        <Check label="Loop" title="Wrap past the range instead of stopping at its ends" checked={c()!.loop} onChange={(v) => set({ loop: v })} />
        <Check label="Additive" title="Add the animation's change on top of the pose instead of replacing it" checked={c()!.additive} onChange={(v) => set({ additive: v })} />
        <button class="danger" onClick={() => apply("deleteSlider", { slider: p.id }) !== undefined && setSelection(null)}>
          Delete
        </button>
      </Section>
    </Show>
  );
}

function PhysicsInspector(p: { id: string }) {
  const c = () => doc().skeleton.physics.find((x) => x.id === p.id);
  const set = (props: Record<string, unknown>) => apply("updatePhysicsConstraint", { constraint: p.id, ...props });
  return (
    <Show when={c()}>
      <Section title="Physics constraint">
        <TextField label="Name" value={c()!.name} onCommit={(v) => set({ name: v })} />
        <div class="hint">Springs lag behind the animated pose. Drag bones in the viewport or play an animation to see it.</div>
        <AnimateHint />
        <SelectField label="Bone" value={c()!.bone} options={doc().skeleton.bones.map((b) => ({ value: b.id, label: b.name }))} onCommit={(v) => set({ bone: v })} />
        <CNumber kind="physics" id={p.id} prop="rotate" label="Rotate" step={0.01} min={0} max={1} value={c()!.rotate} />
        <CNumber kind="physics" id={p.id} prop="x" label="Move X" step={0.01} min={0} max={1} value={c()!.x} />
        <CNumber kind="physics" id={p.id} prop="y" label="Move Y" step={0.01} min={0} max={1} value={c()!.y} />
        <CNumber kind="physics" id={p.id} prop="scaleX" label="Stretch" step={0.01} min={0} max={1} value={c()!.scaleX} />
        <CNumber kind="physics" id={p.id} prop="inertia" label="Inertia" step={0.01} min={0} max={1} value={c()!.inertia} />
        <CNumber kind="physics" id={p.id} prop="strength" label="Strength" min={0} value={c()!.strength} />
        <CNumber kind="physics" id={p.id} prop="damping" label="Damping" step={0.1} min={0} value={c()!.damping} />
        <CNumber kind="physics" id={p.id} prop="mass" label="Mass" step={0.05} min={0.01} value={c()!.mass} />
        <CNumber kind="physics" id={p.id} prop="gravity" label="Gravity" value={c()!.gravity} />
        <CNumber kind="physics" id={p.id} prop="wind" label="Wind" value={c()!.wind} />
        <CNumber kind="physics" id={p.id} prop="mix" label="Mix" step={0.01} min={0} max={1} value={c()!.mix} />
        <CNumber kind="physics" id={p.id} prop="fps" label="Steps/s" min={1} max={480} value={c()!.fps} />
        <button class="danger" onClick={() => apply("deleteConstraint", { constraint: p.id }) !== undefined && setSelection(null)}>
          Delete
        </button>
      </Section>
    </Show>
  );
}

function ImageInspector(p: { id: string }) {
  const img = () => doc().images.find((i) => i.id === p.id);
  return (
    <Show when={img()}>
      <Section title="Image">
        <div class="image-preview">
          <Show when={imageFor(img()!)}>{(el) => <img src={el().src} alt={img()!.name} />}</Show>
        </div>
        <div class="hint">
          {img()!.name} · {img()!.width}×{img()!.height}
          {doc().atlas?.regions.some((r) => r.image === p.id) ? " · packed in atlas" : ""}
        </div>
        <button class="danger" onClick={() => apply("deleteImage", { image: p.id }) !== undefined && setSelection(null)}>
          Delete image
        </button>
      </Section>
    </Show>
  );
}

/**
 * Background: a checkbox turns it on (off = transparent, the default), then a colour and its opacity in percent.
 */
function BackgroundField() {
  const bg = () => doc().background;
  const on = () => bg() !== null;
  const color = () => (bg() ?? lastBackground()).slice(0, 7);
  const opacity = () => {
    const v = bg() ?? lastBackground();
    return v.length >= 9 ? Math.round((parseInt(v.slice(7, 9), 16) / 255) * 100) : 100;
  };
  const hexA = (pct: number) => (pct >= 100 ? "" : Math.round((pct / 100) * 255).toString(16).padStart(2, "0"));
  return (
    <div class="field bg-field" title="Off: no background, so the artboard shows a checkerboard and the player and exports are transparent. Also the BG button above the viewport.">
      <span>Background</span>
      <input type="checkbox" aria-label="Background on" checked={on()} onChange={(e) => setBackground(e.currentTarget.checked ? lastBackground() : null)} />
      <Show when={on()} fallback={<span class="muted small">transparent</span>}>
        <input type="color" aria-label="Background colour" value={color()} onChange={(e) => setBackground(e.currentTarget.value + hexA(opacity()))} />
        <input
          type="number"
          class="alpha"
          aria-label="Background opacity (percent)"
          title="Opacity (%): below 100 the artboard shows through, like the checkerboard"
          min={0}
          max={100}
          step={5}
          value={opacity()}
          onChange={(e) => setBackground(color() + hexA(Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0))))}
        />
        <span class="unit">%</span>
      </Show>
    </div>
  );
}

function DocumentInspector() {
  const d = () => doc();
  return (
    <Section title="Document">
      <TextField label="Name" value={d().name} onCommit={(v) => apply("setDocument", { name: v })} />
      <NumberField label="Width" value={d().width} onCommit={(v) => apply("setDocument", { width: v })} />
      <NumberField label="Height" value={d().height} onCommit={(v) => apply("setDocument", { height: v })} />
      <NumberField label="Origin X" value={d().originX} onCommit={(v) => apply("setDocument", { originX: v })} />
      <NumberField label="Origin Y" value={d().originY} onCommit={(v) => apply("setDocument", { originY: v })} />
      <BackgroundField />
      <NumberField label="FPS" value={d().fps} onCommit={(v) => apply("setDocument", { fps: v })} />
      <div class="hint">
        Select a bone or slot to edit it. Tools: V rotate · T translate · S scale · B create bone. Drop images on the viewport. Ctrl+Z undo.
      </div>
    </Section>
  );
}

export function Inspector() {
  return (
    <div class="panel inspector">
      <Switch fallback={<DocumentInspector />}>
        <Match when={selection()?.kind === "bone" && selection()}>{(s) => <BoneInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "slot" && selection()}>
          {(s) => <SlotInspector id={s().id} attachment={(s() as { attachment?: string }).attachment} />}
        </Match>
        <Match when={selection()?.kind === "ik" && selection()}>{(s) => <IkInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "transform" && selection()}>{(s) => <TransformInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "path" && selection()}>{(s) => <PathInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "physics" && selection()}>{(s) => <PhysicsInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "slider" && selection()}>{(s) => <SliderInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "image" && selection()}>{(s) => <ImageInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "sound" && selection()}>{(s) => <SoundInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "bus" && selection()}>{(s) => <BusInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "audio" && selection()}>{(s) => <AudioAssetInspector id={s().id} />}</Match>
      </Switch>
      <Show when={bindingTarget()}>
        {(t) => (
          <Section title="Bindings">
            <div class="hint">Number inputs that drive this {t().target} every frame, after animations.</div>
            <BindingList target={t().target} object={t().id} />
          </Section>
        )}
      </Show>
    </div>
  );
}

/** The selected bone, slot or constraint, when it can be driven by an input binding. */
function bindingTarget(): { target: BindingTarget; id: string } | null {
  const s = selection();
  if (!s || s.kind === "image") return null;
  const d = doc();
  const exists = s.kind === "bone" ? d.skeleton.bones : s.kind === "slot" ? d.skeleton.slots : (d.skeleton[s.kind as "ik"] ?? []);
  return exists.some((x) => x.id === s.id) ? { target: s.kind as BindingTarget, id: s.id } : null;
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** Text attachment: template, font and box. */
function TextAttachmentEditor(p: { att: () => Extract<Attachment, { type: "text" }>; set: (props: Record<string, unknown>) => void }) {
  const t = () => (doc(), p.att());
  const used = () => templateInputs(t().text);
  return (
    <>
      <label class="field">
        <span>Text</span>
        <textarea rows={2} value={t().text} onChange={(e) => p.set({ text: e.currentTarget.value })} />
      </label>
      <div class="hint">
        {"{name}"} shows an input; {"{name:0.00}"} formats numbers (#,##0 thousands, + sign, % percent, any other characters kept).
        <Show when={used().length}> Uses: {used().join(", ")}.</Show>
      </div>
      <TextField label="Font" value={t().font} placeholder="sans-serif" onCommit={(v) => p.set({ font: v || "sans-serif" })} />
      <NumberField label="Size" value={t().size} onCommit={(v) => p.set({ size: Math.max(1, v) })} />
      <SelectField label="Weight" value={String(t().weight)} options={WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))} onCommit={(v) => p.set({ weight: Number(v) })} />
      <SelectField label="Align" value={t().align} options={["left", "center", "right"].map((v) => ({ value: v, label: v }))} onCommit={(v) => p.set({ align: v })} />
      <ColorField label="Color" value={t().color} onCommit={(v) => p.set({ color: v })} />
      <ColorField label="Outline" value={t().outline ?? "#000000"} onCommit={(v) => p.set({ outline: v, outlineWidth: t().outlineWidth || 2 })} />
      <NumberField label="Outline W" value={t().outlineWidth ?? 0} onCommit={(v) => p.set({ outlineWidth: Math.max(0, v), outline: t().outline ?? "#000000" })} />
      <NumberField label="Box W" value={t().width} onCommit={(v) => p.set({ width: Math.max(1, v) })} />
      <NumberField label="Box H" value={t().height} onCommit={(v) => p.set({ height: Math.max(1, v) })} />
      <button title="Size the box (alignment frame and hit area) to the text, estimated" onClick={() => p.set(estimateTextBox(t().text, t().size))}>
        Fit box to text
      </button>
    </>
  );
}

/** Clipping mask: which slots it clips, and its outline (regenerated as a rect or ellipse). */
function ClippingEditor(p: { slotId: string; att: ClippingAttachment; set: (props: Record<string, unknown>) => void }) {
  const att = () => (doc(), p.att);
  const slots = () => doc().skeleton.slots;
  const after = () => slots().slice(slots().findIndex((s) => s.id === p.slotId) + 1);
  const clippedCount = () => {
    const list = after();
    const end = att().end;
    const i = end ? list.findIndex((s) => s.id === end) : -1;
    return i >= 0 ? i + 1 : list.length;
  };
  // Outline parameters are seeded from the current polygon's bounds.
  const bounds = () => {
    const v = att().vertices;
    const xs = v.filter((_, i) => i % 2 === 0);
    const ys = v.filter((_, i) => i % 2 === 1);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: x1 - x0, height: y1 - y0 };
  };
  /** What the outline looks like: a (rounded) rect or ellipse made by this panel, or a custom polygon. */
  const kind = (): { shape: "rect" | "ellipse" | "custom"; radius: number } => {
    const v = att().vertices;
    const b = bounds();
    const top = v.filter((_, i) => i % 2 === 0).filter((_, k) => Math.abs(v[k * 2 + 1] - (b.y + b.height / 2)) < 1e-3);
    const n = v.length / 2;
    if (n === 4 && top.length === 2) return { shape: "rect", radius: 0 };
    if (top.length === 2 && n > 4 && n % 4 === 0) return { shape: "rect", radius: Math.max(0, Math.min(...top) - (b.x - b.width / 2)) };
    if (n === 32 && top.length === 1) return { shape: "ellipse", radius: 0 };
    return { shape: "custom", radius: 0 };
  };
  const regen = (o: Partial<{ x: number; y: number; width: number; height: number; radius: number; shape: "rect" | "ellipse" }>) => {
    const k = kind();
    const b = { ...bounds(), radius: k.radius, shape: k.shape === "custom" ? "rect" : k.shape, ...o };
    const vertices = shapeOutline({ type: "shape", name: "", shape: b.shape, x: b.x, y: b.y, rotation: 0, width: Math.max(1, b.width), height: Math.max(1, b.height), radius: b.radius, fill: "#000" }).map(
      (v) => Math.round(v * 1000) / 1000,
    );
    p.set({ vertices });
  };
  /** Move/resize: regenerate made shapes (keeps corner radius exact), scale/translate custom polygons. */
  const reshape = (o: Partial<{ x: number; y: number; width: number; height: number }>) => {
    if (kind().shape !== "custom") return regen(o);
    const b = bounds();
    const t = { ...b, ...o };
    const sx = b.width ? t.width / b.width : 1;
    const sy = b.height ? t.height / b.height : 1;
    p.set({ vertices: att().vertices.map((v, i) => Math.round((i % 2 === 0 ? t.x + (v - b.x) * sx : t.y + (v - b.y) * sy) * 1000) / 1000) });
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return (
    <>
      <div class="hint">
        Not drawn. Clips {clippedCount()} slot{clippedCount() === 1 ? "" : "s"} drawn after this one (draw order) to its outline.
      </div>
      <SelectField
        label="Clip until"
        value={att().end ?? ""}
        options={[{ value: "", label: "every slot after it" }, ...after().map((s) => ({ value: s.id, label: s.name }))]}
        onCommit={(v) => p.set({ end: v || null })}
      />
      <SelectField
        label="Outline"
        value={kind().shape}
        options={[{ value: "rect", label: "rectangle" }, { value: "ellipse", label: "ellipse" }, ...(kind().shape === "custom" ? [{ value: "custom" as const, label: "custom polygon" }] : [])]}
        onCommit={(v) => v !== "custom" && regen({ shape: v, radius: v === "rect" ? kind().radius : 0 })}
      />
      <NumberField label="X" value={r2(bounds().x)} onCommit={(v) => reshape({ x: v })} />
      <NumberField label="Y" value={r2(bounds().y)} onCommit={(v) => reshape({ y: v })} />
      <NumberField label="Width" value={r2(bounds().width)} onCommit={(v) => reshape({ width: v })} />
      <NumberField label="Height" value={r2(bounds().height)} onCommit={(v) => reshape({ height: v })} />
      <Show when={kind().shape === "rect"}>
        <NumberField label="Radius" value={r2(kind().radius)} onCommit={(v) => regen({ radius: Math.max(0, v) })} />
      </Show>
    </>
  );
}
