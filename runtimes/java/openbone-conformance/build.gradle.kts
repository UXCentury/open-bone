plugins {
  java
}

dependencies {
  testImplementation(project(":openbone-runtime"))
  testRuntimeOnly(project(":openbone-scripting"))
  testImplementation(platform("org.junit:junit-bom:5.11.4"))
  testImplementation("org.junit.jupiter:junit-jupiter")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
}

tasks.withType<JavaCompile>().configureEach {
  options.release.set(11)
  options.encoding = "UTF-8"
}

tasks.test {
  useJUnitPlatform()
  // The suite lives at the repo root: runtimes/java/../../conformance
  systemProperty("openbone.repo", rootProject.projectDir.resolve("../..").canonicalPath)
  System.getProperty("openbone.only")?.let { systemProperty("openbone.only", it) }
  maxHeapSize = "2g"
  testLogging {
    events("failed")
    exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    showStandardStreams = false
  }
}
