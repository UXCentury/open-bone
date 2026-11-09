using System;
using System.Collections.Generic;

namespace OpenBone
{
    /// <summary>mulberry32: same seed ⇒ same sequence on every platform.</summary>
    public sealed class Rng
    {
        uint _s;
        public Rng(uint seed) { _s = seed; }

        public double Next()
        {
            unchecked
            {
                _s = _s + 0x6D2B79F5u;
                uint t = _s;
                t = (t ^ (t >> 15)) * (t | 1u);
                t ^= t + (t ^ (t >> 7)) * (t | 61u);
                return (t ^ (t >> 14)) / 4294967296.0;
            }
        }

        public double Range(double[] r) => r[0] == r[1] ? r[0] : r[0] + (r[1] - r[0]) * Next();
        public double Between(double a, double b) => a + (b - a) * Next();

        /// <summary>FNV-1a over UTF-16 code units.</summary>
        public static uint HashString(string s)
        {
            unchecked
            {
                uint h = 0x811c9dc5;
                foreach (char c in s) h = (h ^ c) * 0x01000193u;
                return h;
            }
        }
    }

    public sealed class Particle
    {
        public double X, Y, Vx, Vy, Age, Life, Size0, Size1, Rot0, Rot1, Spin;
    }

    /// <summary>Live keyable emitter values (null ⇒ the attachment's setup value).</summary>
    public sealed class EmitterValues
    {
        public bool? Emitting;
        public double? Rate;
        public EmitterValues Clone() => new EmitterValues { Emitting = Emitting, Rate = Rate };
    }

    public sealed class ParticleGeometry
    {
        public int Count;
        public float[] Vertices, Uvs, Colors;
        public ushort[] Indices;
    }

    /// <summary>Simulation of one particles attachment on one slot (runtime/particles.ts).</summary>
    public sealed class ParticleEmitter
    {
        public const double Step = 1.0 / 60;
        public const int MaxSteps = 30;
        const int MaxPrewarmSteps = 600;
        const double Eps = 1e-9;
        static readonly float[] UnitUvs = { 0, 0, 1, 0, 1, 1, 0, 1 };

        public readonly ParticlesAttachment Data;
        public readonly List<Particle> Particles = new List<Particle>();
        public double Cycle;
        public int Steps;
        public double Pending;
        double _acc;
        bool _wasEmitting;
        readonly Rng _rng;
        double _lastX = double.NaN, _lastY = double.NaN;

        public ParticleEmitter(ParticlesAttachment data, uint salt = 0)
        {
            Data = data;
            _rng = new Rng(Js.ToUint32(data.Seed) ^ salt);
        }

        public int Alive => Particles.Count;

        public void Restart()
        {
            Cycle = 0;
            _acc = 0;
            _wasEmitting = false;
        }

        public void StepOnce(double h, Affine m, EmitterValues values)
        {
            var d = Data;
            bool emitting = values?.Emitting ?? d.Emitting;
            double rate = values?.Rate ?? d.Rate;
            if (Steps == 0 && emitting && d.Prewarm && d.Loop)
            {
                int n = (int)Math.Min(MaxPrewarmSteps, Math.Ceiling(d.Duration / h - 1e-6));
                _lastX = m.X;
                _lastY = m.Y;
                for (int i = 0; i < n; i++) Advance(h, m, true, rate);
            }
            Advance(h, m, emitting, rate);
            Steps++;
        }

        void Advance(double h, Affine m, bool emitting, double rate)
        {
            var d = Data;
            double damp = d.Drag > 0 ? Math.Exp(-d.Drag * h) : 1;
            double g = d.Gravity * h;
            int w = 0;
            var ps = Particles;
            for (int i = 0; i < ps.Count; i++)
            {
                var p = ps[i];
                p.Age += h;
                if (p.Age >= p.Life) continue;
                p.Vy -= g;
                p.Vx *= damp;
                p.Vy *= damp;
                p.X += p.Vx * h;
                p.Y += p.Vy * h;
                ps[w++] = p;
            }
            ps.RemoveRange(w, ps.Count - w);

            if (emitting && !_wasEmitting)
            {
                Cycle = 0;
                _acc = 0;
            }
            _wasEmitting = emitting;
            bool active = emitting && (d.Loop || Cycle < d.Duration);
            double streamed = 0;
            double burst = Pending;
            Pending = 0;
            if (active)
            {
                _acc += Math.Max(0, rate) * h;
                streamed = Math.Floor(_acc);
                _acc -= streamed;
                double start = Cycle, end = start + h;
                bool wraps = end >= d.Duration - Eps;
                double rest = end - d.Duration;
                foreach (var b in d.Bursts)
                {
                    if (b.Time > d.Duration + Eps) continue;
                    if (b.Time >= start - Eps && b.Time < end - Eps) burst += b.Count;
                    else if (wraps && d.Loop && b.Time < rest - Eps) burst += b.Count;
                }
                Cycle = wraps ? (d.Loop ? Math.Max(0, rest) : d.Duration) : end;
            }
            double room = Math.Max(0, d.MaxParticles - ps.Count);
            double nb = Math.Min(burst, room);
            double ns = Math.Min(streamed, room - nb);
            double lx = double.IsNaN(_lastX) ? m.X : _lastX;
            double ly = double.IsNaN(_lastY) ? m.Y : _lastY;
            for (int i = 0; i < nb; i++) Spawn(m, 0, m.X, m.Y);
            for (int i = 0; i < ns; i++)
            {
                double k = (i + 1) / ns;
                Spawn(m, (1 - k) * h, MathUtil.Lerp(lx, m.X, k), MathUtil.Lerp(ly, m.Y, k));
            }
            _lastX = m.X;
            _lastY = m.Y;
        }

        void Spawn(Affine m, double preAge, double ox, double oy)
        {
            var d = Data;
            var r = _rng;
            double rot = d.Rotation * MathUtil.DEG;
            double half = d.Angle / 2 * MathUtil.DEG;
            double f = 0, s = 0;
            double dir = rot + r.Between(-half, half);
            switch (d.Shape)
            {
                case "circle":
                    {
                        double a = r.Next() * Math.PI * 2;
                        double rad = Math.Sqrt(r.Next()) * d.Radius;
                        f = Math.Cos(a) * rad;
                        s = Math.Sin(a) * rad;
                        dir = rot + a;
                        break;
                    }
                case "box":
                    s = r.Between(-d.Width / 2, d.Width / 2);
                    f = r.Between(-d.Height / 2, d.Height / 2);
                    break;
                case "cone":
                    s = r.Between(-d.Radius, d.Radius);
                    if (d.Radius > 0) dir = rot + s / d.Radius * half;
                    break;
            }
            double cos = Math.Cos(rot), sin = Math.Sin(rot);
            double x = d.X + f * cos - s * sin;
            double y = d.Y + f * sin + s * cos;
            double speed = r.Range(d.Speed);
            double vx = Math.Cos(dir) * speed;
            double vy = Math.Sin(dir) * speed;
            if (d.Space == "world")
            {
                double wx = m.A * x + m.B * y + ox;
                double wy = m.C * x + m.D * y + oy;
                x = wx;
                y = wy;
                double tx = m.A * vx + m.B * vy;
                double ty = m.C * vx + m.D * vy;
                double len = Js.Hypot(tx, ty);
                vx = len > 1e-9 ? tx / len * speed : 0;
                vy = len > 1e-9 ? ty / len * speed : 0;
            }
            var p = new Particle
            {
                X = x,
                Y = y,
                Vx = vx,
                Vy = vy,
                Age = 0,
                Life = Math.Max(1e-3, r.Range(d.Lifetime)),
                Size0 = r.Range(d.StartSize),
                Size1 = r.Range(d.EndSize),
                Rot0 = r.Range(d.StartRotation),
                Rot1 = r.Range(d.EndRotation),
                Spin = r.Range(d.AngularVelocity),
            };
            if (preAge > 0)
            {
                p.Age = preAge;
                p.Vy -= d.Gravity * preAge;
                p.X += p.Vx * preAge;
                p.Y += p.Vy * preAge;
            }
            if (p.Age < p.Life) Particles.Add(p);
        }

        /// <summary>Quads (TL, TR, BR, BL), <paramref name="frac"/> seconds after the last step.</summary>
        public ParticleGeometry Geometry(double frac, Affine m, double[] tint)
        {
            var d = Data;
            var ps = Particles;
            int n = Math.Min(ps.Count, 16383);
            var vertices = new float[n * 8];
            var colors = new float[n * 16];
            var uvs = new float[n * 8];
            var indices = new ushort[n * 6];
            bool local = d.Space == "local";
            double sizeScale = local ? Math.Sqrt(Math.Abs(m.A * m.D - m.B * m.C)) : 1;
            int k = 0;
            for (int i = 0; i < n; i++)
            {
                var p = ps[i];
                double age = Math.Min(p.Age + frac, p.Life);
                double t = age / p.Life;
                double x = p.X + p.Vx * frac, y = p.Y + p.Vy * frac;
                double vx = p.Vx, vy = p.Vy;
                if (local)
                {
                    double wx = m.A * x + m.B * y + m.X, wy = m.C * x + m.D * y + m.Y;
                    x = wx;
                    y = wy;
                    double tx = m.A * vx + m.B * vy;
                    vy = m.C * vx + m.D * vy;
                    vx = tx;
                }
                double size = Math.Max(0, MathUtil.Lerp(p.Size0, p.Size1, t)) * sizeScale;
                var c = Gradient.Color(d.Colors, t);
                double a = c[3] * tint[3];
                if (size <= 0 || a <= 0) continue;
                double ux, uy, hw;
                if (d.Look == "spark")
                {
                    double sp = Js.Hypot(vx, vy);
                    double len = size / 2 + sp * d.Stretch / 2;
                    double ang = sp > 1e-6 ? Math.Atan2(vy, vx) : (MathUtil.Lerp(p.Rot0, p.Rot1, t) + p.Spin * age) * MathUtil.DEG;
                    ux = Math.Cos(ang) * len;
                    uy = Math.Sin(ang) * len;
                    hw = size / 2;
                }
                else
                {
                    double ang = (MathUtil.Lerp(p.Rot0, p.Rot1, t) + p.Spin * age) * MathUtil.DEG;
                    ux = Math.Cos(ang) * size / 2;
                    uy = Math.Sin(ang) * size / 2;
                    hw = size / 2;
                }
                double ul = Js.Hypot(ux, uy);
                if (ul == 0 || double.IsNaN(ul)) ul = 1;
                double vx2 = -uy / ul * hw, vy2 = ux / ul * hw;
                int o = k * 8;
                vertices[o] = (float)(x - ux + vx2);
                vertices[o + 1] = (float)(y - uy + vy2);
                vertices[o + 2] = (float)(x + ux + vx2);
                vertices[o + 3] = (float)(y + uy + vy2);
                vertices[o + 4] = (float)(x + ux - vx2);
                vertices[o + 5] = (float)(y + uy - vy2);
                vertices[o + 6] = (float)(x - ux - vx2);
                vertices[o + 7] = (float)(y - uy - vy2);
                Array.Copy(UnitUvs, 0, uvs, o, 8);
                float cr = (float)(c[0] * tint[0]), cg = (float)(c[1] * tint[1]), cb = (float)(c[2] * tint[2]), ca = (float)a;
                for (int j = 0; j < 4; j++)
                {
                    int q = k * 16 + j * 4;
                    colors[q] = cr;
                    colors[q + 1] = cg;
                    colors[q + 2] = cb;
                    colors[q + 3] = ca;
                }
                int ii = k * 6, b0 = k * 4;
                indices[ii] = (ushort)b0;
                indices[ii + 1] = (ushort)(b0 + 1);
                indices[ii + 2] = (ushort)(b0 + 2);
                indices[ii + 3] = (ushort)b0;
                indices[ii + 4] = (ushort)(b0 + 2);
                indices[ii + 5] = (ushort)(b0 + 3);
                k++;
            }
            if (k < n)
            {
                Array.Resize(ref vertices, k * 8);
                Array.Resize(ref uvs, k * 8);
                Array.Resize(ref colors, k * 16);
                Array.Resize(ref indices, k * 6);
            }
            return new ParticleGeometry { Count = k, Vertices = vertices, Uvs = uvs, Colors = colors, Indices = indices };
        }
    }
}
