plugins {
  `java-library`
  id("com.vanniktech.maven.publish")
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
  coordinates(artifactId = "openbone-runtime")
  pom {
    name.set("OpenBone Runtime")
    description.set("OpenBone 2D skeletal animation and state machine runtime for Java 11+: loads .obone/.obonb documents, poses skeletons, mixes animations, runs state machines and builds the draw list. No dependencies.")
  }
}
