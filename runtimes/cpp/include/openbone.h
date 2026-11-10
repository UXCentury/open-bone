/*
 * OpenBone C API: a stable, FFI-friendly surface over the C++ runtime (libopenbone).
 * Opaque handles, plain structs, no C++ types. Swift, Dart, C#, Python… can bind it directly.
 *
 * Lifetime rules
 *   - ob_document is immutable once loaded and may be shared by many instances; free it after its instances.
 *   - Strings and arrays returned by the API are owned by the library. Document strings live as long as the
 *     document; per-frame data (draw items, clips, events passed to callbacks) is valid until the next call that
 *     changes the instance (advance, update_draw_list, set_*, play, free).
 *   - Functions returning int return 1 (or a count) on success and 0 / -1 on failure; ob_last_error() then says why.
 *   - Not thread-safe per instance; different instances may be used from different threads.
 *
 * Coordinates are skeleton space: x right, y up, units = document pixels. ob_artboard_to_skeleton converts from the
 * document's artboard (y down, origin top-left).
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef OPENBONE_H
#define OPENBONE_H

#include <stddef.h>
#include <stdint.h>

#if defined(OPENBONE_STATIC)
#define OB_API
#elif defined(_WIN32)
#if defined(OPENBONE_BUILDING_DLL)
#define OB_API __declspec(dllexport)
#else
#define OB_API __declspec(dllimport)
#endif
#else
#define OB_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define OB_API_VERSION 1

typedef struct ob_document ob_document;
typedef struct ob_instance ob_instance;
typedef struct ob_bounds ob_bounds;

typedef enum ob_blend { OB_BLEND_NORMAL = 0, OB_BLEND_ADDITIVE = 1, OB_BLEND_MULTIPLY = 2, OB_BLEND_SCREEN = 3 } ob_blend;

typedef enum ob_pointer_type { OB_POINTER_DOWN = 0, OB_POINTER_UP = 1, OB_POINTER_MOVE = 4 } ob_pointer_type;

typedef enum ob_value_type { OB_VALUE_NONE = 0, OB_VALUE_BOOL = 1, OB_VALUE_NUMBER = 2, OB_VALUE_STRING = 3 } ob_value_type;

typedef enum ob_item_kind {
  OB_ITEM_REGION = 0,
  OB_ITEM_MESH = 1,
  OB_ITEM_SEQUENCE = 2,
  OB_ITEM_SHAPE = 3,
  OB_ITEM_TEXT = 4,
  OB_ITEM_PARTICLES = 5
} ob_item_kind;

/* OB_AUDIO_MIX: a setMute listener action muted (muted = 1) or unmuted `bus` (NULL = the master) on top of the
 * document's mix; apply it to that bus's gain (or every sound for the master). */
typedef enum ob_audio_type { OB_AUDIO_PLAY = 0, OB_AUDIO_STOP = 1, OB_AUDIO_FADE = 2, OB_AUDIO_MIX = 3 } ob_audio_type;

/** Instance creation flags. */
#define OB_INSTANCE_SCRIPTS 1 /* run document scripts in the embedded QuickJS sandbox (ignored when built without) */

/** A texture source: an image asset or an atlas page. `src` is a data: URL or a path relative to the document. */
typedef struct ob_texture_info {
  const char* id;
  const char* name;
  const char* src;
  double width, height;
  int is_atlas_page;
  int premultiplied_alpha; /* atlas pages only */
} ob_texture_info;

typedef struct ob_bone_info {
  const char* name;
  const char* parent; /* NULL for a root bone */
  double length;
  /* World matrix: x' = a*x + b*y + x0, y' = c*x + d*y + y0. */
  double a, b, c, d, x, y;
  int active;
} ob_bone_info;

/** One draw call worth of geometry, in draw order. Pointers stay valid until the instance changes. */
typedef struct ob_draw_item {
  const char* slot;
  const char* attachment;
  ob_item_kind kind;
  ob_blend blend;
  /** Texture id (image or atlas page id, or "@openbone/particle-dot"), NULL = untextured (solid colour). */
  const char* texture_id;
  const char* texture_src; /* NULL for the particle dot */
  double texture_width, texture_height;
  const float* vertices; /* x,y pairs, skeleton space */
  const float* uvs;      /* u,v pairs, 0..1 in the texture, v down */
  int vertex_count;
  const uint16_t* indices;
  int index_count;
  /** Tint (straight alpha). Ignored when `colors` is set. */
  float color[4];
  /** Two-colour tint: output = dark + (color - dark) * texture.rgb; has_dark = 0 means black (plain multiply). */
  int has_dark;
  float dark[3];
  /** Per-vertex RGBA (particles), or NULL. */
  const float* colors;
  /** Index of the clipping mask (ob_instance_clip) this item is drawn inside, or -1. */
  int clip;
  /** Text attachments: resolved content and style; the box (width × height) is centred on text_matrix's origin. */
  const char* text;
  const char* font;
  double font_size, font_weight;
  int text_align; /* 0 left, 1 center, 2 right */
  double text_width, text_height;
  float text_fill[4];
  int has_outline;
  float text_outline[4];
  double outline_width;
  double text_matrix[6]; /* a, b, c, d, x, y (box centre to skeleton space) */
  /** Shapes: stroke (has_stroke, colour, width); vertices are the outline. */
  int has_stroke;
  float stroke_color[4];
  double stroke_width;
} ob_draw_item;

/** A slot's current state (after advance): attachment shown, tint and optional dark (two-colour) tint. */
typedef struct ob_slot_info {
  const char* name;
  const char* bone;       /* bone name */
  const char* attachment; /* attachment name, or NULL when the slot is empty */
  float color[4];
  int has_dark;
  float dark[3];
  ob_blend blend;
} ob_slot_info;

typedef struct ob_clip {
  const char* slot;
  const float* polygon; /* x,y pairs */
  int vertex_count;
  const uint16_t* indices;
  int index_count;
} ob_clip;

typedef struct ob_event {
  const char* name;
  const char* id;
  double time;
  double int_value;
  double float_value;
  const char* string_value;
  const char* animation; /* "" for listener/script events */
  const char* audio;     /* sound the event plays, or NULL */
} ob_event;

typedef struct ob_audio_command {
  ob_audio_type type;
  const char* id; /* playing instance id; stop/fade refer to it */
  /* play */
  const char* sound;
  const char* asset;
  const char* bus; /* NULL = master */
  double volume, rate, fade_in;
  int loop;
  const char* source;
  /* stop: fade-out seconds; fade: target volume (volume) over duration */
  double fade, duration;
  /* mix: 1 = `bus` (NULL = master) muted, 0 = unmuted. Appended last so older callers keep their layout. */
  int muted;
} ob_audio_command;

typedef struct ob_value {
  ob_value_type type;
  int b;
  double n;
  const char* s;
} ob_value;

typedef void (*ob_event_fn)(void* user, const ob_event* event);
typedef void (*ob_audio_fn)(void* user, const ob_audio_command* command);
typedef void (*ob_state_fn)(void* user, const char* layer, const char* from, const char* to);
typedef void (*ob_log_fn)(void* user, const char* message, int is_error);

/* ---------- Library ---------- */
OB_API int ob_api_version(void);
OB_API const char* ob_version(void);
/** Message of the last failure on this thread ("" if none). */
OB_API const char* ob_last_error(void);
/** 1 when built with the QuickJS script host. */
OB_API int ob_has_scripts(void);

/* ---------- Documents ---------- */
OB_API ob_document* ob_document_load_file(const char* path);
/** .obone JSON or .obonb binary bytes (copied). */
OB_API ob_document* ob_document_load_memory(const void* data, size_t size);
OB_API void ob_document_free(ob_document* doc);
OB_API void ob_document_size(const ob_document* doc, double* width, double* height, double* origin_x, double* origin_y);
OB_API int ob_document_animation_count(const ob_document* doc);
OB_API const char* ob_document_animation_name(const ob_document* doc, int index);
OB_API double ob_document_animation_duration(const ob_document* doc, int index);
/** Sound files of the document (for playing its audio commands): `src` is a data: URL or a path relative to the document. */
typedef struct ob_audio_asset {
  const char* id;
  const char* name;
  const char* src;
  double duration;
} ob_audio_asset;
/** A mixer bus: audio commands name their bus; its volume multiplies the command's volume. */
typedef struct ob_audio_bus {
  const char* id;
  const char* name;
  double volume;
  int muted;
} ob_audio_bus;
OB_API int ob_document_audio_asset_count(const ob_document* doc);
OB_API int ob_document_audio_asset(const ob_document* doc, int index, ob_audio_asset* out);
OB_API int ob_document_audio_bus_count(const ob_document* doc);
OB_API int ob_document_audio_bus(const ob_document* doc, int index, ob_audio_bus* out);
/** Master volume (0 when the document's audio is muted, 1 when it has no audio settings). */
OB_API double ob_document_audio_master(const ob_document* doc);
OB_API int ob_document_skin_count(const ob_document* doc);
OB_API const char* ob_document_skin_name(const ob_document* doc, int index);
OB_API int ob_document_state_machine_count(const ob_document* doc);
OB_API const char* ob_document_state_machine_name(const ob_document* doc, int index);
/** Number of inputs of a state machine, and each input's name/type (default value in *def). */
OB_API int ob_document_input_count(const ob_document* doc, int state_machine);
OB_API int ob_document_input(const ob_document* doc, int state_machine, int index, const char** name, ob_value* def, int* is_trigger);
/** Textures a renderer may need: atlas pages first, then images. */
OB_API int ob_document_texture_count(const ob_document* doc);
OB_API int ob_document_texture(const ob_document* doc, int index, ob_texture_info* out);

/* ---------- Instances ---------- */
OB_API ob_instance* ob_instance_create(ob_document* doc, int flags);
OB_API void ob_instance_free(ob_instance* inst);
/** Set the skin by name or id; NULL or "" = none (default skin attachments only). */
OB_API int ob_instance_set_skin(ob_instance* inst, const char* skin);
/** Skeleton placement (applied to root bones). Defaults: 0, 0, 1, 1. */
OB_API void ob_instance_set_transform(ob_instance* inst, double x, double y, double scale_x, double scale_y);

/** Play an animation on a track (replaces a running state machine). Cross-fades over 0.2 s from what was playing. */
OB_API int ob_instance_play(ob_instance* inst, const char* animation, int loop, int track);
/** Queue an animation after the current one completes (or after `delay` seconds when > 0). */
OB_API int ob_instance_queue(ob_instance* inst, const char* animation, int loop, int track, double delay);
OB_API void ob_instance_clear_tracks(ob_instance* inst);

/** Start a state machine by name or id (NULL = the first). */
OB_API int ob_instance_use_state_machine(ob_instance* inst, const char* name);
OB_API int ob_instance_set_bool(ob_instance* inst, const char* input, int value);
OB_API int ob_instance_set_number(ob_instance* inst, const char* input, double value);
OB_API int ob_instance_set_string(ob_instance* inst, const char* input, const char* value);
OB_API int ob_instance_fire(ob_instance* inst, const char* trigger);
/** Current value of a state-machine input (strings valid until the next call on this instance). */
OB_API int ob_instance_get_input(ob_instance* inst, const char* input, ob_value* out);
/** Pointer event in skeleton space; processed by the next advance. */
OB_API int ob_instance_pointer(ob_instance* inst, ob_pointer_type type, double x, double y);
OB_API void ob_artboard_to_skeleton(const ob_document* doc, double px, double py, double* x, double* y);
/** Number of state-machine layers, and the active state of one ("exit", a state name, or NULL). */
OB_API int ob_instance_layer_count(const ob_instance* inst);
OB_API int ob_instance_active_state(const ob_instance* inst, int layer, const char** layer_name, const char** state_name);
/** Show fixed text (or a {template}) in a slot's text attachment; NULL restores the attachment's own text. */
OB_API int ob_instance_set_text(ob_instance* inst, const char* slot, const char* text);

/** Step time by dt seconds and pose the skeleton (fires callbacks). advance(0) poses without moving time. */
OB_API void ob_instance_advance(ob_instance* inst, double dt);

OB_API void ob_instance_set_event_callback(ob_instance* inst, ob_event_fn fn, void* user);
OB_API void ob_instance_set_audio_callback(ob_instance* inst, ob_audio_fn fn, void* user);
OB_API void ob_instance_set_state_callback(ob_instance* inst, ob_state_fn fn, void* user);
OB_API void ob_instance_set_log_callback(ob_instance* inst, ob_log_fn fn, void* user);

/* ---------- Pose and draw list ---------- */
OB_API int ob_instance_bone_count(const ob_instance* inst);
OB_API int ob_instance_bone(const ob_instance* inst, int index, ob_bone_info* out);
OB_API int ob_instance_find_bone(const ob_instance* inst, const char* name);
/** Slots in document (setup) order; strings valid until the instance changes. */
OB_API int ob_instance_slot_count(const ob_instance* inst);
OB_API int ob_instance_slot(const ob_instance* inst, int index, ob_slot_info* out);
/** Index of a slot by name or id, or -1. */
OB_API int ob_instance_find_slot(const ob_instance* inst, const char* name);
/** Alpha of the built-in soft particle sprite ("@openbone/particle-dot", 64 px) at distance r from its centre (0..1). */
OB_API double ob_particle_dot_alpha(double r);
/** Rebuild the draw list from the current pose; returns the item count. */
OB_API int ob_instance_update_draw_list(ob_instance* inst);
OB_API int ob_instance_draw_item(const ob_instance* inst, int index, ob_draw_item* out);
OB_API int ob_instance_clip_count(const ob_instance* inst);
OB_API int ob_instance_clip(const ob_instance* inst, int index, ob_clip* out);
/** Bounds of the drawn geometry and bones: min x, min y, max x, max y. */
OB_API void ob_instance_bounds(ob_instance* inst, double out[4]);

/* ---------- Bounding-box queries (docs/runtime-spec.md §8.10, like Spine's SkeletonBounds) ----------
 * An ob_bounds is a snapshot of an instance's active bounding boxes: every slot, in draw order, whose bone is active
 * and whose current attachment is a bounding box. Take it with ob_bounds_update after advancing; it does not follow
 * the pose by itself. It keeps the document alive and does not reference the instance, so it may outlive it.
 * Box indices are 0..ob_bounds_count-1 in draw order; with no box every query returns nothing. */

/** One bounding box: names (valid while the ob_bounds lives), world polygon (valid until the next update). */
typedef struct ob_bounding_box {
  const char* slot;       /* slot name */
  const char* attachment; /* attachment name */
  const float* vertices;  /* x,y pairs, skeleton space */
  int vertex_count;
  double min_x, min_y, max_x, max_y;
} ob_bounding_box;

OB_API ob_bounds* ob_bounds_create(void);
OB_API void ob_bounds_free(ob_bounds* bounds);
/** Recompute from the instance's current pose; returns the box count (0 on failure, see ob_last_error). */
OB_API int ob_bounds_update(ob_bounds* bounds, const ob_instance* inst);
OB_API int ob_bounds_count(const ob_bounds* bounds);
OB_API int ob_bounds_box(const ob_bounds* bounds, int index, ob_bounding_box* out);
/** Overall AABB (min x, min y, max x, max y); returns 0 (and writes zeros) when there is no box. */
OB_API int ob_bounds_aabb(const ob_bounds* bounds, double out[4]);
/** 1 when the point is inside the overall AABB (edges included). */
OB_API int ob_bounds_aabb_contains_point(const ob_bounds* bounds, double x, double y);
/** 1 when the overall AABB overlaps the rectangle (edges included). */
OB_API int ob_bounds_aabb_intersects(const ob_bounds* bounds, double min_x, double min_y, double max_x, double max_y);
/** Index of the first box containing the point (even-odd rule), or -1. */
OB_API int ob_bounds_contains_point(const ob_bounds* bounds, double x, double y);
/** Every box containing the point: writes up to `capacity` indices to `out` (may be NULL) and returns the full count. */
OB_API int ob_bounds_contains_point_all(const ob_bounds* bounds, double x, double y, int* out, int capacity);
/** Index of the first box the segment touches (crosses an edge, or starts inside), or -1. */
OB_API int ob_bounds_intersects_segment(const ob_bounds* bounds, double x1, double y1, double x2, double y2);
/** Every box the segment touches; same out/capacity/return convention as ob_bounds_contains_point_all. */
OB_API int ob_bounds_intersects_segment_all(const ob_bounds* bounds, double x1, double y1, double x2, double y2, int* out, int capacity);
/** First overlapping pair between two snapshots (e.g. two characters): returns 1 and sets *mine / *theirs
 *  (either may be NULL), or 0 when none overlap. Mine is the outer loop, both in draw order. */
OB_API int ob_bounds_intersects_bounds(const ob_bounds* bounds, const ob_bounds* other, int* mine, int* theirs);

#ifdef __cplusplus
}
#endif

#endif /* OPENBONE_H */
