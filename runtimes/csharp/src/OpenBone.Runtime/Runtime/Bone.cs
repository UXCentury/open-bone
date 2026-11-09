using System.Collections.Generic;

namespace OpenBone
{
    public sealed class Bone
    {
        public readonly BoneData Data;
        public Bone Parent;
        public readonly List<Bone> Children = new List<Bone>();
        /// <summary>Local pose written by animations and scripts.</summary>
        public double X, Y, Rotation, ScaleX = 1, ScaleY = 1, ShearX, ShearY;
        /// <summary>Inherit mode used this frame (setup value, or an inherit key).</summary>
        public string Inherit = "normal";
        /// <summary>False while the bone is skin-only and the current skin doesn't list it.</summary>
        public bool Active = true;
        /// <summary>Local values actually used for the world transform this frame (constraints may change them).</summary>
        public readonly LocalTransform Applied = new LocalTransform();
        public Affine World = Affine.Identity();

        public Bone(BoneData data)
        {
            Data = data;
            SetToSetupPose();
            ResetApplied();
        }

        public string Name => Data.Name;

        public void SetToSetupPose()
        {
            var d = Data;
            X = d.X; Y = d.Y; Rotation = d.Rotation; ScaleX = d.ScaleX; ScaleY = d.ScaleY; ShearX = d.ShearX; ShearY = d.ShearY;
            Inherit = d.Inherit;
        }

        public void ResetApplied()
        {
            var a = Applied;
            a.X = X; a.Y = Y; a.Rotation = Rotation; a.ScaleX = ScaleX; a.ScaleY = ScaleY; a.ShearX = ShearX; a.ShearY = ShearY;
        }

        public void UpdateWorld(Affine root)
        {
            World = MathUtil.BoneWorld(Parent != null ? Parent.World : root, Applied, Parent != null ? Inherit : "normal");
        }

        /// <summary>After a constraint wrote <see cref="World"/> directly: store the matching local values in <see cref="Applied"/>.</summary>
        public void SyncApplied(Affine root)
        {
            var parent = Parent != null ? Parent.World : root;
            Applied.CopyFrom(MathUtil.LocalFromWorld(parent, World, Parent != null ? Inherit : "normal", Applied));
        }

        public void UpdateSubtree(Affine root, bool includeSelf = true)
        {
            if (!Active) return;
            if (includeSelf) UpdateWorld(root);
            foreach (var c in Children) c.UpdateSubtree(root);
        }

        public double WorldX => World.X;
        public double WorldY => World.Y;
        public double WorldRotation => MathUtil.WorldRotation(World);

        public void WorldToLocal(double x, double y, out double lx, out double ly) => MathUtil.Invert(World).Apply(x, y, out lx, out ly);

        /// <summary>Local pose property by name (x, y, rotation, scaleX, scaleY, shearX, shearY); null if unknown.</summary>
        public double? Get(string prop)
        {
            switch (prop)
            {
                case "x": return X;
                case "y": return Y;
                case "rotation": return Rotation;
                case "scaleX": return ScaleX;
                case "scaleY": return ScaleY;
                case "shearX": return ShearX;
                case "shearY": return ShearY;
                default: return null;
            }
        }

        public bool Set(string prop, double v)
        {
            switch (prop)
            {
                case "x": X = v; return true;
                case "y": Y = v; return true;
                case "rotation": Rotation = v; return true;
                case "scaleX": ScaleX = v; return true;
                case "scaleY": ScaleY = v; return true;
                case "shearX": ShearX = v; return true;
                case "shearY": ShearY = v; return true;
                default: return false;
            }
        }

        internal static double DataProp(BoneData d, string prop)
        {
            switch (prop)
            {
                case "x": return d.X;
                case "y": return d.Y;
                case "rotation": return d.Rotation;
                case "scaleX": return d.ScaleX;
                case "scaleY": return d.ScaleY;
                case "shearX": return d.ShearX;
                case "shearY": return d.ShearY;
                default: return double.NaN;
            }
        }
    }

    public sealed class Slot
    {
        public readonly SlotData Data;
        public readonly Bone Bone;
        public double[] Color = { 1, 1, 1, 1 };
        /// <summary>Two-colour tint dark colour (alpha unused), or null for none.</summary>
        public double[] Dark;
        public string AttachmentName;
        /// <summary>Mesh/path deform offsets by attachment name.</summary>
        public readonly Dictionary<string, double[]> Deform = new Dictionary<string, double[]>();
        /// <summary>Keyed sequence frame counters by attachment name.</summary>
        public readonly Dictionary<string, double> SequenceFrames = new Dictionary<string, double>();

        public Slot(SlotData data, Bone bone)
        {
            Data = data;
            Bone = bone;
            SetToSetupPose();
        }

        public string Name => Data.Name;

        public void SetToSetupPose()
        {
            Color = MathUtil.ParseHex(Data.Color);
            Dark = !string.IsNullOrEmpty(Data.Dark) ? MathUtil.ParseHex(Data.Dark) : null;
            AttachmentName = Data.Attachment;
            Deform.Clear();
            SequenceFrames.Clear();
        }
    }
}
