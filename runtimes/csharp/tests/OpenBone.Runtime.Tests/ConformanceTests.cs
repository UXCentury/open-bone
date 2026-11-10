using System.Collections.Generic;
using System.Linq;
using Xunit;

namespace OpenBone.Tests
{
    public class ConformanceTests
    {
        public static IEnumerable<object[]> Files() => Conformance.ExpectedFiles().Select(f => new object[] { f });

        [Fact]
        public void HasEveryReferenceFile()
        {
            var files = Conformance.ExpectedFiles().ToList();
            Assert.True(files.Count >= 20, $"only {files.Count} expected files");
        }

        [Theory]
        [MemberData(nameof(Files))]
        public void MatchesReference(string file)
        {
            int before = Conformance.Compared;
            var errors = Conformance.Run(file);
            Assert.True(Conformance.Compared > before, $"no samples compared in {file}");
            Assert.True(errors.Count == 0, $"{errors.Count} mismatch(es) in {file}:\n" + string.Join("\n", errors));
        }
    }
}
