// OpenBone two-colour tint effect for MonoGame.
//
// Textures are premultiplied (OpenBoneTextures premultiplies straight images on load), and so are the vertex colours:
// COLOR0 = (light.rgb * a, a) and COLOR1 = (dark.rgb * a, 1). The output is premultiplied, so every blend mode is a
// fixed-function BlendState:
//   straight texel s = t.rgb / t.a, tinted colour c = dark + (light - dark) * s, output = (c * t.a * a, t.a * a)
//   = (dark' * t.a + (light' - dark') * t.rgb, t.a * a)   with light' = light * a, dark' = dark * a.
// With dark = black this is texel * colour, i.e. what BasicEffect computes (the fallback when this effect is missing).
//
// Compile: ./build-shader.sh (mgfxc /Profile:OpenGL); the result is embedded as OpenBoneTint.ogl.mgfx.

#if OPENGL
#define SV_POSITION POSITION
#define VS_SHADERMODEL vs_3_0
#define PS_SHADERMODEL ps_3_0
#else
#define VS_SHADERMODEL vs_4_0_level_9_1
#define PS_SHADERMODEL ps_4_0_level_9_1
#endif

float4x4 WorldViewProjection;

Texture2D Texture;
sampler2D TextureSampler = sampler_state
{
    Texture = <Texture>;
};

struct VertexInput
{
    float4 Position : POSITION0;
    float4 Color : COLOR0;
    float4 Dark : COLOR1;
    float2 TexCoord : TEXCOORD0;
};

struct VertexOutput
{
    float4 Position : SV_POSITION;
    float4 Color : COLOR0;
    float4 Dark : COLOR1;
    float2 TexCoord : TEXCOORD0;
};

VertexOutput MainVS(in VertexInput input)
{
    VertexOutput output;
    output.Position = mul(input.Position, WorldViewProjection);
    output.Color = input.Color;
    output.Dark = input.Dark;
    output.TexCoord = input.TexCoord;
    return output;
}

float4 MainPS(VertexOutput input) : COLOR
{
    float4 t = tex2D(TextureSampler, input.TexCoord);
    float3 rgb = input.Dark.rgb * t.a + (input.Color.rgb - input.Dark.rgb) * t.rgb;
    return float4(rgb, t.a * input.Color.a);
}

technique TwoColorTint
{
    pass P0
    {
        VertexShader = compile VS_SHADERMODEL MainVS();
        PixelShader = compile PS_SHADERMODEL MainPS();
    }
};
