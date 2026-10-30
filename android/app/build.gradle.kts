plugins {
	id("com.android.application") version "9.4.1"
}

// The app version is the repo's release version (root package.json; tags are v<version>): one bump per release.
// versionCode = major*10000 + minor*100 + patch (0.4.0 -> 400), so it rises with the version; a pre-release suffix is ignored.
val releaseVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(rootDir.resolve("../../package.json").readText())?.groupValues?.get(1)
	?: throw GradleException("no version in ../../package.json")
val releaseCode: Int = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)").find(releaseVersion)?.destructured
	?.let { (major, minor, patch) -> major.toInt() * 10000 + minor.toInt() * 100 + patch.toInt() }
	?: throw GradleException("package.json version $releaseVersion is not major.minor.patch")

android {
	namespace = "dev.learnharness.android"
	compileSdk = 37

	defaultConfig {
		applicationId = "dev.learnharness.android"
		minSdk = 31
		targetSdk = 37
		versionCode = releaseCode
		versionName = releaseVersion
		// proot and the Linux guest are arm64 only (M12)
		ndk { abiFilters += "arm64-v8a" }
	}

	buildFeatures {
		buildConfig = true
	}

	packaging {
		jniLibs {
			// M12: proot and its loader ride as lib*.so and must exist as real files in nativeLibraryDir
			useLegacyPackaging = true
		}
	}

	// CI signs the debug APK with the committed throwaway key (ci-debug.keystore) so every published build has the same
	// signature and installs over the last one. Local builds keep the machine's own debug key.
	if (providers.environmentVariable("LH_CI_SIGNING").isPresent) {
		signingConfigs.getByName("debug") {
			storeFile = file("ci-debug.keystore")
			storePassword = "android"
			keyAlias = "androiddebugkey"
			keyPassword = "android"
		}
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}
}

dependencies {
	implementation("androidx.core:core-ktx:1.19.1")
	implementation("androidx.activity:activity-ktx:1.13.0")
	implementation("androidx.webkit:webkit:1.18.0")
	// M10: the native ink layer (androidx.ink and its motion prediction; the M9 spike proved the latency)
	implementation("androidx.ink:ink-authoring:1.0.0")
	implementation("androidx.ink:ink-brush:1.0.0")
	implementation("androidx.ink:ink-strokes:1.0.0")
	implementation("androidx.ink:ink-rendering:1.0.0")
	implementation("androidx.input:input-motionprediction:1.0.0")
	testImplementation("junit:junit:4.13.2")
	// the JVM unit tests need a real org.json (the Android jar's is a stub)
	testImplementation("org.json:json:20240303")
}

// proot is not committed (GPL binaries from the Termux packages): fetch it before the first build
tasks.named("preBuild") {
	doFirst {
		if (!file("src/main/jniLibs/arm64-v8a/libproot.so").exists()) {
			throw GradleException("proot is missing: run `python scripts/fetch-proot.py` in android/app first")
		}
	}
}
