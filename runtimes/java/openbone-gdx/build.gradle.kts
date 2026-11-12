plugins {
  `java-library`
  id("com.vanniktech.maven.publish")
}

val gdxVersion = rootProject.extra["gdxVersion"] as String

dependencies {
  api(project(":openbone-runtime"))
  api("com.badlogicgames.gdx:gdx:$gdxVersion")
  // Text through FreeType (Apache-2.0): real outlines and any script the installed fonts cover. Apps add the natives
  // for their platform (gdx-freetype-platform: natives-desktop, natives-arm64-v8a, …); without them text falls back
  // to libGDX's built-in bitmap font.
  api("com.badlogicgames.gdx:gdx-freetype:$gdxVersion")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
}

tasks.withType<JavaCompile>().configureEach {
  options.release.set(11)
  options.encoding = "UTF-8"
}

mavenPublishing {
  coordinates(artifactId = "openbone-gdx")
  pom {
    name.set("OpenBone libGDX")
    description.set("libGDX renderer for OpenBone skeletons: two-colour tint shader, blend modes, stencil clipping, particles, text and audio.")
  }
}
