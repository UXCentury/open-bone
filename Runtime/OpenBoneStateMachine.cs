using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.EventSystems;

namespace OpenBone.Unity
{
    /// <summary>Layer name, new state name.</summary>
    [Serializable]
    public sealed class OpenBoneStateUnityEvent : UnityEvent<string, string> { }

    /// <summary>Input name.</summary>
    [Serializable]
    public sealed class OpenBoneInputUnityEvent : UnityEvent<string> { }

    /// <summary>
    /// Runs an OpenBone state machine: inputs from code or the inspector, pointer listeners fed by the Unity EventSystem
    /// (needs a Physics/Physics2D raycaster on the camera and a collider; one sized to the skeleton is added if missing)
    /// or by polling the mouse, and events / state changes as UnityEvents.
    /// </summary>
    [AddComponentMenu("OpenBone/OpenBone State Machine")]
    public sealed class OpenBoneStateMachine : OpenBoneBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerEnterHandler, IPointerExitHandler
#if UNITY_2021_2_OR_NEWER
        , IPointerMoveHandler
#endif
    {
        public enum PointerSource
        {
            /// <summary>IPointer*Handler callbacks from the EventSystem (works with both input systems).</summary>
            EventSystem,
            /// <summary>Poll the legacy Input manager's mouse every frame (no EventSystem needed).</summary>
            MousePolling,
            /// <summary>Only what you send with <see cref="Pointer"/>.</summary>
            None,
        }

        [Serializable]
        public sealed class InputValue
        {
            public string name;
            public enum Kind { Bool, Number, String }
            public Kind kind;
            public bool boolValue;
            public float numberValue;
            public string stringValue;
        }

        [Tooltip("State machine (name or id); empty = the document's first.")]
        public string stateMachine = "";
        [Tooltip("Input values set when the machine starts.")]
        public List<InputValue> initialInputs = new List<InputValue>();
        public PointerSource pointerSource = PointerSource.EventSystem;
        [Tooltip("Camera for MousePolling (default: Camera.main).")]
        public Camera pointerCamera;
        [Tooltip("Add a BoxCollider2D around the skeleton when the object has no collider (EventSystem source).")]
        public bool addCollider = true;

        [Header("Events")]
        public OpenBoneEventUnityEvent onEvent = new OpenBoneEventUnityEvent();
        public OpenBoneStateUnityEvent onStateChanged = new OpenBoneStateUnityEvent();
        public OpenBoneInputUnityEvent onInputChanged = new OpenBoneInputUnityEvent();

        /// <summary>Every event with its full data (C# code).</summary>
        public event Action<FiredEvent> EventFired;

        public StateMachineInstance Machine => Instance?.StateMachine;

        protected override void OnInstanceCreated(OpenBoneInstance instance)
        {
            if (instance.Doc.StateMachines.Count == 0)
            {
                Warn("the document has no state machine");
                return;
            }
            var name = string.IsNullOrEmpty(stateMachine) ? null : stateMachine;
            if (name != null && instance.Doc.FindStateMachine(name) == null)
            {
                Warn($"state machine \"{name}\" not found");
                return;
            }
            var sm = instance.UseStateMachine(name);
            instance.Event += e =>
            {
                EventFired?.Invoke(e);
                onEvent.Invoke(e.Name, (int)e.Int, (float)e.Float, e.String);
            };
            instance.StateChanged += c => onStateChanged.Invoke(c.Layer, c.To);
            sm.InputChanged += (n, v) => onInputChanged.Invoke(n);
            sm.Error += e => Warn("script error: " + e.Message);
            sm.Log += args => Debug.Log("OpenBone script: " + string.Join(" ", args), this);
            foreach (var i in initialInputs)
            {
                if (i == null || string.IsNullOrEmpty(i.name)) continue;
                try
                {
                    sm.SetInput(i.name, i.kind == InputValue.Kind.Bool ? i.boolValue : i.kind == InputValue.Kind.Number ? (object)(double)i.numberValue : i.stringValue ?? "");
                }
                catch (ArgumentException e)
                {
                    Warn(e.Message);
                }
            }
            if (Application.isPlaying && pointerSource == PointerSource.EventSystem && addCollider && GetComponent<Collider2D>() == null && GetComponent<Collider>() == null)
            {
                instance.Advance(0);
                instance.Skeleton.Bounds(out var x0, out var y0, out var x1, out var y1);
                if (!double.IsInfinity(x0))
                {
                    var box = gameObject.AddComponent<BoxCollider2D>();
                    box.offset = new Vector2((float)(x0 + x1) / 2 / pixelsPerUnit, (float)(y0 + y1) / 2 / pixelsPerUnit);
                    box.size = new Vector2((float)(x1 - x0) / pixelsPerUnit, (float)(y1 - y0) / pixelsPerUnit);
                }
            }
        }

        // ---------------- Inputs ----------------

        public void SetBool(string input, bool value) => Machine?.SetInput(input, value);
        public void SetNumber(string input, float value) => Machine?.SetInput(input, (double)value);
        public void SetString(string input, string value) => Machine?.SetInput(input, value);
        public void Fire(string trigger) => Machine?.Fire(trigger);
        /// <summary>Input value (bool, double or string), or null.</summary>
        public object GetInput(string input) => Machine?.GetInput(input);
        public bool GetBool(string input) => Js.Truthy(GetInput(input));
        public float GetNumber(string input) => (float)Js.ToNumber(GetInput(input));
        /// <summary>Show fixed text (or a template) in a slot's text attachment; null restores it.</summary>
        public void SetText(string slot, string text) => Machine?.SetText(slot, text);

        /// <summary>Active state per layer.</summary>
        public Dictionary<string, string> ActiveStates => Machine?.ActiveStates ?? new Dictionary<string, string>();

        // ---------------- Pointer ----------------

        /// <summary>Send a pointer event ("down", "up", "move") at a world position.</summary>
        public void Pointer(string type, Vector3 worldPosition)
        {
            if (Instance == null) return;
            var p = WorldToSkeleton(worldPosition);
            Instance.Pointer(type, p.x, p.y);
        }

        bool _hasLastMouse;
        Vector3 _lastMouse;

        protected override void Update()
        {
            if (Application.isPlaying && pointerSource == PointerSource.MousePolling) PollMouse();
            base.Update();
        }

        void PollMouse()
        {
#if ENABLE_LEGACY_INPUT_MANAGER
            var cam = pointerCamera != null ? pointerCamera : Camera.main;
            if (cam == null || !TryPlanePoint(cam, Input.mousePosition, out var world)) return;
            var mouse = Input.mousePosition;
            if (!_hasLastMouse || mouse != _lastMouse) Pointer("move", world);
            if (Input.GetMouseButtonDown(0)) Pointer("down", world);
            if (Input.GetMouseButtonUp(0)) Pointer("up", world);
            _lastMouse = mouse;
            _hasLastMouse = true;
#endif
        }

        /// <summary>Where a screen point's ray meets this object's plane.</summary>
        bool TryPlanePoint(Camera cam, Vector3 screen, out Vector3 world)
        {
            var ray = cam.ScreenPointToRay(screen);
            var plane = new Plane(transform.forward, transform.position);
            if (plane.Raycast(ray, out float d))
            {
                world = ray.GetPoint(d);
                return true;
            }
            world = default;
            return false;
        }

        void FromEventSystem(string type, PointerEventData e)
        {
            if (pointerSource != PointerSource.EventSystem) return;
            var cam = e.pressEventCamera != null ? e.pressEventCamera : e.enterEventCamera;
            if (cam == null) cam = pointerCamera != null ? pointerCamera : Camera.main;
            if (cam != null && TryPlanePoint(cam, e.position, out var world)) Pointer(type, world);
        }

        public void OnPointerDown(PointerEventData e) => FromEventSystem("down", e);
        public void OnPointerUp(PointerEventData e) => FromEventSystem("up", e);
        // Enter/exit are derived by the runtime from move events (hit tests on the slots' hit areas).
        public void OnPointerEnter(PointerEventData e) => FromEventSystem("move", e);
        public void OnPointerExit(PointerEventData e) => FromEventSystem("move", e);
#if UNITY_2021_2_OR_NEWER
        public void OnPointerMove(PointerEventData e) => FromEventSystem("move", e);
#endif
    }
}
