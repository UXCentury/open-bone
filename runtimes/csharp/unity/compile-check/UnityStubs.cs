// Compile-only stand-ins for the parts of UnityEngine / UnityEditor the OpenBone package uses, with the same names and
// signatures as Unity 2021.3+. They let `dotnet build` type-check the package without Unity; nothing here runs.
// Keep them minimal: an API the package starts using must be added here with Unity's exact signature.
#pragma warning disable CS0067, CS0626, CS1591
using System;
using System.Collections.Generic;

namespace UnityEngine
{
    public class Object
    {
        public string name { get; set; }
        public HideFlags hideFlags { get; set; }
        public static void Destroy(Object o) { }
        public static void DestroyImmediate(Object o) { }
        public static implicit operator bool(Object o) => !ReferenceEquals(o, null);
        public int GetInstanceID() => 0;
    }

    [Flags] public enum HideFlags { None = 0, HideInHierarchy = 1, HideInInspector = 2, DontSaveInEditor = 4, NotEditable = 8, DontSaveInBuild = 16, DontUnloadUnusedAsset = 32, DontSave = 52, HideAndDontSave = 61 }

    public class ScriptableObject : Object
    {
        public static T CreateInstance<T>() where T : ScriptableObject => default;
    }

    public class Component : Object
    {
        public Transform transform => null;
        public GameObject gameObject => null;
        public T GetComponent<T>() => default;
    }

    public class Behaviour : Component
    {
        public bool enabled { get; set; }
        public bool isActiveAndEnabled => true;
    }

    public class MonoBehaviour : Behaviour { }

    public sealed class GameObject : Object
    {
        public GameObject(string name) { }
        public Transform transform => null;
        public T AddComponent<T>() where T : Component => default;
        public T GetComponent<T>() => default;
        public void SetActive(bool value) { }
    }

    public class Transform : Component
    {
        public Vector3 position { get; set; }
        public Vector3 localPosition { get; set; }
        public Quaternion localRotation { get; set; }
        public Vector3 localScale { get; set; }
        public Vector3 forward => default;
        public void SetParent(Transform parent, bool worldPositionStays) { }
        public Vector3 InverseTransformPoint(Vector3 p) => p;
        public Vector3 TransformPoint(Vector3 p) => p;
    }

    public struct Vector2
    {
        public float x, y;
        public Vector2(float x, float y) { this.x = x; this.y = y; }
        public static Vector2 zero => default;
        public float magnitude => 0;
        public static Vector2 operator +(Vector2 a, Vector2 b) => a;
        public static Vector2 operator -(Vector2 a, Vector2 b) => a;
        public static Vector2 operator *(Vector2 a, float d) => a;
        public static Vector2 operator /(Vector2 a, float d) => a;
    }

    public struct Vector3
    {
        public float x, y, z;
        public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
        public static Vector3 operator +(Vector3 a, Vector3 b) => a;
        public static Vector3 zero => default;
        public static implicit operator Vector3(Vector2 v) => default;
        public static bool operator ==(Vector3 a, Vector3 b) => true;
        public static bool operator !=(Vector3 a, Vector3 b) => false;
        public override bool Equals(object o) => false;
        public override int GetHashCode() => 0;
    }

    public struct Bounds
    {
        public Bounds(Vector3 center, Vector3 size) { this.center = center; this.size = size; }
        public Vector3 center { get; set; }
        public Vector3 size { get; set; }
        public Vector3 extents => size;
        public void Encapsulate(Vector3 point) { }
    }

    public struct Vector4
    {
        public float x, y, z, w;
        public Vector4(float x, float y, float z, float w) { this.x = x; this.y = y; this.z = z; this.w = w; }
        public static Vector4 zero => default;
    }

    public struct Quaternion
    {
        public static Quaternion Euler(float x, float y, float z) => default;
        public static Vector3 operator *(Quaternion r, Vector3 p) => p;
    }

    public struct Color
    {
        public float r, g, b, a;
        public Color(float r, float g, float b, float a) { this.r = r; this.g = g; this.b = b; this.a = a; }
        public static Color white => default;
    }

    public struct Color32
    {
        public byte r, g, b, a;
        public Color32(byte r, byte g, byte b, byte a) { this.r = r; this.g = g; this.b = b; this.a = a; }
    }

    public struct Ray
    {
        public Vector3 GetPoint(float distance) => default;
    }

    public struct Plane
    {
        public Plane(Vector3 inNormal, Vector3 inPoint) { }
        public bool Raycast(Ray ray, out float enter) { enter = 0; return false; }
    }

    public static class Mathf
    {
        public static float Lerp(float a, float b, float t) => a;
        public static float Clamp01(float v) => v;
    }

    public static class Time
    {
        public static float deltaTime => 0;
        public static float unscaledDeltaTime => 0;
    }

    public static class Application
    {
        public static bool isPlaying => false;
    }

    public static class Debug
    {
        public static void Log(object m, Object context) { }
        public static void LogWarning(object m) { }
        public static void LogWarning(object m, Object context) { }
        public static void LogError(object m, Object context) { }
    }

    public static class Resources
    {
        public static T GetBuiltinResource<T>(string path) where T : Object => default;
    }

    public class Shader : Object
    {
        public static Shader Find(string name) => null;
    }

    public class Material : Object
    {
        public Material(Shader shader) { }
        public Texture mainTexture { get; set; }
        public void SetFloat(string name, float value) { }
    }

    public class Texture : Object
    {
        public TextureWrapMode wrapMode { get; set; }
        public FilterMode filterMode { get; set; }
    }

    public enum TextureFormat { RGBA32 = 4 }
    public enum TextureWrapMode { Repeat = 0, Clamp = 1 }
    public enum FilterMode { Point = 0, Bilinear = 1, Trilinear = 2 }

    public sealed class Texture2D : Texture
    {
        public Texture2D(int width, int height, TextureFormat format, bool mipChain) { }
        public static Texture2D whiteTexture => null;
        public void SetPixels32(Color32[] colors) { }
        public void Apply() { }
    }

    public static class ImageConversion
    {
        public static bool LoadImage(this Texture2D tex, byte[] data) => true;
    }

    public sealed class Mesh : Object
    {
        public Rendering.IndexFormat indexFormat { get; set; }
        public int subMeshCount { get; set; }
        public void Clear() { }
        public void MarkDynamic() { }
        public void SetVertices(List<Vector3> v) { }
        public void SetColors(List<Color> c) { }
        public void SetUVs(int channel, List<Vector2> uvs) { }
        public void SetUVs(int channel, List<Vector4> uvs) { }
        public void SetTriangles(List<int> triangles, int submesh, bool calculateBounds) { }
        public void RecalculateBounds() { }
    }

    public sealed class MeshFilter : Component
    {
        public Mesh sharedMesh { get; set; }
    }

    public class Renderer : Component
    {
        public Material sharedMaterial { get; set; }
        public Material[] sharedMaterials { get; set; }
        public int sortingOrder { get; set; }
        public Bounds bounds => default;
    }

    public sealed class MeshRenderer : Renderer { }

    public sealed class Font : Object
    {
        public Material material => null;
        public static string[] GetOSInstalledFontNames() => new string[0];
        public static Font CreateDynamicFontFromOSFont(string[] fontnames, int size) => null;
    }

    public enum TextAnchor { UpperLeft, UpperCenter, UpperRight, MiddleLeft, MiddleCenter, MiddleRight, LowerLeft, LowerCenter, LowerRight }
    public enum TextAlignment { Left, Center, Right }

    public sealed class TextMesh : Component
    {
        public string text { get; set; }
        public Font font { get; set; }
        public int fontSize { get; set; }
        public float characterSize { get; set; }
        public TextAnchor anchor { get; set; }
        public TextAlignment alignment { get; set; }
        public Color color { get; set; }
    }

    public sealed class Camera : Behaviour
    {
        public static Camera main => null;
        public Ray ScreenPointToRay(Vector3 pos) => default;
    }

    public class Collider : Component { }
    public class Collider2D : Behaviour
    {
        public Vector2 offset { get; set; }
    }
    public sealed class BoxCollider2D : Collider2D
    {
        public Vector2 size { get; set; }
    }

    public static class Input
    {
        public static Vector3 mousePosition => default;
        public static bool GetMouseButtonDown(int button) => false;
        public static bool GetMouseButtonUp(int button) => false;
    }

    public sealed class AudioClip : Object
    {
        public static AudioClip Create(string name, int lengthSamples, int channels, int frequency, bool stream) => null;
        public bool SetData(float[] data, int offsetSamples) => true;
    }

    public sealed class AudioSource : Behaviour
    {
        public AudioClip clip { get; set; }
        public float volume { get; set; }
        public float pitch { get; set; }
        public bool loop { get; set; }
        public bool playOnAwake { get; set; }
        public float spatialBlend { get; set; }
        public bool isPlaying => false;
        public Audio.AudioMixerGroup outputAudioMixerGroup { get; set; }
        public void Play() { }
        public void Stop() { }
    }

    [AttributeUsage(AttributeTargets.Field)] public sealed class SerializeField : Attribute { }
    [AttributeUsage(AttributeTargets.Field)] public sealed class HideInInspector : Attribute { }
    [AttributeUsage(AttributeTargets.Field)] public sealed class TooltipAttribute : Attribute { public TooltipAttribute(string t) { } }
    [AttributeUsage(AttributeTargets.Field)] public sealed class HeaderAttribute : Attribute { public HeaderAttribute(string h) { } }
    [AttributeUsage(AttributeTargets.Field)] public sealed class RangeAttribute : Attribute { public RangeAttribute(float min, float max) { } }
    [AttributeUsage(AttributeTargets.Class)] public sealed class RequireComponent : Attribute { public RequireComponent(Type a) { } public RequireComponent(Type a, Type b) { } }
    [AttributeUsage(AttributeTargets.Class)] public sealed class ExecuteAlways : Attribute { }
    [AttributeUsage(AttributeTargets.Class)] public sealed class DisallowMultipleComponent : Attribute { }
    [AttributeUsage(AttributeTargets.Class)] public sealed class AddComponentMenu : Attribute { public AddComponentMenu(string m) { } }
}

namespace UnityEngine.Audio
{
    public class AudioMixerGroup : Object { }
}

namespace UnityEngine.Rendering
{
    public enum IndexFormat { UInt16 = 0, UInt32 = 1 }
    public enum BlendMode { Zero = 0, One = 1, DstColor = 2, SrcColor = 3, OneMinusDstColor = 4, SrcAlpha = 5, OneMinusSrcColor = 6, DstAlpha = 7, OneMinusDstAlpha = 8, SrcAlphaSaturate = 9, OneMinusSrcAlpha = 10 }
    public enum CompareFunction { Disabled = 0, Never = 1, Less = 2, Equal = 3, LessEqual = 4, Greater = 5, NotEqual = 6, GreaterEqual = 7, Always = 8 }
    public enum StencilOp { Keep = 0, Zero = 1, Replace = 2, IncrementSaturate = 3, DecrementSaturate = 4, Invert = 5, IncrementWrap = 6, DecrementWrap = 7 }
}

namespace UnityEngine.Events
{
    public abstract class UnityEventBase { }
    public class UnityEvent<T0> : UnityEventBase { public void Invoke(T0 a) { } }
    public class UnityEvent<T0, T1> : UnityEventBase { public void Invoke(T0 a, T1 b) { } }
    public class UnityEvent<T0, T1, T2, T3> : UnityEventBase { public void Invoke(T0 a, T1 b, T2 c, T3 d) { } }
}

namespace UnityEngine.EventSystems
{
    public class PointerEventData
    {
        public Vector2 position { get; set; }
        public Camera pressEventCamera => null;
        public Camera enterEventCamera => null;
    }

    public interface IEventSystemHandler { }
    public interface IPointerDownHandler : IEventSystemHandler { void OnPointerDown(PointerEventData eventData); }
    public interface IPointerUpHandler : IEventSystemHandler { void OnPointerUp(PointerEventData eventData); }
    public interface IPointerEnterHandler : IEventSystemHandler { void OnPointerEnter(PointerEventData eventData); }
    public interface IPointerExitHandler : IEventSystemHandler { void OnPointerExit(PointerEventData eventData); }
    public interface IPointerMoveHandler : IEventSystemHandler { void OnPointerMove(PointerEventData eventData); }
}

namespace UnityEditor
{
    public static class AssetDatabase
    {
        public static T LoadAssetAtPath<T>(string path) where T : UnityEngine.Object => default;
        public static void ImportAsset(string path, ImportAssetOptions options = ImportAssetOptions.Default) { }
        public static void StartAssetEditing() { }
        public static void StopAssetEditing() { }
    }

    [Flags] public enum ImportAssetOptions { Default = 0, ForceUpdate = 1, ForceSynchronousImport = 8, ImportRecursive = 256, DontDownloadFromCacheServer = 8192, ForceUncompressedImport = 16384 }

    public delegate void CallbackFunction();

    public class AssetPostprocessor { }

    public static class EditorApplication
    {
        public static CallbackFunction delayCall;
    }

    [AttributeUsage(AttributeTargets.Class)] public sealed class CustomEditor : Attribute { public CustomEditor(Type t) { } }

    public class Editor : UnityEngine.ScriptableObject
    {
        public UnityEngine.Object target => null;
        public virtual void OnInspectorGUI() { }
        public bool DrawDefaultInspector() => true;
    }

    public enum MessageType { None, Info, Warning, Error }

    public static class EditorGUILayout
    {
        public static void LabelField(string label, string label2, params object[] options) { }
        public static void HelpBox(string message, MessageType type) { }
        public static void Space() { }
    }
}

namespace UnityEditor.AssetImporters
{
    public abstract class ScriptedImporter : UnityEngine.Object
    {
        public abstract void OnImportAsset(AssetImportContext ctx);
    }

    [AttributeUsage(AttributeTargets.Class)]
    public sealed class ScriptedImporterAttribute : Attribute
    {
        public ScriptedImporterAttribute(int version, string[] exts) { }
    }

    public sealed class AssetImportContext
    {
        public string assetPath => "";
        public void AddObjectToAsset(string identifier, UnityEngine.Object obj) { }
        public void SetMainObject(UnityEngine.Object obj) { }
        public void DependsOnSourceAsset(string path) { }
        public void DependsOnArtifact(string path) { }
        public void LogImportError(string msg, UnityEngine.Object obj = null) { }
        public void LogImportWarning(string msg, UnityEngine.Object obj = null) { }
    }
}
