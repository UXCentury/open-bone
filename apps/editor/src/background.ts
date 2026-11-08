import { apply, doc } from "./state.ts";

/**
 * Document background on/off. Turning it off makes the artboard transparent (the editor shows a checkerboard; the
 * player and exports show whatever is behind them). The last colour is remembered per project, so turning it back
 * on restores it.
 */
const remembered = new Map<string, string>();

export const lastBackground = (): string => remembered.get(doc().name) ?? "#ffffff";

export function setBackground(color: string | null) {
  const cur = doc().background;
  if (cur) remembered.set(doc().name, cur);
  if (color) remembered.set(doc().name, color);
  apply("setDocument", { background: color });
}

export const toggleBackground = () => setBackground(doc().background ? null : lastBackground());
