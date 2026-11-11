using System;
using System.Collections.Generic;

namespace OpenBone
{
    /// <summary>
    /// High-level handle: one skeleton driven by an <see cref="AnimationState"/> (play/queue animations) or by a
    /// state machine (inputs and listeners). The usual entry point for games (runtime/instance.ts).
    /// </summary>
    public sealed class OpenBoneInstance : IDisposable
    {
        public readonly Document Doc;
        public readonly Skeleton Skeleton;
        public readonly AnimationState AnimationState;
        public StateMachineInstance StateMachine { get; private set; }
        readonly StateMachineOptions _smOptions;

        public event Action<FiredEvent> Event;
        public event Action<StateChange> StateChanged;
        /// <summary>Sound commands from the animation state or the state machine; feed them to an audio backend.</summary>
        public event Action<AudioCommand> AudioCommand;

        public OpenBoneInstance(Document doc, StateMachineOptions options = null)
        {
            Doc = doc;
            _smOptions = options ?? new StateMachineOptions();
            Skeleton = new Skeleton(doc);
            AnimationState = new AnimationState(Skeleton);
            AnimationState.Event += (e, _) => Event?.Invoke(e);
            AnimationState.AudioCommand += c => AudioCommand?.Invoke(c);
        }

        public static OpenBoneInstance Load(byte[] bytes, StateMachineOptions options = null) => new OpenBoneInstance(DocumentLoader.Load(bytes), options);

        public TrackEntry Play(string animation, bool loop = true, int track = 0)
        {
            StateMachine?.Dispose();
            StateMachine = null;
            return AnimationState.SetAnimation(track, animation, loop);
        }

        public StateMachineInstance UseStateMachine(string name = null)
        {
            var data = name != null ? Doc.FindStateMachine(name) : Doc.StateMachines.Count > 0 ? Doc.StateMachines[0] : null;
            if (data == null) throw new ArgumentException(name != null ? $"State machine \"{name}\" not found" : "Document has no state machine");
            StateMachine?.Dispose();
            AnimationState.ClearTracks();
            var sm = new StateMachineInstance(Skeleton, data, _smOptions);
            sm.AudioCommand += c => AudioCommand?.Invoke(c);
            sm.Event += e => Event?.Invoke(e);
            sm.StateChanged += e => StateChanged?.Invoke(e);
            StateMachine = sm;
            return sm;
        }

        /// <summary>One frame: update animations or the state machine, pose, constraints, physics, particles (§3).</summary>
        public void Advance(double dt)
        {
            if (StateMachine != null)
            {
                StateMachine.Advance(dt);
                return;
            }
            AnimationState.Update(dt);
            Skeleton.SetToSetupPose();
            AnimationState.Apply();
            Skeleton.Update(dt);
            Skeleton.UpdateWorldTransform();
        }

        /// <summary>A bus id for a name or id; null for the master (null, "" or "master"). False when there is no such bus.</summary>
        bool BusRef(string bus, out string id)
        {
            id = null;
            if (string.IsNullOrEmpty(bus) || bus == "master") return true;
            var buses = Doc.Audio?.Buses;
            if (buses == null) return false;
            foreach (var b in buses) if (b.Id == bus) { id = b.Id; return true; }
            foreach (var b in buses) if (b.Name == bus) { id = b.Id; return true; }
            return false;
        }

        /// <summary>
        /// Mute, unmute or toggle (null) a sound bus by name or id ("music"), or the master with null / "master", from
        /// outside the artboard (game settings, UI buttons). Same as a mute-button listener. Returns the new state, or
        /// null when there is no such bus.
        /// </summary>
        public bool? SetBusMuted(string bus, bool? muted = true)
        {
            if (!BusRef(bus, out var id)) return null;
            return StateMachine != null ? StateMachine.SetBusMute(id, muted) : AnimationState.Audio.SetMute(id, muted);
        }

        /// <summary>Whether a bus (name or id; null / "master" = the master) is muted now; null when there is no such bus.</summary>
        public bool? IsBusMuted(string bus)
        {
            if (!BusRef(bus, out var id)) return null;
            return (StateMachine?.Audio ?? AnimationState.Audio).IsMuted(id);
        }

        /// <summary>Pointer event (down, up, move) in skeleton space (y up).</summary>
        public void Pointer(string type, double x, double y) => StateMachine?.Pointer(type, x, y);

        /// <summary>Artboard pixels (y down, origin top-left) → skeleton space.</summary>
        public void ArtboardToSkeleton(double px, double py, out double x, out double y)
        {
            x = px - Doc.OriginX;
            y = Doc.OriginY - py;
        }

        public List<DrawItem> DrawList() => Skeleton.DrawList();

        public void Dispose()
        {
            StateMachine?.Dispose();
            AnimationState.ClearTracks();
        }
    }
}
