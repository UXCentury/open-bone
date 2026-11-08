/** Demo controls shared by the engine pages: the knight's state machine inputs and an event log. */
export interface Controls {
  setInput(name: string, value: boolean | number | string): void;
  fire(name: string): void;
}

const params = new URLSearchParams(location.search);
/** Which example to play: `?example=campfire` (default knight). */
export const EXAMPLE = params.get("example") ?? "knight";
export const SRC = `/examples/${EXAMPLE}.obone`;
/** The knight's state machine; other examples run their first one. */
export const STATE_MACHINE = EXAMPLE === "knight" ? "knight" : undefined;

export function bindControls(target: Controls, onEvent?: (cb: (name: string) => void) => void) {
  const walk = document.getElementById("walk") as HTMLInputElement;
  walk.onchange = () => target.setInput("walk", walk.checked);
  (document.getElementById("attack") as HTMLButtonElement).onclick = () => target.fire("attack");
  (document.getElementById("salute") as HTMLButtonElement).onclick = () => target.fire("salute");
  const log = document.getElementById("log")!;
  onEvent?.((name) => (log.textContent = `event: ${name}`));
}

export const stage = () => document.getElementById("stage") as HTMLDivElement;
