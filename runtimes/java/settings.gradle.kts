pluginManagement {
  repositories {
    gradlePluginPortal()
    google()
    mavenCentral()
  }
  plugins {
    kotlin("jvm") version "2.4.21"
  }
}

dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "openbone-java"

include("openbone-runtime", "openbone-scripting", "openbone-conformance", "openbone-gdx", "openbone-gdx-sample")
