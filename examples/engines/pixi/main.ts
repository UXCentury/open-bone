import { OpenBone } from "@openbone/pixi";
import { Application } from "pixi.js";
import { SRC, STATE_MACHINE, bindControls, stage } from "../shared.ts";

const el = stage();
const app = new Application();
await app.init({ preference: "webgl", backgroundAlpha: 0, antialias: true, resizeTo: el, resolution: devicePixelRatio, autoDensity: true });
el.appendChild(app.canvas);

const knight = await OpenBone.from(SRC, { stateMachine: STATE_MACHINE });
app.stage.addChild(knight);

// Fit the 900 × 600 artboard into the stage.
const fit = () => {
  const a = knight.artboard;
  const s = Math.min(app.screen.width / a.width, app.screen.height / a.height);
  knight.scale.set(s);
  knight.position.set((app.screen.width - a.width * s) / 2 - a.x * s, (app.screen.height - a.height * s) / 2 - a.y * s);
};
fit();
app.renderer.on("resize", fit);

bindControls(knight, (log) => knight.onOpenBone("event", (e) => log(e.name)));
Object.assign(window, { app, knight });
