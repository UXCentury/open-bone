using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using OpenBone.MonoGame;

namespace OpenBone.MonoGame.Sample
{
    /// <summary>
    /// Shows examples/knight.obone with its state machine: click the knight's body to attack, his head to salute or the
    /// road to toggle walking (the listeners' slots). Space fires "attack", W toggles "walk", C toggles clipping to the
    /// stage (on by default; --no-clip starts with it off), Esc quits.
    ///
    /// Usage: OpenBone.MonoGame.Sample [file.obone] [--state-machine name] [--animation name]
    ///        [--screenshot out.png] [--frames n] [--click x,y@frame]... [--basic-effect] [--no-clip]
    /// --screenshot renders off-screen (after --frames frames at 60 fps, with the given clicks) to a PNG and exits.
    /// </summary>
    public sealed class SampleGame : Game
    {
        readonly GraphicsDeviceManager _graphics;
        readonly Options _options;
        OpenBoneMonoGame _player;
        KeyboardState _keys;
        RenderTarget2D _target;
        SpriteBatch _batch;
        int _frame;

        public SampleGame(Options options)
        {
            _options = options;
            _graphics = new GraphicsDeviceManager(this)
            {
                PreferredBackBufferWidth = 1080,
                PreferredBackBufferHeight = 720,
                // Clipping masks need a stencil buffer.
                PreferredDepthStencilFormat = DepthFormat.Depth24Stencil8,
                SynchronizeWithVerticalRetrace = true,
                PreferMultiSampling = false,
            };
            IsMouseVisible = true;
            Window.AllowUserResizing = true;
            Window.Title = "OpenBone MonoGame";
        }

        protected override void LoadContent()
        {
            _player = OpenBoneMonoGame.Load(GraphicsDevice, _options.File);
            _player.Warning += w => Console.WriteLine("warning: " + w);
            foreach (var w in _player.Textures.Warnings) Console.WriteLine("warning: " + w);
            foreach (var w in _player.FontWarnings) Console.WriteLine("warning: " + w);
            _player.AcceptInput = () => IsActive && _options.Screenshot == null;
            _player.Event += e => Console.WriteLine($"event {e.Name} at {e.Time:0.###}");
            _player.StateChanged += s => Console.WriteLine($"state {s.Layer}: {s.From ?? "-"} -> {s.To}");
            _player.PointerSent += (type, p) => { if (type != "move") Console.WriteLine($"pointer {type} at skeleton {p.X:0},{p.Y:0}"); };
            _player.AudioCommand += c => Console.WriteLine($"audio {c.Type} {c.Sound ?? c.Id}");
            if (_options.BasicEffect) _player.Renderer.UseTintEffect = false;
            Console.WriteLine(_player.Renderer.SupportsTwoColorTint ? "renderer: two-colour tint effect" : "renderer: BasicEffect fallback (" + _player.Renderer.EffectError + ")");

            if (_options.Animation != null) _player.Play(_options.Animation);
            else if (_player.Document.StateMachines.Count > 0)
            {
                var sm = _player.UseStateMachine(_options.StateMachine);
                sm.InputChanged += (name, value) => Console.WriteLine($"input {name} = {value}");
            }
            else if (_player.Document.Animations.Count > 0) _player.Play(_player.Document.Animations[0].Name);

            if (_options.Screenshot != null)
            {
                var pp = GraphicsDevice.PresentationParameters;
                _target = new RenderTarget2D(GraphicsDevice, pp.BackBufferWidth, pp.BackBufferHeight, false, SurfaceFormat.Color, DepthFormat.Depth24Stencil8);
                _player.Sound?.StopAll();
                if (_player.Sound != null) _player.Sound.Volume = 0;
            }
            _player.ClipToStage = !_options.NoClip;
            Window.Title = $"OpenBone MonoGame - {_player.Document.Name} (clip {(_player.ClipToStage ? "on" : "off")}, C toggles)";
        }

        protected override void Update(GameTime gameTime)
        {
            var keys = Keyboard.GetState();
            if (keys.IsKeyDown(Keys.Escape)) Exit();
            if (IsActive && keys.IsKeyDown(Keys.C) && !_keys.IsKeyDown(Keys.C))
            {
                _player.ClipToStage = !_player.ClipToStage;
                Console.WriteLine("clip to stage: " + (_player.ClipToStage ? "on" : "off"));
                Window.Title = $"OpenBone MonoGame - {_player.Document.Name} (clip {(_player.ClipToStage ? "on" : "off")}, C toggles)";
            }
            var sm = _player.StateMachine;
            if (sm != null && IsActive)
            {
                if (keys.IsKeyDown(Keys.Space) && !_keys.IsKeyDown(Keys.Space) && sm.Inputs.ContainsKey("attack")) sm.Fire("attack");
                if (keys.IsKeyDown(Keys.W) && !_keys.IsKeyDown(Keys.W) && sm.Inputs.ContainsKey("walk")) sm.SetInput("walk", !(sm.GetInput("walk") is bool b && b));
            }
            _keys = keys;

            if (_options.Screenshot != null)
            {
                // Deterministic off-screen run: fixed 60 fps steps and scripted clicks (the render target has the
                // back buffer's size, so the auto-fitted view is the same).
                foreach (var c in _options.Clicks.Where(c => c.Frame == _frame))
                {
                    Console.WriteLine($"click {c.Position} -> skeleton {_player.ScreenToSkeleton(c.Position)}");
                    _player.Pointer("down", c.Position);
                    _player.Pointer("up", c.Position);
                }
                _player.Update(1 / 60.0);
            }
            else _player.Update(gameTime);
            _frame++;
            base.Update(gameTime);
        }

        protected override void Draw(GameTime gameTime)
        {
            if (_target != null) GraphicsDevice.SetRenderTarget(_target);
            if (_player.ClipToStage)
            {
                // Dark bars around the stage, the document's background only on it (as the web player shows it).
                GraphicsDevice.Clear(ClearOptions.Target | ClearOptions.DepthBuffer | ClearOptions.Stencil, new Color(11, 6, 20), 1, 0);
                if (_player.AutoFit) _player.View = SkeletonView.FitStage(_player.Document, GraphicsDevice.Viewport.Bounds, _player.FitPadding);
                _batch ??= new SpriteBatch(GraphicsDevice);
                _batch.Begin();
                _batch.Draw(_player.Textures.White, _player.StageRectangle(), Background());
                _batch.End();
            }
            else GraphicsDevice.Clear(ClearOptions.Target | ClearOptions.DepthBuffer | ClearOptions.Stencil, Background(), 1, 0);
            _player.Draw();
            if (_target != null)
            {
                GraphicsDevice.SetRenderTarget(null);
                if (_frame >= _options.Frames)
                {
                    using (var f = File.Create(_options.Screenshot)) _target.SaveAsPng(f, _target.Width, _target.Height);
                    Console.WriteLine($"saved {_options.Screenshot} ({_target.Width}x{_target.Height}, {_player.Renderer.LastDrawCalls} draw calls)");
                    Exit();
                }
            }
            base.Draw(gameTime);
        }

        Color Background()
        {
            var bg = _player.Document.Background;
            if (!string.IsNullOrEmpty(bg) && bg.StartsWith("#") && bg.Length >= 7)
                return new Color(Convert.ToInt32(bg.Substring(1, 2), 16), Convert.ToInt32(bg.Substring(3, 2), 16), Convert.ToInt32(bg.Substring(5, 2), 16));
            return new Color(24, 26, 32);
        }

        protected override void UnloadContent()
        {
            _player?.Dispose();
            _target?.Dispose();
        }
    }

    public sealed class Click
    {
        public Vector2 Position;
        public int Frame;
    }

    public sealed class Options
    {
        public string File;
        public string StateMachine, Animation, Screenshot;
        public int Frames = 60;
        public bool BasicEffect, NoClip;
        public readonly List<Click> Clicks = new List<Click>();

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--state-machine": o.StateMachine = args[++i]; break;
                    case "--animation": o.Animation = args[++i]; break;
                    case "--screenshot": o.Screenshot = args[++i]; break;
                    case "--frames": o.Frames = int.Parse(args[++i]); break;
                    case "--basic-effect": o.BasicEffect = true; break;
                    case "--no-clip": o.NoClip = true; break;
                    case "--click":
                        {
                            var parts = args[++i].Split('@');
                            var xy = parts[0].Split(',');
                            o.Clicks.Add(new Click
                            {
                                Position = new Vector2(float.Parse(xy[0]), float.Parse(xy[1])),
                                Frame = parts.Length > 1 ? int.Parse(parts[1]) : 0,
                            });
                            break;
                        }
                    default: o.File = args[i]; break;
                }
            }
            o.File ??= FindExample("knight.obone");
            if (o.File == null) throw new FileNotFoundException("examples/knight.obone not found; pass a .obone / .obonb file");
            return o;
        }

        /// <summary>examples/&lt;name&gt; in the repository, found by walking up from the binaries.</summary>
        static string FindExample(string name)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                var p = Path.Combine(dir.FullName, "examples", name);
                if (System.IO.File.Exists(p)) return p;
            }
            return null;
        }
    }

    public static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            using var game = new SampleGame(Options.Parse(args));
            game.Run();
        }
    }
}
