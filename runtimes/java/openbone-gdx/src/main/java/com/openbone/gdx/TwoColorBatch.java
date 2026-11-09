package com.openbone.gdx;

import com.badlogic.gdx.Gdx;
import com.badlogic.gdx.graphics.GL20;
import com.badlogic.gdx.graphics.Mesh;
import com.badlogic.gdx.graphics.Texture;
import com.badlogic.gdx.graphics.VertexAttribute;
import com.badlogic.gdx.graphics.VertexAttributes;
import com.badlogic.gdx.graphics.glutils.ShaderProgram;
import com.badlogic.gdx.math.Matrix4;
import com.badlogic.gdx.utils.Disposable;
import com.badlogic.gdx.utils.GdxRuntimeException;

/**
 * Triangle batch with a two-colour tint (light × texture + dark), per-vertex colours and premultiplied output, so all
 * four blend modes work with straight or premultiplied textures.
 */
public class TwoColorBatch implements Disposable {
  /** x, y, light rgba, dark rgb, u, v. */
  static final int STRIDE = 2 + 4 + 3 + 2;

  static final String VERTEX = ""
      + "attribute vec4 a_position;\n"
      + "attribute vec4 a_light;\n"
      + "attribute vec3 a_dark;\n"
      + "attribute vec2 a_texCoord0;\n"
      + "uniform mat4 u_projTrans;\n"
      + "varying vec4 v_light;\n"
      + "varying vec3 v_dark;\n"
      + "varying vec2 v_uv;\n"
      + "void main() {\n"
      + "  v_light = a_light;\n"
      + "  v_dark = a_dark;\n"
      + "  v_uv = a_texCoord0;\n"
      + "  gl_Position = u_projTrans * a_position;\n"
      + "}\n";

  static final String FRAGMENT = ""
      + "#ifdef GL_ES\nprecision mediump float;\n#endif\n"
      + "varying vec4 v_light;\n"
      + "varying vec3 v_dark;\n"
      + "varying vec2 v_uv;\n"
      + "uniform sampler2D u_texture;\n"
      + "uniform float u_pma;\n"
      + "void main() {\n"
      + "  vec4 t = texture2D(u_texture, v_uv);\n"
      + "  if (u_pma > 0.5 && t.a > 0.0) t.rgb /= t.a;\n"
      + "  vec3 rgb = v_dark + (v_light.rgb - v_dark) * t.rgb;\n"
      + "  float a = t.a * v_light.a;\n"
      + "  gl_FragColor = vec4(rgb * a, a);\n"
      + "}\n";

  private final Mesh mesh;
  private final ShaderProgram shader;
  private final float[] vertices;
  private final short[] indices;
  private int vCount, iCount;
  private Texture texture;
  private boolean pma;
  private String blend = "normal";
  private final Matrix4 projection = new Matrix4();
  private boolean drawing;
  public int drawCalls;

  public TwoColorBatch(int maxVertices) {
    if (maxVertices > 32767) throw new IllegalArgumentException("maxVertices must be <= 32767");
    mesh = new Mesh(false, maxVertices, maxVertices * 3,
        new VertexAttribute(VertexAttributes.Usage.Position, 2, ShaderProgram.POSITION_ATTRIBUTE),
        new VertexAttribute(VertexAttributes.Usage.ColorUnpacked, 4, "a_light"),
        new VertexAttribute(VertexAttributes.Usage.Generic, 3, "a_dark"),
        new VertexAttribute(VertexAttributes.Usage.TextureCoordinates, 2, ShaderProgram.TEXCOORD_ATTRIBUTE + "0"));
    vertices = new float[maxVertices * STRIDE];
    indices = new short[maxVertices * 3];
    ShaderProgram.pedantic = false;
    shader = new ShaderProgram(VERTEX, FRAGMENT);
    if (!shader.isCompiled()) throw new GdxRuntimeException("OpenBone shader: " + shader.getLog());
  }

  public void setProjection(Matrix4 m) {
    projection.set(m);
    if (drawing) shader.setUniformMatrix("u_projTrans", projection);
  }

  public void begin() {
    drawing = true;
    Gdx.gl.glDepthMask(false);
    Gdx.gl.glEnable(GL20.GL_BLEND);
    shader.bind();
    shader.setUniformMatrix("u_projTrans", projection);
    shader.setUniformi("u_texture", 0);
    applyBlend();
  }

  public void end() {
    flush();
    drawing = false;
  }

  /** Set the state for the next triangles; flushes when it changes. */
  public void state(Texture tex, boolean premultiplied, String blendMode) {
    if (tex != texture || premultiplied != pma || !blendMode.equals(blend)) {
      flush();
      texture = tex;
      pma = premultiplied;
      if (!blendMode.equals(blend)) {
        blend = blendMode;
        applyBlend();
      }
    }
  }

  private void applyBlend() {
    switch (blend) {
      case "additive": Gdx.gl.glBlendFunc(GL20.GL_ONE, GL20.GL_ONE); break;
      case "multiply": Gdx.gl.glBlendFunc(GL20.GL_DST_COLOR, GL20.GL_ONE_MINUS_SRC_ALPHA); break;
      case "screen": Gdx.gl.glBlendFunc(GL20.GL_ONE, GL20.GL_ONE_MINUS_SRC_COLOR); break;
      default: Gdx.gl.glBlendFunc(GL20.GL_ONE, GL20.GL_ONE_MINUS_SRC_ALPHA);
    }
  }

  /** Make room for n vertices and m indices; returns the base vertex index. */
  public int reserve(int n, int m) {
    if (n > vertices.length / STRIDE || m > indices.length) throw new IllegalArgumentException("Too many vertices for one batch: " + n);
    if (vCount + n > vertices.length / STRIDE || iCount + m > indices.length) flush();
    return vCount;
  }

  public void vertex(float x, float y, float r, float g, float b, float a, float dr, float dg, float db, float u, float v) {
    int o = vCount * STRIDE;
    float[] vs = vertices;
    vs[o] = x;
    vs[o + 1] = y;
    vs[o + 2] = r;
    vs[o + 3] = g;
    vs[o + 4] = b;
    vs[o + 5] = a;
    vs[o + 6] = dr;
    vs[o + 7] = dg;
    vs[o + 8] = db;
    vs[o + 9] = u;
    vs[o + 10] = v;
    vCount++;
  }

  public void index(int i) {
    indices[iCount++] = (short) i;
  }

  public void flush() {
    if (iCount == 0 || texture == null) {
      vCount = iCount = 0;
      return;
    }
    texture.bind(0);
    shader.setUniformf("u_pma", pma ? 1 : 0);
    mesh.setVertices(vertices, 0, vCount * STRIDE);
    mesh.setIndices(indices, 0, iCount);
    mesh.render(shader, GL20.GL_TRIANGLES, 0, iCount);
    drawCalls++;
    vCount = iCount = 0;
  }

  @Override
  public void dispose() {
    mesh.dispose();
    shader.dispose();
  }
}
