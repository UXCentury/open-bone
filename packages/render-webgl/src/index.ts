import { type ClipRegion, type DrawItem, PARTICLE_DOT_SIZE, PARTICLE_DOT_TEXTURE, type Skeleton, type TextContext, type TextDraw, cssFont, drawTextBox, particleDotAlpha } from "@openbone/runtime";

/** One rasterised text item: re-drawn only when its content, style or pixel scale changes. */
interface TextTexture {
  key: string;
  tex: WebGLTexture;
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Padding (skeleton units) around the box, so outlines and overhangs are not cut off. */
  pad: number;
  used: number;
}

/** Largest side of a text texture in pixels. */
const MAX_TEXT_TEXTURE = 2048;

const VS = `#version 300 es
in vec2 aPos; in vec2 aUv; in vec4 aColor;
uniform mat3 uView;
out vec2 vUv; out vec4 vColor;
void main(){ vec3 p = uView * vec3(aPos, 1.0); gl_Position = vec4(p.xy, 0.0, 1.0); vUv = aUv; vColor = aColor; }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUv; in vec4 vColor; uniform sampler2D uTex; out vec4 o;
void main(){ vec4 t = texture(uTex, vUv); o = vec4(t.rgb * vColor.rgb, t.a) * vColor.a; }`;

type TexSource = TexImageSource;

/**
 * Batched WebGL2 renderer: one draw call per texture/blend change. Textures are resolved by id: image ids for
 * loose images, atlas page ids for packed ones (packed images and shapes share their page, so they batch).
 * Vertex layout: x, y, u, v, r, g, b, a (premultiplied alpha output).
 */
export class WebGLRenderer {
  gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private uView: WebGLUniformLocation;
  private textures = new Map<string, WebGLTexture>();
  private white: WebGLTexture;
  private verts = new Float32Array(8 * 16384);
  private idx = new Uint16Array(6 * 16384);
  private nv = 0;
  private ni = 0;
  private curTex: WebGLTexture | null = null;
  private curBlend = "";
  private curClip: ClipRegion | undefined;
  private texts = new Map<string, TextTexture>();
  private zoom = 1;
  private frame = 0;
  /** Draw calls issued by the last render() (clip-mask stencil writes included). */
  drawCalls = 0;

  constructor(
    public canvas: HTMLCanvasElement | OffscreenCanvas,
    public images: (id: string) => TexSource | null | undefined,
  ) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true, stencil: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    this.prog = link(gl, VS, FS);
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    this.uView = gl.getUniformLocation(this.prog, "uView")!;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    const stride = 8 * 4;
    const attr = (name: string, size: number, off: number) => {
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    };
    attr("aPos", 2, 0);
    attr("aUv", 2, 2);
    attr("aColor", 4, 4);
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  private texture(id: string): WebGLTexture | null {
    let t = this.textures.get(id);
    if (t) return t;
    if (id === PARTICLE_DOT_TEXTURE) return this.dotTexture();
    const src = this.images(id);
    if (!src) return null;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(id, t);
    return t;
  }

  /** The built-in soft round particle sprite (premultiplied white). */
  private dotTexture(): WebGLTexture {
    const gl = this.gl;
    const n = PARTICLE_DOT_SIZE;
    const px = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const r = Math.hypot((x + 0.5) / n - 0.5, (y + 0.5) / n - 0.5) * 2;
        px.fill(Math.round(particleDotAlpha(r) * 255), (y * n + x) * 4, (y * n + x) * 4 + 4);
      }
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(PARTICLE_DOT_TEXTURE, t);
    return t;
  }

  /** Forget a cached texture (e.g. after an image asset changed). */
  invalidate(id?: string) {
    if (id) {
      const t = this.textures.get(id);
      if (t) this.gl.deleteTexture(t);
      this.textures.delete(id);
    } else {
      for (const t of this.textures.values()) this.gl.deleteTexture(t);
      this.textures.clear();
    }
  }

  render(sk: Skeleton, view = { x: 0, y: 0, zoom: 1 }, clearColor: [number, number, number, number] | null = [0, 0, 0, 0]) {
    const gl = this.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    if (clearColor) {
      gl.clearColor(...clearColor);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    const doc = sk.doc;
    // skeleton (y-up) -> canvas px -> clip space
    const z = view.zoom;
    const tx = view.x + doc.originX * z;
    const ty = view.y + doc.originY * z;
    const sx = 2 / w;
    const sy = -2 / h;
    gl.uniformMatrix3fv(this.uView, false, [z * sx, 0, 0, 0, -z * sy, 0, tx * sx - 1, ty * sy + 1, 1]);
    this.zoom = z;
    this.frame++;
    this.curTex = null;
    this.curBlend = "";
    this.curClip = undefined;
    this.drawCalls = 0;
    gl.disable(gl.STENCIL_TEST);
    for (const it of sk.drawList()) this.push(it);
    this.flush();
    gl.disable(gl.STENCIL_TEST);
    // Drop text textures of slots that stopped showing text.
    for (const [k, t] of this.texts)
      if (this.frame - t.used > 60) {
        gl.deleteTexture(t.tex);
        this.texts.delete(k);
      }
  }

  /** Rasterise a text item into its texture (cached per slot and attachment). */
  private textTexture(it: DrawItem & { text: TextDraw }): TextTexture | null {
    const t = it.text;
    const m = t.matrix;
    // Pixels per skeleton unit on screen, in powers of two so zooming does not re-rasterise every frame.
    const px = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * this.zoom;
    let scale = 2 ** Math.ceil(Math.log2(Math.max(0.25, px)));
    const pad = t.outlineWidth + t.size * 0.25;
    const w = t.width + pad * 2;
    const h = t.height + pad * 2;
    scale = Math.min(scale, MAX_TEXT_TEXTURE / Math.max(w, h));
    const id = `${it.slot.data.id}/${it.attachment.name}`;
    const key = `${t.content}|${cssFont(t)}|${t.align}|${t.width}x${t.height}|${t.fill}|${t.outline}|${t.outlineWidth}|${scale}`;
    let entry = this.texts.get(id);
    if (entry && entry.key === key) {
      entry.used = this.frame;
      return entry;
    }
    const W = Math.max(1, Math.ceil(w * scale));
    const H = Math.max(1, Math.ceil(h * scale));
    const gl = this.gl;
    if (!entry) {
      const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : document.createElement("canvas");
      entry = { key: "", tex: gl.createTexture()!, canvas, pad, used: this.frame };
      this.texts.set(id, entry);
    }
    const c = entry.canvas;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(scale, 0, 0, scale, W / 2, H / 2);
    drawTextBox(ctx as unknown as TextContext, t);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.curTex === entry.tex) this.curTex = null;
    entry.key = key;
    entry.pad = pad;
    entry.used = this.frame;
    return entry;
  }

  /** Quad of a text item's texture: the box grown by the padding (TL, TR, BR, BL in world space). */
  private static textQuad(t: TextDraw, pad: number): Float32Array {
    const m = t.matrix;
    const hw = t.width / 2 + pad;
    const hh = t.height / 2 + pad;
    const out = new Float32Array(8);
    const corners = [-hw, hh, hw, hh, hw, -hh, -hw, -hh];
    for (let i = 0; i < 8; i += 2) {
      out[i] = m.a * corners[i] + m.b * corners[i + 1] + m.x;
      out[i + 1] = m.c * corners[i] + m.d * corners[i + 1] + m.y;
    }
    return out;
  }

  /** Switch the stencil mask: write the clip polygon into the stencil buffer, then draw only where it is set. */
  private setClip(clip: ClipRegion | undefined) {
    const gl = this.gl;
    this.flush();
    this.curClip = clip;
    if (!clip) {
      gl.disable(gl.STENCIL_TEST);
      return;
    }
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    const n = clip.polygon.length / 2;
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      this.verts[o] = clip.polygon[i * 2];
      this.verts[o + 1] = clip.polygon[i * 2 + 1];
      this.verts.fill(1, o + 2, o + 8);
    }
    this.idx.set(clip.indices);
    this.nv = n;
    this.ni = clip.indices.length;
    const tex = this.curTex;
    this.curTex = this.white;
    this.flush();
    this.curTex = tex;
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private push(it: DrawItem) {
    if (it.clip !== this.curClip) this.setClip(it.clip);
    if (it.text) {
      this.flush();
      const tt = this.textTexture(it as DrawItem & { text: TextDraw });
      if (!tt) return;
      it = { ...it, vertices: WebGLRenderer.textQuad(it.text, tt.pad), texture: null };
      this.curTex = tt.tex;
      this.setBlend(it.blend);
      return this.pushGeometry(it);
    }
    const tex = it.texture ? (this.texture(it.texture.id) ?? this.white) : this.white;
    if (tex !== this.curTex || it.blend !== this.curBlend) {
      this.flush();
      this.curTex = tex;
      this.setBlend(it.blend);
    }
    this.pushGeometry(it);
  }

  private pushGeometry(it: DrawItem) {
    const n = it.vertices.length / 2;
    if (this.nv + n > this.verts.length / 8 || this.ni + it.indices.length > this.idx.length) this.flush();
    const base = this.nv;
    const [r, g, b, a] = it.color;
    const cols = it.colors;
    for (let i = 0; i < n; i++) {
      const o = (this.nv + i) * 8;
      this.verts[o] = it.vertices[i * 2];
      this.verts[o + 1] = it.vertices[i * 2 + 1];
      this.verts[o + 2] = it.uvs[i * 2] ?? 0;
      this.verts[o + 3] = it.uvs[i * 2 + 1] ?? 0;
      if (cols) {
        this.verts[o + 4] = cols[i * 4];
        this.verts[o + 5] = cols[i * 4 + 1];
        this.verts[o + 6] = cols[i * 4 + 2];
        this.verts[o + 7] = cols[i * 4 + 3];
      } else {
        this.verts[o + 4] = r;
        this.verts[o + 5] = g;
        this.verts[o + 6] = b;
        this.verts[o + 7] = a;
      }
    }
    for (let i = 0; i < it.indices.length; i++) this.idx[this.ni + i] = base + it.indices[i];
    this.nv += n;
    this.ni += it.indices.length;
  }

  private setBlend(mode: string) {
    const gl = this.gl;
    this.curBlend = mode;
    if (mode === "additive") gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else if (mode === "screen") gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private flush() {
    if (!this.ni) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.curTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, this.nv * 8), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.subarray(0, this.ni), gl.DYNAMIC_DRAW);
    gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_SHORT, 0);
    this.drawCalls++;
    this.nv = 0;
    this.ni = 0;
  }

  dispose() {
    this.invalidate();
    for (const t of this.texts.values()) this.gl.deleteTexture(t.tex);
    this.texts.clear();
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteBuffer(this.ibo);
    this.gl.deleteProgram(this.prog);
  }
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
