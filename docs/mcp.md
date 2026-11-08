# OpenBone MCP server

```bash
pnpm mcp                                  # stdio, plus live bridge on ws://127.0.0.1:7717
pnpm mcp --project ~/anim/hero.obone      # open (or create) a project at startup
pnpm mcp --http 7718                      # streamable HTTP at http://127.0.0.1:7718/mcp
pnpm mcp --no-bridge                      # no WebSocket bridge
```

## Tools

- **Project**: `new_project`, `open_project`, `save_project` (projects with a path autosave after every edit), `get_summary`, `get_document`, `validate`, `undo`, `redo`, `import_image`, `get_guide`.
- **Edit tools**: one per core op, for example `add_bone`, `update_bone`, `add_slot`, `add_shape`, `add_region`, `add_mesh`, `auto_weights`, `add_ik_constraint`, `create_animation`, `set_keys`, `add_event_key`, `create_state_machine`, `add_input`, `add_state`, `add_transition`, `add_listener`, `add_script`, `attach_script`, `set_atlas`. Run `pnpm cli ops` for the full list.
- **`pack_atlas`**: packs every image into texture atlas pages (embedded PNGs) and stores them with `set_atlas`, so renderers draw from one texture (fewer WebGL draw calls).
- **Verification**:
  - `render_frame`: returns a PNG (bones and hit boxes overlaid) for the setup pose, an animation at a time, or a state machine after scripted steps.
  - `render_gif`: an animated preview.
  - `simulate_state_machine`: a text log of state changes, events, input changes and script output for a sequence of steps (`setInputs`, `fire`, `pointer`, `advance`).
  - `inspect_pose`: world positions and rotations of bones.

Resources: `openbone://guide`, `openbone://document`, `openbone://summary`. Prompts: `rig_character`, `interactive_button`.

## Live editing

When the editor connects (**⚡ Connect MCP**), the server sends its document and from then on both sides exchange ops. The server is the source of truth: undo and redo in the editor are forwarded to it, and if an op fails the editor is resynced from the server.
