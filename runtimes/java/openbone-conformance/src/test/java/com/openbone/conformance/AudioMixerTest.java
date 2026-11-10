package com.openbone.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.openbone.runtime.AudioCommand;
import com.openbone.runtime.AudioMixer;
import com.openbone.runtime.OpenBoneInstance;
import com.openbone.runtime.data.AudioData;
import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.OpenBoneDocument;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** AudioMixer (gain, voices, fades) with a recording output: the logic the libGDX and Android players share. */
class AudioMixerTest {
  static final class Recorder implements AudioMixer.Output {
    final List<String> calls = new ArrayList<>();
    final Set<String> failing = new HashSet<>();

    @Override
    public boolean start(int voice, AudioData.Asset asset, double gain, double rate, boolean loop) {
      calls.add("start " + voice + " " + asset.id + " " + r(gain) + " " + r(rate) + (loop ? " loop" : ""));
      return !failing.contains(asset.id);
    }

    @Override
    public void setGain(int voice, double gain) {
      calls.add("gain " + voice + " " + r(gain));
    }

    @Override
    public void stop(int voice) {
      calls.add("stop " + voice);
    }

    static String r(double x) {
      return String.valueOf(Math.round(x * 1000) / 1000.0);
    }
  }

  static AudioData audio(double master, boolean muted) {
    AudioData a = new AudioData();
    a.master = master;
    a.muted = muted;
    for (String[] s : new String[][] {{"a", "1.0"}, {"b", "0"}, {"c", "0.5"}}) {
      AudioData.Asset asset = new AudioData.Asset();
      asset.id = s[0];
      asset.name = s[0];
      asset.src = s[0] + ".wav";
      asset.duration = Double.parseDouble(s[1]);
      a.assets.add(asset);
    }
    AudioData.Bus sfx = new AudioData.Bus();
    sfx.id = "sfx";
    sfx.volume = 0.5;
    AudioData.Bus off = new AudioData.Bus();
    off.id = "off";
    off.muted = true;
    a.buses.add(sfx);
    a.buses.add(off);
    return a;
  }

  @Test
  void gain() {
    Recorder out = new Recorder();
    AudioMixer m = new AudioMixer(audio(0.8, false), out);
    assertEquals(0.4, m.busGain("sfx"), 1e-12);
    assertEquals(0, m.busGain("off"));
    assertEquals(0.8, m.busGain(null), 1e-12);
    assertEquals(0.8, m.busGain("unknown"), 1e-12);
    assertEquals(0, new AudioMixer(audio(0.8, true), out).busGain(null));
    assertEquals(1, new AudioMixer((AudioData) null, out).busGain("sfx"));
    m.handle(AudioCommand.play("p", "a", "sfx", 0.5, 1.5, true, 0));
    assertEquals(List.of("start 1 a 0.2 1.5 loop"), out.calls);
    m.setVolume(0.5);
    assertEquals("gain 1 0.1", out.calls.get(1));
  }

  @Test
  void fadeInFadeAndStopFade() {
    Recorder out = new Recorder();
    AudioMixer m = new AudioMixer(audio(1, false), out);
    m.handle(AudioCommand.play("p", "b", "sfx", 1, 1, true, 1));
    m.update(0.5);
    m.update(0.5);
    m.update(0.5); // ramp done: no more calls
    // A fade gives the sound's new volume; the bus gain stays.
    m.handle(AudioCommand.fade("p", 0.2, 0.5));
    m.update(0.25);
    m.update(0.25);
    assertEquals(0.2, m.voice("p").soundVolume);
    m.handle(AudioCommand.fade("p", 1, 0)); // instant
    m.handle(AudioCommand.stop("p", 1));
    assertNull(m.voice("p"));
    assertEquals(1, m.voiceCount(), "still fading out");
    m.handle(AudioCommand.stop("p", 1)); // unknown now: ignored
    m.update(0.5);
    m.update(0.5);
    assertEquals(0, m.voiceCount());
    assertEquals(List.of("start 1 b 0.0 1.0 loop", "gain 1 0.25", "gain 1 0.5", "gain 1 0.3", "gain 1 0.1", "gain 1 0.5",
        "gain 1 0.25", "gain 1 0.0", "stop 1"), out.calls);
  }

  @Test
  void voices() {
    Recorder out = new Recorder();
    out.failing.add("c");
    AudioMixer m = new AudioMixer(audio(1, false), out);
    m.handle(AudioCommand.play("x", "missing", null, 1, 1, false, 0)); // unknown asset
    m.handle(AudioCommand.play("y", "c", null, 1, 1, false, 0)); // the output cannot play it
    assertEquals(0, m.voiceCount());
    m.handle(AudioCommand.play("p", "b", null, 1, 1, true, 0));
    m.handle(AudioCommand.play("p", "b", null, 1, 1, true, 0)); // same id again: replaces the old voice
    assertEquals(List.of("start 1 c 1.0 1.0", "start 2 b 1.0 1.0 loop", "stop 2", "start 3 b 1.0 1.0 loop"), out.calls);
    m.voiceFinished(3);
    assertEquals(0, m.voiceCount());
    m.handle(AudioCommand.stop("p", 0)); // already finished: no call
    assertEquals(4, out.calls.size());
  }

  @Test
  void oneShotsExpireAfterTheirDuration() {
    Recorder out = new Recorder();
    AudioMixer m = new AudioMixer(audio(1, false), out);
    m.handle(AudioCommand.play("p", "a", null, 1, 2, false, 0)); // 1 s at rate 2 = 0.5 s
    m.handle(AudioCommand.play("q", "b", null, 1, 1, false, 0)); // unknown duration: kept until stopped
    m.update(0.5);
    assertNotNull(m.voice("p"));
    m.update(0.3);
    assertNull(m.voice("p"));
    assertNotNull(m.voice("q"));
    assertEquals("stop 1", out.calls.get(out.calls.size() - 1));
    m.stopAll();
    assertEquals("stop 2", out.calls.get(out.calls.size() - 1));
    assertEquals(0, m.voiceCount());
  }

  @Test
  void instanceCommandsDriveTheMixer() throws Exception {
    // The button's state machine plays its hover / click sounds: route them through a mixer.
    Path repo = Path.of(System.getProperty("openbone.repo", "../.."));
    OpenBoneDocument doc = DocumentLoader.load(Files.readAllBytes(repo.resolve("examples/button.obone")));
    OpenBoneInstance inst = new OpenBoneInstance(doc, null);
    Recorder out = new Recorder();
    AudioMixer mixer = new AudioMixer(doc, out);
    inst.addListener(new OpenBoneInstance.Listener() {
      @Override
      public void audio(AudioCommand c) {
        mixer.handle(c);
      }
    });
    inst.useStateMachine(null);
    inst.advance(0);
    double[] centre = inst.artboardToSkeleton(doc.width / 2, doc.height / 2);
    inst.pointer("move", -10000, -10000);
    for (String type : new String[] {"move", "down", "up"}) {
      inst.pointer(type, centre[0], centre[1]);
      inst.advance(1 / 60.0);
      mixer.update(1 / 60.0);
    }
    assertFalse(out.calls.isEmpty(), "the button plays sounds");
    for (String call : out.calls) {
      if (!call.startsWith("start")) continue;
      String asset = call.split(" ")[2];
      assertTrue(doc.audio.assets.stream().anyMatch(a -> a.id.equals(asset)), call);
    }
    for (int i = 0; i < 120; i++) mixer.update(1 / 60.0);
    assertEquals(0, mixer.voiceCount(), "one-shots are released after their duration");
  }
}
