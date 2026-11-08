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
}

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

export type Attachment =
  | ClippingAttachment
  | RegionAttachment
  | MeshAttachment
  | ShapeAttachment
  | BoundingBoxAttachment
  | PointAttachment;
export type AttachmentType = Attachment["type"];

export interface SkinData {
  id: Id;
  name: string;
  /** slotId -> attachmentName -> attachment */
  attachments: Record<Id, Record<string, Attachment>>;
}

export interface IkConstraintData {
  id: Id;
  name: string;
  /** One or two bones; for two, the second must be a child of the first. */
  bones: Id[];
  target: Id;
  mix: number;
  bendPositive: boolean;
}

export interface TransformConstraintData {
  id: Id;
  name: string;
  bones: Id[];
  target: Id;
  mixRotate: number;
  mixTranslate: number;
  mixScale: number;
  offsetRotation: number;
  offsetX: number;
  offsetY: number;
}

export interface SkeletonData {
  bones: BoneData[];
  /** Array order is the setup draw order (first = back). */
  slots: SlotData[];
  skins: SkinData[];
  ik: IkConstraintData[];
  transform: TransformConstraintData[];
}

/** Bezier handles [cx1, cy1, cx2, cy2] in normalised 0..1 key-span space. */
export type Curve = "linear" | "stepped" | [number, number, number, number];

export type BoneProperty = "rotation" | "x" | "y" | "scaleX" | "scaleY" | "shearX" | "shearY";
export const BONE_PROPERTIES: BoneProperty[] = ["rotation", "x", "y", "scaleX", "scaleY", "shearX", "shearY"];

export interface Key<T> {
  time: number;
  value: T;
  curve: Curve;
}

export type Timeline =
  | { target: "bone"; id: Id; property: BoneProperty; keys: Key<number>[] }
  | { target: "slot"; id: Id; property: "color"; keys: Key<Hex>[] }
  | { target: "slot"; id: Id; property: "attachment"; keys: Key<string | null>[] }
  | { target: "ik"; id: Id; property: "mix"; keys: Key<number>[] }
  | { target: "transform"; id: Id; property: "mix"; keys: Key<number>[] }
  /** Offsets added to mesh vertices (flat x,y per vertex). id = slot id. */
  | { target: "deform"; id: Id; attachment: string; property: "offsets"; keys: Key<number[]>[] }
  | { target: "drawOrder"; id: "skeleton"; property: "order"; keys: Key<Id[]>[] };

export type TimelineTarget = Timeline["target"];

export interface EventData {
  id: Id;
  name: string;
  int: number;
  float: number;
  string: string;
  audio?: string;
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
  /** Explicit length in seconds; when 0 the last key time is used. */
  duration: number;
  timelines: Timeline[];
  events: EventKey[];
}

// ---------- State machines (Rive-style interactivity) ----------

export type InputType = "bool" | "number" | "trigger";
export interface InputData {
  id: Id;
  name: string;
  type: InputType;
  default: boolean | number;
}

export type ConditionOp = "==" | "!=" | ">" | "<" | ">=" | "<=";
export interface Condition {
  input: Id;
  /** Ignored for triggers (a trigger condition passes when the trigger fired). */
  op: ConditionOp;
  value: boolean | number;
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
  | { type: "setInput"; input: Id; value: boolean | number }
  | { type: "toggleInput"; input: Id }
  | { type: "fireTrigger"; input: Id }
  | { type: "reportEvent"; event: Id }
  | { type: "runScript"; script: Id; fn: string };

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

export interface StateMachineData {
  id: Id;
  name: string;
  inputs: InputData[];
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
}

export const FORMAT_VERSION = 1 as const;
