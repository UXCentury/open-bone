import { type OpenBoneGameObject, OpenBonePlugin } from "@openbone/phaser";
import * as Phaser from "phaser";
import { SRC, STATE_MACHINE, bindControls, stage } from "../shared.ts";

class KnightScene extends Phaser.Scene {
  declare openbone: OpenBonePlugin;
  knight!: OpenBoneGameObject;
  preload() {
    this.load.openbone("doc", SRC);
  }
  create() {
    // Place the skeleton origin where the artboard puts it, and zoom the camera to fit the artboard.
    const doc = this.openbone.get("doc")!.doc;
    this.knight = this.add.openbone(doc.originX, doc.originY, "doc", { stateMachine: STATE_MACHINE });
    const cam = this.cameras.main;
    cam.setZoom(Math.min(this.scale.width / doc.width, this.scale.height / doc.height));
    cam.centerOn(doc.width / 2, doc.height / 2);
    bindControls(this.knight, (log) => this.knight.onOpenBone("event", (e) => log(e.name)));
    Object.assign(window, { game: this.game, knight: this.knight });
  }
}

new Phaser.Game({
  type: new URLSearchParams(location.search).has("canvas") ? Phaser.CANVAS : Phaser.WEBGL,
  parent: stage(),
  width: 900,
  height: 600,
  transparent: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  plugins: { scene: [{ key: "OpenBonePlugin", plugin: OpenBonePlugin, mapping: "openbone" }] },
  scene: KnightScene,
});
