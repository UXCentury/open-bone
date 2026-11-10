using System;
using System.Collections.Generic;
using UnityEngine;

namespace OpenBone.Unity
{
    /// <summary>
    /// Shared base of <see cref="OpenBoneAnimation"/> and <see cref="OpenBoneStateMachine"/>: owns the runtime instance,
    /// advances it every frame and draws its draw list into a MeshRenderer.
    /// </summary>
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    [ExecuteAlways]
    [DisallowMultipleComponent]
    public abstract class OpenBoneBehaviour : MonoBehaviour
    {
        [Tooltip("The imported .obone / .obonb file.")]
        public OpenBoneAsset asset;
        [Tooltip("Skin to show (name or id); empty = none (default skin attachments only).")]
        public string skin = "";
        [Tooltip("Skeleton units (artboard pixels) per Unity unit.")]
        public float pixelsPerUnit = 100;
        [Tooltip("Playback speed multiplier.")]
        public float timeScale = 1;
        [Tooltip("Draw text attachments with TextMesh children (turn off to draw text yourself from DrawListReady).")]
        public bool renderText = true;
        [Tooltip("Shader for the skeleton mesh (OpenBone/Skeleton). Kept as a reference so builds include it.")]
        public Shader shader;

        /// <summary>The runtime instance (null until initialised).</summary>
        public OpenBoneInstance Instance { get; private set; }
        public Skeleton Skeleton => Instance?.Skeleton;

        /// <summary>After every frame's draw list is built (e.g. to draw text with TextMesh Pro).</summary>
        public event Action<OpenBoneBehaviour, List<DrawItem>> DrawListReady;
        /// <summary>Script errors and missing textures.</summary>
        public event Action<string> Warning;

        Action<AudioCommand> _audio;
        readonly List<AudioCommand> _audioBacklog = new List<AudioCommand>();

        /// <summary>
        /// Audio commands of the instance (see <see cref="OpenBoneAudio"/>). Commands emitted before anyone subscribed
        /// (state sounds on the first frame) are delivered to the first subscriber.
        /// </summary>
        public event Action<AudioCommand> AudioCommand
        {
            add
            {
                _audio += value;
                var backlog = _audioBacklog.ToArray();
                _audioBacklog.Clear();
                foreach (var c in backlog) value(c);
            }
            remove => _audio -= value;
        }

        void OnAudio(AudioCommand c)
        {
            if (!Application.isPlaying) return;
            if (_audio != null) _audio(c);
            else if (_audioBacklog.Count < 256) _audioBacklog.Add(c);
        }

        Mesh _mesh;
        MeshGenerator _generator;
        MaterialCache _materials;
        TextRenderer _text;
        readonly List<Material> _materialList = new List<Material>();
        OpenBoneAsset _builtFor;

        protected virtual void Reset()
        {
            shader = Shader.Find("OpenBone/Skeleton");
        }

        protected virtual void OnEnable() => Initialize();

        protected virtual void OnDisable() => Teardown();

        bool _dirty;

        // Unity forbids creating objects inside OnValidate: apply inspector changes on the next Update.
        protected virtual void OnValidate() => _dirty = true;

        void ApplyInspectorChanges()
        {
            _dirty = false;
            if (!isActiveAndEnabled) return;
            if (asset != _builtFor) Initialize();
            else if (Instance != null)
            {
                Instance.Skeleton.SetSkin(string.IsNullOrEmpty(skin) ? null : skin);
                if (!Application.isPlaying)
                {
                    Instance.Advance(0);
                    Render();
                }
            }
        }

        /// <summary>(Re)create the instance from <see cref="asset"/>.</summary>
        public void Initialize()
        {
            Teardown();
            _builtFor = asset;
            if (asset == null) return;
            Document doc;
            try
            {
                doc = asset.Document;
            }
            catch (Exception e)
            {
                Debug.LogError($"OpenBone: cannot load {asset.name}: {e.Message}", this);
                return;
            }
            if (_mesh == null)
            {
                _mesh = new Mesh { name = "OpenBone", hideFlags = HideFlags.DontSave };
                _mesh.MarkDynamic();
            }
            GetComponent<MeshFilter>().sharedMesh = _mesh;
            _generator = new MeshGenerator { MissingTexture = id => Warn($"no texture for \"{id}\" in {asset.name}") };
            _materials = new MaterialCache(shader);
            _text = new TextRenderer(transform);
            Instance = new OpenBoneInstance(doc, new StateMachineOptions { ScriptHost = CreateScriptHost() });
            Instance.Skeleton.SetSkin(string.IsNullOrEmpty(skin) ? null : skin);
            Instance.AudioCommand += OnAudio;
            OnInstanceCreated(Instance);
            Instance.Advance(0);
            Render();
        }

        /// <summary>Script engine for state-machine scripts (Jint by default; return null to disable scripts).</summary>
        protected virtual IScriptHost CreateScriptHost() => new OpenBone.Scripting.JintScriptHost();

        /// <summary>Set up animations / state machine on a new instance (before its first frame).</summary>
        protected abstract void OnInstanceCreated(OpenBoneInstance instance);

        protected void Warn(string message)
        {
            if (Warning != null) Warning(message);
            else Debug.LogWarning("OpenBone: " + message, this);
        }

        void Teardown()
        {
            Instance?.Dispose();
            Instance = null;
            _materials?.Dispose();
            _materials = null;
            _text?.Dispose();
            _text = null;
        }

        protected virtual void OnDestroy()
        {
            Teardown();
            if (_mesh != null)
            {
                if (Application.isPlaying) Destroy(_mesh);
                else DestroyImmediate(_mesh);
            }
        }

        protected virtual void Update()
        {
            if (_dirty) ApplyInspectorChanges();
            if (Instance == null || !Application.isPlaying) return;
            Instance.Advance(Time.deltaTime * timeScale);
        }

        protected virtual void LateUpdate()
        {
            if (Instance != null && Application.isPlaying) Render();
        }

        /// <summary>Rebuild the mesh from the current pose.</summary>
        public void Render()
        {
            if (Instance == null || _mesh == null) return;
            var items = Instance.DrawList();
            _generator.Build(_mesh, items, asset, _materials, pixelsPerUnit, _materialList);
            var r = GetComponent<MeshRenderer>();
            r.sharedMaterials = _materialList.ToArray();
            if (renderText) _text.Render(items, pixelsPerUnit, r.sortingOrder + 1);
            else _text.Render(new List<DrawItem>(), pixelsPerUnit, 0);
            DrawListReady?.Invoke(this, items);
        }

        public void SetSkin(string name)
        {
            skin = name ?? "";
            Instance?.Skeleton.SetSkin(string.IsNullOrEmpty(name) ? null : name);
        }

        /// <summary>A world-space point in skeleton space (y up, skeleton units).</summary>
        public Vector2 WorldToSkeleton(Vector3 world)
        {
            var local = transform.InverseTransformPoint(world);
            return new Vector2(local.x * pixelsPerUnit, local.y * pixelsPerUnit);
        }

        /// <summary>A skeleton-space point in world space.</summary>
        /// <summary>
        /// The document's stage (its width × height canvas, as framed in the OpenBone editor) in world space: frame a
        /// camera on this rather than on the mesh bounds, which include anything drawn off-stage (scrolling backgrounds).
        /// </summary>
        public Bounds StageBounds
        {
            get
            {
                var doc = asset != null ? asset.Document : null;
                if (doc == null || doc.Width <= 0 || doc.Height <= 0) return GetComponent<MeshRenderer>().bounds;
                // Skeleton space is y-up with the origin at (originX, originY) of the y-down canvas.
                var a = SkeletonToWorld(-doc.OriginX, doc.OriginY - doc.Height);
                var b = SkeletonToWorld(doc.Width - doc.OriginX, doc.OriginY);
                var bounds = new Bounds(a, Vector3.zero);
                bounds.Encapsulate(b);
                return bounds;
            }
        }

        public Vector3 SkeletonToWorld(double x, double y) => transform.TransformPoint(new Vector3((float)x / pixelsPerUnit, (float)y / pixelsPerUnit, 0));

        /// <summary>World position of a bone (by name or id), or the component's position if there is no such bone.</summary>
        public Vector3 BoneWorldPosition(string bone)
        {
            var b = Skeleton?.FindBone(bone);
            return b == null ? transform.position : SkeletonToWorld(b.World.X, b.World.Y);
        }
    }
}
