import { OpenBoneObject3D } from "@openbone/three";
import * as THREE from "three";
import { SRC, STATE_MACHINE, bindControls, stage } from "../shared.ts";

const el = stage();
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true }); // stencil: clipping masks
renderer.setPixelRatio(devicePixelRatio);
el.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1.5, 1, 5000);

const knight = await OpenBoneObject3D.from(SRC, { stateMachine: STATE_MACHINE });
// Centre the 900 × 600 artboard on the origin; the knight is a flat card in 3D, tilted by the mouse below.
const a = knight.artboard;
knight.position.set(-(a.x + a.width / 2), -(a.y + a.height / 2), 0);
const card = new THREE.Group();
card.add(knight);
scene.add(card);
camera.position.set(0, 0, 1000);
knight.bindPointer(renderer.domElement, camera);

const resize = () => {
  const w = el.clientWidth;
  const h = el.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Fit the artboard at z = 0.
  const fitH = Math.max(a.height, a.width / camera.aspect) * 1.02;
  camera.position.z = fitH / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(el);
resize();

let tilt = 0;
el.addEventListener("pointermove", (e) => (tilt = ((e.offsetX / el.clientWidth) - 0.5) * 0.3));
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  card.rotation.y += (tilt - card.rotation.y) * 0.05;
  knight.update(Math.min(0.1, clock.getDelta()));
  renderer.render(scene, camera);
});

bindControls(knight, (log) => knight.onOpenBone("event", (e) => log(e.name)));
Object.assign(window, { knight, renderer, scene, camera });
