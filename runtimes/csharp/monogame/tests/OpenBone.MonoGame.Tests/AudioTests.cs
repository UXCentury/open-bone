using System.Collections.Generic;
using Xunit;

namespace OpenBone.MonoGame.Tests
{
    public class AudioMathTests
    {
        [Theory]
        [InlineData(1, 0)]
        [InlineData(2, 1)]
        [InlineData(0.5, -1)]
        [InlineData(4, 1)]       // clamped to an octave
        [InlineData(0.25, -1)]
        [InlineData(0, 0)]       // invalid rates play at normal pitch
        [InlineData(-2, 0)]
        public void PitchIsLog2OfRate(double rate, float pitch) => Assert.Equal(pitch, AudioMath.Pitch(rate), 5);

        [Fact]
        public void PitchBetweenOctaves() => Assert.Equal(0.5849625f, AudioMath.Pitch(1.5), 5);

        static AudioData Mixer() => new AudioData
        {
            Master = 0.8,
            Buses = { new AudioBus { Id = "bus_sfx", Name = "sfx", Volume = 0.5 }, new AudioBus { Id = "bus_off", Volume = 1, Muted = true } },
        };

        [Fact]
        public void BusGainIsMasterTimesBus()
        {
            var a = Mixer();
            Assert.Equal(0.4, AudioMath.BusGain(a, "bus_sfx"), 6);
            Assert.Equal(0.4, AudioMath.BusGain(a, "sfx"), 6);
            Assert.Equal(0.8, AudioMath.BusGain(a, null), 6);
            Assert.Equal(0.8, AudioMath.BusGain(a, "missing"), 6);
            Assert.Equal(0, AudioMath.BusGain(a, "bus_off"));
            a.Muted = true;
            Assert.Equal(0, AudioMath.BusGain(a, "bus_sfx"));
            Assert.Equal(1, AudioMath.BusGain(null, "x"));
        }

        [Fact]
        public void VolumeMultipliesAndClamps()
        {
            Assert.Equal(0.6f * 0.5f * 0.4f, AudioMath.Volume(0.6, 0.5, 0.4), 6);
            Assert.Equal(1f, AudioMath.Volume(2, 1, 1, 1));
            Assert.Equal(0f, AudioMath.Volume(1, -1, 1));
            Assert.Equal(0.25f, AudioMath.Volume(1, 1, 0.5, 0.5), 6);
        }

        [Fact]
        public void FadeLevelIsLinear()
        {
            Assert.Equal(0.5, AudioMath.FadeLevel(0, 1, 0.25, 0.5), 6);
            Assert.Equal(1, AudioMath.FadeLevel(0, 1, 2, 0.5));
            Assert.Equal(0.3, AudioMath.FadeLevel(0.9, 0.3, 0, 0));
        }
    }

    public class AudioMixerTests
    {
        sealed class FakeVoice : ISoundVoice
        {
            public string Asset;
            public float Vol = -1, Pit;
            public bool Loop, Playing, Disposed;
            public float Volume { set => Vol = value; }
            public float Pitch { set => Pit = value; }
            public bool IsLooped { set => Loop = value; }
            public bool IsPlaying => Playing;
            public void Play() => Playing = true;
            public void Stop() => Playing = false;
            public void Dispose() => Disposed = true;
        }

        readonly List<FakeVoice> _voices = new List<FakeVoice>();

        AudioMixer Make(AudioData audio = null) => new AudioMixer(audio ?? new AudioData { Master = 0.5, Buses = { new AudioBus { Id = "sfx", Volume = 0.8 } } }, asset =>
        {
            if (asset == "missing") return null;
            var v = new FakeVoice { Asset = asset };
            _voices.Add(v);
            return v;
        });

        static AudioCommand Play(string id, double volume = 1, double rate = 1, bool loop = false, double fadeIn = 0) =>
            new AudioCommand { Type = "play", Id = id, Asset = "aud", Bus = "sfx", Volume = volume, Rate = rate, Loop = loop, FadeIn = fadeIn };

        [Fact]
        public void PlaySetsVolumePitchAndLoop()
        {
            var m = Make();
            m.Volume = 0.5;
            m.Handle(Play("p1", volume: 0.9, rate: 2, loop: true));
            var v = Assert.Single(_voices);
            Assert.True(v.Playing);
            Assert.True(v.Loop);
            Assert.Equal(1f, v.Pit, 5);
            Assert.Equal((float)(0.9 * 0.5 * 0.8 * 0.5), v.Vol, 5); // command × master × bus × player
        }

        [Fact]
        public void FadeInStepsPerUpdate()
        {
            var m = Make(new AudioData());
            m.Handle(Play("p1", fadeIn: 1));
            var v = _voices[0];
            Assert.Equal(0f, v.Vol);
            m.Update(0.25);
            Assert.Equal(0.25f, v.Vol, 5);
            m.Update(0.5);
            Assert.Equal(0.75f, v.Vol, 5);
            m.Update(1);
            Assert.Equal(1f, v.Vol, 5);
        }

        [Fact]
        public void StopWithFadeRampsDownThenStops()
        {
            var m = Make(new AudioData());
            m.Handle(Play("p1"));
            var v = _voices[0];
            m.Handle(new AudioCommand { Type = "stop", Id = "p1", Fade = 0.5 });
            Assert.True(v.Playing);
            m.Update(0.25);
            Assert.Equal(0.5f, v.Vol, 5);
            Assert.True(v.Playing);
            m.Update(0.25);
            Assert.False(v.Playing);
            Assert.True(v.Disposed);
            Assert.Equal(0, m.ActiveVoices);
        }

        [Fact]
        public void StopWithoutFadeIsImmediate()
        {
            var m = Make();
            m.Handle(Play("p1"));
            m.Handle(new AudioCommand { Type = "stop", Id = "p1" });
            Assert.False(_voices[0].Playing);
            Assert.Equal(0, m.ActiveVoices);
        }

        [Fact]
        public void FadeCommandTargetsAnAbsoluteVolume()
        {
            var m = Make(new AudioData());
            m.Handle(Play("p1", volume: 0.8));
            var v = _voices[0];
            Assert.Equal(0.8f, v.Vol, 5);
            m.Handle(new AudioCommand { Type = "fade", Id = "p1", Volume = 0.2, Duration = 1 });
            m.Update(0.5);
            Assert.Equal(0.5f, v.Vol, 5);
            m.Update(0.5);
            Assert.Equal(0.2f, v.Vol, 5);
            Assert.True(v.Playing);
        }

        [Fact]
        public void FinishedVoicesAreDropped()
        {
            var m = Make();
            m.Handle(Play("p1"));
            _voices[0].Playing = false; // one-shot ended
            m.Update(0.016);
            Assert.Equal(0, m.ActiveVoices);
            Assert.True(_voices[0].Disposed);
        }

        [Fact]
        public void MissingSoundsAreReported()
        {
            var m = Make();
            string missing = null;
            m.MissingSound += id => missing = id;
            var c = Play("p1");
            c.Asset = "missing";
            m.Handle(c);
            Assert.Equal("missing", missing);
            Assert.Equal(0, m.ActiveVoices);
        }

        [Fact]
        public void BusAndMasterChangesApplyOnUpdate()
        {
            var audio = new AudioData { Master = 1, Buses = { new AudioBus { Id = "sfx", Volume = 1 } } };
            var m = Make(audio);
            m.Handle(Play("p1"));
            audio.Buses[0].Muted = true;
            m.Update(0.016);
            Assert.Equal(0f, _voices[0].Vol);
        }

        [Fact]
        public void MixCommandsMuteBusesAndMaster()
        {
            var audio = new AudioData { Master = 1, Buses = { new AudioBus { Id = "sfx", Volume = 0.5 }, new AudioBus { Id = "music", Volume = 0.8 } } };
            var m = Make(audio);
            m.Handle(Play("p1"));                                                            // sfx
            m.Handle(new AudioCommand { Type = "play", Id = "p2", Asset = "aud", Bus = "music", Volume = 1, Rate = 1 });
            var sfx = _voices[0];
            var music = _voices[1];
            Assert.Equal(0.5f, sfx.Vol, 5);
            Assert.Equal(0.8f, music.Vol, 5);

            // Muting a bus silences its playing voices at once; others keep their gain.
            m.Handle(new AudioCommand { Type = "mix", Bus = "music", Muted = true });
            Assert.True(m.IsMuted("music"));
            Assert.Equal(0f, music.Vol);
            Assert.Equal(0.5f, sfx.Vol, 5);
            m.Update(0.016);
            Assert.Equal(0f, music.Vol);

            // Unmuting restores it.
            m.Handle(new AudioCommand { Type = "mix", Bus = "music", Muted = false });
            Assert.False(m.IsMuted("music"));
            Assert.Equal(0.8f, music.Vol, 5);

            // The master mutes everything, including sounds started afterwards.
            m.Handle(new AudioCommand { Type = "mix", Bus = null, Muted = true });
            Assert.True(m.IsMuted(null));
            Assert.Equal(0f, sfx.Vol);
            Assert.Equal(0f, music.Vol);
            m.Handle(Play("p3"));
            Assert.Equal(0f, _voices[2].Vol);
            m.Update(0.016);
            Assert.All(_voices, v => Assert.Equal(0f, v.Vol));

            m.Handle(new AudioCommand { Type = "mix", Bus = null, Muted = false });
            Assert.Equal(0.5f, sfx.Vol, 5);
            Assert.Equal(0.5f, _voices[2].Vol, 5);
        }

        [Fact]
        public void MixCommandUnmutesABusTheDocumentMutes()
        {
            var audio = new AudioData { Master = 0.5, Muted = true, Buses = { new AudioBus { Id = "sfx", Volume = 0.8, Muted = true } } };
            var m = Make(audio);
            m.Handle(Play("p1"));
            Assert.Equal(0f, _voices[0].Vol);
            m.Handle(new AudioCommand { Type = "mix", Bus = "sfx", Muted = false });
            Assert.Equal(0f, _voices[0].Vol);                                               // the document's master is still muted
            m.Handle(new AudioCommand { Type = "mix", Bus = null, Muted = false });
            Assert.Equal(0.4f, _voices[0].Vol, 5);                                          // master × bus.volume
            Assert.False(m.IsMuted("sfx"));
            Assert.Equal(0, AudioMath.BusGain(audio, "sfx"));                               // the document is untouched
        }

        [Fact]
        public void KnightAttackPlaysSounds()
        {
            var doc = DocumentLoader.Load(System.IO.File.ReadAllBytes(TestPaths.Example("knight.obone")));
            var inst = new OpenBoneInstance(doc);
            var m = new AudioMixer(doc.Audio, asset => { var v = new FakeVoice { Asset = asset }; _voices.Add(v); return v; });
            inst.AudioCommand += m.Handle;
            var sm = inst.UseStateMachine("knight");
            inst.Advance(0);
            sm.Fire("attack");
            for (int i = 0; i < 30; i++) { inst.Advance(1 / 60.0); m.Update(1 / 60.0); }
            Assert.NotEmpty(_voices);
            Assert.All(_voices, v => Assert.InRange(v.Vol, 0f, 1f));
        }
    }
}
