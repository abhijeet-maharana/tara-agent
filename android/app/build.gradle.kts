import java.time.Duration
import java.time.Instant
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Every build gets a higher versionCode (minutes since 2026-01-01), so a phone sees any newer APK that
// tara-agent serves as an update. CI may pin it with TARA_PHONE_VERSION_CODE.
val buildMinutes =
    Duration.between(Instant.parse("2026-01-01T00:00:00Z"), Instant.now()).toMinutes().toInt()

// Release signing comes from ~/.gradle/gradle.properties (never from this public repo):
//   taraPhoneStoreFile=/Users/you/.android/tara-phone.jks
//   taraPhoneStorePassword=…  taraPhoneKeyAlias=tara-phone  taraPhoneKeyPassword=…
// Without it (CI), release builds are signed with the debug key. An update must be signed like the
// installed app, so build the APKs the phone gets on one machine.
val releaseStore = (findProperty("taraPhoneStoreFile") as String?)?.let(::file)?.takeIf { it.exists() }

android {
    namespace = "com.abtara.taraphone"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.abtara.taraphone"
        minSdk = 31
        targetSdk = 35
        versionCode = System.getenv("TARA_PHONE_VERSION_CODE")?.toInt() ?: buildMinutes
        versionName = "0.1.0"
    }

    signingConfigs {
        if (releaseStore != null) {
            create("release") {
                storeFile = releaseStore
                storePassword = findProperty("taraPhoneStorePassword") as String
                keyAlias = findProperty("taraPhoneKeyAlias") as String
                keyPassword = findProperty("taraPhoneKeyPassword") as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures { buildConfig = true }

    lint {
        // The shell is a kiosk on one phone: not on Play, so Play-only checks don't apply.
        disable += setOf("ExpiredTargetSdkVersion", "OldTargetApi", "GradleDependency", "NewerVersionAvailable")
        abortOnError = true
        warningsAsErrors = false
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
}

// `./gradlew publishApk`: the release APK and its version into android/apk/, where tara-agent serves
// them (GET /phone/app.json, /phone/app.apk). Mutagen carries the folder to the host.
tasks.register("publishApk") {
    group = "distribution"
    description = "Builds the release APK into android/apk/ for tara-agent to offer as an update."
    dependsOn("assembleRelease")
    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk")
    val out = rootProject.layout.projectDirectory.dir("apk")
    val code = android.defaultConfig.versionCode
    val name = android.defaultConfig.versionName
    doLast {
        val dir = out.asFile.apply { mkdirs() }
        apk.get().asFile.copyTo(File(dir, "tara-phone.apk"), overwrite = true)
        // Written last: tara-agent reads the version from it, so it never names an APK not yet there.
        File(dir, "tara-phone.json").writeText("{\"versionCode\":$code,\"versionName\":\"$name\"}\n")
    }
}
