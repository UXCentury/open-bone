/**
 * `@openbone/core` without the op registry and DocumentStore (they pull in zod, ~450 KB, and are only needed for
 * editing). The bundle build aliases `@openbone/core` to this file; esbuild fails the build if a player module
 * imports something not re-exported here.
 */
export * from "@openbone/core/lite";
