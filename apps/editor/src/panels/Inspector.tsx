import { type Attachment, type BoneProperty, CONSTRAINT_PROPERTIES, defaultSkin, descendantIds, getAttachment } from "@openbone/core";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { commitBone, keyBoneProperty, keyConstraint, keySlot } from "../edit.ts";
import { imageFor } from "../images.ts";
import { apply, currentAnimation, doc, mode, selection, setSelection, store, time, transaction } from "../state.ts";
import { ColorField, NumberField, Section, SelectField, TextField } from "./fields.tsx";

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
            <option value="">choose bone…</option>
            <For each={doc().skeleton.bones.filter((b) => b.id !== p.id)}>{(b) => <option value={b.id}>{b.name}</option>}</For>
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

function AnimateHint() {
  return (
    <Show when={mode() === "animate"}>
      <div class="hint">Animate mode: ◆ fields set keys at {time().toFixed(2)}s. Values shown are setup values.</div>
    </Show>
  );
}

function BindBones(p: { slotId: string; attachment: string }) {
  const [weightBones, setWeightBones] = createSignal<string[]>([]);
  return (
    <>
      <div class="field col">
        <span>Bind to bones</span>
        <select multiple size={5} onChange={(e) => setWeightBones(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}>
          <For each={doc().skeleton.bones}>{(b) => <option value={b.id}>{b.name}</option>}</For>
        </select>
      </div>
      <button disabled={weightBones().length === 0} onClick={() => apply("autoWeights", { slot: p.slotId, attachment: p.attachment, bones: weightBones(), maxInfluences: 2 })}>
        Auto weights
      </button>
    </>
  );
}

function PathAttachmentEditor(p: { slotId: string; att: Extract<Attachment, { type: "path" }> }) {
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, props });
  const [chain, setChain] = createSignal<string[]>([]);
  const slotBone = () => doc().skeleton.slots.find((s) => s.id === p.slotId)?.bone;
  return (
    <>
      <div class="hint">
        {p.att.vertices.length / 6} knots · {p.att.weights ? "weighted (bend it by moving its bones)" : "unweighted (follows slot bone)"}. Edit knots via MCP/JSON (`vertices`).
      </div>
      <Check label="Closed" checked={p.att.closed} onChange={(v) => set({ closed: v })} />
      <ColorField label="Color" value={p.att.color} onCommit={(v) => set({ color: v })} />
      <BindBones slotId={p.slotId} attachment={p.att.name} />
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

function AttachmentEditor(p: { slotId: string; att: Attachment }) {
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, props });
  return (
    <Section title={`Attachment · ${p.att.type}`}>
      <TextField label="Name" value={p.att.name} onCommit={(v) => set({ name: v })} />
      <Switch>
        <Match when={p.att.type === "region" || p.att.type === "shape" || p.att.type === "point"}>
          <NumberField label="X" value={(p.att as { x: number }).x} onCommit={(v) => set({ x: v })} />
          <NumberField label="Y" value={(p.att as { y: number }).y} onCommit={(v) => set({ y: v })} />
          <NumberField label="Rotation" value={(p.att as { rotation: number }).rotation} onCommit={(v) => set({ rotation: v })} />
        </Match>
      </Switch>
      <Switch>
        <Match when={p.att.type === "region" && p.att}>
          {(a) => {
            const r = a() as Extract<Attachment, { type: "region" }>;
            return (
              <>
                <NumberField label="Width" value={r.width} onCommit={(v) => set({ width: v })} />
                <NumberField label="Height" value={r.height} onCommit={(v) => set({ height: v })} />
                <NumberField label="Scale X" step={0.01} value={r.scaleX} onCommit={(v) => set({ scaleX: v })} />
                <NumberField label="Scale Y" step={0.01} value={r.scaleY} onCommit={(v) => set({ scaleY: v })} />
                <ColorField label="Tint" value={r.color} onCommit={(v) => set({ color: v })} />
                <button
                  title="Replace with a deformable grid mesh using the same image"
                  onClick={() =>
                    transaction("convert to mesh", () => {
                      store.apply("deleteAttachment", { slot: p.slotId, attachment: r.name });
                      store.apply("addMesh", { slot: p.slotId, name: r.name, image: r.image, x: r.x, y: r.y, width: r.width * r.scaleX, height: r.height * r.scaleY, cols: 4, rows: 4 });
                    })
                  }
                >
                  Convert to mesh (4×4)
                </button>
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "shape" && p.att}>
          {(a) => {
            const s = a() as Extract<Attachment, { type: "shape" }>;
            return (
              <>
                <SelectField label="Shape" value={s.shape} options={["rect", "ellipse", "polygon"].map((v) => ({ value: v, label: v }))} onCommit={(v) => set({ shape: v })} />
                <NumberField label="Width" value={s.width} onCommit={(v) => set({ width: v })} />
                <NumberField label="Height" value={s.height} onCommit={(v) => set({ height: v })} />
                <Show when={s.shape === "rect"}>
                  <NumberField label="Radius" value={s.radius} onCommit={(v) => set({ radius: v })} />
                </Show>
                <ColorField label="Fill" value={s.fill} onCommit={(v) => set({ fill: v })} />
                <ColorField label="Stroke" value={s.stroke ?? "#000000"} onCommit={(v) => set({ stroke: v, strokeWidth: s.strokeWidth || 2 })} />
                <NumberField label="Stroke W" value={s.strokeWidth ?? 0} onCommit={(v) => set({ strokeWidth: v })} />
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "mesh" && p.att}>
          {(a) => {
            const m = a() as Extract<Attachment, { type: "mesh" }>;
            return (
              <>
                <div class="hint">
                  {m.vertices.length / 2} vertices · {m.triangles.length / 3} triangles · {m.weights ? "weighted" : "unweighted (follows slot bone)"}
                </div>
                <BindBones slotId={p.slotId} attachment={m.name} />
              </>
            );
          }}
        </Match>
        <Match when={p.att.type === "path" && p.att}>
          {(a) => <PathAttachmentEditor slotId={p.slotId} att={a() as Extract<Attachment, { type: "path" }>} />}
        </Match>
        <Match when={p.att.type === "boundingBox"}>
          <div class="hint">Hit area for state-machine listeners. Edit vertices via MCP/JSON for now.</div>
        </Match>
      </Switch>
      <button class="danger" onClick={() => apply("deleteAttachment", { slot: p.slotId, attachment: p.att.name })}>
        Delete attachment
      </button>
    </Section>
  );
}

function SlotInspector(p: { id: string; attachment?: string }) {
  const slot = () => doc().skeleton.slots.find((s) => s.id === p.id);
  const atts = () => Object.keys(defaultSkin(doc()).attachments[p.id] ?? {});
  const att = () => getAttachment(doc(), p.id, p.attachment ?? slot()?.attachment ?? null);
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
        <div class="btn-row">
          <button title="Move back in draw order" onClick={() => apply("updateSlot", { slot: p.id, index: Math.max(0, index() - 1) })}>
            ↓ Back
          </button>
          <button title="Move forward in draw order" onClick={() => apply("updateSlot", { slot: p.id, index: index() + 1 })}>
            ↑ Front
          </button>
          <button class="danger" onClick={() => apply("deleteSlot", { slot: p.id }) !== undefined && setSelection(null)}>
            Delete
          </button>
        </div>
        <div class="btn-row">
          <button onClick={() => apply("addShape", { slot: p.id, name: `shape${atts().length + 1}`, shape: "ellipse", width: 50, height: 50, fill: "#ff9f43" })}>+ Shape</button>
          <button onClick={() => apply("addBoundingBox", { slot: p.id, width: 100, height: 100 })}>+ Hit box</button>
          <button onClick={() => apply("addPoint", { slot: p.id })}>+ Point</button>
          <button title="Bezier path for path constraints" onClick={() => apply("addPath", { slot: p.id, name: `path${atts().length + 1}`, anchors: [0, 0, 80, 40, 160, 0] })}>
            + Path
          </button>
        </div>
      </Section>
      <Show when={att()}>{(a) => <AttachmentEditor slotId={p.id} att={a()} />}</Show>
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
        <Check label="Bend +" checked={c()!.bendPositive} onChange={(v) => set({ bendPositive: v })} />
        <Check label="Stretch" title="Scale bones up to reach a far target" checked={c()!.stretch} onChange={(v) => set({ stretch: v })} />
        <Show when={c()!.bones.length === 1}>
          <Check label="Compress" title="Scale the bone down when the target is closer than its length" checked={c()!.compress} onChange={(v) => set({ compress: v })} />
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
        </div>
        <button class="danger" onClick={() => apply("deleteImage", { image: p.id }) !== undefined && setSelection(null)}>
          Delete image
        </button>
      </Section>
    </Show>
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
      <ColorField label="Background" value={d().background ?? "#ffffff"} onCommit={(v) => apply("setDocument", { background: v })} />
      <NumberField label="FPS" value={d().fps} onCommit={(v) => apply("setDocument", { fps: v })} />
      <div class="hint">
        Select a bone or slot to edit it. Tools: V rotate · T translate · S scale · B create bone. Drop images on the viewport. Ctrl+Z undo.
      </div>
    </Section>
  );
}

export function Inspector() {
  return (
    <aside class="panel right">
      <Switch fallback={<DocumentInspector />}>
        <Match when={selection()?.kind === "bone" && selection()}>{(s) => <BoneInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "slot" && selection()}>
          {(s) => <SlotInspector id={s().id} attachment={(s() as { attachment?: string }).attachment} />}
        </Match>
        <Match when={selection()?.kind === "ik" && selection()}>{(s) => <IkInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "transform" && selection()}>{(s) => <TransformInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "path" && selection()}>{(s) => <PathInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "physics" && selection()}>{(s) => <PhysicsInspector id={s().id} />}</Match>
        <Match when={selection()?.kind === "image" && selection()}>{(s) => <ImageInspector id={s().id} />}</Match>
      </Switch>
    </aside>
  );
}
