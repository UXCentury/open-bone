# OpenBone Runtime for Unity

Play [OpenBone](https://github.com/UXCentury/open-bone) skeletal animations and interactive state machines in Unity 2021.3 or newer.

- **Importer** for `.obone` (JSON) and `.obonb` (binary): drop the file in `Assets/`, get an `OpenBoneAsset`. Images and atlas pages embedded in the file become textures; others are found next to the file (their `src` path, or `<name>.png` beside it or in an `images/` folder).
- **OpenBone Animation** component: play and queue animations, cross-fades, skins; animation events, starts and completions as UnityEvents.
- **OpenBone State Machine** component: inputs (bool, number, string, trigger) from code or the inspector, pointer listeners fed by the EventSystem (old or new Input System) or by mouse polling, events and state changes as UnityEvents, scripts (JavaScript, run by Jint).
- **Mesh generator** with the four blend modes, clipping masks (stencil), two-colour tint, premultiplied atlas pages, particles and shape strokes, in one mesh per skeleton (a submesh per texture/blend run). Shader `OpenBone/Skeleton` is unlit and works in the built-in pipeline and URP.
- **OpenBone Audio** component: plays the runtime's audio commands (play, stop, fade) through pooled AudioSources with the document's buses and master volume.

The posing, constraints, particles, text templates, state machines and audio commands come from `OpenBone.Runtime`, the C# port of the reference runtime, which passes the cross-language conformance suite (`runtimes/csharp`).

> **Status:** tested in Unity 6 (6000.6.8f1, built-in render pipeline) on Linux with every OpenBone example: import, state machines, rendering, pointer input and sound. Unity 2021.3–2023 and URP are compile-checked only; please report what breaks.

## Install

The package needs four DLLs in `Plugins/` that are built from source (they are not committed):

| DLL | What | Licence |
|---|---|---|
| `OpenBone.Runtime.dll` | the runtime (netstandard2.1) | MIT |
| `OpenBone.Scripting.Jint.dll` | script host | MIT |
| `Jint.dll` | JavaScript interpreter | BSD-2-Clause |
| `Esprima.dll` | JavaScript parser used by Jint | BSD-3-Clause |

1. Install the [.NET 8 SDK](https://dot.net) (only needed to build the plugins).
2. From the repository root:

   ```bash
   python3 runtimes/csharp/unity/build-package.py --pack
   ```

   This builds the DLLs into `runtimes/csharp/unity/com.openbone.runtime/Plugins/`, writes the `.meta` files and creates `runtimes/csharp/unity/com.openbone.runtime-<version>.tgz`.
3. In Unity: **Window → Package Manager → + → Add package from tarball…** and pick the `.tgz` (or **Add package from disk…** and pick `com.openbone.runtime/package.json` to work on the package in place).

## Use

1. Put `hero.obone` (and its images, unless they are embedded) in `Assets/`.
2. Create a GameObject, add **OpenBone → OpenBone Animation** (or **OpenBone State Machine**), and set **Asset** to the imported file.
3. Set **Start Animation** (animation component) or **State Machine** (state-machine component), and **Pixels Per Unit** (skeleton units per Unity unit, default 100).
4. Add **OpenBone → OpenBone Audio** to the same object to hear the document's sounds.
5. Point an orthographic camera at `StageBounds` (the document's stage, as framed in the OpenBone editor): `cam.transform.position = b.center + Vector3.back * 10; cam.orthographicSize = b.extents.y;`.

```csharp
using OpenBone.Unity;
using UnityEngine;

public class Hero : MonoBehaviour
{
    public OpenBoneAnimation anim;
    public OpenBoneStateMachine machine;

    void Start()
    {
        anim.Play("walk");                       // loop on track 0
        anim.Queue("jump", loop: false);         // after walk completes
        anim.onEvent.AddListener((name, i, f, s) => Debug.Log($"event {name}"));

        machine.SetBool("walk", true);
        machine.Fire("attack");
        machine.onStateChanged.AddListener((layer, state) => Debug.Log($"{layer}: {state}"));
    }
}
```

The full runtime is available underneath: `component.Instance` (`OpenBoneInstance`), `component.Skeleton` (bones, slots, `FindBone`, `SetSkin`, `SetText`), `OpenBoneStateMachine.Machine` (`StateMachineInstance`). `BoneWorldPosition("hand")` gives a bone's world position (to attach weapons, effects…).

### Pointer input

With **Pointer Source = EventSystem** (default) the component receives `IPointerDown/Up/Enter/Exit/MoveHandler` callbacks: the scene needs an **EventSystem**, the camera a **Physics 2D Raycaster** (or Physics Raycaster with a 3D collider), and the object a collider; a `BoxCollider2D` around the skeleton is added at start if it has none. The runtime then hit-tests the listeners' slots itself (bounding boxes, else the attachment's outline), exactly like the other runtimes. **MousePolling** reads the legacy Input manager's mouse instead (no EventSystem; not available when only the new Input System is enabled). **None** leaves it to you: `machine.Pointer("down", worldPosition)`.

### Loading at runtime

```csharp
var bytes = File.ReadAllBytes(path);                                     // .obone or .obonb
var asset = OpenBoneAsset.Create(bytes, new Dictionary<string, Texture2D> { ["img_head"] = headTexture });
component.asset = asset;
component.Initialize();
```

Texture keys are image ids, or atlas page ids for packed documents.

## Rendering notes

- Vertex colours are straight (not premultiplied); the shader outputs premultiplied colour, so the blend modes are: normal `One, OneMinusSrcAlpha`; additive `One, One`; multiply `DstColor, OneMinusSrcAlpha`; screen `One, OneMinusSrcColor`. Atlas pages packed with premultiplied alpha are marked by the importer and divided back in the shader.
- Clipping uses stencil value 1 (written by the mask, tested by the clipped run, cleared after it). The camera's target needs a stencil buffer (the default).
- Two-colour tint: `dark + (light − dark) × texture` per channel; without a dark colour it is the usual multiply.
- Text attachments are drawn with legacy `TextMesh` children on top of the skeleton mesh, in Unity's font. For TextMesh Pro, turn **Render Text** off and draw `DrawItem.Text` (content, size, alignment, colour, matrix) from the `DrawListReady` event.

## Scripts

State-machine scripts run in Jint with the same `ob` API, hooks (`onStart`, `onUpdate`, `onPointer`, `onEvent`) and limits (16 ms per call, 50 ms to load, 8 MB) as the web runtimes. Override `CreateScriptHost()` to change the limits, or return `null` to turn scripts off. `Runtime/link.xml` keeps Jint from being stripped in IL2CPP builds (copy it into `Assets/` if your Unity version ignores link.xml files in packages).

## Not done / known limits

- Not yet run in the Unity Editor or a player build (see Status above).
- Embedded audio: WAV only (decoded at runtime); MP3/OGG need the file next to the document so Unity imports it as an AudioClip.
- Text is drawn above the skeleton (no interleaving with draw order) and with Unity's font metrics.
- No inspector preview of animations (the component shows the setup pose in edit mode).
