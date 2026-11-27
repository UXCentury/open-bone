/** A synthetic side-view figure and the landmarks a body tracker would report for it (tests only). */
import type { PoseTrack } from "@openbone/core";

export const W = 640;
export const H = 480;
export const D = Math.PI / 180;
/** Angles (degrees, y up, counter-clockwise) of a side-view stick figure at time t, and where its hips are (pixels). */
export function figure(t: number) {
  return {
    hips: [320 + 60 * t, 260 + 10 * Math.sin(t * 6)] as [number, number],
    spine: 90 + 8 * Math.sin(t * 3),
    neck: 95,
    leftUpperArm: -90 + 70 * Math.sin(t * 4),
    leftForearm: -90 + 70 * Math.sin(t * 4) + 30 + 20 * Math.sin(t * 5),
    leftHand: -60,
    rightUpperArm: -90 - 50 * Math.sin(t * 4),
    rightForearm: -70,
    rightHand: -80,
    leftThigh: -90 + 30 * Math.sin(t * 4),
    leftShin: -90 + 10 * Math.sin(t * 4),
    rightThigh: -90 - 30 * Math.sin(t * 4),
    rightShin: -100,
  };
}

/** Landmarks of the figure, as the tracker reports them (fractions of the frame, y down). */
export function poseTrack(seconds: number, fps = 30, hide: number[] = []): PoseTrack {
  const frames = [];
  for (let i = 0; i <= seconds * fps; i++) {
    const t = i / fps;
    const f = figure(t);
    const pts: ([number, number, number] | null)[] = new Array(33).fill(null);
    const set = (i: number, p: [number, number]) => (pts[i] = [p[0] / W, -p[1] / H, hide.includes(i) ? 0.1 : 0.99]);
    const go = (p: [number, number], deg: number, len: number): [number, number] => [p[0] + Math.cos(deg * D) * len, p[1] + Math.sin(deg * D) * len];
    const hipsUp: [number, number] = [f.hips[0], -f.hips[1]];
    const shoulder = go(hipsUp, f.spine, 120);
    const ear = go(shoulder, f.neck, 50);
    for (const side of ["left", "right"] as const) {
      const o = side === "left" ? 0 : 1;
      set(11 + o, shoulder);
      const elbow = go(shoulder, f[`${side}UpperArm`], 70);
      set(13 + o, elbow);
      const wrist = go(elbow, f[`${side}Forearm`], 65);
      set(15 + o, wrist);
      set(19 + o, go(wrist, f[`${side}Hand`], 20));
      set(23 + o, hipsUp);
      const knee = go(hipsUp, f[`${side}Thigh`], 90);
      set(25 + o, knee);
      const ankle = go(knee, f[`${side}Shin`], 95);
      set(27 + o, ankle);
      set(29 + o, go(ankle, 180, 10));
      set(31 + o, go(ankle, 0, 25));
      set(7 + o, ear);
    }
    set(0, go(ear, 10, 15));
    frames.push({ time: t, points: pts });
  }
  return { width: W, height: H, fps, frames };
}

