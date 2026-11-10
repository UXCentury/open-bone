/**
 * OpenBone document model (.obone). Plain JSON, versioned.
 * Coordinate system: y-up skeleton space, rotations in degrees counter-clockwise.
 */
export type Id = string;
export type Hex = string; // "#rrggbb" or "#rrggbbaa"

export type InheritMode = "normal" | "onlyTranslation" | "noRotation" | "noScale";
export type BlendMode = "normal" | "additive" | "multiply" | "screen";

export interface BoneData {
  id: Id;
  name: string;
  parent: Id | null;
  length: number;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  inherit: InheritMode;
  color?: Hex;
}

export interface SlotData {
  id: Id;
  name: string;
  bone: Id;
  color: Hex;
  /** Name of the attachment shown in setup pose (looked up in the active skin, then the default skin). */
  attachment: string | null;
  blend: BlendMode;
  /**
   * Two-colour tint (Spine's "tint black"): the colour the image's dark parts become, as `#rrggbb`. The image's
   * colours are mapped from this dark colour to the slot's `color` (white keeps the image as is). Unset = black.
   */
  dark?: Hex;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
}

export interface ImageAsset {
  id: Id;
  name: string;
  /** data: URI, relative path, or URL. */
  src: string;
  width: number;
  height: number;
}

// ---------- Texture atlas ----------

/** One packed texture. Same shape as an ImageAsset so loaders can treat both alike. */
export interface AtlasPage {
  id: Id;
  name: string;
  /** data: URI, relative path, or URL of the page image. */
  src: string;
  width: number;
  height: number;
}

/**
 * Where an image lives inside an atlas page. `x, y, width, height` is the packed rectangle in page pixels
 * (y-down). It holds the part of the original image that starts at `offsetX, offsetY` (y-down, in original
 * image pixels); with no trimming the offsets are 0 and the size equals `originalWidth x originalHeight`.
 */
export interface AtlasRegion {
  image: Id;
  page: Id;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
  /** Stored turned 90° clockwise to pack tighter: on the page it covers height × width at (x, y). */
  rotated?: boolean;
  /**
   * The image is fully transparent ("ignore blank images"): it got no space of its own. The region points at a
   * shared 1×1 transparent block (originalWidth/Height 1), so any renderer samples nothing visible; runtimes may
   * skip drawing it altogether.
   */
  empty?: boolean;
  /**
   * Polygon packing: a convex outline (flat [x0,y0,x1,y1,...], original image pixels like the offsets, y-down)
   * around the visible pixels, inside the packed rect. Region attachments draw this polygon instead of the full quad,
   * so less transparent area is filled.
   */
  polygon?: number[];
}

/** A solid white block in a page; untextured shapes sample it so they batch with packed images. */
export interface AtlasWhite {
  page: Id;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AtlasData {
  pages: AtlasPage[];
  regions: AtlasRegion[];
  white?: AtlasWhite;
  /** Pixels kept empty around each packed rectangle (informational). */
  padding: number;
  /** Images were stored at this fraction of their size (informational; uvs already account for it). */
  scale?: number;
  /**
   * Page pixels are stored with premultiplied alpha (rgb × a). Renderers upload them as they are and blend with
   * ONE, ONE_MINUS_SRC_ALPHA; 2D-canvas renderers convert them back to straight alpha.
   */
  premultipliedAlpha?: boolean;
  /** Whitespace stripping was on when packing: regions hold only their images' visible bounds (informational). */
  stripWhitespace?: boolean;
  /** Polygon packing was on when packing: regions carry outline polygons (informational). */
  polygons?: boolean;
  /** Texture filtering runtimes should use for the pages when minifying / magnifying. Default "linear" for both. */
  filterMin?: AtlasFilter;
  filterMag?: AtlasFilter;
  /** Texture wrap mode on each axis. Default "clamp". */
  wrapX?: AtlasWrap;
  wrapY?: AtlasWrap;
  /** Pixel format runtimes should upload the pages as (a hint; pages are always stored as PNG or JPEG). Default "RGBA8888". */
  pixelFormat?: AtlasPixelFormat;
}

/** Texture filter. The mipmap variants only make sense for minification; renderers generate the mipmaps. */
export type AtlasFilter = "nearest" | "linear" | "mipmap" | "mipmapNearestNearest" | "mipmapLinearNearest" | "mipmapNearestLinear" | "mipmapLinearLinear";
export type AtlasWrap = "clamp" | "repeat" | "mirroredRepeat";
export type AtlasPixelFormat = "RGBA8888" | "RGB888" | "RGBA4444" | "RGB565" | "Alpha";
export const ATLAS_FILTERS: readonly AtlasFilter[] = ["nearest", "linear", "mipmap", "mipmapNearestNearest", "mipmapLinearNearest", "mipmapNearestLinear", "mipmapLinearLinear"];
export const ATLAS_WRAPS: readonly AtlasWrap[] = ["clamp", "repeat", "mirroredRepeat"];
export const ATLAS_PIXEL_FORMATS: readonly AtlasPixelFormat[] = ["RGBA8888", "RGB888", "RGBA4444", "RGB565", "Alpha"];

interface AttachmentBase {
  name: string;
}

export interface RegionAttachment extends AttachmentBase {
  type: "region";
  image: Id;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Skew in degrees (optional): X slants vertical edges, Y slants horizontal edges; applied before rotation. */
  skewX?: number;
  skewY?: number;
  width: number;
  height: number;
  color: Hex;
}

/** One bone influence on a weighted mesh vertex: position is in that bone's setup-pose local space. */
export interface VertexWeight {
  bone: Id;
  x: number;
  y: number;
  weight: number;
}

export interface MeshAttachment extends AttachmentBase {
  type: "mesh";
  image: Id;
  /** Flat [u0,v0,u1,v1,...] in 0..1 image space (v down). */
  uvs: number[];
  triangles: number[];
  /** Unweighted: flat [x0,y0,...] in slot-bone local space. */
  vertices: number[];
  /** Weighted: per-vertex influences. When present, `vertices` is ignored for posing. */
  weights?: VertexWeight[][];
  /** Number of vertices on the outer hull (first N vertices). */
  hull: number;
  color: Hex;
  /**
   * Linked mesh (like Spine's): uses the geometry and weights of another mesh (the parent) with its own image, so
   * one rig serves many looks. Core copies the parent's vertices, uvs, triangles, hull and weights into this mesh
   * after every edit, so readers can treat it as a plain mesh. With `deform`, the parent's deform keys move it too.
   */
  linked?: LinkedMesh;
}

export interface LinkedMesh {
  /** Name of the parent mesh attachment. */
  mesh: string;
  /** Slot the parent is on (default: this attachment's slot). */
  slot?: Id;
  /** Skin the parent is in (default: this attachment's skin, then the default skin). */
  skin?: Id;
  /** Follow the parent's deform keys (Spine's "timelines" / inherit deform). */
  deform: boolean;
}

export type ShapeKind = "rect" | "ellipse" | "polygon";

/** Vector primitive (Rive-like), rendered without a texture. */
export interface ShapeAttachment extends AttachmentBase {
  type: "shape";
  shape: ShapeKind;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  /** Corner radius for rects. */
  radius: number;
  /** Polygon points, flat [x0,y0,...] in attachment space (polygon only). */
  points?: number[];
  fill: Hex;
  stroke?: Hex;
  strokeWidth?: number;
}

export interface BoundingBoxAttachment extends AttachmentBase {
  type: "boundingBox";
  /** Flat [x0,y0,...] polygon in slot-bone local space. */
  vertices: number[];
  /** Optional per-vertex bone influences (same layout as mesh weights), so the box bends with several bones. */
  weights?: VertexWeight[][];
  /** Editor display colour (default orange). */
  color?: Hex;
}

export interface PointAttachment extends AttachmentBase {
  type: "point";
  x: number;
  y: number;
  rotation: number;
}

/**
 * Clipping mask (Spine-style). Not drawn itself: the slots that come after its slot in draw order, up to and
 * including `end`, are clipped to the polygon.
 */
export interface ClippingAttachment extends AttachmentBase {
  type: "clipping";
  /** Flat [x0,y0,...] polygon in slot-bone local space. */
  vertices: number[];
  /** Last slot (id) that is clipped; null clips every slot drawn after this one. */
  end: Id | null;
}

/**
 * Cubic bezier spline used by path constraints. Every knot is three vertices
 * `[inHandle, anchor, outHandle]`, so `vertices` is flat `[inX, inY, x, y, outX, outY, ...]`
 * in slot-bone local space. Segment i runs from knot i's anchor (via its out handle and
 * knot i+1's in handle) to knot i+1's anchor; `closed` adds a segment from the last knot back to the first.
 */
export interface PathAttachment extends AttachmentBase {
  type: "path";
  vertices: number[];
  /** Optional per-vertex bone influences (same layout as mesh weights), so control bones can bend the path. */
  weights?: VertexWeight[][];
  closed: boolean;
  /** Editor display colour. */
  color: Hex;
}

/** One frame of a sequence: a whole image, or a rectangle of a sprite sheet image. */
export interface SequenceFrame {
  image: Id;
  /** Sub-rectangle of the image (image pixels, y-down). The whole image when omitted. */
  rect?: { x: number; y: number; width: number; height: number };
  /**
   * Trimmed frame (sheet exporters cut transparent margins): `rect` sits at `x, y` (y-down) inside the
   * untrimmed `sourceWidth x sourceHeight` frame. The attachment's width/height cover the untrimmed frame.
   */
  trim?: { x: number; y: number; sourceWidth: number; sourceHeight: number };
}

/**
 * How the frame counter maps to a frame: `loop` wraps, `once` plays through and then shows nothing,
 * `pingPong` plays forward then backward, `holdLast` plays through and stays on the last frame.
 */
export type SequenceMode = "loop" | "once" | "pingPong" | "holdLast";

/**
 * Frame-by-frame animation (image sequence or sprite sheet) drawn as a quad like a region. The frame counter is
 * `floor(time * fps) + offset`, where time is the animation (or state) time, or the skeleton clock when nothing
 * is playing. A `sequence` timeline key or a number `input` replaces `floor(time * fps)` with its value.
 */
export interface SequenceAttachment extends AttachmentBase {
  type: "sequence";
  frames: SequenceFrame[];
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  /** Skew in degrees (optional): X slants vertical edges, Y slants horizontal edges; applied before rotation. */
  skewX?: number;
  skewY?: number;
  /** Size of one (untrimmed) frame in skeleton units. */
  width: number;
  height: number;
  color: Hex;
  fps: number;
  mode: SequenceMode;
  /** Frames added to the counter (start the sequence part way through, or delay it with a negative value). */
  offset: number;
  /** Number input (id) of a state machine whose value is the frame counter. */
  input?: Id | null;
}

// ---------- Particles ----------

/** Where new particles appear, in attachment space (centred on x, y, rotated by `rotation`). */
export type EmitterShape = "point" | "circle" | "box" | "cone";
/** What each particle looks like: a built-in soft shape, or an image (packed or loose). */
export type ParticleLook = "circle" | "square" | "spark" | "image";
/** world: particles stay where they were born when the bone moves; local: they move with the bone. */
export type ParticleSpace = "world" | "local";

/** A [min, max] range; each particle picks a seeded random value inside it. */
export type Range = [number, number];

export interface ParticleBurst {
  /** Seconds into the emitter cycle. */
  time: number;
  count: number;
}

/** One stop of the colour-over-life gradient (`t` 0..1 of a particle's life; colour may carry alpha). */
export interface ColorStop {
  t: number;
  color: Hex;
}

/**
 * Particle emitter shown by a slot. Emits from the slot bone's world transform; simulated at a fixed step
 * with a seeded random generator, so the same seed and time always give the same particles.
 */
export interface ParticlesAttachment extends AttachmentBase {
  type: "particles";
  // Emission
  /** Setup value of the keyable on/off switch. */
  emitting: boolean;
  /** Particles per second (keyable). */
  rate: number;
  bursts: ParticleBurst[];
  maxParticles: number;
  /** Emitter cycle length in seconds (bursts repeat every cycle when looping). */
  duration: number;
  /** Repeat the cycle; when false emission stops after `duration`. */
  loop: boolean;
  /** Start as if the emitter had already run one cycle. */
  prewarm: boolean;
  // Shape
  shape: EmitterShape;
  x: number;
  y: number;
  /** Emission direction in degrees (0 = along the bone, 90 = bone's +y). */
  rotation: number;
  /** Spread in degrees around the direction (point, box, cone). Circles emit outwards. */
  angle: number;
  /** Circle radius / cone mouth half-width. */
  radius: number;
  /** Box size. */
  width: number;
  height: number;
  space: ParticleSpace;
  // Particles
  lifetime: Range;
  speed: Range;
  /** Downward acceleration (skeleton units / s²); negative floats up. */
  gravity: number;
  /** Velocity decay per second. */
  drag: number;
  startSize: Range;
  endSize: Range;
  /** Degrees; rotation goes from start to end over the life, plus angularVelocity × age. */
  startRotation: Range;
  endRotation: Range;
  /** Degrees per second. */
  angularVelocity: Range;
  /** Colour (with alpha) over each particle's life; at least one stop. */
  colors: ColorStop[];
  blend: BlendMode;
  // Look
  look: ParticleLook;
  /** Image id (look = "image"); packed images are drawn from their atlas page. */
  image?: Id;
  /** Spark streak length in seconds of velocity (look = "spark"). */
  stretch: number;
  /** Random seed (integer). */
  seed: number;
}

export type TextAlign = "left" | "center" | "right";

/**
 * Text drawn in a box centred at (x, y) in slot-bone space. `text` is a template: `{name}` or
 * `{name:format}` is replaced by the state machine input called `name` (see `formatTemplate`), `{{`/`}}` are
 * literal braces. The box (`width` x `height`) is the hit area and the alignment frame; text is centred vertically.
 */
export interface TextAttachment extends AttachmentBase {
  type: "text";
  text: string;
  x: number;
  y: number;
  rotation: number;
  width: number;
  height: number;
  font: string;
  /** Pixel size (skeleton units). */
  size: number;
  /** CSS font weight 100..900. */
  weight: number;
  color: Hex;
  align: TextAlign;
  /** Outline colour; drawn behind the fill when `outlineWidth` > 0. */
  outline?: Hex;
  outlineWidth?: number;
}

export type Attachment =
  | ParticlesAttachment
  | ClippingAttachment
  | SequenceAttachment
  | TextAttachment
  | RegionAttachment
  | MeshAttachment
  | ShapeAttachment
  | BoundingBoxAttachment
  | PointAttachment
  | PathAttachment;
export type AttachmentType = Attachment["type"];

export interface SkinData {
  id: Id;
  name: string;
  /** slotId -> attachmentName -> attachment */
  attachments: Record<Id, Record<string, Attachment>>;
  /**
   * Skin bones (Spine-style): bones listed in any skin are active only while a skin listing them is set. An inactive
   * bone (and every bone below it) is not posed and its slots are not drawn.
   */
  bones?: Id[];
  /** Skin constraints: constraints listed in any skin are applied only while a skin listing them is set. */
  constraints?: Id[];
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
}

export interface IkConstraintData {
  id: Id;
  name: string;
  /** Position in the constraint update order (see `SkeletonData`); unset = the default order. */
  order?: number;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  /** One or two bones; for two, the second must be a child of the first. */
  bones: Id[];
  target: Id;
  mix: number;
  bendPositive: boolean;
  /** 2-bone only: distance before full extension over which the chain eases into straightness (0 = off). */
  softness: number;
  /** Scale the bones up along their length when the target is out of reach. */
  stretch: boolean;
  /** 1-bone only: scale the bone down when the target is closer than its length. */
  compress: boolean;
  /** With stretch/compress: scale both axes (keeps the image's proportions) instead of only along the bone. */
  uniform?: boolean;
}

export interface TransformConstraintData {
  id: Id;
  name: string;
  /** Position in the constraint update order (see `SkeletonData`); unset = the default order. */
  order?: number;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  bones: Id[];
  target: Id;
  mixRotate: number;
  mixTranslate: number;
  mixScale: number;
  /** Blend of the Y-axis shear (the angle between the bone's axes). */
  mixShear: number;
  offsetRotation: number;
  offsetX: number;
  offsetY: number;
  /** Added to the target's scale (0 = copy it as is). */
  offsetScaleX: number;
  offsetScaleY: number;
  offsetShear: number;
  /** Work on local (parent-space) values instead of world matrices. */
  local: boolean;
  /** Add the target's change from its setup pose instead of copying its absolute value. */
  relative: boolean;
}

/** fixed: `position` is a distance along the path; percent: `position` is 0..1 of the path length. */
export type PathPositionMode = "fixed" | "percent";
/**
 * length: gap between bones is each bone's length plus `spacing`;
 * fixed: every gap is `spacing`; percent: every gap is `spacing` x path length;
 * proportional: gaps share `spacing` x path length in proportion to bone lengths.
 */
export type PathSpacingMode = "length" | "fixed" | "percent" | "proportional";
/** tangent: bones follow the curve's direction; chain: each bone points at the next placed point; chainScale: chain plus scaling to reach it. */
export type PathRotateMode = "tangent" | "chain" | "chainScale";

export interface PathConstraintData {
  id: Id;
  name: string;
  /** Position in the constraint update order (see `SkeletonData`); unset = the default order. */
  order?: number;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  /** Bones placed along the path, in hierarchy order (parent before child). */
  bones: Id[];
  /** Slot whose current attachment is a path attachment. */
  target: Id;
  positionMode: PathPositionMode;
  spacingMode: PathSpacingMode;
  rotateMode: PathRotateMode;
  /**
   * Distances along each bezier segment are measured by arc length (default, unset = true), so bones stay evenly
   * spaced however the handles are placed. `false`: the segment is still found by arc length, but the point within
   * it is at the raw bezier parameter `t = (distance into the segment) / (segment length)` (Spine with "constant
   * speed" off), so bones bunch up where the handles are short.
   */
  constantSpeed?: boolean;
  offsetRotation: number;
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
}

/**
 * Secondary motion for one bone: two spring particles (bone origin and bone tip) lag behind the
 * animated pose and are blended back into it. Simulated at a fixed timestep, so results only depend
 * on the sequence of frame times.
 */
export interface PhysicsConstraintData {
  id: Id;
  name: string;
  /** Position in the constraint update order (see `SkeletonData`); unset = the default order. */
  order?: number;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  bone: Id;
  /** Per-channel influence 0..1: how much the simulation moves the bone origin (x, y), rotates it and stretches it. */
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  /** 0..1: how much of the bone's own movement the particles resist (1 = full lag, 0 = carried along). */
  inertia: number;
  /** Spring stiffness pulling particles back to the animated pose. */
  strength: number;
  /** Velocity decay per second (higher settles faster). */
  damping: number;
  /** Divides the spring force (heavier = slower, floppier). */
  mass: number;
  /** Downward acceleration in skeleton units per second squared. */
  gravity: number;
  /** Sideways (+x) force in skeleton units per second squared. */
  wind: number;
  /** Overall blend 0..1. */
  mix: number;
  /** Simulation steps per second. */
  fps: number;
}
export interface SkeletonData {
  bones: BoneData[];
  /** Array order is the setup draw order (first = back). */
  slots: SlotData[];
  skins: SkinData[];
  /**
   * Constraints solve in one list each frame, sorted by their `order`. A constraint without `order` uses its index in
   * the default order (ik, transform, path, physics, each list in array order); ties keep the default order.
   */
  ik: IkConstraintData[];
  transform: TransformConstraintData[];
  path: PathConstraintData[];
  physics: PhysicsConstraintData[];
  /** Sliders: animations scrubbed by a bone property or an input. Applied first, before the constraints above. */
  sliders?: SliderData[];
  /**
   * Size, in percent, the rig's physics and IK softness values were made for (default 100). Exporting the rig at
   * another size changes this with it: physics gravity and wind and IK softness are multiplied by
   * `referenceScale / 100` times the skeleton's placement scale, so the rig behaves the same at any size.
   */
  referenceScale?: number;
}

/**
 * Slider (Spine 4.2-style): a driver value scrubs an animation. The driver is a bone's local property (`bone` +
 * `property`) or a number input (`input`, by id). `from`..`to` of the driver maps to `timeFrom`..`timeTo` seconds of
 * the animation (default: its whole length), clamped, or wrapped with `loop`. The animation is blended in by `mix`,
 * or added on top of the current pose with `additive` (its change from the setup pose, times `mix`).
 */
export interface SliderData {
  id: Id;
  name: string;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  animation: Id;
  bone?: Id;
  property?: BoneProperty;
  input?: Id;
  from: number;
  to: number;
  timeFrom?: number;
  timeTo?: number;
  mix: number;
  loop: boolean;
  additive: boolean;
}

/** Bezier handles [cx1, cy1, cx2, cy2] in normalised 0..1 key-span space. */
export type Curve = "linear" | "stepped" | [number, number, number, number];

export type BoneProperty = "rotation" | "x" | "y" | "scaleX" | "scaleY" | "shearX" | "shearY";
export const BONE_PROPERTIES: BoneProperty[] = ["rotation", "x", "y", "scaleX", "scaleY", "shearX", "shearY"];
export const INHERIT_MODES: InheritMode[] = ["normal", "onlyTranslation", "noRotation", "noScale"];

/** bend (1 = positive, -1 = negative), stretch and compress (1 = on, 0 = off) key in steps, like Spine's IK timeline. */
export type IkProperty = "mix" | "softness" | "bend" | "stretch" | "compress";
/** IK values that switch at each key instead of blending. */
export const IK_STEP_PROPERTIES: IkProperty[] = ["bend", "stretch", "compress"];
export type TransformProperty = "mix" | "mixRotate" | "mixTranslate" | "mixScale" | "mixShear";
export type PathProperty = "position" | "spacing" | "mixRotate" | "mixX" | "mixY";
export type PhysicsProperty = "mix" | "inertia" | "strength" | "damping" | "mass" | "gravity" | "wind";
export type ConstraintTarget = "ik" | "transform" | "path" | "physics";
/** Keyable emitter values (timeline id = slot id; acts on the particles attachment the slot shows). */
export type ParticleProperty = "emitting" | "rate";
export const PARTICLE_PROPERTIES: ParticleProperty[] = ["emitting", "rate"];

/** Keyable numeric fields of each constraint kind. */
export const CONSTRAINT_PROPERTIES: {
  ik: IkProperty[];
  transform: TransformProperty[];
  path: PathProperty[];
  physics: PhysicsProperty[];
} = {
  ik: ["mix", "softness", "bend", "stretch", "compress"],
  transform: ["mix", "mixRotate", "mixTranslate", "mixScale", "mixShear"],
  path: ["position", "spacing", "mixRotate", "mixX", "mixY"],
  physics: ["mix", "inertia", "strength", "damping", "mass", "gravity", "wind"],
};

export interface Key<T> {
  time: number;
  value: T;
  curve: Curve;
}

export type Timeline =
  | { target: "bone"; id: Id; property: BoneProperty; keys: Key<number>[] }
  /** Switches the bone's inherit mode at each key (stepped, curves ignored). */
  | { target: "bone"; id: Id; property: "inherit"; keys: Key<InheritMode>[] }
  | { target: "slot"; id: Id; property: "color" | "dark"; keys: Key<Hex>[] }
  | { target: "slot"; id: Id; property: "attachment"; keys: Key<string | null>[] }
  | { target: "ik"; id: Id; property: IkProperty; keys: Key<number>[] }
  /** "mix" multiplies every transform mix (setup value 1); the others are absolute. */
  | { target: "transform"; id: Id; property: TransformProperty; keys: Key<number>[] }
  | { target: "path"; id: Id; property: PathProperty; keys: Key<number>[] }
  | { target: "physics"; id: Id; property: PhysicsProperty; keys: Key<number>[] }
  /** Frame counter of a sequence attachment (replaces time x fps; the mode still applies). id = slot id. */
  | { target: "sequence"; id: Id; attachment: string; property: "frame"; keys: Key<number>[] }
  | { target: "particles"; id: Id; property: "emitting"; keys: Key<boolean>[] }
  | { target: "particles"; id: Id; property: "rate"; keys: Key<number>[] }
  /** Offsets added to mesh or path vertices (flat x,y per vertex). id = slot id. */
  | { target: "deform"; id: Id; attachment: string; property: "offsets"; keys: Key<number[]>[] }
  | { target: "drawOrder"; id: "skeleton"; property: "order"; keys: Key<Id[]>[] };

export type TimelineTarget = Timeline["target"];

export interface EventData {
  id: Id;
  name: string;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  int: number;
  float: number;
  string: string;
  /** Sound (id or name) played whenever this event fires. An audio asset id/name also works (played with defaults). */
  audio?: string;
  /** Volume multiplier for `audio` (default 1). */
  volume?: number;
}

export interface EventKey {
  time: number;
  event: Id;
  int?: number;
  float?: number;
  string?: string;
}

export interface AnimationData {
  id: Id;
  name: string;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  /** Explicit length in seconds; when 0 the last key time is used. */
  duration: number;
  timelines: Timeline[];
  events: EventKey[];
  /** Audio track: sounds started at a time. Looping ones stop when the animation ends or is replaced. */
  audio?: AudioKey[];
  /** false: a helper / work-in-progress animation, left out of exports unless picked by hand. Default true. */
  export?: boolean;
  /** Colour shown for the animation in the editor's lists. */
  color?: Hex;
}

// ---------- Audio ----------

/** An audio file. Like images, asset objects are immutable (ops replace them) so undo snapshots can share them. */
export interface AudioAsset {
  id: Id;
  name: string;
  /** data: URI, relative path, or URL (WAV, MP3, OGG). */
  src: string;
  /** Seconds. 0 when unknown. */
  duration: number;
}

/** A mixer channel (e.g. sfx, music, ui). Effective gain = master x bus x sound x play volume. */
export interface AudioBus {
  id: Id;
  name: string;
  volume: number;
  muted: boolean;
}

/** A playable sound: an asset plus mix settings. Animations, events and state machines play sounds. */
export interface SoundData {
  id: Id;
  name: string;
  asset: Id;
  /** Bus id; null plays straight into the master. */
  bus: Id | null;
  volume: number;
  /** Playback rate (pitch). 1 = original. */
  rate: number;
  loop: boolean;
  /** Seconds to fade in when started / out when stopped. */
  fadeIn: number;
  fadeOut: number;
}

export interface AudioData {
  /** Master volume 0..1+. */
  master: number;
  muted: boolean;
  assets: AudioAsset[];
  buses: AudioBus[];
  sounds: SoundData[];
}

/** A sound key on an animation's audio track. Unset fields use the sound's settings. */
export interface AudioKey {
  time: number;
  sound: Id;
  volume?: number;
  rate?: number;
  loop?: boolean;
}

/** Play or stop a sound when a state is entered or exited. Looping sounds played on enter stop on exit. */
export interface StateSound {
  sound: Id;
  on: "enter" | "exit";
  action: "play" | "stop";
  volume?: number;
}

// ---------- State machines (Rive-style interactivity) ----------

export type InputType = "bool" | "number" | "trigger" | "string";
export type InputValue = boolean | number | string;
export interface InputData {
  id: Id;
  name: string;
  type: InputType;
  default: InputValue;
}

export type ConditionOp = "==" | "!=" | ">" | "<" | ">=" | "<=";
export interface Condition {
  input: Id;
  /** Ignored for triggers (a trigger condition passes when the trigger fired). Strings support == and !=. */
  op: ConditionOp;
  value: InputValue;
}

export interface BlendEntry {
  animation: Id;
  value: number;
}

export type StateType = "animation" | "blend1d" | "exit";
export interface StateData {
  id: Id;
  name: string;
  type: StateType;
  animation?: Id;
  loop: boolean;
  speed: number;
  /** blend1d: numeric input driving the blend. */
  blendInput?: Id;
  blend?: BlendEntry[];
  /** Editor graph position. */
  x: number;
  y: number;
  /** Scripts run while this state is active. */
  scripts?: Id[];
  /** Sounds played or stopped on enter/exit. */
  sounds?: StateSound[];
  /** Particle emitters switched on/off when this state is entered. */
  emitters?: StateEmitter[];
  /** Inputs set when this state is entered (for example, reset a round's multiplier when going back to idle). */
  inputs?: StateInput[];
  /**
   * State to go to once the animation has played through once (for looping states: after the first cycle).
   * Checked after the state's own transitions, so a trigger can still interrupt it.
   */
  onComplete?: Id | null;
}

/** Special `from` value: transition can fire from any state of the layer. */
export const ANY_STATE = "@any";

export interface TransitionData {
  id: Id;
  from: Id; // state id or ANY_STATE
  to: Id;
  conditions: Condition[];
  /** Cross-fade seconds. */
  duration: number;
  /** If set, only fires once the source animation has played this fraction (0..1, may exceed 1 for loops). */
  exitTime: number | null;
}

export interface LayerData {
  id: Id;
  name: string;
  entry: Id | null;
  states: StateData[];
  transitions: TransitionData[];
}

export type PointerEventType = "down" | "up" | "enter" | "exit" | "move" | "click";

export type ListenerAction =
  | { type: "setInput"; input: Id; value: InputValue }
  | { type: "toggleInput"; input: Id }
  | { type: "fireTrigger"; input: Id }
  | { type: "reportEvent"; event: Id }
  | { type: "runScript"; script: Id; fn: string }
  | { type: "playSound"; sound: Id; volume?: number }
  /** Stops every playing instance of the sound (fade seconds; default the sound's fadeOut). */
  | { type: "stopSound"; sound: Id; fade?: number }
  /** Turn a slot's particle emitter on (restarting its cycle, so bursts replay) or off. */
  | { type: "setEmitter"; slot: Id; emitting: boolean }
  /** Spawn `count` particles from a slot's emitter right away. */
  | { type: "emitParticles"; slot: Id; count: number };

/** Input value applied when a state is entered (bool, number or string inputs; not triggers). */
export interface StateInput {
  input: Id;
  value: InputValue;
}

/** Emitter switch applied when a state is entered. */
export interface StateEmitter {
  slot: Id;
  emitting: boolean;
}

export interface ListenerData {
  id: Id;
  name: string;
  /** Slot whose bounding-box attachment is the hit area; null = whole artboard. */
  slot: Id | null;
  event: PointerEventType;
  actions: ListenerAction[];
}

export interface ScriptData {
  id: Id;
  name: string;
  /** JavaScript. May define onStart(), onUpdate(dt), onEvent(e), onPointer(p). Uses the global `ob` API. */
  code: string;
}

/** Properties an input binding can drive. `color` (slots only) blends between two hex colours. */
export type BindingTarget = "bone" | "slot" | ConstraintTarget;
export type BindingProperty = BoneProperty | "color" | "alpha" | IkProperty | TransformProperty | PathProperty | PhysicsProperty;

/**
 * Drives a property from a number input every frame, after animations: the input is mapped linearly from
 * `[inMin, inMax]` to `[outMin, outMax]` (clamped). For slot `color` the outputs are hex colours; for slot
 * `alpha` they are 0..1. Bindings run in array order, so a later one wins on the same property.
 */
export interface InputBinding {
  id: Id;
  input: Id;
  target: BindingTarget;
  /** Bone, slot or constraint id. */
  object: Id;
  property: BindingProperty;
  inMin: number;
  inMax: number;
  outMin: number | Hex;
  outMax: number | Hex;
}

export interface StateMachineData {
  id: Id;
  name: string;
  /** Editor folder path ("body/arms") the item is listed under. Organisation only: no effect on drawing or posing. */
  folder?: string;
  inputs: InputData[];
  /** Input → property drivers applied every frame after animations. */
  bindings: InputBinding[];
  layers: LayerData[];
  listeners: ListenerData[];
  /** Scripts running for the whole lifetime of the state machine. */
  scripts: Id[];
}

export interface OpenBoneDocument {
  format: "openbone";
  version: 1;
  name: string;
  /** Artboard size and origin (origin = skeleton 0,0 within the artboard, y-down pixels). */
  width: number;
  height: number;
  originX: number;
  originY: number;
  background: Hex | null;
  fps: number;
  /** An image whose src is "" is only available through `atlas`. */
  images: ImageAsset[];
  /** Packed textures. Images with a region here are drawn from the atlas page instead of their own src. */
  atlas?: AtlasData;
  skeleton: SkeletonData;
  events: EventData[];
  animations: AnimationData[];
  stateMachines: StateMachineData[];
  scripts: ScriptData[];
  /** Audio assets, sounds and the mixer. Absent when the document has no audio. */
  audio?: AudioData;
}

export const FORMAT_VERSION = 1 as const;
