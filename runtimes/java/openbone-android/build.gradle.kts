plugins {
  id("com.android.library")
  kotlin("android")
  id("com.vanniktech.maven.publish")
}

android {
  namespace = "com.openbone.android"
  compileSdk = 36
  defaultConfig {
    minSdk = 24
    consumerProguardFiles("consumer-rules.pro")
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
  }
  sourceSets["main"].java.srcDirs("src/main/kotlin")
  // The instrumented test replays the whole conformance suite on the device with the shared runner.
  sourceSets["androidTest"].java.srcDirs("src/androidTest/kotlin", "../openbone-conformance/src/runner/java")
  // A plain directory (AGP 9 rejects Providers here); conformanceAssets below fills it before the assets merge.
  sourceSets["androidTest"].assets.srcDir(layout.buildDirectory.dir("conformance-assets").get().asFile)
  testOptions.unitTests.isReturnDefaultValues = true
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
  }
}

dependencies {
  api(project(":openbone-runtime"))
  // State machine scripts (QuickJS); the Android variant of quickjs-kt is picked automatically.
  api(project(":openbone-scripting"))
  testImplementation(platform("org.junit:junit-bom:5.11.4"))
  testImplementation("org.junit.jupiter:junit-jupiter")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test>().configureEach { useJUnitPlatform() }

dependencies {
  androidTestImplementation("androidx.test:runner:1.6.2")
  androidTestImplementation("androidx.test:core:1.6.1")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("junit:junit:4.13.2")
}

// conformance/expected, conformance/fixtures and the example documents, packed into the test APK's assets.
val conformanceAssets = tasks.register<Sync>("conformanceAssets") {
  val repo = rootProject.projectDir.resolve("../..")
  into(layout.buildDirectory.dir("conformance-assets"))
  from(repo.resolve("conformance/expected")) { into("conformance/expected") }
  from(repo.resolve("conformance/fixtures")) { into("conformance/fixtures") }
  from(repo.resolve("examples")) { include("*.obone"); into("examples") }
}
tasks.matching { it.name.startsWith("merge") && it.name.contains("AndroidTestAssets") }.configureEach { dependsOn(conformanceAssets) }

mavenPublishing {
  coordinates(artifactId = "openbone-android")
  pom {
    name.set("OpenBone Android")
    description.set("Android View for OpenBone skeletons and state machines with a Kotlin API: inputs, triggers, events, touch listeners, audio.")
  }
}
