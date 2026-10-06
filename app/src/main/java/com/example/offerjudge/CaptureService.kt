package com.example.offerjudge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.abs

class CaptureService : Service() {

    companion object {
        const val EXTRA_CODE = "code"
        const val EXTRA_DATA = "data"
        const val PREFS = "offer"
        const val KEY_LAST_OFFER = "last_offer_text"
        private const val CHANNEL = "capture"
        private const val INTERVAL_MS = 1000L

        // ===== 判定基準（ここを自分用に変えてください）=====
        private const val GOOD_PER_HOUR = 1500 // これ以上なら 🟢受ける
        private const val OK_PER_HOUR = 1100   // これ以上なら 🟡微妙、未満は 🔴見送り
        private const val DEBUG = false        // trueにすると読み取った文字も表示
        private const val ROAD_FACTOR = 1.3    // 直線距離 → 道のりの概算倍率
    }

    private val main = Handler(Looper.getMainLooper())
    private val recognizer =
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var overlay: TextView? = null
    private var busy = false

    // 現在地
    private var here: Location? = null
    private val locListener = object : LocationListener {
        override fun onLocationChanged(location: Location) { here = location }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    // 表示中のオファー（ちらつき防止のため、一度読めた値を保持する）
    private var offerKey: String? = null
    private var deliveryAt: Int? = null // お届け時刻（0時からの分）
    private var missFrames = 0

    // 住所 → 緯度経度（null = 見つからない）
    private val geoCache = HashMap<String, Location?>()
    private val geoPending = HashSet<String>()
    private val geoThread = Executors.newSingleThreadExecutor()

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
        startLocation()

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
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            if (hasLocationPermission()) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            startForeground(1, n, type)
        } else {
            startForeground(1, n)
        }
    }

    private fun showOverlay() {
        val tv = TextView(this).apply {
            text = "待機中…"
            textSize = 13f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.argb(200, 0, 0, 0))
            setPadding(16, 6, 16, 6)
            maxLines = 2
            maxWidth = (resources.displayMetrics.widthPixels * 0.95).toInt()
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // NOT_TOUCHABLE: 下のアプリの操作を邪魔しない
            // SECURE: 自分の表示をキャプチャに写さない（OCRが自分の文字を読まないように）
            //   ※キャプチャ上ではこの部分が黒く抜けるので、小さく・画面上端に置く
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_SECURE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = 0
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
            .addOnSuccessListener { showResult(it) }
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

    private fun showResult(result: Text) {
        val tv = overlay ?: return
        val text = result.text
        val flat = text.replace('\n', ' ')

        // オファー画面かどうか
        val isOffer = flat.contains("自動拒否") || flat.contains("シングル") || flat.contains("ダブル")
        if (!isOffer) {
            // 一瞬読めなかっただけなら表示を保つ
            if (offerKey != null && ++missFrames < 3) return
            offerKey = null
            deliveryAt = null
            tv.setBackgroundColor(Color.argb(150, 0, 0, 0))
            tv.text = if (DEBUG) "待機中 " + flat.take(80) else "待機中"
            return
        }
        missFrames = 0
        // 最後に読んだオファー画面の文字を保存（メイン画面の「共有」ボタンで送れる）
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LAST_OFFER, text).apply()

        // 「506円 / 1.5km」を読む
        val m = Regex("""([0-9][0-9,]*)\s*円\s*[/／]?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:km|KM|Km|ｋｍ)""").find(flat)
        if (m == null) {
            if (offerKey != null) return // 前の表示を保つ
            tv.setBackgroundColor(Color.argb(220, 90, 90, 90))
            tv.text = "オファー検出：金額・距離が読めません"
            return
        }
        val yen = m.groupValues[1].replace(",", "").toIntOrNull() ?: 0
        val km = m.groupValues[2].toDoubleOrNull() ?: 0.0
        val key = "$yen/$km"
        if (key != offerKey) {
            offerKey = key
            deliveryAt = null
        }
        if (deliveryAt == null) deliveryAt = deliveryTime(result)
        val minutes = deliveryAt?.let { minutesUntil(it) }?.takeIf { it in 1..180 }
        val perHour = minutes?.let { yen * 60 / it }

        val (label, color) = when {
            perHour == null -> "⚪ 時間不明" to Color.argb(220, 90, 90, 90)
            perHour >= GOOD_PER_HOUR -> "🟢 受ける" to Color.argb(230, 20, 140, 60)
            perHour >= OK_PER_HOUR -> "🟡 微妙" to Color.argb(230, 190, 140, 0)
            else -> "🔴 見送り" to Color.argb(230, 190, 30, 30)
        }
        val storeAddr = findStoreAddress(result)
        val town = storeAddr?.substringAfter("市", "")?.take(5).orEmpty()

        tv.setBackgroundColor(color)
        tv.text = buildString {
            append(label)
            if (perHour != null) append(" 時給${perHour}円")
            if (town.isNotEmpty()) append(" (受取:").append(town).append(')')
            append('\n')
            append("${yen}円/${km}km")
            if (minutes != null) append(" ${minutes}分")
            append(" | ").append(deadhead(storeAddr, yen, km))
        }
    }

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun startLocation() {
        if (!hasLocationPermission()) return
        val lm = getSystemService(LocationManager::class.java)
        for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (!lm.isProviderEnabled(p)) continue
                lm.getLastKnownLocation(p)?.let { last ->
                    val cur = here
                    if (cur == null || last.time > cur.time) here = last
                }
                lm.requestLocationUpdates(p, 5000L, 10f, locListener, Looper.getMainLooper())
            } catch (e: SecurityException) {
            } catch (e: IllegalArgumentException) {
            }
        }
    }

    // お店の住所：都道府県から書かれている方（お届け先は市から始まる）。なければ「受取」に近い方
    private val addressRe = Regex("""\S{1,5}[市区郡]\S*[0-9０-９]""")
    private val prefRe = Regex("""[都道府県]\S*[市区郡]""")

    private fun findStoreAddress(result: Text): String? {
        val lines = result.textBlocks.flatMap { it.lines }
            .map { (it.text.replace(" ", "").replace("　", "")) to (it.boundingBox?.centerY() ?: 0) }
        val addrs = lines.filter { addressRe.containsMatchIn(it.first) }
        if (addrs.isEmpty()) return null
        addrs.firstOrNull { prefRe.containsMatchIn(it.first) }?.let { return it.first }
        val pickup = lines.firstOrNull { it.first.contains("受取") }
            ?: return addrs.minByOrNull { it.second }?.first
        return addrs.minByOrNull { abs(it.second - pickup.second) }?.first
    }

    private fun geocode(addr: String): Location? {
        if (geoCache.containsKey(addr)) return geoCache[addr]
        if (geoPending.add(addr)) {
            geoThread.execute {
                try {
                    @Suppress("DEPRECATION")
                    val a = Geocoder(this, Locale.JAPAN).getFromLocationName(addr, 1)?.firstOrNull()
                    val loc = a?.let { Location("geo").apply { latitude = it.latitude; longitude = it.longitude } }
                    main.post { geoCache[addr] = loc; geoPending.remove(addr) }
                } catch (e: Exception) {
                    main.post { geoPending.remove(addr) } // 通信エラーなどは次回やり直す
                }
            }
        }
        return null
    }

    private fun deadhead(addr: String?, yen: Int, km: Double): String {
        if (addr == null) return "回送:住所読めず"
        val cur = here ?: return "回送:現在地不明"
        if (!Geocoder.isPresent()) return "回送:住所検索非対応"
        val store = geocode(addr) ?: return if (geoPending.contains(addr)) "回送:計算中" else "回送:住所不明"
        val dead = cur.distanceTo(store) / 1000.0 * ROAD_FACTOR
        val total = dead + km
        val perTotal = if (total > 0) (yen / total).toInt() else 0
        return String.format(Locale.JAPAN, "回送%.1fkm 計%.1fkm %d円/km", dead, total, perTotal)
    }

    private val timeRe = Regex("""(?<![0-9])([0-2]?[0-9]):([0-5][0-9])""")

    private fun nowMinute(): Int {
        val cal = Calendar.getInstance()
        return cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
    }

    private fun minutesUntil(t: Int) = ((t - nowMinute()) % 1440 + 1440) % 1440

    // 地図上の「お届け」の近くにある時刻 = お届け予定（0時からの分）。
    // 見つからなければ、2時間以内で一番遅い時刻を使う
    private fun deliveryTime(result: Text): Int? {
        val lines = result.textBlocks.flatMap { it.lines }
        val allTimes = lines.flatMap { line ->
            val box = line.boundingBox
            timeRe.findAll(line.text).mapNotNull { mm ->
                val h = mm.groupValues[1].toInt()
                val mi = mm.groupValues[2].toInt()
                if (h > 23) null else Triple(h * 60 + mi, box?.centerX() ?: 0, box?.centerY() ?: 0)
            }.toList()
        }
        val times = allTimes.filter { minutesUntil(it.first) in 1..120 } // ステータスバーの時計などは除外
        fun nearest(list: List<Triple<Int, Int, Int>>, box: android.graphics.Rect) = list.minByOrNull {
            val dx = (it.second - box.centerX()).toDouble()
            val dy = (it.third - box.centerY()).toDouble()
            dx * dx + dy * dy
        }
        // 「受取」の時刻より後のものだけをお届け候補にする（受取時刻を誤って使わないように）
        val pickup = lines.firstOrNull { it.text.contains("受取") }?.boundingBox?.let { nearest(allTimes, it) }
        val cands = if (pickup == null) times
            else times.filter { minutesUntil(it.first) > minutesUntil(pickup.first) }
        if (cands.isEmpty()) return null
        val label = lines.firstOrNull { it.text.contains("お届け") }?.boundingBox
        if (label != null) return nearest(cands, label)?.first
        return cands.maxByOrNull { minutesUntil(it.first) }?.first
    }

    override fun onDestroy() {
        main.removeCallbacks(loop)
        getSystemService(LocationManager::class.java).removeUpdates(locListener)
        geoThread.shutdown()
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
