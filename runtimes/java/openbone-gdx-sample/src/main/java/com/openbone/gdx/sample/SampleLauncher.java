package com.openbone.gdx.sample;

import com.badlogic.gdx.backends.lwjgl3.Lwjgl3Application;
import com.badlogic.gdx.backends.lwjgl3.Lwjgl3ApplicationConfiguration;

/**
 * Desktop sample: plays an OpenBone document's state machine (or its first animation) and forwards the mouse.
 *
 * <pre>
 * ./gradlew :openbone-gdx-sample:run --args="../../examples/knight.obone"
 * ./gradlew :openbone-gdx-sample:run --args="../../examples/button.obone --frames 120 --screenshot build/shot.png"
 * </pre>
 */
public final class SampleLauncher {
  public static void main(String[] args) {
    SampleApp.Options o = SampleApp.Options.parse(args);
    Lwjgl3ApplicationConfiguration config = new Lwjgl3ApplicationConfiguration();
    config.setTitle("OpenBone · libGDX");
    config.setWindowedMode(o.width, o.height);
    config.setBackBufferConfig(8, 8, 8, 8, 16, 8, 0); // stencil for clipping masks
    config.useVsync(o.frames <= 0);
    config.setForegroundFPS(60);
    new Lwjgl3Application(new SampleApp(o), config);
  }
}
