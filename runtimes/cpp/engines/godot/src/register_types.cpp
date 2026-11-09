// SPDX-License-Identifier: MIT
#include <gdextension_interface.h>

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/godot.hpp>

#include "openbone_node.hpp"

using namespace godot;

static void initialize_openbone(ModuleInitializationLevel level) {
  if (level != MODULE_INITIALIZATION_LEVEL_SCENE) return;
  GDREGISTER_CLASS(OpenBoneSprite);
}

static void uninitialize_openbone(ModuleInitializationLevel level) {}

extern "C" GDExtensionBool GDE_EXPORT openbone_library_init(GDExtensionInterfaceGetProcAddress get_proc_address, GDExtensionClassLibraryPtr library,
                                                            GDExtensionInitialization* initialization) {
  GDExtensionBinding::InitObject init(get_proc_address, library, initialization);
  init.register_initializer(initialize_openbone);
  init.register_terminator(uninitialize_openbone);
  init.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);
  return init.init();
}
