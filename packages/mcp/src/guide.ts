export const GUIDE = `# OpenBone authoring guide (for agents)

Coordinate system: skeleton space is y-UP, rotations in degrees counter-clockwise. The skeleton origin (0,0)
sits at (originX, originY) pixels in the artboard (artboard pixels are y-down). Default artboard 800x600,
origin (400,450) — so y=0 is near the bottom, positive y goes up.

Everything can be referenced by **name or id**. Every edit tool validates its input and returns ids.

## Typical workflow
1. new_project {name, path} (autosaves to path) — or open_project.
2. Rig: add_bone (parent defaults to root; x/y/rotation are LOCAL to the parent). A bone points along its local +x.
   E.g. an upright torso: add_bone {name:"torso", y:100, rotation:90, length:120}.
   Children of a rotated parent use the parent's frame: a head on top of that torso is add_bone {name:"head", parent:"torso", x:120}.
3. Visuals: add_slot {bone} then add_shape (no art needed) or import_image + add_region / add_mesh.
   Attachments are positioned in the slot BONE's local frame (x along the bone).
   Draw order = slot order (first is back). Use update_slot {index} to reorder.
4. Deformation: add_mesh {cols, rows} then auto_weights {bones:[...]} so the mesh bends with bones.
5. Constraints: add_ik_constraint {bones:["thigh","shin"], target:"foot-target"} (target must not be a child of the chain).
6. Animate: create_animation {name}, then set_keys with absolute values:
   set_keys {animation:"walk", target:"bone", id:"thigh", property:"rotation", keys:[{time:0,value:-20},{time:0.5,value:20,curve:"easeInOut"},{time:1,value:-20}]}
   Properties: bone rotation|x|y|scaleX|scaleY|shearX|shearY, slot color ("#rrggbbaa") | attachment (name or null),
   ik/transform mix, deform offsets, drawOrder. Curves: linear, stepped, easeIn, easeOut, easeInOut, backOut or [cx1,cy1,cx2,cy2].
   Loop cleanly by making the last key equal the first. add_event_key fires events (footsteps, sounds).
7. Interactivity (Rive-style): create_state_machine → add_input (bool/number/trigger) → add_state {animation}
   (first state = entry) → add_transition {from, to, conditions:[{input, op, value}], duration, exitTime}.
   Transition with no conditions waits for the source animation to finish (exitTime 1).
   from:"@any" fires from any state. blend1d states blend animations by a number input.
   Pointer: add_bounding_box on a slot, then add_listener {slot, event:"click"|"down"|"up"|"enter"|"exit"|"move", actions:[...]}.
   Scripts: add_script {code} + attach_script. Script API (global ob): ob.input(n), ob.setInput(n,v), ob.fire(n),
   ob.emit(event,{int,float,string}), ob.bone(n), ob.setBone(n,{rotation,...}) (per-frame override), ob.slot(n,{color,attachment}),
   ob.pointer(), ob.time(), ob.log(...). Hooks: onStart(), onUpdate(dt), onEvent(e), onPointer(p), or named fns for runScript actions.
8. Check your work: render_frame (returns a PNG; bones are drawn as blue wedges) and simulate_state_machine (text log of
   state changes/events). render_gif for motion. get_summary for an outline, validate for problems.

Tips: keep bones' length meaningful (used by IK and auto weights). Use update_* tools to fix mistakes, undo to revert.
`;
