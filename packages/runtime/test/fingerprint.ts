import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { animationDuration, deserialize, type OpenBoneDocument } from "@openbone/core";

type Rt = { Skeleton: new (d: OpenBoneDocument) => any; applyAnimation: (sk: any, a: any, t: number) => void };

/**
 * Bone world matrices of a document over every animation (and the setup pose), at 30 fps with physics stepping,
 * rounded to 1e-3 and hashed. Used to check that rigs keep posing exactly as before.
 */
export function poseFingerprint(rt: Rt, doc: OpenBoneDocument): string {
  const out: number[] = [];
  for (const anim of [null, ...doc.animations]) {
    const sk = new rt.Skeleton(doc);
    const d = anim ? Math.min(animationDuration(anim), 3) : 0.5;
    for (let f = 0; f * (1 / 30) <= d + 1e-9; f++) {
      sk.update(1 / 30);
      sk.setToSetupPose();
      if (anim) rt.applyAnimation(sk, anim, f / 30);
      sk.updateWorldTransform();
      for (const b of sk.bones) for (const k of ["a", "b", "c", "d", "x", "y"]) out.push(Math.round(b.world[k] * 1000) / 1000 + 0);
    }
  }
  return createHash("sha1").update(out.join(",")).digest("hex");
}

export const exampleDocs = (): [string, OpenBoneDocument][] => {
  const dir = new URL("../../../examples/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".obone"))
    .sort()
    .map((f) => [f, deserialize(readFileSync(new URL(f, dir), "utf8"))]);
};
