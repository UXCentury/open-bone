plugins {
  `java-library`
}

val gdxVersion: String by rootProject.extra

dependencies {
  api(project(":openbone-runtime"))
  api("com.badlogicgames.gdx:gdx:$gdxVersion")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
  withSourcesJar()
}

tasks.withType<JavaCompile>().configureEach {
  options.release.set(11)
  options.encoding = "UTF-8"
}
