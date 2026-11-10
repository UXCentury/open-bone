using System.Collections.Generic;
using Xunit;

namespace OpenBone.Tests
{
    public class AudioDirectorTests
    {
        [Fact]
        public void SetMuteStartsFromTheDocumentAndEmitsMix()
        {
            var doc = new Document
            {
                Audio = new AudioData { Muted = false, Buses = { new AudioBus { Id = "music", Muted = true }, new AudioBus { Id = "sfx" } } },
            };
            var cmds = new List<AudioCommand>();
            var dir = new AudioDirector(doc, cmds.Add);

            Assert.True(dir.IsMuted("music"));
            Assert.False(dir.IsMuted("sfx"));
            Assert.False(dir.IsMuted(null));

            Assert.False(dir.SetMute("music", null));   // toggle from the document's flag
            Assert.True(dir.SetMute("music", null));
            Assert.True(dir.SetMute(null, true));
            Assert.True(dir.SetMute(null, true));       // explicit value, no flip
            Assert.True(dir.IsMuted(null));
            Assert.False(dir.IsMuted("sfx"));           // the master override does not change a bus's own state

            Assert.Equal(4, cmds.Count);
            Assert.All(cmds, c => { Assert.Equal("mix", c.Type); Assert.Null(c.Id); });
            Assert.Equal("music", cmds[0].Bus);
            Assert.False(cmds[0].Muted);
            Assert.True(cmds[1].Muted);
            Assert.Null(cmds[2].Bus);
            Assert.True(cmds[2].Muted);
            Assert.True(doc.Audio.Buses[0].Muted);       // the document is untouched
        }
    }
}
