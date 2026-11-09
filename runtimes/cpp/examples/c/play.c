/* Minimal C use of libopenbone: load a document, run its first state machine (or first animation), press the
 * centre of the artboard, advance one second, print events, audio commands and the draw list.
 *   openbone_c_example path/to/file.obone
 * SPDX-License-Identifier: MIT */
#include <openbone.h>
#include <stdio.h>

static void on_event(void* user, const ob_event* e) {
  (void)user;
  printf("event  %-10s t=%.3f int=%g float=%g string=\"%s\"\n", e->name, e->time, e->int_value, e->float_value, e->string_value);
}

static void on_audio(void* user, const ob_audio_command* c) {
  (void)user;
  if (c->type == OB_AUDIO_PLAY) printf("audio  play %s sound=%s volume=%.2f source=%s\n", c->id, c->sound, c->volume, c->source);
  else if (c->type == OB_AUDIO_STOP) printf("audio  stop %s fade=%.2f\n", c->id, c->fade);
  else printf("audio  fade %s -> %.2f over %.2f\n", c->id, c->volume, c->duration);
}

static void on_state(void* user, const char* layer, const char* from, const char* to) {
  (void)user;
  printf("state  %s: %s -> %s\n", layer, from ? from : "(none)", to);
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s file.obone\n", argv[0]);
    return 2;
  }
  ob_document* doc = ob_document_load_file(argv[1]);
  if (!doc) {
    fprintf(stderr, "load failed: %s\n", ob_last_error());
    return 1;
  }
  printf("OpenBone %s (scripts: %s): %d animations, %d state machines, %d skins\n", ob_version(), ob_has_scripts() ? "yes" : "no",
         ob_document_animation_count(doc), ob_document_state_machine_count(doc), ob_document_skin_count(doc));
  ob_instance* inst = ob_instance_create(doc, OB_INSTANCE_SCRIPTS);
  ob_instance_set_event_callback(inst, on_event, NULL);
  ob_instance_set_audio_callback(inst, on_audio, NULL);
  ob_instance_set_state_callback(inst, on_state, NULL);
  int machine = ob_document_state_machine_count(doc) > 0;
  if (machine) ob_instance_use_state_machine(inst, NULL);
  else if (ob_document_animation_count(doc) > 0) ob_instance_play(inst, ob_document_animation_name(doc, 0), 1, 0);
  ob_instance_advance(inst, 0);
  int clicked = 0;
  for (int i = 0; i < 60; i++) {
    if (machine && i == 10) {
      /* Click the first bone's origin (the interactive fixture's button sits on it). */
      ob_bone_info b;
      int bone = ob_instance_bone_count(inst) > 1 ? 1 : 0;
      if (ob_instance_bone(inst, bone, &b)) {
        ob_instance_pointer(inst, OB_POINTER_DOWN, b.x, b.y);
        ob_instance_pointer(inst, OB_POINTER_UP, b.x, b.y);
        clicked = 1;
      }
    }
    ob_instance_advance(inst, 1.0 / 60);
  }
  int n = ob_instance_update_draw_list(inst);
  printf("draw list: %d items%s\n", n, clicked ? " (after a click)" : "");
  for (int i = 0; i < n; i++) {
    ob_draw_item it;
    ob_instance_draw_item(inst, i, &it);
    printf("  %-12s %-10s kind=%d verts=%d tris=%d tex=%s%s%s\n", it.slot, it.attachment, (int)it.kind, it.vertex_count, it.index_count / 3,
           it.texture_id ? it.texture_id : "-", it.text ? " text=" : "", it.text ? it.text : "");
  }
  if (machine) {
    for (int l = 0; l < ob_instance_layer_count(inst); l++) {
      const char *layer, *state;
      ob_instance_active_state(inst, l, &layer, &state);
      printf("layer %s: %s\n", layer, state ? state : "(none)");
    }
  }
  ob_instance_free(inst);
  ob_document_free(doc);
  return 0;
}
