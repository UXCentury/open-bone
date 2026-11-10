package com.openbone.gdx;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.audio.Sound;
import com.badlogic.gdx.files.FileHandle;
import com.badlogic.gdx.utils.Disposable;
import com.openbone.runtime.AudioCommand;
import com.openbone.runtime.AudioMixer;
import com.openbone.runtime.OpenBoneInstance;
import com.openbone.runtime.data.AudioData;
import com.openbone.runtime.data.OpenBoneDocument;
import java.io.File;
import java.io.IOException;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Plays a document's sounds with libGDX ({@code Gdx.audio} {@link Sound}s): each file is loaded once (a {@code data:}
 * URL or a path relative to the document's folder), voices follow the command's volume × bus × master, rate (as pitch,
 * libGDX's 0.5…2 range), looping and fade-in, stop fades and fades (stepped in {@link #update(float)}), and {@code mix}
 * commands (setMute actions) that mute or unmute a bus or the master on top of the document's mix.
 *
 * <pre>
 * OpenBoneAudio audio = new OpenBoneAudio(doc, Gdx.files.internal("button"));
 * instance.addListener(audio);   // it is an OpenBoneInstance.Listener; leave it out to stay silent
 * // render():
 * instance.advance(dt);
 * audio.update(Gdx.graphics.getDeltaTime());
 * // dispose():
 * audio.dispose();
 * </pre>
 *
 * Your own listeners keep receiving every audio command either way. Use it on the render thread.
 */
public class OpenBoneAudio implements OpenBoneInstance.Listener, Disposable {
  public final OpenBoneDocument doc;
  public final AudioMixer mixer;
  private final FileHandle base;
  private final Map<String, Sound> sounds = new HashMap<>();
  private final Map<String, Boolean> missing = new HashMap<>();
  private final Map<Integer, Sound> voiceSound = new HashMap<>();
  private final Map<Integer, Long> voiceId = new HashMap<>();
  private boolean disposed;

  /** @param base folder that relative sound paths resolve against (usually the document's folder), or null. */
  public OpenBoneAudio(OpenBoneDocument doc, FileHandle base) {
    this.doc = doc;
    this.base = base;
    mixer = new AudioMixer(doc, new AudioMixer.Output() {
      @Override
      public boolean start(int voice, AudioData.Asset asset, double gain, double rate, boolean loop) {
        return startVoice(voice, asset, gain, rate, loop);
      }

      @Override
      public void setGain(int voice, double gain) {
        Sound s = voiceSound.get(voice);
        if (s != null) s.setVolume(voiceId.get(voice), clamp(gain));
      }

      @Override
      public void stop(int voice) {
        Sound s = voiceSound.remove(voice);
        Long id = voiceId.remove(voice);
        if (s != null && id != null) s.stop(id);
      }
    });
  }

  @Override
  public void audio(AudioCommand c) {
    if (!disposed) mixer.handle(c);
  }

  /** Steps fades and releases finished one-shots; call once per frame with real seconds. */
  public void update(float dt) {
    if (!disposed) mixer.update(dt);
  }

  /** Extra gain on everything this player plays. */
  public void setVolume(float volume) {
    mixer.setVolume(volume);
  }

  /** Stops every voice. */
  public void stopAll() {
    mixer.stopAll();
  }

  private static float clamp(double gain) {
    return (float) Math.max(0, Math.min(1, gain));
  }

  private boolean startVoice(int voice, AudioData.Asset asset, double gain, double rate, boolean loop) {
    Sound sound = sound(asset);
    if (sound == null) return false;
    long id = sound.play(clamp(gain), (float) Math.max(0.5, Math.min(2, rate)), 0);
    if (id == -1) return false;
    if (loop) sound.setLooping(id, true);
    voiceSound.put(voice, sound);
    voiceId.put(voice, id);
    return true;
  }

  private Sound sound(AudioData.Asset asset) {
    Sound s = sounds.get(asset.id);
    if (s != null || missing.containsKey(asset.id) || Gdx.audio == null) return s;
    try {
      FileHandle f = file(asset.src);
      s = f == null ? null : Gdx.audio.newSound(f);
    } catch (Exception e) {
      s = null;
      Gdx.app.error("OpenBone", "Cannot load sound \"" + asset.name + "\": " + e.getMessage());
    }
    if (s == null) missing.put(asset.id, true);
    else sounds.put(asset.id, s);
    return s;
  }

  /**
   * The file of a sound source. {@code data:} URLs are written to a temporary file (libGDX loads sounds from files and
   * picks the decoder by extension).
   */
  protected FileHandle file(String src) throws IOException {
    if (src == null || src.isEmpty()) return null;
    if (src.startsWith("data:")) {
      int comma = src.indexOf(',');
      if (comma < 0 || !src.substring(0, comma).endsWith(";base64")) return null;
      String mime = src.substring(5, comma).toLowerCase();
      String ext = mime.contains("mpeg") || mime.contains("mp3") ? ".mp3" : mime.contains("ogg") ? ".ogg" : ".wav";
      File tmp = File.createTempFile("openbone-sound", ext);
      tmp.deleteOnExit();
      FileHandle f = Gdx.files.absolute(tmp.getAbsolutePath());
      f.writeBytes(Base64.getMimeDecoder().decode(src.substring(comma + 1)), false);
      return f;
    }
    FileHandle f = base != null ? base.child(src) : Gdx.files.internal(src);
    if (!f.exists()) f = Gdx.files.absolute(src);
    return f.exists() ? f : null;
  }

  /** Stops all voices and frees the loaded sounds. */
  @Override
  public void dispose() {
    if (disposed) return;
    disposed = true;
    mixer.stopAll();
    for (Sound s : sounds.values()) s.dispose();
    sounds.clear();
  }
}
