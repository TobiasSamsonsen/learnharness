plugins {
	id("com.android.application") version "9.4.1"
}

android {
	namespace = "dev.learnharness.android"
	compileSdk = 37

	defaultConfig {
		applicationId = "dev.learnharness.android"
		minSdk = 31
		targetSdk = 37
		versionCode = 1
		versionName = "0.1.0"
	}

	buildFeatures {
		buildConfig = true
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
	// M9 spike (debug builds only): androidx.ink and its motion prediction, for the native-ink latency comparison
	debugImplementation("androidx.ink:ink-authoring:1.0.0")
	debugImplementation("androidx.ink:ink-brush:1.0.0")
	debugImplementation("androidx.ink:ink-strokes:1.0.0")
	debugImplementation("androidx.ink:ink-rendering:1.0.0")
	debugImplementation("androidx.input:input-motionprediction:1.0.0")
	testImplementation("junit:junit:4.13.2")
}
