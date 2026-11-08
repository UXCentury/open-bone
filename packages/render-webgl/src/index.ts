import type { DrawItem, Skeleton } from "@openbone/runtime";

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
 * Batched WebGL2 renderer: one draw call per texture/blend change.
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

  constructor(
    public canvas: HTMLCanvasElement | OffscreenCanvas,
    public images: (id: string) => TexSource | null | undefined,
  ) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true }) as WebGL2RenderingContext | null;
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
    this.curTex = null;
    this.curBlend = "";
    for (const it of sk.drawList()) this.push(it);
    this.flush();
  }

  private push(it: DrawItem) {
    const tex = it.image ? (this.texture(it.image.id) ?? this.white) : this.white;
    if (tex !== this.curTex || it.blend !== this.curBlend) {
      this.flush();
      this.curTex = tex;
      this.setBlend(it.blend);
    }
    const n = it.vertices.length / 2;
    if (this.nv + n > this.verts.length / 8 || this.ni + it.indices.length > this.idx.length) this.flush();
    const base = this.nv;
    const [r, g, b, a] = it.color;
    for (let i = 0; i < n; i++) {
      const o = (this.nv + i) * 8;
      this.verts[o] = it.vertices[i * 2];
      this.verts[o + 1] = it.vertices[i * 2 + 1];
      this.verts[o + 2] = it.uvs[i * 2] ?? 0;
      this.verts[o + 3] = it.uvs[i * 2 + 1] ?? 0;
      this.verts[o + 4] = r;
      this.verts[o + 5] = g;
      this.verts[o + 6] = b;
      this.verts[o + 7] = a;
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
    this.nv = 0;
    this.ni = 0;
  }

  dispose() {
    this.invalidate();
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
