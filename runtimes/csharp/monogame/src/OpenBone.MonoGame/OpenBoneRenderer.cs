using System;
using System.Collections.Generic;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>Draws the text items of a draw list (see <see cref="SpriteFontTextRenderer"/>).</summary>
    public interface IOpenBoneTextRenderer
    {
        /// <param name="item">A draw item whose <see cref="DrawItem.Text"/> is set.</param>
        /// <param name="skeletonToScreen">Skeleton space → screen pixels.</param>
        /// <param name="stencil">The stencil state of the item (clipping).</param>
        void DrawText(DrawItem item, Matrix skeletonToScreen, DepthStencilState stencil);
    }

    /// <summary>
    /// Draws an OpenBone draw list with <see cref="GraphicsDevice.DrawUserIndexedPrimitives{T}(PrimitiveType, T[], int, int, short[], int, int, VertexDeclaration)"/>:
    /// one draw call per run of items sharing a texture, blend mode and clipping state. Blend modes are premultiplied
    /// BlendStates (normal, additive, multiply, screen); clipping masks use the stencil buffer (the back buffer or render
    /// target needs a stencil format such as <see cref="DepthFormat.Depth24Stencil8"/>, otherwise clipped items draw
    /// unclipped); two-colour tint uses <see cref="TintEffect"/> (or <see cref="BasicEffect"/> without the dark colour
    /// when that effect cannot be loaded). Text items go to <see cref="TextRenderer"/> (skipped when null).
    /// Device states are restored after drawing.
    /// </summary>
    public sealed class OpenBoneRenderer : IDisposable
    {
        readonly GraphicsDevice _device;
        readonly DrawListMesher _mesher = new DrawListMesher();
        readonly Effect _tint;
        readonly EffectParameter _tintMatrix, _tintTexture;
        readonly BasicEffect _basic;
        Effect _custom;
        EffectParameter _customMatrix, _customTexture;
        OpenBoneTextures _textures;
        readonly HashSet<string> _warned = new HashSet<string>();

        /// <summary>Why the built-in tint effect could not be loaded (null when it was).</summary>
        public string EffectError { get; }
        /// <summary>Whether dark colours (two-colour tint) are drawn.</summary>
        public bool SupportsTwoColorTint => _custom != null || (_tint != null && UseTintEffect);
        /// <summary>Draw with the built-in tint effect when it loaded (false: always BasicEffect, no dark colour).</summary>
        public bool UseTintEffect = true;
        /// <summary>Texture filtering (default: linear, clamped edges).</summary>
        public SamplerState SamplerState = SamplerState.LinearClamp;
        /// <summary>Draws text items; null skips them.</summary>
        public IOpenBoneTextRenderer TextRenderer;
        /// <summary>Clip space projection; null = the viewport in pixels (y down), matching <see cref="SkeletonView"/>.</summary>
        public Matrix? Projection;
        /// <summary>Called once per texture id that has no loaded texture (those items are skipped).</summary>
        public event Action<string> MissingTexture;

        /// <summary>Draw calls of the last <see cref="Draw(IReadOnlyList{DrawItem}, OpenBoneTextures, Matrix)"/>.</summary>
        public int LastDrawCalls { get; private set; }

        public OpenBoneRenderer(GraphicsDevice device)
        {
            _device = device ?? throw new ArgumentNullException(nameof(device));
            _tint = TintEffect.TryCreate(device, out var error);
            EffectError = error;
            if (_tint != null)
            {
                _tintMatrix = _tint.Parameters["WorldViewProjection"];
                _tintTexture = _tint.Parameters["Texture"];
            }
            _basic = new BasicEffect(device) { TextureEnabled = true, VertexColorEnabled = true, LightingEnabled = false };
            _mesher.CanDraw = t =>
            {
                if (_textures != null && _textures.Has(t)) return true;
                if (t != null && _warned.Add(t.Id)) MissingTexture?.Invoke(t.Id);
                return false;
            };
        }

        /// <summary>
        /// Your own effect (e.g. Shaders/OpenBoneTint.fx compiled with mgfxc for DirectX). It gets the
        /// <c>WorldViewProjection</c> matrix and the <c>Texture</c> parameter and the vertices of <see cref="OpenBoneVertex"/>.
        /// </summary>
        public Effect Effect
        {
            get => _custom ?? _tint;
            set
            {
                _custom = value;
                _customMatrix = value?.Parameters["WorldViewProjection"];
                _customTexture = value?.Parameters["Texture"];
            }
        }

        /// <summary>The mesher (vertex / index arrays and batches of the last draw).</summary>
        public DrawListMesher Mesher => _mesher;

        /// <summary>Draw an instance's current pose.</summary>
        public void Draw(OpenBoneInstance instance, OpenBoneTextures textures, SkeletonView view) =>
            Draw(instance.DrawList(), textures, view.Matrix);

        /// <summary>
        /// Screen rectangle to draw inside (a scissor rectangle), or null to draw everywhere. OpenBoneMonoGame sets it to
        /// the stage with ClipToStage, like the web player clipping to the artboard.
        /// </summary>
        public Rectangle? Clip;

        /// <summary>Draw a draw list; <paramref name="skeletonToScreen"/> maps skeleton space to screen pixels.</summary>
        public void Draw(IReadOnlyList<DrawItem> items, OpenBoneTextures textures, Matrix skeletonToScreen)
        {
            _textures = textures;
            _mesher.IncludeText = TextRenderer != null;
            _mesher.Build(items);
            LastDrawCalls = 0;
            if (_mesher.BatchCount == 0) return;

            var d = _device;
            var oldBlend = d.BlendState;
            var oldDepth = d.DepthStencilState;
            var oldRaster = d.RasterizerState;
            var oldSampler = d.SamplerStates[0];
            var oldScissor = d.ScissorRectangle;
            var vp = d.Viewport;
            var raster = RenderStates.NoCull;
            if (Clip is Rectangle clip)
            {
                var r = Rectangle.Intersect(clip, vp.Bounds);
                if (r.Width <= 0 || r.Height <= 0) return;
                d.ScissorRectangle = r;
                raster = RenderStates.NoCullScissor;
            }
            var projection = Projection ?? Matrix.CreateOrthographicOffCenter(0, vp.Width, vp.Height, 0, 0, 1);

            Effect effect;
            EffectParameter texParam = null;
            if (_custom != null)
            {
                effect = _custom;
                _customMatrix?.SetValue(skeletonToScreen * projection);
                texParam = _customTexture;
            }
            else if (_tint != null && UseTintEffect)
            {
                effect = _tint;
                _tintMatrix.SetValue(skeletonToScreen * projection);
                texParam = _tintTexture;
            }
            else
            {
                effect = _basic;
                _basic.World = skeletonToScreen;
                _basic.View = Matrix.Identity;
                _basic.Projection = projection;
            }

            try
            {
                for (int i = 0; i < _mesher.BatchCount; i++)
                {
                    var b = _mesher.Batch(i);
                    if (b.Text != null)
                    {
                        d.RasterizerState = raster;  // text renderers clip when this does
                        TextRenderer?.DrawText(b.Text, skeletonToScreen, RenderStates.ForStencil(b.Stencil));
                        continue;
                    }
                    if (b.IndexCount == 0) continue;
                    var tex = textures != null ? textures.Get(b.TextureId) : null;
                    if (tex == null) continue;
                    d.BlendState = RenderStates.ForBatch(b.Blend, b.Stencil);
                    d.DepthStencilState = RenderStates.ForStencil(b.Stencil);
                    d.RasterizerState = raster;
                    if (texParam != null) texParam.SetValue(tex);
                    else if (effect == _basic) _basic.Texture = tex;
                    foreach (var pass in effect.CurrentTechnique.Passes)
                    {
                        pass.Apply();
                        d.SamplerStates[0] = SamplerState;
                        if (texParam == null && effect != _basic) d.Textures[0] = tex;
                        d.DrawUserIndexedPrimitives(PrimitiveType.TriangleList, _mesher.Vertices, b.VertexStart, b.VertexCount,
                            _mesher.Indices, b.IndexStart, b.PrimitiveCount, OpenBoneVertex.VertexDeclaration);
                        LastDrawCalls++;
                    }
                }
            }
            finally
            {
                d.BlendState = oldBlend;
                d.DepthStencilState = oldDepth;
                d.RasterizerState = oldRaster;
                d.ScissorRectangle = oldScissor;
                d.SamplerStates[0] = oldSampler;
            }
        }

        public void Dispose()
        {
            _tint?.Dispose();
            _basic.Dispose();
        }
    }
}
