using System;
using Microsoft.Xna.Framework;

namespace OpenBone.MonoGame
{
    /// <summary>
    /// Where a skeleton sits on screen: skeleton space (y up, skeleton units) → screen pixels (y down). A point (x, y)
    /// lands at <c>Position + (x, −y) × Scale</c>, rotated by <see cref="Rotation"/> about <see cref="Position"/>.
    /// </summary>
    public struct SkeletonView
    {
        /// <summary>Screen position of the skeleton origin.</summary>
        public Vector2 Position;
        /// <summary>Screen pixels per skeleton unit (uniform); negative X/Y flips via <see cref="FlipX"/> / <see cref="FlipY"/>.</summary>
        public float Scale;
        /// <summary>Clockwise rotation on screen, radians.</summary>
        public float Rotation;
        public bool FlipX, FlipY;

        public SkeletonView(Vector2 position, float scale)
        {
            Position = position;
            Scale = scale;
            Rotation = 0;
            FlipX = FlipY = false;
        }

        /// <summary>The matrix taking skeleton-space points to screen pixels (row vectors, as MonoGame uses).</summary>
        public Matrix Matrix =>
            Matrix.CreateScale(Scale * (FlipX ? -1 : 1), -Scale * (FlipY ? -1 : 1), 1) *
            Matrix.CreateRotationZ(Rotation) *
            Matrix.CreateTranslation(Position.X, Position.Y, 0);

        public Vector2 SkeletonToScreen(double x, double y) => Vector2.Transform(new Vector2((float)x, (float)y), Matrix);

        public Vector2 ScreenToSkeleton(Vector2 screen) => Vector2.Transform(screen, Matrix.Invert(Matrix));

        /// <summary>
        /// A view that fits the document's stage (its width × height canvas, as framed in the editor) into a viewport,
        /// centred, keeping its aspect ratio. <paramref name="padding"/> is in screen pixels on every side.
        /// </summary>
        public static SkeletonView FitStage(Document doc, Rectangle viewport, float padding = 0)
        {
            double w = doc.Width > 0 ? doc.Width : 1, h = doc.Height > 0 ? doc.Height : 1;
            return Fit(-doc.OriginX, doc.OriginY - h, w, h, viewport, padding);
        }

        /// <summary>
        /// A view that fits a skeleton-space rectangle (left, bottom, width, height; y up) into a viewport, centred.
        /// </summary>
        public static SkeletonView Fit(double left, double bottom, double width, double height, Rectangle viewport, float padding = 0)
        {
            float vw = Math.Max(1, viewport.Width - 2 * padding), vh = Math.Max(1, viewport.Height - 2 * padding);
            float s = (float)Math.Min(vw / Math.Max(width, 1e-6), vh / Math.Max(height, 1e-6));
            double cx = left + width / 2, cy = bottom + height / 2;
            var centre = new Vector2(viewport.X + viewport.Width / 2f, viewport.Y + viewport.Height / 2f);
            return new SkeletonView(new Vector2((float)(centre.X - cx * s), (float)(centre.Y + cy * s)), s);
        }
    }
}
