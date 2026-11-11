package com.openbone.runtime;

import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.runtime.data.StateMachineData;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * High-level handle: one skeleton driven either by an {@link AnimationState} (play/queue animations) or by a state
 * machine (inputs, listeners, scripts). The usual entry point for players and games (runtime/instance.ts).
 *
 * <pre>
 * OpenBoneInstance inst = new OpenBoneInstance(DocumentLoader.load(bytes), null);
 * inst.play("walk", true);
 * inst.advance(1 / 60.0);
 * for (DrawItem it : inst.drawList()) renderer.draw(it);
 * </pre>
 */
public final class OpenBoneInstance {
  /** Receives events, state changes and audio commands from whichever driver is active. */
  public interface Listener {
    default void event(FiredEvent e) {}

    default void stateChange(String layer, String from, String to) {}

    default void audio(AudioCommand c) {}
  }

  public final OpenBoneDocument doc;
  public final Skeleton skeleton;
  public final AnimationState animationState;
  public StateMachineInstance stateMachine;
  private final ScriptHost scriptHost;
  private final List<Listener> listeners = new CopyOnWriteArrayList<>();

  /** @param scriptHost engine for state machine scripts, or null to ignore scripts. */
  public OpenBoneInstance(OpenBoneDocument doc, ScriptHost scriptHost) {
    this.doc = doc;
    this.scriptHost = scriptHost;
    skeleton = new Skeleton(doc);
    animationState = new AnimationState(skeleton);
    animationState.addListener(new AnimationState.Listener() {
      @Override
      public void event(FiredEvent e, int track) {
        for (Listener l : listeners) l.event(e);
      }

      @Override
      public void audio(AudioCommand c) {
        for (Listener l : listeners) l.audio(c);
      }
    });
  }

  public OpenBoneInstance(OpenBoneDocument doc) {
    this(doc, null);
  }

  /** Load a .obone or .obonb file. */
  public static OpenBoneInstance load(Path file, ScriptHost scriptHost) throws IOException {
    return new OpenBoneInstance(DocumentLoader.load(Files.readAllBytes(file)), scriptHost);
  }

  public void addListener(Listener l) {
    listeners.add(l);
  }

  public void removeListener(Listener l) {
    listeners.remove(l);
  }

  /** Play an animation on a track (stops the state machine, if any). */
  public TrackEntry play(String animation, boolean loop, int track) {
    if (stateMachine != null) stateMachine.dispose();
    stateMachine = null;
    return animationState.setAnimation(track, animation, loop);
  }

  public TrackEntry play(String animation, boolean loop) {
    return play(animation, loop, 0);
  }

  /** Drive the skeleton with a state machine (by name or id; null = the first). */
  public StateMachineInstance useStateMachine(String name) {
    StateMachineData data = name != null ? doc.findStateMachine(name) : doc.stateMachines.isEmpty() ? null : doc.stateMachines.get(0);
    if (data == null) throw new IllegalArgumentException(name != null ? "State machine \"" + name + "\" not found" : "Document has no state machine");
    if (stateMachine != null) stateMachine.dispose();
    animationState.clearTracks();
    stateMachine = new StateMachineInstance(skeleton, data, scriptHost);
    stateMachine.addListener(new StateMachineInstance.EventListener() {
      @Override
      public void event(FiredEvent e) {
        for (Listener l : listeners) l.event(e);
      }

      @Override
      public void stateChange(String layer, String from, String to) {
        for (Listener l : listeners) l.stateChange(layer, from, to);
      }

      @Override
      public void audio(AudioCommand c) {
        for (Listener l : listeners) l.audio(c);
      }
    });
    return stateMachine;
  }

  /** Step time by dt seconds and pose the skeleton. */
  public void advance(double dt) {
    if (stateMachine != null) {
      stateMachine.advance(dt);
      return;
    }
    animationState.update(dt);
    skeleton.setToSetupPose();
    animationState.apply();
    skeleton.update(dt);
    skeleton.updateWorldTransform();
  }

  /** A bus id for a name or id, "" for the master (null, "" or "master"); null when there is no such bus. */
  private String busRef(String bus) {
    if (bus == null || bus.isEmpty() || bus.equals("master")) return "";
    if (doc.audio == null) return null;
    for (com.openbone.runtime.data.AudioData.Bus b : doc.audio.buses) if (b.id.equals(bus)) return b.id;
    for (com.openbone.runtime.data.AudioData.Bus b : doc.audio.buses) if (b.name.equals(bus)) return b.id;
    return null;
  }

  /**
   * Mute, unmute or toggle (null) a sound bus by name or id ("music"), or the master with null / "master", from
   * outside the artboard (game settings, UI buttons). Same as a mute-button listener. Returns the new state, or null
   * when there is no such bus.
   */
  public Boolean setBusMuted(String bus, Boolean muted) {
    String ref = busRef(bus);
    if (ref == null) return null;
    String id = ref.isEmpty() ? null : ref;
    return stateMachine != null ? stateMachine.setBusMute(id, muted) : animationState.audio.setMute(id, muted);
  }

  /** Whether a bus (name or id; null / "master" = the master) is muted now; null when there is no such bus. */
  public Boolean isBusMuted(String bus) {
    String ref = busRef(bus);
    if (ref == null) return null;
    String id = ref.isEmpty() ? null : ref;
    return (stateMachine != null ? stateMachine.audio : animationState.audio).isMuted(id);
  }

  /** Pointer event ("down", "up", "move") in skeleton space (y up). */
  public void pointer(String type, double x, double y) {
    if (stateMachine != null) stateMachine.pointer(type, x, y);
  }

  /** Artboard pixels (y down, origin top-left) to skeleton space. */
  public double[] artboardToSkeleton(double px, double py) {
    return new double[] {px - doc.originX, doc.originY - py};
  }

  /** Stop every sound and release the state machine's scripts. */
  public void dispose() {
    if (stateMachine != null) stateMachine.dispose();
    animationState.clearTracks();
  }

  public List<DrawItem> drawList() {
    return skeleton.drawList();
  }
}
