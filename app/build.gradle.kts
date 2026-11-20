plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "ir.asalac.crm"
    compileSdk = 34
    defaultConfig {
        applicationId = "ir.asalac.crm"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.2"
    }
    // Fixed signing key (app/asalac.keystore) so every new APK installs OVER the old one and keeps the phone data.
    signingConfigs {
        create("asalac") {
            storeFile = file("asalac.keystore")
            storePassword = "asalac123"
            keyAlias = "asalac"
            keyPassword = "asalac123"
        }
    }
    buildTypes {
        debug { signingConfig = signingConfigs.getByName("asalac") }
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("asalac") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

// The CRM page (assets/index.html) needs two JS libraries. They are downloaded once at build time
// (same files and versions that run.bat downloads). You can also drop them into app/src/main/assets yourself.
val webLibs = mapOf(
    "xlsx.full.min.js" to "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    "qrcode.js" to "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"
)
val fetchWebLibs by tasks.registering {
    val dir = file("src/main/assets")
    doLast {
        dir.mkdirs()
        webLibs.forEach { (name, url) ->
            val f = File(dir, name)
            if (!f.exists() || f.length() < 1000) {
                uri(url).toURL().openStream().use { input -> f.outputStream().use { out -> input.copyTo(out) } }
            }
            if (f.length() < 1000) throw GradleException("Could not download $name")
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(fetchWebLibs) }
