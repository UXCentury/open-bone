import type { OpenBoneDocument } from "@openbone/core";
import { AnimationState } from "./animation-state.ts";
import type { FiredEvent } from "./animation.ts";
import type { AudioCommand } from "./audio.ts";
import { Emitter } from "./emitter.ts";
import { Skeleton } from "./skeleton.ts";
import { type StateMachineOptions, StateMachineInstance } from "./state-machine.ts";

type Events = {
  event: [FiredEvent];
  stateChange: [{ layer: string; from: string | null; to: string }];
  /** Sound commands from the animation state or the state machine; feed them to an audio backend. */
  audio: [AudioCommand];
};

/**
 * High-level handle: one skeleton driven either by an AnimationState (play/queue animations)
 * or by a state machine (inputs + listeners). The usual entry point for players and games.
 */
export class OpenBoneInstance extends Emitter<Events> {
  skeleton: Skeleton;
  animationState: AnimationState;
  stateMachine: StateMachineInstance | null = null;

  constructor(
    public doc: OpenBoneDocument,
    private smOptions: StateMachineOptions = {},
  ) {
    super();
    this.skeleton = new Skeleton(doc);
    this.animationState = new AnimationState(this.skeleton);
    this.animationState.on("event", (e) => this.emit("event", e));
    this.animationState.on("audio", (c) => this.emit("audio", c));
  }

  play(animation: string, loop = true, track = 0) {
    this.stateMachine?.dispose();
    this.stateMachine = null;
    return this.animationState.setAnimation(track, animation, loop);
  }

  useStateMachine(name?: string): StateMachineInstance {
    const data = name ? this.doc.stateMachines.find((s) => s.name === name || s.id === name) : this.doc.stateMachines[0];
    if (!data) throw new Error(name ? `State machine "${name}" not found` : "Document has no state machine");
    this.stateMachine?.dispose();
    this.animationState.clearTracks();
    this.stateMachine = new StateMachineInstance(this.skeleton, data, this.smOptions);
    this.stateMachine.on("audio", (c) => this.emit("audio", c));
    this.stateMachine.on("event", (e) => this.emit("event", e));
    this.stateMachine.on("stateChange", (e) => this.emit("stateChange", e));
    return this.stateMachine;
  }

  advance(dt: number) {
    if (this.stateMachine) {
      this.stateMachine.advance(dt);
      return;
    }
    this.animationState.update(dt);
    this.skeleton.setToSetupPose();
    this.animationState.apply();
    this.skeleton.update(dt);
    this.skeleton.updateWorldTransform();
  }

  /** Pointer in skeleton space (y-up). */
  pointer(type: "down" | "up" | "move", x: number, y: number) {
    this.stateMachine?.pointer(type, x, y);
  }

  /** Convert artboard pixel coordinates (y-down, origin top-left) to skeleton space. */
  artboardToSkeleton(px: number, py: number): [number, number] {
    return [px - this.doc.originX, this.doc.originY - py];
  }

  /** Stop every sound and release the state machine's scripts. */
  dispose() {
    this.stateMachine?.dispose();
    this.animationState.clearTracks();
  }

  drawList() {
    return this.skeleton.drawList();
  }
}
