package dev.learnharness.android

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
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
	/** The learner's opt-in (Settings): this run may use the online recognizer when the language has no offline pack. */
	private var onlineAllowed = false
	/** True once this run switched to the online recognizer (audio goes to Google). */
	private var online = false
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
			is SpeechOp.Start -> start(op.language, op.online)
			SpeechOp.Stop -> stop()
			SpeechOp.Cancel -> cancel()
			null -> Unit
		}
	}

	private fun start(lang: String, allowOnline: Boolean) {
		if (recognizer != null) return error("busy")
		onlineAllowed = allowOnline
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
		online = false
		intent =Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
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
				// an online recognizer that rejects the language has nothing further to try (and must not loop back into missingPack)
				SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
					if (online) fail("other", "online language") else missingPack()
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
		online = false
		recognizer?.let {
			it.setRecognitionListener(null)
			it.cancel()
			it.destroy()
		}
		recognizer = null
	}

	/**
	 * The recognizer has no pack for the language. Ask Android whether it offers one: only then is a download started. Some
	 * recognizers have no offline pack at all for a language (the Galaxy Tab S10+'s Google recognizers have none for nb-NO, and
	 * a download request is silently ignored), and that must not read as "downloading". With the learner's opt-in
	 * ([onlineAllowed]) the run then goes online; without it the page gets an honest error.
	 */
	private fun missingPack() {
		val r = recognizer ?: return
		val tag = SpeechWire.locale(language) ?: return fail("language", language)
		// not the listening intent: it carries the microphone pipe, which is closed by now ("Bad file descriptor")
		val ask = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, tag)
		r.checkRecognitionSupport(ask, context.mainExecutor, object : RecognitionSupportCallback {
			override fun onSupportResult(support: RecognitionSupport) {
				// the session may have been cancelled or replaced while Android was answering
				if (recognizer !== r) return
				val offered = SpeechWire.offersPack(tag, support.installedOnDeviceLanguages, support.pendingOnDeviceLanguages, support.supportedOnDeviceLanguages)
				if (offered) r.triggerModelDownload(ask)
				if (onlineAllowed) goOnline(r)
				else if (offered) fail("language", language)
				else fail("unsupported", language)
			}

			// the pack is known to be missing, so an unanswered support check changes nothing for an opted-in run
			override fun onError(error: Int) {
				if (recognizer !== r) return
				if (onlineAllowed) goOnline(r) else fail("other", "support check $error")
			}
		})
	}

	/**
	 * Swap the on-device recognizer for the standard one (Speech Services by Google: the engine behind keyboard voice typing),
	 * online. Only after the learner's opt-in and only for a language with no offline pack. The page is told (`speech mode online`)
	 * so it can show that audio leaves the device, and the restart-after-pause loop carries on as before.
	 */
	private fun goOnline(old: SpeechRecognizer) {
		if (!wanted || stopping) return finish() // the learner stopped while Android was answering
		old.setRecognitionListener(null)
		old.cancel()
		old.destroy()
		intent?.removeExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE)
		val r = SpeechRecognizer.createSpeechRecognizer(context)
		recognizer = r
		online = true
		lastPartial = ""
		r.setRecognitionListener(listener)
		post(SpeechWire.mode(true))
		listen(r)
	}

	/** Called when the page goes away (a reload, the activity ending): stop listening. */
	fun close() = cancel()

	private companion object {
		const val STOP_TIMEOUT_MS = 4000L
	}
}

sealed interface SpeechOp {
	data object Probe : SpeechOp
	data class Start(val language: String, val online: Boolean = false) : SpeechOp
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
			"start" -> words.getOrNull(2)?.let { SpeechOp.Start(it, online = words.getOrNull(3) == "online") }
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

	/** True when the recognizer lists [tag] (BCP-47, any case) as installed, being downloaded, or downloadable. */
	fun offersPack(tag: String, vararg lists: List<String>): Boolean = lists.any { list -> list.any { it.equals(tag, ignoreCase = true) } }

	/** Which recognizer this run uses; `online` means the learner's audio goes to Google (shown on the page). */
	fun mode(online: Boolean): String = if (online) "speech mode online" else "speech mode offline"

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
