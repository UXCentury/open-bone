pluginManagement {
  repositories {
    gradlePluginPortal()
    google()
    mavenCentral()
  }
  plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("android") version "2.4.21"
    id("com.android.library") version "8.13.1"
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

// The Android library needs the Android SDK: built when local.properties has sdk.dir, ANDROID_HOME /
// ANDROID_SDK_ROOT is set, or an SDK is in the default place (then local.properties is written for the plugin).
val localProps = file("local.properties")
fun sdkFromLocalProps(): String? =
  if (localProps.exists()) localProps.readLines().firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=") else null
val home = System.getProperty("user.home")
val androidSdk = sdkFromLocalProps()
  ?: System.getenv("ANDROID_HOME")
  ?: System.getenv("ANDROID_SDK_ROOT")
  ?: listOf("$home/Android/Sdk", "$home/Library/Android/sdk", "$home/AppData/Local/Android/Sdk").firstOrNull { file(it).isDirectory }
if (androidSdk != null && file(androidSdk).isDirectory) {
  if (sdkFromLocalProps() == null && System.getenv("ANDROID_HOME") == null && System.getenv("ANDROID_SDK_ROOT") == null)
    localProps.appendText("sdk.dir=" + androidSdk.replace("\\", "\\\\") + "\n")
  include("openbone-android")
} else {
  logger.lifecycle("OpenBone: no Android SDK found, skipping :openbone-android")
}
