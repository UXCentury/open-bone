# OpenBone.MonoGame

[MonoGame](https://monogame.net) (DesktopGL, 3.8) integration for the [OpenBone](https://github.com/UXCentury/open-bone)
C# runtime: a renderer (one draw call per texture / blend / clip run, premultiplied alpha, stencil clipping masks,
two-colour tint), a player that maps mouse and touch input to state-machine listeners, and a `SoundEffect` bridge for
audio commands with buses and fades. State-machine scripts run in Jint.

```csharp
using OpenBone.MonoGame;

// LoadContent (clipping masks need a stencil: graphics.PreferredDepthStencilFormat = DepthFormat.Depth24Stencil8)
knight = OpenBoneMonoGame.Load(GraphicsDevice, "Content/knight.obone");   // images and sounds relative to the file
knight.UseStateMachine("knight");                                          // or knight.Play("walk")

// Update
knight.Update(gameTime);

// Draw (after GraphicsDevice.Clear; no SpriteBatch)
knight.Draw();
```

Documentation: [MonoGame section of the C# runtime README](https://github.com/UXCentury/open-bone/tree/main/runtimes/csharp#monogame).
License: MIT.
