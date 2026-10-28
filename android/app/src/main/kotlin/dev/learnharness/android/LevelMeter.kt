package dev.learnharness.android

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.ParcelFileDescriptor
import java.io.OutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * The dictation microphone, captured once by this app (owner, 2026-10-28: the meter did not react to short pauses). The
 * system recognizer reports its own level only in bursts of two readings every 0.64 s, and a second capture next to the
 * recognizer's own would silence the recognizer (Android gives the foreground app priority). So the app records, measures
 * the loudness of every 50 ms for the meter, and hands the same audio to the recognizer through
 * `RecognizerIntent.EXTRA_AUDIO_SOURCE`. The samples live only in this pipe; nothing is stored or sent anywhere.
 */
class LevelMeter(private val onLevel: (Float) -> Unit) {
	@Volatile private var running = false
	@Volatile private var sink: OutputStream? = null
	private var readEnd: ParcelFileDescriptor? = null
	private val queue = ArrayBlockingQueue<ByteArray>(QUEUE)
	private var capture: Thread? = null
	private var writer: Thread? = null

	/** A fresh pipe for the next listening session: the read end goes to the recognizer, the write end is fed from here. */
	fun newSource(): ParcelFileDescriptor {
		val (read, write) = ParcelFileDescriptor.createPipe()
		queue.clear()
		val old = sink
		sink = ParcelFileDescriptor.AutoCloseOutputStream(write)
		try { old?.close() } catch (_: Exception) {}
		try { readEnd?.close() } catch (_: Exception) {}
		readEnd = read
		return read
	}

	/** Whether the capture runs (false when the microphone could not be opened: the recognizer then listens by itself). */
	@SuppressLint("MissingPermission") // the page asks for the microphone before dictation starts (SpeechBridge.askMicrophone)
	fun start(): Boolean {
		if (running) return true
		val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
		if (min <= 0) return false
		val record = try {
			AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, CHUNK * 8))
		} catch (_: Exception) {
			return false
		}
		if (record.state != AudioRecord.STATE_INITIALIZED) {
			record.release()
			return false
		}
		running = true
		capture = Thread({
			val samples = ShortArray(CHUNK)
			try {
				record.startRecording()
				while (running) {
					val n = record.read(samples, 0, CHUNK)
					if (n <= 0) continue
					var sum = 0.0
					val bytes = ByteArray(n * 2)
					for (i in 0 until n) {
						sum += samples[i].toDouble() * samples[i]
						bytes[2 * i] = (samples[i].toInt() and 0xff).toByte()
						bytes[2 * i + 1] = (samples[i].toInt() shr 8).toByte()
					}
					onLevel(levelOf(sqrt(sum / n)))
					if (!queue.offer(bytes)) { queue.poll(); queue.offer(bytes) } // the recognizer is behind: drop the oldest
				}
			} catch (_: Exception) {
				// a failed capture ends the audio; the recognizer then reports no speech
			} finally {
				try { record.stop() } catch (_: Exception) {}
				record.release()
			}
		}, "lh-mic-capture").also { it.isDaemon = true; it.start() }
		writer = Thread({
			while (running) {
				val chunk = queue.poll(100, TimeUnit.MILLISECONDS) ?: continue
				val out = sink ?: continue
				try {
					out.write(chunk)
					out.flush()
				} catch (_: Exception) {
					// the recognizer closed this session's pipe (a pause ended it): the next newSource() opens another
					if (sink === out) sink = null
					try { out.close() } catch (_: Exception) {}
				}
			}
		}, "lh-mic-writer").also { it.isDaemon = true; it.start() }
		return true
	}

	fun stop() {
		running = false
		capture = null
		writer = null
		val old = sink
		sink = null
		try { old?.close() } catch (_: Exception) {}
		try { readEnd?.close() } catch (_: Exception) {}
		readEnd = null
		queue.clear()
	}

	companion object {
		const val RATE = 16000
		/** 800 samples = 50 ms. */
		const val CHUNK = 800
		private const val QUEUE = 64

		/** A 16-bit sample RMS as a 0..1 level: -60 dBFS (a quiet room) to -20 dBFS (loud speech), linear in dB. */
		fun levelOf(rms: Double): Float {
			val db = 20.0 * log10(maxOf(rms, 1.0) / 32768.0)
			return ((db + 60.0) / 40.0).coerceIn(0.0, 1.0).toFloat()
		}
	}
}
