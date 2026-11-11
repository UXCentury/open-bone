using System;
using UnityEngine;
using UnityEngine.Events;

namespace OpenBone.Unity
{
    /// <summary>An OpenBone event: name, int, float, string.</summary>
    [Serializable]
    public sealed class OpenBoneEventUnityEvent : UnityEvent<string, int, float, string> { }

    /// <summary>An animation name.</summary>
    [Serializable]
    public sealed class OpenBoneAnimationUnityEvent : UnityEvent<string> { }

    /// <summary>
    /// Plays OpenBone animations: set an animation to start with, then <see cref="Play"/> / <see cref="Queue"/> from
    /// code. Animation events, starts and completions are raised as UnityEvents.
    /// </summary>
    [AddComponentMenu("OpenBone/OpenBone Animation")]
    public sealed class OpenBoneAnimation : OpenBoneBehaviour
    {
        [Tooltip("Animation started when the component starts (name or id); empty = setup pose.")]
        public string startAnimation = "";
        public bool loop = true;
        [Tooltip("Cross-fade seconds when an animation replaces another.")]
        public float defaultMix = 0.2f;

        [Header("Events")]
        public OpenBoneEventUnityEvent onEvent = new OpenBoneEventUnityEvent();
        public OpenBoneAnimationUnityEvent onAnimationStart = new OpenBoneAnimationUnityEvent();
        public OpenBoneAnimationUnityEvent onAnimationComplete = new OpenBoneAnimationUnityEvent();

        /// <summary>Every event with its full data (C# code).</summary>
        public event Action<FiredEvent> EventFired;

        public AnimationState AnimationState => Instance?.AnimationState;

        protected override void OnInstanceCreated(OpenBoneInstance instance)
        {
            instance.AnimationState.DefaultMix = defaultMix;
            instance.Event += e =>
            {
                EventFired?.Invoke(e);
                onEvent.Invoke(e.Name, (int)e.Int, (float)e.Float, e.String);
            };
            instance.AnimationState.Start += (entry, track) => onAnimationStart.Invoke(entry.Animation.Name);
            instance.AnimationState.Complete += (entry, track) => onAnimationComplete.Invoke(entry.Animation.Name);
            if (!string.IsNullOrEmpty(startAnimation))
            {
                if (instance.Doc.FindAnimation(startAnimation) != null) instance.Play(startAnimation, loop);
                else Warn($"animation \"{startAnimation}\" not found");
            }
        }

        /// <summary>Play an animation now on a track (cross-fading from what was there).</summary>
        public TrackEntry Play(string animation, bool loop = true, int track = 0, float? mix = null)
        {
            if (Instance == null) return null;
            return Instance.AnimationState.SetAnimation(track, animation, loop, mix);
        }

        /// <summary>Queue an animation after the current one completes (or after delay seconds).</summary>
        public TrackEntry Queue(string animation, bool loop = true, float delay = 0, int track = 0, float? mix = null)
        {
            if (Instance == null) return null;
            return Instance.AnimationState.AddAnimation(track, animation, loop, delay, mix);
        }

        public void ClearTrack(int track = 0) => Instance?.AnimationState.ClearTrack(track);

        /// <summary>Stop every track (back to the setup pose).</summary>
        public void Stop() => Instance?.AnimationState.ClearTracks();
    }
}
