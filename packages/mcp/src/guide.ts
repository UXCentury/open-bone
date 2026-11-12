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
   Art prep: process_image {input, out, ops:[...], importAs | replace} keys out flat backgrounds (keyColor), cuts an object
   out by comparing with a painted-out copy (differenceMatte), trims, crops, resizes, flips and feathers edges; its "box"
   says where the result sat in the input picture, so a layer cut from a full scene can be placed exactly where it was.
   Attachments are positioned in the slot BONE's local frame (x along the bone).
   Draw order = slot order (first is back). Use update_slot {index} to reorder.
4. Deformation: add_mesh {cols, rows} (or trace_mesh on a region) then auto_weights {bones:[...]} so the mesh bends with bones.
   trace_mesh on a mesh re-traces it in place and rebinds the same bones (tolerance 1–2 for detailed edges such as feet).
   set_weights_in_area {slot, attachment, area:{yMax:...} | polygon, influences, blend} pins every vertex in an area
   to bones (e.g. everything below the knees to the legs bone) without listing vertex indices.
5. Constraints (solved every frame in one list; default order IK, transform, path, physics — set_constraint_order
   {constraints:[every constraint, first applied first]} changes it, [] restores the default):
   add_ik_constraint {bones:["thigh","shin"], target:"foot-target"} (target must not be a child of the chain);
   optional softness (2-bone), stretch, compress (1-bone).
   add_transform_constraint {bones, target, mixRotate, mixTranslate, mixScale, mixShear, local?, relative?}.
   Path: add_path {slot, anchors:[x0,y0,x1,y1,...]} (smooth bezier in the slot bone's frame; bind it to control bones
   with auto_weights or set_weights so moving them bends it), then add_path_constraint {bones:[parent..child], target:slot,
   positionMode:"fixed"|"percent", spacingMode:"length"|"fixed"|"percent"|"proportional", rotateMode:"tangent"|"chain"|"chainScale"}.
   Physics: add_physics_constraint {bone, inertia, strength, damping, mass, gravity, wind, mix} per bone (parent first)
   for hair/cloth/tails. It simulates over time, so check it with render_gif rather than a single frame.
   Physics gravity/wind and IK softness scale with the skeleton's size relative to set_document {referenceScale} (default 100 %).
6. Animate: create_animation {name}, then set_keys with absolute values:
   set_keys {animation:"walk", target:"bone", id:"thigh", property:"rotation", keys:[{time:0,value:-20},{time:0.5,value:20,curve:"easeInOut"},{time:1,value:-20}]}
   Properties: bone rotation|x|y|scaleX|scaleY|shearX|shearY|inherit (stepped string: normal|onlyTranslation|noRotation|noScale), slot color ("#rrggbbaa") | dark (two-colour tint "#rrggbb") | attachment (name or null),
   ik mix|softness, transform mix|mixRotate|mixTranslate|mixScale|mixShear, path position|spacing|mixRotate|mixX|mixY,
   physics mix|inertia|strength|damping|mass|gravity|wind, deform offsets (mesh or path), sequence frame (with attachment), drawOrder. Curves: linear, stepped, easeIn, easeOut, easeInOut, backOut or [cx1,cy1,cx2,cy2].
   set_keys merges into the timeline; pass replace:true to set the whole timeline (e.g. when redoing a motion path).
   Loop cleanly by making the last key equal the first. add_event_key fires events (footsteps, sounds).
7. Interactivity (Rive-style): create_state_machine → add_input (bool/number/trigger) → add_state {animation}
   (first state = entry) → add_transition {from, to, conditions:[{input, op, value}], duration, exitTime}.
   Transition with no conditions waits for the source animation to finish (exitTime 1).
   from:"@any" fires from any state. blend1d states blend animations by a number input.
   Pointer: add_bounding_box on a slot, then add_listener {slot, event:"click"|"down"|"up"|"enter"|"exit"|"move", actions:[...]}.
   Staged flows: add_state {..., loop:false, onComplete:"next"} plays once then moves on (its own transitions can still interrupt).
   Live data: add_input {type:"string"} or number inputs; add_text {slot, text:"{multiplier:0.00}x", size, weight, color, outline}
   shows inputs (number patterns: 0.00, #,##0, +0, 0%); add_binding {input, target:"bone"|"slot"|"ik"|..., object, property,
   inMin, inMax, outMin, outMax} drives a property from a number input every frame (slot color takes hex outMin/outMax).
   simulate_state_machine / render_frame steps accept setInputs with strings too.
   Scripts: add_script {code} + attach_script. Script API (global ob): ob.input(n), ob.setInput(n,v), ob.fire(n),
   ob.emit(event,{int,float,string}), ob.bone(n), ob.setBone(n,{rotation,...}) (per-frame override), ob.slot(n,{color,attachment}),
   ob.pointer(), ob.time(), ob.log(...). Hooks: onStart(), onUpdate(dt), onEvent(e), onPointer(p), or named fns for runScript actions.
8. Particles: add_particles {slot, preset:"fire"|"smoke"|"sparks"|"confetti"|"exhaust"|"coins", ...overrides} emits from the
   slot bone (rotation = emission direction in the bone's frame, e.g. -90 for exhaust under an upright rocket bone; space
   "world" leaves trails). update_particles changes settings. Key it with set_keys {target:"particles", id:slot,
   property:"emitting" (true/false) | "rate"}. State machines: set_state_emitter {state, slot, emitting} and listener actions
   {type:"setEmitter", slot, emitting} / {type:"emitParticles", slot, count}. Seeded and deterministic; check with render_gif.
9. Skins (outfits): the first skin is the default skin, shared by all. add_skin {name}, then either pass skin:"<name>" to
   add_shape/add_region/... or copy_attachment {slot, attachment, toSkin} and update_attachment {..., skin} to override a
   default attachment under the same name. rename_skin, duplicate_skin, delete_skin manage them; render_frame {skin} previews one.
   Skin bones/constraints: add_to_skin {skin, bones?, constraints?} makes them skin-only (active only while a skin listing
   them is set; inactive bones and their children aren't posed and their slots aren't drawn); remove_from_skin undoes it.
10. Audio: import_audio {path} (or add_audio {name, src:data:/path, duration}) creates an asset and a same-named sound on the
   sfx bus. Play it with add_audio_key {animation, sound, time, volume?, rate?, loop?}, set_event_sound {event, sound} (plays
   whenever the event fires), set_state_sound {stateMachine, state, sound, on:"enter"|"exit", action:"play"|"stop"} or a
   listener action {type:"playSound", sound} / {type:"stopSound", sound, fade?}. Mute buttons: give a bool input the bus it
   mutes (add_input / update_input {mutes:"music"|"sfx"|... or "master" for everything}), then a listener {type:"setMute",
   bus:"music", muted:"toggle"} (or toggleInput on that input; not both) and a slot color binding to show the state. The
   app embedding the animation mutes it the same way (setInput("musicOff", true), or player.setBusMuted("music", true)).
   Looping sounds stop when their state or
   animation ends. Mix with update_sound {volume, rate, loop, fadeIn, fadeOut, bus}, add_bus/update_bus {volume, muted},
   set_audio_mix {master, muted}. simulate_state_machine lists the audio commands. A sound that should play whenever a
   trigger fires belongs on the state it enters (set_state_sound), not only on the button's listener: code and page
   buttons fire triggers without clicking the art (validate warns about this).
   Fonts: import_font {path} adds a TTF/OTF as a document font (family read from the file). Texts whose font list names
   that family ("Noto Serif JP, serif") use it everywhere (editor, renders, every runtime) instead of whatever is installed.
11. Sprite sequences (frame-by-frame, e.g. fire or explosions): add_image for each frame (or one sheet image), then
   add_sequence {slot, frames:["fire_0001","fire_0002",...], fps, mode:"loop"|"once"|"pingPong"|"holdLast", offset}
   or add_sequence {slot, grid:{image:"sheet", cols, rows}}. Bind input (a number input) to pick the frame from a state
   machine, or set_keys target:"sequence" {id:slot, attachment, property:"frame"}. set_sequence_frames replaces/reorders frames.
12. Check your work: render_frame (returns a PNG; bones are drawn as blue wedges) and simulate_state_machine (text log of
   state changes/events). render_gif for motion. get_summary for an outline, validate for problems.

Tips: keep bones' length meaningful (used by IK and auto weights). Use update_* tools to fix mistakes, undo to revert.
`;
