import { animationDuration } from "@openbone/core";
import { bakeConstraints } from "@openbone/runtime";
import { askForm } from "./dialogs.tsx";
import { activeSkin, apply, doc, toast, transaction } from "./state.ts";

/**
 * Bake constraints into keys ("key constrained"): asks for the range, sample rate and key tolerance, then writes the
 * bones' after-constraint local values as keys and (optionally) keys the constraints' mixes off. One undo step.
 */
export async function bakeConstraintsAsk(animationId: string, selectedBone?: string | null) {
  const anim = doc().animations.find((a) => a.id === animationId);
  if (!anim) return;
  const sk = doc().skeleton;
  if (!sk.ik.length && !sk.transform.length && !sk.path.length && !sk.physics.length)
    return toast("This skeleton has no IK, transform, path or physics constraints to bake", "error");
  const duration = animationDuration(anim);
  const boneName = selectedBone ? sk.bones.find((b) => b.id === selectedBone)?.name : undefined;
  const num = (min: number) => (v: string) => (Number.isFinite(Number(v)) && Number(v) >= min ? null : `A number ≥ ${min}`);
  const r = await askForm({
    title: `Bake constraints into “${anim.name}”`,
    message:
      "Keys the bones as they are after IK, transform, path and physics constraints, so the motion stays with the constraints off or can be edited by hand.",
    fields: [
      {
        key: "bones",
        label: "Bones",
        type: "choice",
        value: "all",
        options: [
          { value: "all", label: "Every constrained bone" },
          ...(boneName ? [{ value: "selected", label: `Only “${boneName}”` }] : []),
        ],
      },
      { key: "start", label: "From (s)", type: "text", value: "0", validate: num(0) },
      { key: "end", label: "To (s)", type: "text", value: String(Math.round(duration * 1000) / 1000), validate: num(0) },
      { key: "fps", label: "Keys per second", type: "text", value: "30", validate: num(1) },
      { key: "tolerance", label: "Simplify (0 = every frame)", type: "text", value: "0.01", validate: num(0) },
      {
        key: "disable",
        label: "Constraints",
        type: "choice",
        value: "off",
        options: [
          { value: "off", label: "Key them off", description: "Mix 0 over the range, so the motion isn't applied twice" },
          { value: "keep", label: "Leave them on" },
        ],
      },
    ],
    confirmLabel: "Bake",
  });
  if (!r) return;
  try {
    const res = bakeConstraints(doc(), {
      animation: anim.id,
      bones: r.bones === "selected" && selectedBone ? [selectedBone] : undefined,
      start: Number(r.start),
      end: Number(r.end),
      fps: Number(r.fps),
      tolerance: Number(r.tolerance),
      disableConstraints: r.disable === "off",
      skin: activeSkin()?.id,
    });
    if (!res.ops.length) return toast("Nothing to bake: the constrained bones never leave their setup pose");
    transaction("Bake constraints", () => {
      for (const op of res.ops) apply("setKeys", { ...op });
    });
    const keys = res.ops.filter((o) => o.target === "bone").reduce((n, o) => n + o.keys.length, 0);
    toast(`Baked ${res.bones.length} bone${res.bones.length === 1 ? "" : "s"} (${keys} keys)${res.constraints.length ? `; keyed off ${res.constraints.join(", ")}` : ""}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
