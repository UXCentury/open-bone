using System;
using System.IO;
using System.Text;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// The two-colour tint effect (Shaders/OpenBoneTint.fx) for MonoGame's OpenGL backend.
    /// <para>
    /// MonoGame's effect compiler (mgfxc) needs Windows or Wine to compile HLSL, so instead of shipping a prebuilt
    /// binary this class writes the MGFX container itself with hand-written GLSL equivalent to the .fx file (MGFX for
    /// OpenGL stores GLSL source). If the running MonoGame rejects it (another MGFX version, or a DirectX build), the
    /// renderer falls back to <see cref="BasicEffect"/>, which draws everything except the dark colour of two-colour
    /// tint. Pass your own compiled effect (<see cref="OpenBoneRenderer.Effect"/>) to override.
    /// </para>
    /// </summary>
    public static class TintEffect
    {
        /// <summary>MGFX version written (MonoGame 3.8.x reads 10 and 11).</summary>
        public const byte MgfxVersion = 11;
        /// <summary>MGFX profile id of the OpenGL backend.</summary>
        public const byte OpenGLProfile = 0;

        /// <summary>Uniform holding WorldViewProjection (4 vec4 columns).</summary>
        public const string ConstantBufferName = "vs_uniforms_vec4";
        public const string SamplerName = "ps_s0";

        public const string VertexShaderGlsl = @"#ifdef GL_ES
precision highp float;
precision mediump int;
#endif

uniform vec4 vs_uniforms_vec4[4];
uniform vec4 posFixup;
attribute vec4 vs_v0;
attribute vec4 vs_v1;
attribute vec4 vs_v2;
attribute vec4 vs_v3;
varying vec4 vFrontColor;
varying vec4 vFrontSecondaryColor;
varying vec4 vTexCoord0;

void main()
{
	gl_Position = vec4(dot(vs_v0, vs_uniforms_vec4[0]), dot(vs_v0, vs_uniforms_vec4[1]), dot(vs_v0, vs_uniforms_vec4[2]), dot(vs_v0, vs_uniforms_vec4[3]));
	vFrontColor = vs_v1;
	vFrontSecondaryColor = vs_v2;
	vTexCoord0 = vs_v3;
	gl_Position.y = gl_Position.y * posFixup.y;
	gl_Position.xy += posFixup.zw * gl_Position.ww;
	gl_Position.z = gl_Position.z * 2.0 - gl_Position.w;
}
";

        public const string PixelShaderGlsl = @"#ifdef GL_ES
precision mediump float;
precision mediump int;
#endif

uniform sampler2D ps_s0;
varying vec4 vFrontColor;
varying vec4 vFrontSecondaryColor;
varying vec4 vTexCoord0;

void main()
{
	vec4 t = texture2D(ps_s0, vTexCoord0.xy);
	vec3 dark = vFrontSecondaryColor.rgb;
	gl_FragColor = vec4(dark * t.a + (vFrontColor.rgb - dark) * t.rgb, t.a * vFrontColor.a);
}
";

        static byte[] _bytes;

        /// <summary>The MGFX bytes of the effect (OpenGL profile).</summary>
        public static byte[] Bytes => _bytes ??= Build();

        /// <summary>The effect for a device, or null if this MonoGame build cannot load it.</summary>
        public static Effect TryCreate(GraphicsDevice device, out string error)
        {
            error = null;
            try
            {
                var e = new Effect(device, Bytes);
                if (e.Parameters["WorldViewProjection"] == null || e.Parameters["Texture"] == null) throw new InvalidOperationException("parameters missing");
                return e;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        /// <summary>Write the MGFX container (see MonoGame's Effect.ReadEffect / Shader for the layout).</summary>
        public static byte[] Build()
        {
            using var body = new MemoryStream();
            using (var w = new BinaryWriter(body, Encoding.UTF8, true))
            {
                // Constant buffers: one, the vertex shader's uniforms (parameter 0 at offset 0, 64 bytes).
                w.Write(1);
                w.Write(ConstantBufferName);
                w.Write((short)64);
                w.Write(1);
                w.Write(0);
                w.Write((ushort)0);

                // Shaders: 0 = vertex, 1 = pixel.
                w.Write(2);
                WriteShader(w, true, VertexShaderGlsl, sampler: false);
                WriteShader(w, false, PixelShaderGlsl, sampler: true);

                // Parameters: 0 = WorldViewProjection (float4x4), 1 = Texture.
                w.Write(2);
                w.Write((byte)EffectParameterClass.Matrix);
                w.Write((byte)EffectParameterType.Single);
                w.Write("WorldViewProjection");
                w.Write("");
                w.Write(0);         // annotations
                w.Write((byte)4);   // rows
                w.Write((byte)4);   // columns
                w.Write(0);         // elements
                w.Write(0);         // struct members
                for (int i = 0; i < 16; i++) w.Write(i % 5 == 0 ? 1f : 0f);

                w.Write((byte)EffectParameterClass.Object);
                w.Write((byte)EffectParameterType.Texture2D);
                w.Write("Texture");
                w.Write("");
                w.Write(0);
                w.Write((byte)0);
                w.Write((byte)0);
                w.Write(0);
                w.Write(0);

                // Techniques: TwoColorTint with one pass (no render states: the renderer sets them).
                w.Write(1);
                w.Write("TwoColorTint");
                w.Write(0);         // annotations
                w.Write(1);         // passes
                w.Write("P0");
                w.Write(0);         // annotations
                w.Write(0);         // vertex shader index
                w.Write(1);         // pixel shader index
                w.Write(false);     // blend state
                w.Write(false);     // depth-stencil state
                w.Write(false);     // rasterizer state

                // Tail: the signature again.
                w.Write(Signature);
            }
            var content = body.ToArray();
            using var file = new MemoryStream();
            using (var w = new BinaryWriter(file))
            {
                w.Write(Signature);
                w.Write(MgfxVersion);
                w.Write(OpenGLProfile);
                w.Write(EffectKey(content));
                w.Write(content);
            }
            return file.ToArray();
        }

        /// <summary>"MGFX" as a little-endian int.</summary>
        public const int Signature = 0x5846474D;

        static void WriteShader(BinaryWriter w, bool vertex, string glsl, bool sampler)
        {
            w.Write(vertex);
            w.Write("OpenBoneTint.fx");                 // source file (version 11+)
            w.Write(vertex ? "MainVS" : "MainPS");       // entry point
            var code = Encoding.ASCII.GetBytes(glsl);
            w.Write(code.Length);
            w.Write(code);
            if (sampler)
            {
                w.Write((byte)1);
                w.Write((byte)0);    // SamplerType.Sampler2D
                w.Write((byte)0);    // texture slot
                w.Write((byte)0);    // sampler slot
                w.Write(false);      // no sampler state: the device's SamplerStates[0] applies
                w.Write(SamplerName);
                w.Write((byte)1);    // parameter: Texture
            }
            else w.Write((byte)0);
            if (vertex)
            {
                w.Write((byte)1);
                w.Write((byte)0);    // constant buffer 0
                w.Write((byte)4);
                WriteAttribute(w, "vs_v0", VertexElementUsage.Position, 0);
                WriteAttribute(w, "vs_v1", VertexElementUsage.Color, 0);
                WriteAttribute(w, "vs_v2", VertexElementUsage.Color, 1);
                WriteAttribute(w, "vs_v3", VertexElementUsage.TextureCoordinate, 0);
            }
            else
            {
                w.Write((byte)0);    // constant buffers
                w.Write((byte)0);    // attributes
            }
        }

        static void WriteAttribute(BinaryWriter w, string name, VertexElementUsage usage, int index)
        {
            w.Write(name);
            w.Write((byte)usage);
            w.Write((byte)index);
            w.Write((short)-1);      // location: looked up when the program links
        }

        /// <summary>Cache key MonoGame uses to share effect instances (FNV-1a of the content).</summary>
        static int EffectKey(byte[] content)
        {
            unchecked
            {
                uint h = 2166136261;
                foreach (var b in content) h = (h ^ b) * 16777619;
                return (int)h;
            }
        }
    }
}
