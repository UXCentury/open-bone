extends Node2D
## Shows the knight example with its state machine: click it, hover it, watch events and audio commands.

func _ready() -> void:
	var sprite := OpenBoneSprite.new()
	sprite.state_machine = "knight"
	sprite.position = Vector2(576, 520)
	add_child(sprite)
	sprite.load("res://knight.obone")
	sprite.animation_event.connect(func(n, t, i, f, s): print("event ", n, " at ", t))
	sprite.audio_command.connect(func(c): print("audio ", c))
	sprite.state_changed.connect(func(l, a, b): print(l, ": ", a, " -> ", b))
