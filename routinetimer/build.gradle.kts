plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.routinetimer"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.example.routinetimer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    // The web app in /routine-timer is bundled as-is, so the APK and the web page stay identical.
    sourceSets["main"].assets.srcDirs("../routine-timer")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
