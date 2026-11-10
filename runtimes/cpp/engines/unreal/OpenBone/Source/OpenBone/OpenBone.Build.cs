// OpenBone runtime module. Links libopenbone (C API, static) from ThirdParty/openbone, built with CMake:
//   cmake -S runtimes/cpp -B build -DCMAKE_BUILD_TYPE=Release -DOPENBONE_BUILD_SHARED=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
//   cmake --build build --config Release && cmake --install build --prefix <Plugin>/ThirdParty/openbone/<Platform>
// SPDX-License-Identifier: MIT
using System.IO;
using UnrealBuildTool;

public class OpenBone : ModuleRules
{
	public OpenBone(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "ProceduralMeshComponent" });
		PrivateDependencyModuleNames.AddRange(new[] { "ImageWrapper", "RenderCore", "RHI" });

		string Root = Path.Combine(PluginDirectory, "ThirdParty", "openbone", Target.Platform.ToString());
		PublicIncludePaths.Add(Path.Combine(Root, "include"));
		PublicDefinitions.Add("OPENBONE_STATIC=1");
		string Lib = Path.Combine(Root, "lib");
		if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "openbone_static.lib"));  // MSVC: static lib, kept apart from the DLL import lib
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "openbone_quickjs.lib"));
		}
		else
		{
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "libopenbone.a"));
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "libopenbone_quickjs.a"));
		}
	}
}
