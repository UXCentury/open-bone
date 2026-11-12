package com.openbone.gdx.sample;

import com.badlogic.gdx.ApplicationAdapter;
import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.InputAdapter;
import com.badlogic.gdx.files.FileHandle;
import com.badlogic.gdx.graphics.GL20;
import com.badlogic.gdx.graphics.OrthographicCamera;
import com.badlogic.gdx.graphics.Pixmap;
import com.badlogic.gdx.graphics.PixmapIO;
import com.badlogic.gdx.math.Vector3;
import com.badlogic.gdx.utils.ScreenUtils;
import com.openbone.gdx.DocumentTextures;
import com.openbone.gdx.OpenBoneAudio;
import com.openbone.gdx.OpenBoneRenderer;
import com.openbone.runtime.AudioCommand;
import com.openbone.runtime.FiredEvent;
import com.openbone.runtime.OpenBoneInstance;
import com.openbone.runtime.data.DocumentLoader;
import com.openbone.runtime.data.OpenBoneDocument;
import com.openbone.scripting.QuickJsScriptHost;

/** Loads a document, runs its state machine (or first animation) and draws it with {@link OpenBoneRenderer}. */
public class SampleApp extends ApplicationAdapter {
  public static final class Options {
    String file = "../../examples/knight.obone";
    String stateMachine, animation, screenshot;
    int frames = 0, width = 960, height = 720;
    boolean mute;

    static Options parse(String[] args) {
      Options o = new Options();
      for (int i = 0; i < args.length; i++) {
        switch (args[i]) {
          case "--frames": o.frames = Integer.parseInt(args[++i]); break;
          case "--screenshot": o.screenshot = args[++i]; break;
          case "--state-machine": o.stateMachine = args[++i]; break;
          case "--animation": o.animation = args[++i]; break;
          case "--mute": o.mute = true; break;
          case "--size": {
            String[] wh = args[++i].split("x");
            o.width = Integer.parseInt(wh[0]);
            o.height = Integer.parseInt(wh[1]);
            break;
          }
          default: o.file = args[i];
        }
      }
      return o;
    }
  }

  private final Options options;
  private OpenBoneDocument doc;
  private OpenBoneInstance instance;
  private DocumentTextures textures;
  private OpenBoneRenderer renderer;
  private OpenBoneAudio audio;
  private final OrthographicCamera camera = new OrthographicCamera();
  private int frame;

  public SampleApp(Options options) {
    this.options = options;
  }

  @Override
  public void create() {
    FileHandle file = Gdx.files.absolute(new java.io.File(options.file).getAbsolutePath());
    doc = DocumentLoader.load(file.readBytes());
    instance = new OpenBoneInstance(doc, new QuickJsScriptHost());
    instance.addListener(new OpenBoneInstance.Listener() {
      @Override
      public void event(FiredEvent e) {
        Gdx.app.log("event", e.name + " t=" + e.time + " int=" + e.intValue + " float=" + e.floatValue + " string=" + e.stringValue);
      }

      @Override
      public void stateChange(String layer, String from, String to) {
        Gdx.app.log("state", layer + ": " + from + " -> " + to);
      }

      @Override
      public void audio(AudioCommand c) {
        Gdx.app.log("audio", c.toMap().toString());
      }
    });
    // Plays the sounds; the log above still sees every command. --mute leaves it out.
    if (!options.mute) instance.addListener(audio = new OpenBoneAudio(doc, file.parent()));
    if (options.animation != null) instance.play(options.animation, true);
    else if (!doc.stateMachines.isEmpty()) instance.useStateMachine(options.stateMachine);
    else if (!doc.animations.isEmpty()) instance.play(doc.animations.get(0).name, true);
    textures = new DocumentTextures(doc, file.parent());
    renderer = new OpenBoneRenderer();
    renderer.useDocumentFonts(doc, file.parent());
    Gdx.input.setInputProcessor(new InputAdapter() {
      final Vector3 v = new Vector3();

      private boolean send(String type, int sx, int sy) {
        camera.unproject(v.set(sx, sy, 0));
        instance.pointer(type, v.x, v.y);
        return true;
      }

      @Override
      public boolean touchDown(int x, int y, int pointer, int button) {
        return send("down", x, y);
      }

      @Override
      public boolean touchUp(int x, int y, int pointer, int button) {
        return send("up", x, y);
      }

      @Override
      public boolean touchDragged(int x, int y, int pointer) {
        return send("move", x, y);
      }

      @Override
      public boolean mouseMoved(int x, int y) {
        return send("move", x, y);
      }
    });
    resize(Gdx.graphics.getWidth(), Gdx.graphics.getHeight());
  }

  @Override
  public void resize(int width, int height) {
    // Fit the artboard (document width × height, origin at originX/originY, y down) into the window.
    double aw = doc.width > 0 ? doc.width : 800, ah = doc.height > 0 ? doc.height : 600;
    double zoom = Math.max(aw / width, ah / height);
    camera.setToOrtho(false, (float) (width * zoom), (float) (height * zoom));
    camera.position.set((float) (aw / 2 - doc.originX), (float) (doc.originY - ah / 2), 0);
    camera.update();
  }

  @Override
  public void render() {
    // Fixed steps in headless mode keep screenshots reproducible.
    double dt = options.frames > 0 ? 1 / 60.0 : Math.min(Gdx.graphics.getDeltaTime(), 0.1);
    instance.advance(dt);
    if (audio != null) audio.update((float) dt);
    ScreenUtils.clear(0.12f, 0.12f, 0.14f, 1, true);
    Gdx.gl.glClear(GL20.GL_STENCIL_BUFFER_BIT);
    renderer.draw(instance, textures, camera.combined);
    frame++;
    if (options.frames > 0 && frame >= options.frames) {
      if (options.screenshot != null) {
        Pixmap pm = Pixmap.createFromFrameBuffer(0, 0, Gdx.graphics.getBackBufferWidth(), Gdx.graphics.getBackBufferHeight());
        PixmapIO.writePNG(Gdx.files.absolute(new java.io.File(options.screenshot).getAbsolutePath()), pm, -1, true);
        pm.dispose();
        Gdx.app.log("sample", "wrote " + options.screenshot + " (" + renderer.drawCalls + " draw calls)");
      }
      Gdx.app.exit();
    }
  }

  @Override
  public void dispose() {
    instance.dispose();
    if (audio != null) audio.dispose();
    renderer.dispose();
    textures.dispose();
  }
}
