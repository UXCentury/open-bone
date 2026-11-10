using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Microsoft.Xna.Framework.Input;
using Microsoft.Xna.Framework.Input.Touch;
using OpenBone.Scripting;

namespace OpenBone.MonoGame
{
    public sealed class OpenBoneMonoGameOptions
    {
        /// <summary>Script engine for state-machine scripts (default: Jint). Set <see cref="DisableScripts"/> to run none.</summary>
        public IScriptHost ScriptHost;
        public bool DisableScripts;
        /// <summary>Load the document's sounds and play its audio commands (default true).</summary>
        public bool Sound = true;
        /// <summary>Skin to show (name or id); null = default skin only.</summary>
        public string Skin;
    }

    /// <summary>
    /// One OpenBone document in a MonoGame game: loads it (textures and sounds included), plays an animation or a state
    /// machine, advances it in <see cref="Update(GameTime)"/>, feeds mouse / touch input to state-machine listeners and
    /// draws it with <see cref="OpenBoneRenderer"/> (no SpriteBatch needed).
    /// </summary>
    /// <example>
    /// <code>
    /// knight = OpenBoneMonoGame.Load(GraphicsDevice, "knight.obone");
    /// knight.UseStateMachine("knight");
    /// // Update: knight.Update(gameTime);   Draw: knight.Draw();
    /// </code>
    /// </example>
    public sealed class OpenBoneMonoGame : IDisposable
    {
        readonly GraphicsDevice _device;
        readonly PointerTracker _pointer = new PointerTracker();
        readonly List<PointerEvent> _pointerEvents = new List<PointerEvent>();

        public Document Document { get; }
        public OpenBoneInstance Instance { get; }
        public OpenBoneRenderer Renderer { get; }
        public OpenBoneTextures Textures { get; }
        /// <summary>The sound player, or null when sound is off.</summary>
        public OpenBoneSoundPlayer Sound { get; }

        /// <summary>Where the skeleton is drawn. Set it yourself after turning <see cref="AutoFit"/> off.</summary>
        public SkeletonView View;
        /// <summary>Fit the document's stage into the viewport every frame (default true).</summary>
        public bool AutoFit = true;
        /// <summary>Screen padding around the stage when <see cref="AutoFit"/> is on.</summary>
        public float FitPadding;
        /// <summary>Playback speed multiplier.</summary>
        public double TimeScale = 1;
        /// <summary>Read the mouse and touch panel in <see cref="Update(GameTime)"/> and send them to listeners.</summary>
        public bool PointerInput = true;
        /// <summary>When set and false, pointer input is ignored (e.g. <c>() =&gt; game.IsActive</c>).</summary>
        public Func<bool> AcceptInput;

        /// <summary>Animation and state-machine events.</summary>
        public event Action<FiredEvent> Event;
        public event Action<StateChange> StateChanged;
        /// <summary>Every audio command (also played by <see cref="Sound"/> when it is on).</summary>
        public event Action<AudioCommand> AudioCommand;
        /// <summary>Missing art or sounds, script errors.</summary>
        public event Action<string> Warning;
        /// <summary>Pointer events sent to the state machine, in skeleton space.</summary>
        public event Action<string, Vector2> PointerSent;

        /// <summary>Load a .obone / .obonb file; images and sounds resolve relative to it.</summary>
        public static OpenBoneMonoGame Load(GraphicsDevice device, string path, OpenBoneMonoGameOptions options = null)
        {
            var doc = DocumentLoader.Load(File.ReadAllBytes(path));
            return new OpenBoneMonoGame(device, doc, Path.GetDirectoryName(Path.GetFullPath(path)), options);
        }

        public OpenBoneMonoGame(GraphicsDevice device, Document doc, string baseDirectory, OpenBoneMonoGameOptions options = null)
        {
            options ??= new OpenBoneMonoGameOptions();
            _device = device ?? throw new ArgumentNullException(nameof(device));
            Document = doc ?? throw new ArgumentNullException(nameof(doc));
            var host = options.DisableScripts ? null : options.ScriptHost ?? new JintScriptHost();
            Instance = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = host });
            if (options.Skin != null) Instance.Skeleton.SetSkin(options.Skin);
            Textures = OpenBoneTextures.Load(device, doc, baseDirectory);
            Renderer = new OpenBoneRenderer(device);
            Renderer.MissingTexture += id => Warn($"no texture for \"{id}\"");
            if (Renderer.EffectError != null) Warn("two-colour tint effect unavailable, using BasicEffect: " + Renderer.EffectError);
            if (options.Sound)
            {
                Sound = new OpenBoneSoundPlayer(doc, baseDirectory);
                foreach (var w in Sound.Warnings) Warn(w);
                Sound.Warnings.Clear();
            }
            foreach (var w in Textures.Warnings) Warn(w);
            Instance.Event += e => Event?.Invoke(e);
            Instance.StateChanged += e => StateChanged?.Invoke(e);
            Instance.AudioCommand += c =>
            {
                Sound?.Handle(c);
                AudioCommand?.Invoke(c);
            };
            View = SkeletonView.FitStage(doc, device.Viewport.Bounds);
            Instance.Advance(0);
        }

        void Warn(string message) => Warning?.Invoke(message);

        public Skeleton Skeleton => Instance.Skeleton;
        public StateMachineInstance StateMachine => Instance.StateMachine;

        /// <summary>Play an animation on a track (stops any state machine).</summary>
        public TrackEntry Play(string animation, bool loop = true, int track = 0) => Instance.Play(animation, loop, track);

        /// <summary>Run a state machine (by name or id; null = the first one).</summary>
        public StateMachineInstance UseStateMachine(string name = null)
        {
            var sm = Instance.UseStateMachine(name);
            sm.Error += e => Warn("script error: " + e.Message);
            return sm;
        }

        public void SetSkin(string skin) => Instance.Skeleton.SetSkin(skin);

        public void Update(GameTime gameTime) => Update(gameTime.ElapsedGameTime.TotalSeconds);

        /// <summary>Read input, advance the skeleton by <paramref name="dt"/> seconds (× <see cref="TimeScale"/>), step sound fades.</summary>
        public void Update(double dt)
        {
            if (AutoFit) View = SkeletonView.FitStage(Document, _device.Viewport.Bounds, FitPadding);
            if (PointerInput) ReadPointer();
            Instance.Advance(dt * TimeScale);
            if (Sound != null)
            {
                Sound.Update(dt);
                if (Sound.Warnings.Count > 0)
                {
                    foreach (var w in Sound.Warnings) Warn(w);
                    Sound.Warnings.Clear();
                }
            }
        }

        void ReadPointer()
        {
            if (AcceptInput != null && !AcceptInput())
            {
                _pointerEvents.Clear();
                _pointer.Reset(_pointerEvents);
                Flush();
                return;
            }
            Vector2 pos;
            bool pressed;
            TouchCollection touches;
            try { touches = TouchPanel.GetState(); }
            catch (Exception) { touches = default; }
            if (touches.IsConnected && touches.Count > 0)
            {
                var t = touches[0];
                pos = t.Position;
                pressed = t.State == TouchLocationState.Pressed || t.State == TouchLocationState.Moved;
            }
            else
            {
                var m = Mouse.GetState();
                pos = new Vector2(m.X, m.Y);
                pressed = m.LeftButton == ButtonState.Pressed;
            }
            _pointer.Update(pos, pressed, _pointerEvents);
            Flush();
        }

        void Flush()
        {
            foreach (var e in _pointerEvents) Pointer(e.Type, e.Position);
            _pointerEvents.Clear();
        }

        /// <summary>Send a pointer event (down, up, move) at a screen position to the state machine.</summary>
        public void Pointer(string type, Vector2 screen)
        {
            var p = View.ScreenToSkeleton(screen);
            Instance.Pointer(type, p.X, p.Y);
            PointerSent?.Invoke(type, p);
        }

        public Vector2 ScreenToSkeleton(Vector2 screen) => View.ScreenToSkeleton(screen);
        public Vector2 SkeletonToScreen(double x, double y) => View.SkeletonToScreen(x, y);

        /// <summary>Screen position of a bone (by name or id), or null.</summary>
        public Vector2? BoneScreenPosition(string bone)
        {
            var b = Skeleton.FindBone(bone);
            return b == null ? (Vector2?)null : View.SkeletonToScreen(b.World.X, b.World.Y);
        }

        /// <summary>Draw the current pose (call between Clear and Present; restores device states).</summary>
        public void Draw()
        {
            if (AutoFit) View = SkeletonView.FitStage(Document, _device.Viewport.Bounds, FitPadding);
            Renderer.Draw(Instance, Textures, View);
        }

        public void Dispose()
        {
            Sound?.Dispose();
            Instance.Dispose();
            Renderer.Dispose();
            Textures.Dispose();
        }
    }
}
