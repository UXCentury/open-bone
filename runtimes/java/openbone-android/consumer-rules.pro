# OpenBone runtime: the loader and script bridge use plain reflection-free code; keep the public API names.
-keep class com.openbone.runtime.** { *; }
-keep class com.openbone.scripting.** { *; }
-keep class com.dokar.quickjs.** { *; }
