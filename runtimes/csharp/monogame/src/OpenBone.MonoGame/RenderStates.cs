using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// Fixed-function states for OpenBone draw batches. Everything is drawn premultiplied (textures are premultiplied
    /// on load, vertex colours are premultiplied, the tint effect outputs rgb × a), so each blend mode is one BlendState.
    /// </summary>
    public static class RenderStates
    {
        /// <summary>normal: src + dst × (1 − src.a).</summary>
        public static readonly BlendState Normal = Make("OpenBone.Normal", Blend.One, Blend.InverseSourceAlpha);
        /// <summary>additive: src + dst.</summary>
        public static readonly BlendState Additive = Make("OpenBone.Additive", Blend.One, Blend.One);
        /// <summary>multiply: src × dst + dst × (1 − src.a).</summary>
        public static readonly BlendState Multiply = Make("OpenBone.Multiply", Blend.DestinationColor, Blend.InverseSourceAlpha);
        /// <summary>screen: src + dst × (1 − src).</summary>
        public static readonly BlendState Screen = Make("OpenBone.Screen", Blend.One, Blend.InverseSourceColor);
        /// <summary>Clip-mask polygons: no colour writes, only the stencil.</summary>
        public static readonly BlendState MaskOnly = new BlendState
        {
            Name = "OpenBone.MaskOnly",
            ColorWriteChannels = ColorWriteChannels.None,
        };

        /// <summary>Stencil reference value of clipping masks.</summary>
        public const int StencilRef = 1;

        public static readonly DepthStencilState NoStencil = new DepthStencilState
        {
            Name = "OpenBone.NoStencil",
            DepthBufferEnable = false,
            DepthBufferWriteEnable = false,
            StencilEnable = false,
        };

        public static readonly DepthStencilState StencilTest = Stencil("OpenBone.StencilTest", CompareFunction.Equal, StencilOperation.Keep);
        public static readonly DepthStencilState StencilWrite = Stencil("OpenBone.StencilWrite", CompareFunction.Always, StencilOperation.Replace);
        public static readonly DepthStencilState StencilClear = Stencil("OpenBone.StencilClear", CompareFunction.Always, StencilOperation.Zero);

        /// <summary>No culling: the skeleton → screen flip reverses winding, and meshes may be mirrored by bones.</summary>
        public static readonly RasterizerState NoCull = new RasterizerState { Name = "OpenBone.NoCull", CullMode = CullMode.None };

        /// <summary>BlendState for a draw-list blend mode (unknown modes draw as normal).</summary>
        public static BlendState ForBlend(string blend)
        {
            switch (blend)
            {
                case "additive": return Additive;
                case "multiply": return Multiply;
                case "screen": return Screen;
                default: return Normal;
            }
        }

        /// <summary>BlendState for a batch: mask polygons write no colour.</summary>
        public static BlendState ForBatch(string blend, StencilMode stencil) =>
            stencil == StencilMode.Write || stencil == StencilMode.Clear ? MaskOnly : ForBlend(blend);

        public static DepthStencilState ForStencil(StencilMode stencil)
        {
            switch (stencil)
            {
                case StencilMode.Test: return StencilTest;
                case StencilMode.Write: return StencilWrite;
                case StencilMode.Clear: return StencilClear;
                default: return NoStencil;
            }
        }

        // The same factors for colour and alpha, like the other OpenBone renderers.
        static BlendState Make(string name, Blend src, Blend dst) => new BlendState
        {
            Name = name,
            ColorSourceBlend = src,
            ColorDestinationBlend = dst,
            ColorBlendFunction = BlendFunction.Add,
            AlphaSourceBlend = src,
            AlphaDestinationBlend = dst,
            AlphaBlendFunction = BlendFunction.Add,
        };

        static DepthStencilState Stencil(string name, CompareFunction func, StencilOperation pass) => new DepthStencilState
        {
            Name = name,
            DepthBufferEnable = false,
            DepthBufferWriteEnable = false,
            StencilEnable = true,
            StencilFunction = func,
            StencilPass = pass,
            StencilFail = StencilOperation.Keep,
            StencilDepthBufferFail = StencilOperation.Keep,
            ReferenceStencil = StencilRef,
            StencilMask = 0xFF,
            StencilWriteMask = 0xFF,
        };
    }
}
