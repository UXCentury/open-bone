using System.Runtime.InteropServices;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// One skeleton vertex: position (skeleton space, y up), premultiplied light colour (COLOR0), premultiplied dark
    /// colour for two-colour tint (COLOR1) and texture coordinates (v down, as in the draw list). The first three
    /// elements line up with what <see cref="BasicEffect"/> reads, so the same vertices work with the fallback effect.
    /// </summary>
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct OpenBoneVertex : IVertexType
    {
        public Vector3 Position;
        public Color Color;
        public Vector2 TextureCoordinate;
        public Color Dark;

        public static readonly VertexDeclaration VertexDeclaration = new VertexDeclaration(
            new VertexElement(0, VertexElementFormat.Vector3, VertexElementUsage.Position, 0),
            new VertexElement(12, VertexElementFormat.Color, VertexElementUsage.Color, 0),
            new VertexElement(16, VertexElementFormat.Vector2, VertexElementUsage.TextureCoordinate, 0),
            new VertexElement(24, VertexElementFormat.Color, VertexElementUsage.Color, 1));

        VertexDeclaration IVertexType.VertexDeclaration => VertexDeclaration;

        public OpenBoneVertex(Vector3 position, Color color, Vector2 uv, Color dark)
        {
            Position = position;
            Color = color;
            TextureCoordinate = uv;
            Dark = dark;
        }
    }
}
