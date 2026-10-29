package dev.learnharness.android

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Dictation for the page (docs/android/m12-plan.md, step 6): the system SpeechRecognizer, ON-DEVICE only (owner decision,
 * 2026-10-28: audio never leaves the phone; there is no cloud fallback). The page talks to it over the same
 * `window.lhAndroid` channel as the native ink layer, with lines that start with `speech`; [SpeechWire] is the format
 * (src/core/speech-bridge.ts is the page's half). The recognizer ends a session at every pause, so while the learner
 * has not stopped, listening is simply restarted and each stretch goes to the page as one final.
 */
class SpeechBridge(private val context: Context, private val askMicrophone: (onResult: (Boolean) -> Unit) -> Unit) {
	private val main = Handler(Looper.getMainLooper())
	private var recognizer: SpeechRecognizer? = null
	private var post: (String) -> Unit = {}
	private var intent: Intent? = null
	private var wanted = false
	private var stopping = false
	private var language = ""
	/** The last partial sent, so an unchanged guess is not sent twice. */
	private var lastPartial = ""
	private var lastLevel = ""
	/** True while this app captures the microphone and feeds the recognizer (see [LevelMeter]). */
	private var micOwned = false
	private val meter = LevelMeter { level ->
		val line = SpeechWire.level(level)
		main.post { if (line != lastLevel) { lastLevel = line; if (recognizer != null) post(line) } }
	}

	/** One line from the page (on the main thread). `reply` posts a line back. */
	fun handle(line: String, reply: (String) -> Unit) {
		post = reply
		when (val op = SpeechWire.parse(line)) {
			SpeechOp.Probe -> post(SpeechWire.ready())
			is SpeechOp.Start -> start(op.language)
			SpeechOp.Stop -> stop()
			SpeechOp.Cancel -> cancel()
			null -> Unit
		}
	}

	private fun start(lang: String) {
		if (recognizer != null) return error("busy")
		val tag = SpeechWire.locale(lang) ?: return error("language", lang)
		// the on-device recognizer API exists from Android 13; an older phone cannot dictate offline
		if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return error("unavailable")
		askMicrophone { granted ->
			if (!granted) error("permission") else begin(lang, tag)
		}
	}

	private fun begin(lang: String, tag: String) {
		if (recognizer != null) return
		language = lang
		wanted = true
		stopping = false
		intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
			.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
			.putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag)
			.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
			// the words appear in the field as they are spoken, like a keyboard's voice typing: the recognizer's guesses are sent as partials
			.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
		val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
		recognizer = r
		r.setRecognitionListener(listener)
		micOwned = meter.start()
		listen(r)
		post(SpeechWire.state("listening"))
	}

	private val listener = object : RecognitionListener {
		override fun onResults(results: Bundle?) {
			val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
			if (text.isNotEmpty()) { lastPartial = ""; post(SpeechWire.final(text)) } else keepPartial()
			if (wanted && !stopping) listenAgain() else finish()
		}

		override fun onError(code: Int) {
			when (code) {
				// nothing was said in this stretch: not an error, keep going while the learner has not stopped
				SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
					keepPartial()
					if (wanted && !stopping) listenAgain() else finish()
				}
				SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> {
					downloadPack()
					fail("language", language)
				}
				SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("permission")
				SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> fail("busy")
				SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER,
				SpeechRecognizer.ERROR_SERVER_DISCONNECTED, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> fail("network")
				// the recognizer reports a client error when it is stopped or cancelled under it
				SpeechRecognizer.ERROR_CLIENT -> if (stopping || !wanted) finish() else fail("other", "client")
				else -> fail("other", "code $code")
			}
		}

		override fun onReadyForSpeech(params: Bundle?) = Unit
		override fun onBeginningOfSpeech() = Unit
		// the recognizer's own level arrives in bursts every 0.64 s: the meter uses [LevelMeter] instead
		override fun onRmsChanged(rmsdB: Float) = Unit

		override fun onBufferReceived(buffer: ByteArray?) = Unit
		override fun onEndOfSpeech() = Unit
		override fun onPartialResults(partialResults: Bundle?) {
			val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
			if (text.isEmpty() || text == lastPartial) return
			lastPartial = text
			post(SpeechWire.partial(text))
		}

		override fun onEvent(eventType: Int, params: Bundle?) = Unit
	}

	/**
	 * A stretch ended with no final but with a guess shown in the field: send the guess as the final. Otherwise the page
	 * replaces it with the next stretch's first partial and the whole stretch's text disappears (long dictation).
	 */
	private fun keepPartial() {
		if (lastPartial.isNotEmpty()) post(SpeechWire.final(lastPartial))
		lastPartial = ""
	}

	private fun listenAgain() {
		lastPartial = ""
		recognizer?.let { listen(it) }
	}

	/** One listening session. When this app owns the microphone ([LevelMeter]) the recognizer is fed its audio through a fresh pipe. */
	private fun listen(r: SpeechRecognizer) {
		val i = intent ?: return
		if (!micOwned) return r.startListening(i)
		val source = meter.newSource()
		i.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source)
			.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, LevelMeter.RATE)
			.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
			.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, android.media.AudioFormat.ENCODING_PCM_16BIT)
		r.startListening(i)
		// startListening hands the intent over later: the meter keeps our end of the pipe open until the next session or the end
	}

	/** The page asked to stop: the recognizer finishes what it has (a final may still arrive), then the state goes idle. */
	private fun stop() {
		if (recognizer == null) return post(SpeechWire.state("idle"))
		stopping = true
		wanted = false
		post(SpeechWire.state("processing"))
		recognizer?.stopListening()
		main.postDelayed({ if (stopping && recognizer != null) finish() }, STOP_TIMEOUT_MS)
	}

	/** Discard: nothing more is sent (the page has already torn its side down). */
	private fun cancel() {
		wanted = false
		stopping = false
		release()
	}

	private fun finish() {
		release()
		post(SpeechWire.state("idle"))
	}

	private fun fail(code: String, detail: String = "") {
		release()
		error(code, detail)
	}

	private fun error(code: String, detail: String = "") = post(SpeechWire.error(code, detail))

	private fun release() {
		meter.stop()
		wanted = false
		stopping = false
		recognizer?.let {
			it.setRecognitionListener(null)
			it.cancel()
			it.destroy()
		}
		recognizer = null
	}

	/** Ask Android to fetch the offline pack for the language that was missing, so the next try works. */
	private fun downloadPack() {
		if (Build.VERSION.SDK_INT < 33) return
		val r = recognizer ?: return
		val tag = SpeechWire.locale(language) ?: return
		// not the listening intent: it carries the microphone pipe, which is closed by now ("Bad file descriptor")
		r.triggerModelDownload(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag))
	}

	/** Called when the page goes away (a reload, the activity ending): stop listening. */
	fun close() = cancel()

	private companion object {
		const val STOP_TIMEOUT_MS = 4000L
	}
}

sealed interface SpeechOp {
	data object Probe : SpeechOp
	data class Start(val language: String) : SpeechOp
	data object Stop : SpeechOp
	data object Cancel : SpeechOp
}

/** The lines of the speech channel; pure, so the unit tests cover it (src/core/speech-bridge.ts is the page's half). */
object SpeechWire {
	fun isSpeech(line: String): Boolean = line.trimStart().startsWith("speech ")

	/** A line from the page, or null when it is not a speech line this shell understands. */
	fun parse(line: String): SpeechOp? {
		val words = line.trim().split(Regex("""\s+"""))
		if (words.size < 2 || words[0] != "speech") return null
		return when (words[1]) {
			"probe" -> SpeechOp.Probe
			"start" -> words.getOrNull(2)?.let { SpeechOp.Start(it) }
			"stop" -> SpeechOp.Stop
			"cancel" -> SpeechOp.Cancel
			else -> null
		}
	}

	/** The lesson languages the app has (src/core/language.ts) and the locale each is recognized in. */
	fun locale(language: String): String? = when (language) {
		"en" -> "en-US"
		"nb" -> "nb-NO"
		else -> null
	}

	fun ready(): String = "speech ready"
	fun state(state: String): String = "speech state $state"

	/** The recognizer's current guess for the stretch being spoken; the page replaces its last partial with it. */
	fun partial(text: String): String = "speech partial " + text.replace(Regex("""\s+"""), " ").trim()

	/** One recognized stretch; line breaks would end the message early, so they become spaces. */
	fun final(text: String): String = "speech final " + text.replace(Regex("""\s+"""), " ").trim()

	/** The microphone's loudness as a 0..1 level ([LevelMeter.levelOf]), two decimals. */
	fun level(level: Float): String = "speech level " + String.format(java.util.Locale.ROOT, "%.2f", level.coerceIn(0f, 1f))

	fun error(code: String, detail: String = ""): String = ("speech error $code " + detail.replace(Regex("""\s+"""), " ")).trim()
}
