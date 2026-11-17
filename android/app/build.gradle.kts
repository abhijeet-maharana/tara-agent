import java.net.URI
import java.security.MessageDigest
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
        // Only the phone's ABI: ONNX Runtime (the wake word) ships native code for four.
        ndk { abiFilters += "arm64-v8a" }
    }

    // The wake word's models, downloaded at build time (see `wakeWordModels` below).
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/wakeword"))

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
    // Voice v2: the WebSocket to tara-agent (pinned TLS, like Net).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // "Hey Jarvis": openWakeWord's models on the phone.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
    testImplementation("junit:junit:4.13.2")
}

// "Hey Jarvis" (Voice v2 step 4): openWakeWord's ONNX models (github.com/dscripka/openWakeWord, release
// v0.5.1). They are licensed CC BY-NC-SA 4.0, so they are fetched at build time into build/ (checked by
// SHA-256) and never committed to this repo.
val wakeWordModels by tasks.registering {
    val dir = layout.buildDirectory.dir("generated/wakeword/oww")
    val models = mapOf(
        "melspectrogram.onnx" to "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
        "embedding_model.onnx" to "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
        "hey_jarvis_v0.1.onnx" to "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb",
    )
    outputs.dir(dir)
    doLast {
        val out = dir.get().asFile.apply { mkdirs() }
        for ((name, sha) in models) {
            val f = File(out, name)
            fun hash() = MessageDigest.getInstance("SHA-256").digest(f.readBytes())
                .joinToString("") { "%02x".format(it) }
            if (f.exists() && hash() == sha) continue
            URI("https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/$name").toURL()
                .openStream().use { input -> f.outputStream().use { input.copyTo(it) } }
            check(hash() == sha) { "$name: checksum differs" }
        }
    }
}
tasks.named("preBuild") { dependsOn(wakeWordModels) }

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
