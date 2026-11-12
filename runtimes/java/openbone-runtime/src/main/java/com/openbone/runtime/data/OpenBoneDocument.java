package com.openbone.runtime.data;

import java.util.ArrayList;
import java.util.List;

/** A loaded OpenBone document (.obone / .obonb). Load with {@link DocumentLoader}. */
public class OpenBoneDocument {
  public String format = "openbone";
  public int version = 1;
  public String name = "";
  public double width, height, originX, originY;
  public String background;
  public double fps = 30;
  public final List<ImageAsset> images = new ArrayList<>();
  /** Fonts the document carries (text attachments name them by family). */
  public final List<FontAsset> fonts = new ArrayList<>();
  /** Texture atlas the images are packed into, or null. */
  public AtlasData atlas;
  public final SkeletonData skeleton = new SkeletonData();
  public final List<EventData> events = new ArrayList<>();
  public final List<AnimationData> animations = new ArrayList<>();
  public final List<StateMachineData> stateMachines = new ArrayList<>();
  public final List<ScriptData> scripts = new ArrayList<>();
  /** Sounds, buses and audio files, or null. */
  public AudioData audio;

  /** Animation by id, then by name; null if none. */
  public AnimationData findAnimation(String ref) {
    for (AnimationData a : animations) if (a.id.equals(ref)) return a;
    for (AnimationData a : animations) if (a.name.equals(ref)) return a;
    return null;
  }

  public AnimationData animationById(String id) {
    if (id == null) return null;
    for (AnimationData a : animations) if (a.id.equals(id)) return a;
    return null;
  }

  public EventData eventById(String id) {
    for (EventData e : events) if (e.id.equals(id)) return e;
    return null;
  }

  public ScriptData scriptById(String id) {
    for (ScriptData s : scripts) if (s.id.equals(id)) return s;
    return null;
  }

  public ImageAsset imageById(String id) {
    for (ImageAsset i : images) if (i.id.equals(id)) return i;
    return null;
  }

  /**
   * The document font for a family name (any case): of the fonts with that family, the one whose weight is closest to
   * {@code weight} (ties: the normal style, then the earlier font). Null when the document has none of that family, so
   * the family is looked up among the installed fonts instead.
   */
  public FontAsset findFont(String family, double weight) {
    if (family == null) return null;
    String fam = family.trim();
    FontAsset best = null;
    double bestScore = Double.MAX_VALUE;
    for (FontAsset f : fonts) {
      if (f.family == null || !f.family.trim().equalsIgnoreCase(fam)) continue;
      double score = Math.abs(f.weight - weight) * 2 + ("italic".equals(f.style) ? 1 : 0);
      if (score < bestScore) {
        best = f;
        bestScore = score;
      }
    }
    return best;
  }

  public StateMachineData findStateMachine(String ref) {
    for (StateMachineData s : stateMachines) if (s.name.equals(ref) || s.id.equals(ref)) return s;
    return null;
  }

  /** The default skin (the first one, whatever its name). */
  public SkinData defaultSkin() {
    return skeleton.skins.isEmpty() ? null : skeleton.skins.get(0);
  }

  /**
   * What to play for a reference: a sound by id/name, or else an audio asset by id/name played with default settings on
   * the sfx bus. Null when nothing matches.
   */
  public SoundData resolveSound(String ref) {
    if (audio == null || ref == null) return null;
    for (SoundData s : audio.sounds) if (s.id.equals(ref)) return s;
    for (SoundData s : audio.sounds) if (s.name.equals(ref)) return s;
    AudioData.Asset asset = null;
    for (AudioData.Asset a : audio.assets) if (a.id.equals(ref)) { asset = a; break; }
    if (asset == null) for (AudioData.Asset a : audio.assets) if (a.name.equals(ref)) { asset = a; break; }
    if (asset == null) return null;
    String bus = null;
    for (AudioData.Bus b : audio.buses) if (b.name.equals("sfx")) { bus = b.id; break; }
    SoundData s = new SoundData();
    s.id = asset.id;
    s.name = asset.name;
    s.asset = asset.id;
    s.bus = bus;
    return s;
  }
}
