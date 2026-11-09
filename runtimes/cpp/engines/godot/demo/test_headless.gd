extends SceneTree
## Headless check of the GDExtension:
##   godot --headless --path runtimes/cpp/engines/godot/demo -s test_headless.gd -- <fixture.obone>
## Loads the document with OpenBoneSprite, plays its first animation, runs its first state machine with a click on
## the first listener's bone, and prints what it saw. Exits 0 on success, 1 on failure.

func fail(msg: String) -> void:
	printerr("FAIL: ", msg)
	quit(1)

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var path: String = args[0] if args.size() > 0 else "res://knight.obone"
	if not ClassDB.class_exists("OpenBoneSprite"):
		return fail("OpenBoneSprite is not registered (extension not loaded)")
	var sprite = ClassDB.instantiate("OpenBoneSprite")
	root.add_child(sprite)
	if not sprite.load(path):
		return fail("could not load " + path)
	var anims: PackedStringArray = sprite.get_animations()
	print("loaded ", path.get_file(), ": animations ", anims, ", state machines ", sprite.get_state_machines(), ", skins ", sprite.get_skins())
	var events: Array = []
	sprite.animation_event.connect(func(n, t, i, f, s): events.append(n))
	var audio: Array = []
	sprite.audio_command.connect(func(c): audio.append(c["type"]))
	if anims.size() > 0:
		sprite.play(anims[0], true)
		for i in 30:
			sprite.advance(1.0 / 60.0)
		var items: Array = sprite.get_draw_items()
		print("animation ", anims[0], ": ", items.size(), " draw items, bounds ", sprite.get_bounds())
		if items.is_empty():
			return fail("no draw items")
	var machines: PackedStringArray = sprite.get_state_machines()
	if machines.size() > 0:
		if not sprite.use_state_machine(machines[0]):
			return fail("use_state_machine failed")
		sprite.advance(0.0)
		print("state machine ", machines[0], ": ", sprite.get_active_state(0))
		# Press the centre of the first draw item a few times (the interactive fixture's button).
		var items: Array = sprite.get_draw_items()
		var b: Transform2D = sprite.get_bone_transform("body") if sprite.get_bone_transform("body") != Transform2D() else Transform2D()
		var p := Vector2(b.origin.x, -b.origin.y)
		for k in 3:
			sprite.pointer(4, p)
			sprite.pointer(0, p)
			sprite.advance(1.0 / 60.0)
			sprite.pointer(1, p)
			for i in 20:
				sprite.advance(1.0 / 60.0)
		var after: Array = sprite.get_draw_items()
		var texts := []
		for it in after:
			if it.has("text"):
				texts.append(it["text"])
		print("after clicks: state ", sprite.get_active_state(0), ", events ", events, ", audio ", audio, ", text ", texts)
	print("OK")
	quit(0)
