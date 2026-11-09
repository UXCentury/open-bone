/**
 * Weight-table helpers shared by the editor's weight tools and the weight ops. A vertex's influences are a
 * bone id → weight map that sums to 1. "Locked" bones (like Spine's weight locks) keep their weight exactly;
 * every change is shared out among the unlocked bones only.
 */
export type Influences = Map<string, number>;

const EPS = 1e-6;

function lockedSum(m: Influences, locked: ReadonlySet<string>): number {
  let s = 0;
  for (const [b, w] of m) if (locked.has(b)) s += w;
  return s;
}

/** Drop tiny unlocked influences and rescale the unlocked ones so the vertex sums to 1 again. */
export function renormalizeAround(m: Influences, locked: ReadonlySet<string> = new Set(), min = 1e-4): void {
  for (const [b, w] of m) if (!locked.has(b) && w < min) m.delete(b);
  const fixed = lockedSum(m, locked);
  let free = 0;
  for (const [b, w] of m) if (!locked.has(b)) free += w;
  const room = Math.max(0, 1 - fixed);
  if (free > EPS) {
    for (const [b, w] of m) if (!locked.has(b)) m.set(b, (w / free) * room);
  } else if (fixed > EPS && Math.abs(fixed - 1) > EPS) {
    // Only locked bones are left: nothing else can take up the difference, so scale them to stay valid.
    for (const [b, w] of m) m.set(b, w / fixed);
  }
}

/**
 * Set `bone` to `value` (0..1) on one vertex. Locked bones keep their weight; the other unlocked bones share what is
 * left in their current proportions. Returns false (and leaves the vertex alone) when nothing can change: the bone is
 * locked, or it is the only unlocked influence so nothing could take up the difference.
 */
export function setInfluence(m: Influences, bone: string, value: number, locked: ReadonlySet<string> = new Set()): boolean {
  if (locked.has(bone)) return false;
  const room = Math.max(0, 1 - lockedSum(m, locked));
  const target = Math.min(room, Math.max(0, value));
  const old = m.get(bone) ?? 0;
  if (Math.abs(target - old) < EPS) return false;
  let others = 0;
  for (const [b, w] of m) if (b !== bone && !locked.has(b)) others += w;
  // Lowering the only unlocked bone: no unlocked bone can take the weight it gives up.
  if (others <= EPS && target < room - EPS) return false;
  const k = others > EPS ? (room - target) / others : 0;
  for (const [b, w] of m) if (b !== bone && !locked.has(b)) m.set(b, w * k);
  m.set(bone, target);
  renormalizeAround(m, locked);
  return true;
}

/** Swap two bones' weights on one vertex. Returns false when neither bone influences it. */
export function swapInfluence(m: Influences, a: string, b: string): boolean {
  if (a === b) return false;
  const wa = m.get(a) ?? 0;
  const wb = m.get(b) ?? 0;
  if (wa <= 0 && wb <= 0) return false;
  m.delete(a);
  m.delete(b);
  if (wb > 0) m.set(a, wb);
  if (wa > 0) m.set(b, wa);
  return true;
}

/**
 * Put locked bones back to their weights in `before` after some tool changed `m` freely (smooth, auto, prune):
 * locked weights are restored and the unlocked ones are rescaled into the rest.
 */
export function restoreLocked(m: Influences, before: Influences, locked: ReadonlySet<string>): void {
  if (!locked.size) return;
  for (const b of locked) {
    const w = before.get(b);
    if (w) m.set(b, w);
    else m.delete(b);
  }
  let free = 0;
  for (const [b, w] of m) if (!locked.has(b)) free += w;
  if (free <= EPS && lockedSum(m, locked) < 1 - EPS) {
    // Nothing unlocked is left to fill the gap: keep the vertex as it was.
    m.clear();
    for (const [b, w] of before) m.set(b, w);
    return;
  }
  renormalizeAround(m, locked);
}
