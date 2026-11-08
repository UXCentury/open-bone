import { type Attachment, type BoneProperty, type SkinData, attachmentOwner, getAttachment, slotAttachments } from "@openbone/core";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { commitBone, keyBoneProperty, keySlot } from "../edit.ts";
import { imageFor } from "../images.ts";
import { activeSkin, apply, currentAnimation, doc, mode, selection, setSelection, skinArg, store, time, transaction } from "../state.ts";
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
          <span>IK target</span>
          <select value={ikTarget()} onChange={(e) => setIkTarget(e.currentTarget.value)}>
            <option value="">choose bone…</option>
            <For each={doc().skeleton.bones.filter((b) => b.id !== p.id)}>{(b) => <option value={b.id}>{b.name}</option>}</For>
          </select>
        </div>
        <div class="btn-row">
          <button disabled={!ikTarget()} onClick={() => apply("addIkConstraint", { bones: [p.id], target: ikTarget() })}>
            1-bone IK
          </button>
          <button
            disabled={!ikTarget() || !bone()!.parent}
            title="Uses this bone and its parent"
            onClick={() => apply("addIkConstraint", { bones: [bone()!.parent!, p.id], target: ikTarget() })}
          >
            2-bone IK (with parent)
          </button>
        </div>
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
  const copy = (move: boolean) => {
    const to = targetSkin();
    if (!to) return;
    if (to.attachments[p.slotId]?.[p.att.name] && !confirm(`“${to.name}” already has “${p.att.name}” on this slot. Replace it?`)) return;
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

function AttachmentEditor(p: { slotId: string; att: Attachment; owner: SkinData }) {
  const set = (props: Record<string, unknown>) => apply("updateAttachment", { slot: p.slotId, attachment: p.att.name, skin: p.owner.id, props });
  const [weightBones, setWeightBones] = createSignal<string[]>([]);
  return (
    <Section title={`Attachment · ${p.att.type}`}>
      <TextField label="Name" value={p.att.name} onCommit={(v) => set({ name: v })} />
      <SkinControls slotId={p.slotId} att={p.att} owner={p.owner} />
      <Switch>
        <Match when={p.att.type === "region" || p.att.type === "shape" || p.att.type === "point"}>
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
                <ColorField label="Tint" value={r().color} onCommit={(v) => set({ color: v })} />
                <button
                  title="Replace with a deformable grid mesh using the same image"
                  onClick={() =>
                    transaction("convert to mesh", () => {
                      store.apply("deleteAttachment", { slot: p.slotId, attachment: r().name, skin: p.owner.id });
                      store.apply("addMesh", { slot: p.slotId, skin: p.owner.id, name: r().name, image: r().image, x: r().x, y: r().y, width: r().width * r().scaleX, height: r().height * r().scaleY, cols: 4, rows: 4 });
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
        <Match when={p.att.type === "mesh" && p.att}>
          {(_a) => {
            // Read through props so the fields follow selection changes and undo.
            const m = () => p.att as Extract<Attachment, { type: "mesh" }>;
            return (
              <>
                <div class="hint">
                  {m().vertices.length / 2} vertices · {m().triangles.length / 3} triangles · {m().weights ? "weighted" : "unweighted (follows slot bone)"}
                </div>
                <div class="field col">
                  <span>Bind to bones</span>
                  <select multiple size={5} onChange={(e) => setWeightBones(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))}>
                    <For each={doc().skeleton.bones}>{(b) => <option value={b.id}>{b.name}</option>}</For>
                  </select>
                </div>
                <button disabled={weightBones().length === 0} onClick={() => apply("autoWeights", { slot: p.slotId, attachment: m().name, skin: p.owner.id, bones: weightBones(), maxInfluences: 2 })}>
                  Auto weights
                </button>
              </>
            );
          }}
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
          <button onClick={() => apply("addShape", { slot: p.id, name: `shape${atts().length + 1}`, shape: "ellipse", width: 50, height: 50, fill: "#ff9f43", ...skinArg() })}>+ Shape</button>
          <button onClick={() => apply("addBoundingBox", { slot: p.id, width: 100, height: 100, ...skinArg() })}>+ Hit box</button>
          <button onClick={() => apply("addPoint", { slot: p.id, ...skinArg() })}>+ Point</button>
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
  return (
    <Show when={c()}>
      <Section title="IK constraint">
        <TextField label="Name" value={c()!.name} onCommit={(v) => apply("updateIkConstraint", { constraint: p.id, name: v })} />
        <div class="hint">
          {c()!.bones.map(name).join(" → ")} reach for <b>{name(c()!.target)}</b>. Move the target bone to pose the chain.
        </div>
        <SelectField label="Target" value={c()!.target} options={doc().skeleton.bones.map((b) => ({ value: b.id, label: b.name }))} onCommit={(v) => apply("updateIkConstraint", { constraint: p.id, target: v })} />
        <NumberField label="Mix" step={0.01} value={c()!.mix} onCommit={(v) => apply("updateIkConstraint", { constraint: p.id, mix: Math.max(0, Math.min(1, v)) })} />
        <label class="field">
          <span>Bend +</span>
          <input type="checkbox" checked={c()!.bendPositive} onChange={(e) => apply("updateIkConstraint", { constraint: p.id, bendPositive: e.currentTarget.checked })} />
        </label>
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
        <Match when={selection()?.kind === "image" && selection()}>{(s) => <ImageInspector id={s().id} />}</Match>
      </Switch>
    </aside>
  );
}
