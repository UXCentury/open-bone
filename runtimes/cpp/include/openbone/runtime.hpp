// OpenBone C++ runtime: skeleton posing, animation, state machines, draw lists.
// A port of packages/runtime (the TypeScript reference); docs/runtime-spec.md is the contract.
// SPDX-License-Identifier: MIT
#pragma once

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "document.hpp"

namespace openbone {

struct Affine {
  double a = 1, b = 0, c = 0, d = 1, x = 0, y = 0;
};

struct LocalTransform {
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, shearX = 0, shearY = 0;
};

class Skeleton;

class Bone {
 public:
  explicit Bone(const BoneData& data);
  const BoneData* data;
  Bone* parent = nullptr;
  std::vector<Bone*> children;
  /** Local pose written by animations and scripts. */
  double x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, shearX = 0, shearY = 0;
  Inherit inherit = Inherit::Normal;
  bool active = true;
  /** Local values used for the world transform this frame (constraints may change them). */
  LocalTransform applied;
  Affine world;

  const std::string& name() const { return data->name; }
  void setToSetupPose();
  void resetApplied();
  void updateWorld(const Affine& root);
  void syncApplied(const Affine& root);
  void updateSubtree(const Affine& root, bool includeSelf = true);
  double get(BoneProp p) const;
  void set(BoneProp p, double v);
  double worldRotation() const;
};

class Slot {
 public:
  Slot(const SlotData& data, Bone* bone);
  const SlotData* data;
  Bone* bone;
  RGBA color{1, 1, 1, 1};
  std::optional<RGBA> dark;
  std::optional<std::string> attachmentName;
  std::unordered_map<std::string, std::vector<double>> deform;
  std::unordered_map<std::string, double> sequenceFrames;
  const std::string& name() const { return data->name; }
  void setToSetupPose();
};

/** The texture a draw item samples: an image asset or an atlas page (or the built-in particle dot). */
struct TextureRef {
  Id id;
  double width = 0, height = 0;
  /** The image asset or atlas page (null for the particle dot). */
  const std::string* src = nullptr;
};

inline const char* const PARTICLE_DOT_TEXTURE = "@openbone/particle-dot";
constexpr int PARTICLE_DOT_SIZE = 64;
/** Alpha of the soft round particle sprite at distance r from its centre (0 = centre, 1 = edge). */
double particleDotAlpha(double r);

struct TextDraw {
  std::string content, font;
  double size = 16, weight = 400;
  TextAlign align = TextAlign::Center;
  double width = 0, height = 0;
  RGBA fill{1, 1, 1, 1};
  std::optional<RGBA> outline;
  double outlineWidth = 0;
  /** Box centre to world (skeleton space, y-up). */
  Affine matrix;
};

struct ClipRegion {
  const Slot* slot = nullptr;
  std::vector<float> polygon;
  std::vector<uint16_t> indices;
};

struct DrawItem {
  const Slot* slot = nullptr;
  const Attachment* attachment = nullptr;
  /** "region", "mesh", "sequence", "shape", "text" or "particles". */
  const char* type = "";
  const ImageAsset* image = nullptr;
  std::optional<TextureRef> texture;
  std::vector<float> vertices;  // world x,y pairs
  std::vector<float> uvs;       // texture space, v down
  std::vector<uint16_t> indices;
  RGBA color{1, 1, 1, 1};
  std::optional<RGBA> dark;
  BlendMode blend = BlendMode::Normal;
  /** Index into DrawList::clips, or -1. */
  int clip = -1;
  /** Particles: per-vertex RGBA (replaces `color`). */
  std::vector<float> colors;
  bool isParticles = false;
  ParticleLook look = ParticleLook::Circle;
  int particleCount = 0;
  std::optional<TextDraw> text;
  /** Shapes with a stroke. */
  bool hasStroke = false;
  RGBA strokeColor{0, 0, 0, 1};
  double strokeWidth = 0;
};

struct DrawList {
  std::vector<DrawItem> items;
  std::vector<ClipRegion> clips;
};

struct FiredEvent {
  std::string name;
  Id id;
  double time = 0, intValue = 0, floatValue = 0;
  std::string stringValue;
  std::optional<std::string> audio;
  std::optional<double> volume;
  std::string animation;
};

struct AudioCommand {
  enum class Type : uint8_t { Play, Stop, Fade } type = Type::Play;
  std::string id;
  // play
  Id sound, asset;
  std::optional<Id> bus;
  double volume = 1, rate = 1, fadeIn = 0;
  bool loop = false;
  std::string source;
  // stop: fade seconds; fade: duration
  double fade = 0, duration = 0;
};

struct EmitterValues {
  std::optional<bool> emitting;
  std::optional<double> rate;
};

class ParticleEmitter;

/** Live constraint values (setup values overwritten by timelines and bindings). */
struct ConstraintValues {
  double v[static_cast<int>(CProp::Count)] = {};
  bool has[static_cast<int>(CProp::Count)] = {};
  double get(CProp p, double fallback = 0) const { return has[int(p)] ? v[int(p)] : fallback; }
  void set(CProp p, double x) { v[int(p)] = x; has[int(p)] = true; }
};

struct ConstraintRef {
  ConstraintKind kind;
  const void* data;
  const Id& id() const;
};

struct PhysicsState;

class Skeleton {
 public:
  explicit Skeleton(std::shared_ptr<const Document> doc);
  ~Skeleton();
  Skeleton(const Skeleton&) = delete;
  Skeleton& operator=(const Skeleton&) = delete;

  std::shared_ptr<const Document> docPtr;
  const Document& doc;
  std::vector<std::unique_ptr<Bone>> bones;
  std::vector<std::unique_ptr<Slot>> slots;
  std::vector<Slot*> drawOrder;
  const SkinData* skin = nullptr;
  std::unordered_map<Id, ConstraintValues> constraintValues;
  /** Placement of the skeleton (applied to root bones). */
  double x = 0, y = 0, scaleX = 1, scaleY = 1;
  double clock = 0;
  std::optional<double> animationTime;
  std::unordered_map<Id, double> inputValues;
  bool particleClockRealtime = true;
  std::unordered_map<Id, EmitterValues> particleValues;
  std::unordered_map<Id, std::string> textOverrides;
  /** Values for text templates by input name (the running state machine sets it). */
  std::function<Value(const std::string&)> textValues;

  Bone* findBone(const std::string& ref) const;
  Slot* findSlot(const std::string& ref) const;
  Bone* boneById(const Id& id) const;
  Slot* slotById(const Id& id) const;

  void setSkin(const std::string* ref);
  void setSkin(const std::string& ref) { setSkin(&ref); }
  void updateActive();
  bool isConstraintActive(const Id& id) const { return !inactiveConstraints.count(id); }
  void setToSetupPose();
  void update(double dt);
  void updateWorldTransform();

  void resetParticles();
  void seekParticles(double t, const std::function<void(double)>& pose);
  void setEmitting(const std::string& slotRef, bool emitting);
  void restartEmitter(const std::string& slotRef);
  void emitParticles(const std::string& slotRef, double count);
  void resetPhysics();
  double unitScaleX() const;
  double unitScaleY() const;

  const Attachment* getAttachment(const Slot& slot) const;
  const Attachment* getAttachment(const Slot& slot, const std::optional<std::string>& name) const;
  std::vector<float> attachmentWorldVertices(const Slot& slot, const Attachment& att) const;
  std::string textContent(const Slot& slot, const Attachment& att) const;
  void setText(const std::string& slotRef, const std::optional<std::string>& text);
  double sequenceCounter(const Slot& slot, const Attachment& att) const;
  int sequenceFrame(const Slot& slot, const Attachment& att) const;

  DrawList drawList() const;
  /** World polygon used for hit-testing a slot (empty when it has none). */
  std::vector<float> hitPolygon(const Slot& slot) const;
  bool hitTest(const Slot& slot, double x, double y) const;
  /** Axis-aligned bounds of everything drawn plus bones: minX, minY, maxX, maxY. */
  std::array<double, 4> bounds() const;
  const std::vector<ConstraintRef>& constraintOrder() const { return order; }

  Affine rootMatrix() const { return {scaleX, 0, 0, scaleY, x, y}; }

 private:
  friend void applyAnimation(Skeleton&, const AnimationData&, double, double);
  struct Packed;
  std::unordered_map<Id, Bone*> boneMap;
  std::unordered_map<Id, Slot*> slotMap;
  std::unordered_map<Id, const ImageAsset*> images;
  std::unordered_map<Id, std::unique_ptr<Packed>> packed;
  bool hasWhite = false;
  const AtlasPage* whitePage = nullptr;
  double whiteU = 0, whiteV = 0;
  std::unordered_map<Id, std::unique_ptr<PhysicsState>> physicsState;
  std::unordered_map<Id, double> inputDefaults;
  std::unordered_map<std::string, Value> inputDefaultsByName;
  double pendingDt = 0;
  mutable std::unique_ptr<std::unordered_map<Id, Affine>> setupCache;
  std::unordered_map<Id, std::unique_ptr<ParticleEmitter>> emitters;
  double particlePending = 0, particleFrac = 0;
  long long particleSteps = 0;
  std::vector<std::pair<Id, double>> pendingBursts;
  std::vector<ConstraintRef> order;
  std::unordered_set<Id> requiredBones, requiredConstraints;
  bool activeComputed = false;
  const SkinData* activeFor = nullptr;
  std::unordered_set<Id> inactiveConstraints;
  mutable std::unordered_map<const Attachment*, std::vector<uint16_t>> triCache;

  ConstraintValues& values(const ConstraintRef& c);
  void applySliders();
  void applyIk(const IkConstraintData& c, ConstraintValues& v);
  void applyTransform(const TransformConstraintData& c, ConstraintValues& v);
  void applyPath(const PathConstraintData& c, ConstraintValues& v);
  void applyPhysics(const PhysicsConstraintData& c, ConstraintValues& v, double dt);
  void stepParticles(double h);
  void advanceParticles(double dt);
  Affine setupWorldOf(const Id& id) const;
  bool sequenceItem(const Slot& slot, const Attachment& att, int index, DrawItem& out) const;
  bool particleItem(const Slot& slot, const Attachment& att, DrawItem& out) const;
  const std::vector<uint16_t>& triangulated(const Attachment& att, const std::vector<double>& outline) const;
};

// ---------------- Animation ----------------

/** Pose `sk` with `anim` at local time `time`, blended over the current pose by `alpha`. */
void applyAnimation(Skeleton& sk, const AnimationData& anim, double time, double alpha = 1);
double localTime(const AnimationData& anim, double total, bool loop);
std::vector<FiredEvent> eventsBetween(const Document& doc, const AnimationData& anim, double prev, double next, bool loop);

// ---------------- Audio ----------------

struct PlayOptions {
  std::optional<double> volume, rate;
  std::optional<bool> loop;
  std::optional<std::string> owner, tag;
  std::string source;
};

/** Bookkeeping of playing sounds; turns play/stop requests into AudioCommands. */
class AudioDirector {
 public:
  AudioDirector(const Document& doc, std::function<void(const AudioCommand&)> out);
  void update(double dt);
  std::optional<std::string> play(const std::string& ref, const PlayOptions& o = {});
  void stop(const std::string& id, std::optional<double> fade = std::nullopt);
  void stopSound(const std::string& ref, std::optional<double> fade = std::nullopt);
  void stopOwner(const std::string& owner, double fade = 0, bool all = false);
  void fade(const std::string& id, double volume, double duration);
  void stopAll(double fade = 0);
  double time = 0;

 private:
  struct Playing {
    std::string id;
    SoundData sound;
    std::optional<std::string> owner, tag;
    bool loop;
    double volume, startedAt, endsAt;
  };
  const Document& doc;
  std::function<void(const AudioCommand&)> out;
  std::vector<Playing> playing;
};

void playAudioKeys(AudioDirector& dir, const AnimationData& anim, double prev, double next, bool loop, const std::string& owner);

// ---------------- AnimationState ----------------

class TrackEntry {
 public:
  TrackEntry(const AnimationData* anim, bool loop);
  std::string uid;
  const AnimationData* animation;
  bool loop;
  double time = 0, prevTime = -1e-6, speed = 1, alpha = 1;
  std::shared_ptr<TrackEntry> mixingFrom;
  double mixTime = 0, mixDuration = 0;
  double completedLoops = 0;
  double duration() const { return animation->computedDuration; }
  double localTime() const;
  bool isComplete() const { return !loop && time >= duration(); }
};

class AnimationState {
 public:
  explicit AnimationState(Skeleton& sk);
  Skeleton& skeleton;
  std::vector<std::shared_ptr<TrackEntry>> tracks;
  double defaultMix = 0.2;
  AudioDirector audio;
  std::function<void(const FiredEvent&, int track)> onEvent;
  std::function<void(const TrackEntry&, int track)> onStart, onComplete;
  std::function<void(const AudioCommand&)> onAudio;

  std::shared_ptr<TrackEntry> setAnimation(int track, const std::string& anim, bool loop = true, std::optional<double> mix = std::nullopt);
  std::shared_ptr<TrackEntry> addAnimation(int track, const std::string& anim, bool loop = true, double delay = 0, std::optional<double> mix = std::nullopt);
  void clearTrack(int track);
  void clearTracks();
  void update(double dt);
  void apply();
  void apply(Skeleton& sk);

 private:
  struct Queued { int track; std::shared_ptr<TrackEntry> entry; double delay, mix; };
  std::vector<Queued> queue;
  const AnimationData* resolve(const std::string& anim) const;
  void endEntry(TrackEntry* e, double fade = 0);
};

// ---------------- Scripts ----------------

/** A loaded script. Arguments and results cross as JSON text (like the QuickJS host in packages/scripting). */
class ScriptHandle {
 public:
  virtual ~ScriptHandle() = default;
  virtual bool has(const std::string& fn) = 0;
  /** Call `fn` with a JSON array of arguments. Throws std::runtime_error on script errors or timeouts. */
  virtual void call(const std::string& fn, const std::string& argsJson) = 0;
};

/** The `ob` API: method name + JSON array of args → JSON result (nullopt = undefined). May throw (becomes a JS error). */
using ScriptApi = std::function<std::optional<std::string>(const std::string& method, const std::string& argsJson)>;

class ScriptHost {
 public:
  virtual ~ScriptHost() = default;
  /** Load a script. Throws std::runtime_error on syntax errors / timeouts. */
  virtual std::unique_ptr<ScriptHandle> load(const ScriptData& script, ScriptApi api) = 0;
};

/** The embedded QuickJS host (16 ms per call, 50 ms per load, 8 MB heap), or null when built without scripts. */
std::shared_ptr<ScriptHost> createQuickJsHost(double timeoutMs = 16, size_t memoryLimit = 8 * 1024 * 1024);

// ---------------- State machine ----------------

class StateMachineInstance {
 public:
  StateMachineInstance(Skeleton& sk, const StateMachineData& data, std::shared_ptr<ScriptHost> host = nullptr);
  ~StateMachineInstance();
  Skeleton& skeleton;
  const StateMachineData& data;
  AudioDirector audio;

  std::function<void(const FiredEvent&)> onEvent;
  std::function<void(const std::string& layer, const std::string* from, const std::string& to)> onStateChange;
  std::function<void(const std::string& name, const Value& value)> onInputChange;
  std::function<void(const std::string& message)> onLog, onError;
  std::function<void(const AudioCommand&)> onAudio;

  Value getInput(const std::string& ref) const;
  /** Set an input by id or name (triggers fire). Unknown inputs throw std::runtime_error. */
  void setInput(const std::string& ref, const Value& value);
  void fire(const std::string& ref);
  void setText(const std::string& slot, const std::optional<std::string>& text) { skeleton.setText(slot, text); }
  void setEmitter(const std::string& slotRef, bool emitting);
  /** Active state per layer: (layer name, state name, "exit", or nullopt). */
  std::vector<std::pair<std::string, std::optional<std::string>>> activeStates() const;
  /** Queue a pointer event in skeleton space (y-up); processed on the next advance(). */
  void pointer(PointerEvent type, double x, double y);
  void advance(double dt);
  void applyBindings();
  void clearOverrides();
  void dispose();

 private:
  struct Impl;
  std::unique_ptr<Impl> impl;
};

// ---------------- Instance ----------------

/** One skeleton driven by an AnimationState (play/queue) or by a state machine. */
class Instance {
 public:
  explicit Instance(std::shared_ptr<const Document> doc, std::shared_ptr<ScriptHost> host = nullptr);
  ~Instance();
  std::shared_ptr<const Document> doc;
  std::unique_ptr<Skeleton> skeleton;
  std::unique_ptr<AnimationState> animationState;
  std::unique_ptr<StateMachineInstance> stateMachine;

  std::function<void(const FiredEvent&)> onEvent;
  std::function<void(const AudioCommand&)> onAudio;
  std::function<void(const std::string& layer, const std::string* from, const std::string& to)> onStateChange;

  std::shared_ptr<TrackEntry> play(const std::string& animation, bool loop = true, int track = 0);
  /** Start a state machine by name or id (empty = the first). Throws if missing. */
  StateMachineInstance& useStateMachine(const std::string& name = "");
  void advance(double dt);
  void pointer(PointerEvent type, double x, double y);
  void dispose();
  DrawList drawList() const { return skeleton->drawList(); }

 private:
  std::shared_ptr<ScriptHost> host;
};

}  // namespace openbone
