using System.Collections.Generic;
using OpenBone.Json;

namespace OpenBone
{
    public abstract class Attachment
    {
        public string Name;
        /// <summary>region, mesh, sequence, particles, text, shape, clipping, boundingBox, point, path.</summary>
        public abstract string Type { get; }
        public JsonValue Json;
    }

    /// <summary>Attachments drawn as a quad around (x, y) in slot-bone space (region, sequence, text).</summary>
    public interface IQuadAttachment
    {
        double X { get; }
        double Y { get; }
        double Rotation { get; }
        double Width { get; }
        double Height { get; }
    }

    public sealed class RegionAttachment : Attachment, IQuadAttachment
    {
        public override string Type => "region";
        public string Image;
        public double X { get; set; }
        public double Y { get; set; }
        public double Rotation { get; set; }
        public double ScaleX = 1, ScaleY = 1, SkewX, SkewY;
        public double Width { get; set; }
        public double Height { get; set; }
        public string Color = "#ffffff";
    }

    public sealed class VertexWeight
    {
        public string Bone;
        public double X, Y, Weight;
    }

    public sealed class LinkedMesh
    {
        public string Mesh, Slot, Skin;
        public bool Deform;
    }

    public sealed class MeshAttachment : Attachment
    {
        public override string Type => "mesh";
        public string Image;
        public double[] Uvs = new double[0];
        public int[] Triangles = new int[0];
        public double[] Vertices = new double[0];
        public VertexWeight[][] Weights;
        public int Hull;
        public string Color = "#ffffff";
        public LinkedMesh Linked;
    }

    public sealed class ShapeAttachment : Attachment
    {
        public override string Type => "shape";
        public string Shape = "rect";
        public double X, Y, Rotation, Width, Height, Radius;
        public double[] Points;
        public string Fill = "#ffffff";
        public string Stroke;
        public double? StrokeWidth;
    }

    public sealed class BoundingBoxAttachment : Attachment
    {
        public override string Type => "boundingBox";
        public double[] Vertices = new double[0];
    }

    public sealed class PointAttachment : Attachment
    {
        public override string Type => "point";
        public double X, Y, Rotation;
    }

    public sealed class ClippingAttachment : Attachment
    {
        public override string Type => "clipping";
        public double[] Vertices = new double[0];
        public string End;
    }

    public sealed class PathAttachment : Attachment
    {
        public override string Type => "path";
        public double[] Vertices = new double[0];
        public VertexWeight[][] Weights;
        public bool Closed;
        public string Color;
    }

    public sealed class FrameRect
    {
        public double X, Y, Width, Height;
    }

    public sealed class FrameTrim
    {
        public double X, Y, SourceWidth, SourceHeight;
    }

    public sealed class SequenceFrame
    {
        public string Image;
        public FrameRect Rect;
        public FrameTrim Trim;
    }

    public sealed class SequenceAttachment : Attachment, IQuadAttachment
    {
        public override string Type => "sequence";
        public List<SequenceFrame> Frames = new List<SequenceFrame>();
        public double X { get; set; }
        public double Y { get; set; }
        public double Rotation { get; set; }
        public double ScaleX = 1, ScaleY = 1, SkewX, SkewY;
        public double Width { get; set; }
        public double Height { get; set; }
        public string Color = "#ffffff";
        public double Fps, Offset;
        public string Mode = "loop";
        public string Input;
    }

    public sealed class ParticleBurst
    {
        public double Time, Count;
    }

    public sealed class ColorStop
    {
        public double T;
        public string Color;
    }

    public sealed class ParticlesAttachment : Attachment
    {
        public override string Type => "particles";
        public bool Emitting, Loop, Prewarm;
        public double Rate, MaxParticles, Duration;
        public List<ParticleBurst> Bursts = new List<ParticleBurst>();
        public string Shape, Space, Blend, Look, Image;
        public double X, Y, Rotation, Angle, Radius, Width, Height;
        public double[] Lifetime, Speed, StartSize, EndSize, StartRotation, EndRotation, AngularVelocity;
        public double Gravity, Drag, Stretch, Seed;
        public List<ColorStop> Colors = new List<ColorStop>();
    }

    public sealed class TextAttachment : Attachment, IQuadAttachment
    {
        public override string Type => "text";
        public string Text = "";
        public double X { get; set; }
        public double Y { get; set; }
        public double Rotation { get; set; }
        public double Width { get; set; }
        public double Height { get; set; }
        public string Font = "sans-serif";
        public double Size = 16, Weight = 400;
        public string Color = "#ffffff";
        public string Align = "center";
        public string Outline;
        public double? OutlineWidth;
    }

    /// <summary>An attachment type this runtime doesn't know (kept, never drawn).</summary>
    public sealed class UnknownAttachment : Attachment
    {
        public string TypeName;
        public override string Type => TypeName;
    }
}
