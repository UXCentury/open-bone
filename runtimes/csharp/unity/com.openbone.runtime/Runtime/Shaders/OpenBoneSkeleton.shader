// OpenBone skeleton shader: two-colour tint (dark + (light - dark) * texture), straight or premultiplied textures,
// premultiplied output so every blend mode is a fixed-function blend, and stencil clipping.
// Unlit with no LightMode tag, so it renders in the built-in pipeline and in URP (SRPDefaultUnlit).
Shader "OpenBone/Skeleton"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        [Toggle] _PMA ("Texture has premultiplied alpha", Float) = 0
        [HideInInspector] _SrcBlend ("Src Blend", Float) = 1
        [HideInInspector] _DstBlend ("Dst Blend", Float) = 10
        [HideInInspector] _StencilRef ("Stencil Ref", Float) = 1
        [HideInInspector] _StencilComp ("Stencil Comparison", Float) = 8
        [HideInInspector] _StencilOp ("Stencil Operation", Float) = 0
        [HideInInspector] _ColorMask ("Color Mask", Float) = 15
    }
    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "PreviewType" = "Plane" }
        Cull Off
        ZWrite Off
        Lighting Off
        Blend [_SrcBlend] [_DstBlend]
        ColorMask [_ColorMask]
        Stencil
        {
            Ref [_StencilRef]
            Comp [_StencilComp]
            Pass [_StencilOp]
        }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            sampler2D _MainTex;
            float _PMA;

            struct appdata
            {
                float4 vertex : POSITION;
                float4 color : COLOR;
                float2 uv : TEXCOORD0;
                float4 dark : TEXCOORD1;
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                float4 color : COLOR;
                float2 uv : TEXCOORD0;
                float3 dark : TEXCOORD1;
            };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.color = v.color;
                o.uv = v.uv;
                o.dark = v.dark.rgb;
                return o;
            }

            float4 frag (v2f i) : SV_Target
            {
                float4 t = tex2D(_MainTex, i.uv);
                // Straight colour of the texel (premultiplied pages are divided back).
                float3 rgb = _PMA > 0.5 ? (t.a > 0.0 ? t.rgb / t.a : float3(0, 0, 0)) : t.rgb;
                float a = t.a * i.color.a;
                // Two-colour tint: dark parts become `dark`, light parts the vertex colour (dark = black: plain multiply).
                float3 c = i.dark + (i.color.rgb - i.dark) * rgb;
                return float4(c * a, a);
            }
            ENDCG
        }
    }
}
