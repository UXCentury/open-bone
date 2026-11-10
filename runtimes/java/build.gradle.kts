import com.vanniktech.maven.publish.MavenPublishBaseExtension

plugins {
  // Loaded once here so every module shares the same plugin classes (the publish plugin inspects AGP and Kotlin).
  kotlin("jvm") apply false
  kotlin("android") apply false
  id("com.android.library") apply false
  id("com.vanniktech.maven.publish") apply false
}

allprojects {
  // Maven coordinates: io.openbone:openbone-<module>. The Java/Kotlin packages stay com.openbone.*.
  group = "io.openbone"
  version = "0.3.0"
}

extra["gdxVersion"] = "1.14.2"

// Shared Maven Central setup for the modules that apply com.vanniktech.maven.publish (runtime, scripting, gdx,
// android). Each module sets its own POM name and description. See docs/releasing.md and .github/workflows/publish-maven.yml.
subprojects {
  plugins.withId("com.vanniktech.maven.publish") {
    extensions.configure<MavenPublishBaseExtension> {
      // Uploads to the Central Portal and releases once validated. Credentials: mavenCentralUsername /
      // mavenCentralPassword (ORG_GRADLE_PROJECT_* env vars); only read by the publishToMavenCentral tasks.
      publishToMavenCentral(automaticRelease = true)
      // Sign only when a key is provided (ORG_GRADLE_PROJECT_signingInMemoryKey), so publishToMavenLocal and
      // ordinary builds work without one. Central rejects unsigned uploads; the publish workflow checks the secrets.
      if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
      pom {
        url.set("https://github.com/UXCentury/open-bone")
        inceptionYear.set("2026")
        licenses {
          license {
            name.set("MIT License")
            url.set("https://opensource.org/licenses/MIT")
            distribution.set("repo")
          }
        }
        developers {
          developer {
            id.set("uxcentury")
            name.set("UX Century")
            url.set("https://uxcentury.com")
          }
        }
        scm {
          url.set("https://github.com/UXCentury/open-bone")
          connection.set("scm:git:https://github.com/UXCentury/open-bone.git")
          developerConnection.set("scm:git:ssh://git@github.com/UXCentury/open-bone.git")
        }
        issueManagement {
          system.set("GitHub Issues")
          url.set("https://github.com/UXCentury/open-bone/issues")
        }
      }
    }
  }
}
