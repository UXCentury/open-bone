using System;
using System.IO;

namespace OpenBone.MonoGame.Tests
{
    static class TestPaths
    {
        /// <summary>examples/&lt;name&gt; in the repository, found by walking up from the test binaries.</summary>
        public static string Example(string name)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                var p = Path.Combine(dir.FullName, "examples", name);
                if (File.Exists(p)) return p;
            }
            throw new FileNotFoundException("examples/" + name + " not found above " + AppContext.BaseDirectory);
        }
    }
}
