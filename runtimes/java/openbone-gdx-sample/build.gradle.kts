plugins {
  application
}

val gdxVersion = rootProject.extra["gdxVersion"] as String

dependencies {
  implementation(project(":openbone-gdx"))
  implementation(project(":openbone-scripting"))
  implementation("com.badlogicgames.gdx:gdx-backend-lwjgl3:$gdxVersion")
  runtimeOnly("com.badlogicgames.gdx:gdx-platform:$gdxVersion:natives-desktop")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
}

tasks.withType<JavaCompile>().configureEach {
  options.release.set(11)
  options.encoding = "UTF-8"
}

application {
  mainClass.set("com.openbone.gdx.sample.SampleLauncher")
  if (System.getProperty("os.name").lowercase().contains("mac")) applicationDefaultJvmArgs = listOf("-XstartOnFirstThread")
}

tasks.named<JavaExec>("run") {
  workingDir = rootProject.projectDir
  // ./gradlew :openbone-gdx-sample:run --args="../../examples/knight.obone"
}
