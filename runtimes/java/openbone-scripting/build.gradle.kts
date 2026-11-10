plugins {
  kotlin("jvm")
  `java-library`
  id("com.vanniktech.maven.publish")
}

dependencies {
  api(project(":openbone-runtime"))
  // QuickJS (MIT) through quickjs-kt (Apache-2.0): JNI builds for Linux, macOS, Windows and Android.
  api("io.github.dokar3:quickjs-kt:1.0.15")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
  }
}

mavenPublishing {
  coordinates(artifactId = "openbone-scripting")
  pom {
    name.set("OpenBone Scripting")
    description.set("QuickJS script host for OpenBone state machine scripts on the JVM and Android (via quickjs-kt).")
  }
}
