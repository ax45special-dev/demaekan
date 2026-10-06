package com.example.offerjudge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions

class CaptureService : Service() {

    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        private const val CHANNEL = "capture"
        private const val INTERVAL_MS = 1000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val recognizer =
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var overlay: TextView? = null
    private var busy = false

    override fun onBind(intent: Intent?): IBinder? = null

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()

        val code = intent?.getIntExtra(EXTRA_CODE, 0) ?: 0
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
            intent?.getParcelableExtra(EXTRA_DATA, Intent::class.java)
        } else {
            intent?.getParcelableExtra(EXTRA_DATA)
        }
        if (data == null || projection != null) return START_NOT_STICKY

        showOverlay()

        val mpm = getSystemService(MediaProjectionManager::class.java)
        projection = mpm.getMediaProjection(code, data).also {
            it.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() { stopSelf() }
            }, main)
        }
        startCapture()
        return START_NOT_STICKY
    }

    private fun startAsForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "画面読み取り", NotificationManager.IMPORTANCE_LOW)
        )
        val n = Notification.Builder(this, CHANNEL)
            .setContentTitle("案件判断 実行中")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(1, n)
        }
    }

    private fun showOverlay() {
        val tv = TextView(this).apply {
            text = "待機中…"
            textSize = 12f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(200, 0, 0, 0))
            setPadding(16, 12, 16, 12)
            maxLines = 10
            maxWidth = (resources.displayMetrics.widthPixels * 0.7).toInt()
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // NOT_TOUCHABLE: 下のアプリの操作を邪魔しない
            // SECURE: 自分の表示をキャプチャに写さない（OCRが自分の文字を読まないように）
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 16
            y = 200
        }
        getSystemService(WindowManager::class.java).addView(tv, params)
        overlay = tv
    }

    private fun startCapture() {
        val dm = resources.displayMetrics
        val w = dm.widthPixels
        val h = dm.heightPixels
        val reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        virtualDisplay = projection?.createVirtualDisplay(
            "offer-capture", w, h, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, null
        )
        main.postDelayed(loop, INTERVAL_MS)
    }

    private val loop = object : Runnable {
        override fun run() {
            captureOnce()
            main.postDelayed(this, INTERVAL_MS)
        }
    }

    private fun captureOnce() {
        if (busy) return
        val image = imageReader?.acquireLatestImage() ?: return // 画面に変化がなければスキップ
        val bmp: Bitmap
        try {
            val plane = image.planes[0]
            val rowPadding = plane.rowStride - plane.pixelStride * image.width
            val padded = Bitmap.createBitmap(
                image.width + rowPadding / plane.pixelStride,
                image.height,
                Bitmap.Config.ARGB_8888
            )
            padded.copyPixelsFromBuffer(plane.buffer)
            bmp = Bitmap.createBitmap(padded, 0, 0, image.width, image.height)
        } finally {
            image.close()
        }

        if (isMostlyBlack(bmp)) {
            overlay?.text = "⚫ 画面が真っ黒です\n（このアプリはキャプチャ禁止の可能性）"
            return
        }

        busy = true
        recognizer.process(InputImage.fromBitmap(bmp, 0))
            .addOnSuccessListener { showResult(it.text) }
            .addOnFailureListener { overlay?.text = "OCRエラー: ${it.message}" }
            .addOnCompleteListener { busy = false }
    }

    private fun isMostlyBlack(bmp: Bitmap): Boolean {
        var dark = 0
        var total = 0
        val stepX = maxOf(1, bmp.width / 20)
        val stepY = maxOf(1, bmp.height / 20)
        var y = 0
        while (y < bmp.height) {
            var x = 0
            while (x < bmp.width) {
                val p = bmp.getPixel(x, y)
                if (Color.red(p) + Color.green(p) + Color.blue(p) < 30) dark++
                total++
                x += stepX
            }
            y += stepY
        }
        return total > 0 && dark.toDouble() / total > 0.95
    }

    private fun showResult(text: String) {
        val yen = Regex("""[¥￥]\s*([0-9,]+)|([0-9,]+)\s*円""").findAll(text)
            .map { m -> m.groupValues[1].ifEmpty { m.groupValues[2] } }
            .toList()
        val km = Regex("""([0-9]+(?:\.[0-9]+)?)\s*(?:km|KM|Km|ｋｍ)""").findAll(text)
            .map { it.groupValues[1] }
            .toList()
        overlay?.text = buildString {
            append("💴 ").append(if (yen.isEmpty()) "-" else yen.joinToString(" / ")).append('\n')
            append("📍 ").append(if (km.isEmpty()) "-" else km.joinToString(" / ") + " km").append('\n')
            append("――読み取り文字――\n")
            append(text.replace('\n', ' ').take(150))
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(loop)
        virtualDisplay?.release()
        imageReader?.close()
        val p = projection
        projection = null
        p?.stop()
        overlay?.let { getSystemService(WindowManager::class.java).removeView(it) }
        overlay = null
        recognizer.close()
        super.onDestroy()
    }
}
