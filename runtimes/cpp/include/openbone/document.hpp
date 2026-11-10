// OpenBone C++ runtime: the document model (what a .obone / .obonb file holds).
// Field names follow docs/format.md; see docs/runtime-spec.md for how the runtime uses them.
// SPDX-License-Identifier: MIT
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace openbone {

using Id = std::string;
/** RGBA, 0..1 doubles, not premultiplied, never clamped. */
using RGBA = std::array<double, 4>;

/** A JS-like dynamic value (state-machine inputs, condition values, script results). */
struct Value {
  enum class Type : uint8_t { Undefined, Null, Bool, Number, String };
  Type type = Type::Undefined;
  bool b = false;
  double n = 0;
  std::string s;

  static Value undefined() { return {}; }
  static Value null() { Value v; v.type = Type::Null; return v; }
  static Value boolean(bool x) { Value v; v.type = Type::Bool; v.b = x; return v; }
  static Value number(double x) { Value v; v.type = Type::Number; v.n = x; return v; }
  static Value string(std::string x) { Value v; v.type = Type::String; v.s = std::move(x); return v; }

  bool isUndefined() const { return type == Type::Undefined; }
  bool isNumber() const { return type == Type::Number; }
  bool isBool() const { return type == Type::Bool; }
  bool isString() const { return type == Type::String; }
  /** JS strict equality (`===`). */
  bool strictEquals(const Value& o) const;
  /** JS `Number(v)`. */
  double toNumber() const;
  /** JS `Boolean(v)`. */
  bool truthy() const;
  /** JS `String(v)`. */
  std::string toString() const;
};

enum class Inherit : uint8_t { Normal, OnlyTranslation, NoRotation, NoScale };
enum class BlendMode : uint8_t { Normal, Additive, Multiply, Screen };
const char* blendName(BlendMode b);
const char* inheritName(Inherit i);

struct BoneData {
  Id id;
  std::string name;
  std::optional<Id> parent;
  double length = 0, x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, shearX = 0, shearY = 0;
  Inherit inherit = Inherit::Normal;
};

struct SlotData {
  Id id;
  std::string name;
  Id bone;
  std::string color = "#ffffff";
  std::optional<std::string> attachment;
  BlendMode blend = BlendMode::Normal;
  std::optional<std::string> dark;
};

struct ImageAsset {
  Id id;
  std::string name, src;
  double width = 0, height = 0;
};

struct AtlasPage {
  Id id;
  std::string name, src;
  double width = 0, height = 0;
};

struct AtlasRegion {
  Id image, page;
  double x = 0, y = 0, width = 0, height = 0, offsetX = 0, offsetY = 0, originalWidth = 0, originalHeight = 0;
  bool rotated = false;
  std::vector<double> polygon;
};

struct AtlasData {
  std::vector<AtlasPage> pages;
  std::vector<AtlasRegion> regions;
  bool hasWhite = false;
  Id whitePage;
  double whiteX = 0, whiteY = 0, whiteWidth = 0, whiteHeight = 0;
  bool premultipliedAlpha = false;
};

enum class AttachmentType : uint8_t { Region, Mesh, Shape, BoundingBox, Point, Clipping, Path, Sequence, Particles, Text, Unknown };
const char* attachmentTypeName(AttachmentType t);

struct VertexWeight {
  Id bone;
  double x = 0, y = 0, weight = 0;
};

struct SequenceFrame {
  Id image;
  bool hasRect = false;
  double rx = 0, ry = 0, rw = 0, rh = 0;
  bool hasTrim = false;
  double tx = 0, ty = 0, sourceWidth = 0, sourceHeight = 0;
};

using Range = std::array<double, 2>;
struct ParticleBurst { double time = 0, count = 0; };
struct ColorStop { double t = 0; std::string color; };

enum class SequenceMode : uint8_t { Loop, Once, PingPong, HoldLast };
enum class EmitterShape : uint8_t { Point, Circle, Box, Cone };
enum class ParticleLook : uint8_t { Circle, Square, Spark, Image };
enum class ShapeKind : uint8_t { Rect, Ellipse, Polygon };
enum class TextAlign : uint8_t { Left, Center, Right };

/** One attachment. A single struct holds the fields of every type; `type` says which are meaningful. */
struct Attachment {
  AttachmentType type = AttachmentType::Unknown;
  std::string name;
  // region / sequence / text / shape / point / particles placement
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, skewX = 0, skewY = 0, width = 0, height = 0;
  std::string color = "#ffffffff";
  Id image;  // region, mesh, particles (look image)
  bool hasImage = false;
  // mesh / path / bbox / clipping
  std::vector<double> uvs, vertices;
  std::vector<uint16_t> triangles;
  std::vector<std::vector<VertexWeight>> weights;
  bool weighted = false;
  int hull = 0;
  bool linkedDeform = false;
  std::string linkedMesh;
  bool closed = false;            // path
  std::optional<Id> end;          // clipping
  // shape
  ShapeKind shape = ShapeKind::Rect;
  double radius = 0;
  bool hasPoints = false;
  std::vector<double> points;
  std::string fill = "#ffffff";
  std::optional<std::string> stroke;
  double strokeWidth = 0;
  // sequence
  std::vector<SequenceFrame> frames;
  double fps = 0, offset = 0;
  SequenceMode mode = SequenceMode::Loop;
  std::optional<Id> input;
  // particles
  bool emitting = true, loop = true, prewarm = false;
  double rate = 20, maxParticles = 200, duration = 1, angle = 30, gravity = 0, drag = 0, stretch = 0.05, seed = 1;
  std::vector<ParticleBurst> bursts;
  EmitterShape emitterShape = EmitterShape::Point;
  bool localSpace = false;
  Range lifetime{0.8, 1.2}, speed{80, 120}, startSize{10, 14}, endSize{2, 4}, startRotation{0, 0}, endRotation{0, 0},
      angularVelocity{0, 0};
  std::vector<ColorStop> colors;
  BlendMode blend = BlendMode::Normal;
  ParticleLook look = ParticleLook::Circle;
  // text
  std::string text, font = "sans-serif";
  double size = 16, weight = 400;
  TextAlign align = TextAlign::Center;
  std::optional<std::string> outline;
  double outlineWidth = 0;
};

/** A slot's attachments in one skin, in JS object key order (integer-like names first, then insertion order). */
struct SlotAttachments {
  // Move-only, said explicitly: MSVC's unordered_map move isn't noexcept, so without a deleted copy std::vector<SkinData>
  // would try to copy skins (and these unique_ptrs) when it grows.
  SlotAttachments() = default;
  SlotAttachments(SlotAttachments&&) = default;
  SlotAttachments& operator=(SlotAttachments&&) = default;
  SlotAttachments(const SlotAttachments&) = delete;
  SlotAttachments& operator=(const SlotAttachments&) = delete;

  std::vector<std::unique_ptr<Attachment>> list;
  std::vector<std::string> keys;  // parallel to list
  std::unordered_map<std::string, Attachment*> byName;
  const Attachment* find(const std::string& name) const {
    auto it = byName.find(name);
    return it == byName.end() ? nullptr : it->second;
  }
};

struct SkinData {
  // Move-only for the same reason as SlotAttachments: MSVC's unordered_map reports itself copyable even when its values
  // aren't, so std::vector<SkinData> must see a deleted copy to pick the move when it grows.
  SkinData() = default;
  SkinData(SkinData&&) = default;
  SkinData& operator=(SkinData&&) = default;
  SkinData(const SkinData&) = delete;
  SkinData& operator=(const SkinData&) = delete;

  Id id;
  std::string name;
  std::unordered_map<Id, SlotAttachments> attachments;
  std::vector<Id> bones, constraints;
};

struct IkConstraintData {
  Id id;
  std::string name;
  std::optional<double> order;
  std::vector<Id> bones;
  Id target;
  double mix = 1, softness = 0;
  bool bendPositive = true, stretch = false, compress = false, uniform = false;
};

struct TransformConstraintData {
  Id id;
  std::string name;
  std::optional<double> order;
  std::vector<Id> bones;
  Id target;
  double mixRotate = 1, mixTranslate = 1, mixScale = 1, mixShear = 0;
  double offsetRotation = 0, offsetX = 0, offsetY = 0, offsetScaleX = 0, offsetScaleY = 0, offsetShear = 0;
  bool local = false, relative = false;
};

enum class PositionMode : uint8_t { Fixed, Percent };
enum class SpacingMode : uint8_t { Length, Fixed, Percent, Proportional };
enum class RotateMode : uint8_t { Tangent, Chain, ChainScale };

struct PathConstraintData {
  Id id;
  std::string name;
  std::optional<double> order;
  std::vector<Id> bones;
  Id target;  // slot id
  PositionMode positionMode = PositionMode::Percent;
  SpacingMode spacingMode = SpacingMode::Length;
  RotateMode rotateMode = RotateMode::Tangent;
  double offsetRotation = 0, position = 0, spacing = 0, mixRotate = 1, mixX = 1, mixY = 1;
};

struct PhysicsConstraintData {
  Id id;
  std::string name;
  std::optional<double> order;
  Id bone;
  double x = 0, y = 0, rotate = 0, scaleX = 0;
  double inertia = 0.5, strength = 100, damping = 1, mass = 1, gravity = 0, wind = 0, mix = 1, fps = 60;
};

enum class BoneProp : uint8_t { X, Y, Rotation, ScaleX, ScaleY, ShearX, ShearY, Inherit, Unknown };
BoneProp boneProp(const std::string& s);

struct SliderData {
  Id id;
  std::string name;
  Id animation;
  std::optional<Id> bone, input;
  BoneProp property = BoneProp::Rotation;
  double from = 0, to = 1, mix = 1;
  std::optional<double> timeFrom, timeTo;
  bool loop = false, additive = false;
};

enum class ConstraintKind : uint8_t { Ik, Transform, Path, Physics };

struct SkeletonData {
  std::vector<BoneData> bones;
  std::vector<SlotData> slots;
  std::vector<SkinData> skins;
  std::vector<IkConstraintData> ik;
  std::vector<TransformConstraintData> transform;
  std::vector<PathConstraintData> path;
  std::vector<PhysicsConstraintData> physics;
  std::vector<SliderData> sliders;
  std::optional<double> referenceScale;
};

struct Curve {
  enum class Kind : uint8_t { Linear, Stepped, Bezier } kind = Kind::Linear;
  double x1 = 0, y1 = 0, x2 = 1, y2 = 1;
};

/** A key. Which value field is used depends on the timeline (numbers, colours/strings, arrays, id lists). */
struct Key {
  double time = 0;
  Curve curve;
  Value value;                 // number / bool / string / null
  std::vector<double> numbers; // deform offsets
  std::vector<Id> ids;         // draw order
};

enum class TimelineTarget : uint8_t { Bone, Slot, Ik, Transform, Path, Physics, Sequence, Particles, Deform, DrawOrder, Unknown };

/** Constraint (live) value slots: every keyable / bindable constraint property. */
enum class CProp : uint8_t {
  Mix, Softness, Bend, Stretch, Compress, MixRotate, MixTranslate, MixScale, MixShear, Position, Spacing, MixX, MixY,
  Inertia, Strength, Damping, Mass, Gravity, Wind, Count, Unknown = 255
};
CProp constraintProp(const std::string& s);

struct Timeline {
  TimelineTarget target = TimelineTarget::Unknown;
  Id id;
  std::string property;
  BoneProp boneProp = BoneProp::Unknown;
  CProp cprop = CProp::Unknown;
  std::string attachment;
  std::vector<Key> keys;
};

struct EventData {
  Id id;
  std::string name;
  double intValue = 0, floatValue = 0;
  std::string stringValue;
  std::optional<std::string> audio;
  std::optional<double> volume;
};

struct EventKey {
  double time = 0;
  Id event;
  std::optional<double> intValue, floatValue;
  std::optional<std::string> stringValue;
};

struct AudioKey {
  double time = 0;
  Id sound;
  std::optional<double> volume, rate;
  std::optional<bool> loop;
};

struct AnimationData {
  Id id;
  std::string name;
  double duration = 0;
  std::vector<Timeline> timelines;
  std::vector<EventKey> events;
  std::vector<AudioKey> audio;
  /** animationDuration(): explicit duration if > 0, else the last key / event / audio time. */
  double computedDuration = 0;
};

struct AudioAsset { Id id; std::string name, src; double duration = 0; };
struct AudioBus { Id id; std::string name; double volume = 1; bool muted = false; };
struct SoundData {
  Id id;
  std::string name;
  Id asset;
  std::optional<Id> bus;
  double volume = 1, rate = 1, fadeIn = 0, fadeOut = 0;
  bool loop = false;
};
struct AudioData {
  double master = 1;
  bool muted = false;
  std::vector<AudioAsset> assets;
  std::vector<AudioBus> buses;
  std::vector<SoundData> sounds;
};

enum class InputType : uint8_t { Bool, Number, Trigger, String };
struct InputData { Id id; std::string name; InputType type = InputType::Number; Value defaultValue; };
struct Condition { Id input; std::string op = "=="; Value value; };
struct BlendEntry { Id animation; double value = 0; };
struct StateSound { Id sound; bool onEnter = true; bool stop = false; std::optional<double> volume; };
struct StateEmitter { Id slot; bool emitting = false; };
struct StateInput { Id input; Value value; };

enum class StateType : uint8_t { Animation, Blend1d, Exit };
struct StateData {
  Id id;
  std::string name;
  StateType type = StateType::Animation;
  std::optional<Id> animation;
  bool loop = true;
  double speed = 1;
  std::optional<Id> blendInput;
  std::vector<BlendEntry> blend;
  std::vector<Id> scripts;
  std::vector<StateSound> sounds;
  std::vector<StateEmitter> emitters;
  std::vector<StateInput> inputs;
  std::optional<Id> onComplete;
};

inline const char* const ANY_STATE = "@any";

struct TransitionData {
  Id id, from, to;
  std::vector<Condition> conditions;
  double duration = 0;
  std::optional<double> exitTime;
};

struct LayerData {
  Id id;
  std::string name;
  std::optional<Id> entry;
  std::vector<StateData> states;
  std::vector<TransitionData> transitions;
};

enum class PointerEvent : uint8_t { Down, Up, Enter, Exit, Move, Click };

struct ListenerAction {
  enum class Type : uint8_t { SetInput, ToggleInput, FireTrigger, ReportEvent, RunScript, PlaySound, StopSound, SetEmitter, EmitParticles, Unknown };
  Type type = Type::Unknown;
  Id input, event, script, sound, slot;
  std::string fn;
  Value value;
  std::optional<double> volume, fade;
  bool emitting = false;
  double count = 0;
};

struct ListenerData {
  Id id;
  std::string name;
  std::optional<Id> slot;
  PointerEvent event = PointerEvent::Down;
  std::vector<ListenerAction> actions;
};

struct ScriptData { Id id; std::string name, code; };

struct InputBinding {
  Id id, input;
  std::string target;  // bone | slot | ik | transform | path | physics
  Id object;
  std::string property;
  double inMin = 0, inMax = 1;
  Value outMin, outMax;
};

struct StateMachineData {
  Id id;
  std::string name;
  std::vector<InputData> inputs;
  std::vector<InputBinding> bindings;
  std::vector<LayerData> layers;
  std::vector<ListenerData> listeners;
  std::vector<Id> scripts;
};

struct Document {
  std::string name;
  double width = 0, height = 0, originX = 0, originY = 0, fps = 30;
  std::vector<ImageAsset> images;
  std::optional<AtlasData> atlas;
  SkeletonData skeleton;
  std::vector<EventData> events;
  std::vector<AnimationData> animations;
  std::vector<StateMachineData> stateMachines;
  std::vector<ScriptData> scripts;
  std::optional<AudioData> audio;

  const AnimationData* findAnimation(const std::string& idOrName) const;
  const AnimationData* animationById(const Id& id) const;
  const EventData* eventById(const Id& id) const;
  const StateMachineData* findStateMachine(const std::string& idOrName) const;
};

/** Parse a .obone JSON document. Throws std::runtime_error on invalid input. */
std::shared_ptr<const Document> loadJson(const std::string& text);
/** Decode a .obonb binary document (see packages/core/src/binary.ts). */
std::shared_ptr<const Document> loadBinary(const uint8_t* data, size_t size);
/** Load from bytes, whichever format they are in. */
std::shared_ptr<const Document> loadDocument(const uint8_t* data, size_t size);
/** Load from a file path (.obone or .obonb). */
std::shared_ptr<const Document> loadFile(const std::string& path);

/** Parse "#rgb", "#rgba", "#rrggbb" or "#rrggbbaa" like core/math.ts:parseHex. */
RGBA parseHex(const std::string& hex);

}  // namespace openbone
