plugins {
  `java-library`
  id("com.vanniktech.maven.publish")
}

val gdxVersion = rootProject.extra["gdxVersion"] as String

dependencies {
  api(project(":openbone-runtime"))
  api("com.badlogicgames.gdx:gdx:$gdxVersion")
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
