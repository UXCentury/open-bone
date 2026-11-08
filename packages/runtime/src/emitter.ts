// biome-ignore lint/suspicious/noExplicitAny: internal handler storage
type AnyFn = (...args: any[]) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  private map = new Map<keyof Events, Set<AnyFn>>();
  on<K extends keyof Events>(type: K, fn: (...args: Events[K]) => void): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof Events>(type: K, ...args: Events[K]) {
    const set = this.map.get(type);
    if (set) for (const fn of set) fn(...args);
  }
}
