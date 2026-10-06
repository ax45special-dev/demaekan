package com.example.offerjudge

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 判定基準・終了時刻・待機場所などの設定（メイン画面で変更できる） */
class JudgeSettings(context: Context) {
    private val p = context.getSharedPreferences(CaptureService.PREFS, Context.MODE_PRIVATE)

    // 判定基準（実質時給。これ以上なら🟢 / これ以上なら🟡 / 未満は🔴）
    var goodNormal: Int
        get() = p.getInt("good_normal", 1300)
        set(v) { p.edit().putInt("good_normal", v).apply() }
    var okNormal: Int
        get() = p.getInt("ok_normal", 1000)
        set(v) { p.edit().putInt("ok_normal", v).apply() }
    var goodPeak: Int
        get() = p.getInt("good_peak", 1600)
        set(v) { p.edit().putInt("good_peak", v).apply() }
    var okPeak: Int
        get() = p.getInt("ok_peak", 1200)
        set(v) { p.edit().putInt("ok_peak", v).apply() }

    // ピーク時間帯（0時からの分）
    var peakStart: Int
        get() = p.getInt("peak_start", 11 * 60 + 30)
        set(v) { p.edit().putInt("peak_start", v).apply() }
    var peakEnd: Int
        get() = p.getInt("peak_end", 12 * 60 + 30)
        set(v) { p.edit().putInt("peak_end", v).apply() }

    // 戻りの時間を出すための移動速度
    var speedKmh: Int
        get() = p.getInt("speed_kmh", 15)
        set(v) { p.edit().putInt("speed_kmh", v).apply() }

    /** 今日の終了時刻（0時からの分）。前の日に設定したものは無効 */
    var endMinute: Int?
        get() = if (p.getString("end_date", null) == today()) p.getInt("end_min", -1).takeIf { it >= 0 } else null
        set(v) { p.edit().putString("end_date", today()).putInt("end_min", v ?: -1).apply() }

    /** 待機場所（緯度, 経度） */
    var base: Pair<Double, Double>?
        get() {
            val lat = p.getString("base_lat", null)?.toDoubleOrNull() ?: return null
            val lng = p.getString("base_lng", null)?.toDoubleOrNull() ?: return null
            return lat to lng
        }
        set(v) {
            p.edit().putString("base_lat", v?.first?.toString()).putString("base_lng", v?.second?.toString()).apply()
        }

    /** その日最初に読み取りを開始した時刻を覚える */
    fun markWorkStart() {
        if (p.getString("start_date", null) != today()) {
            p.edit().putString("start_date", today()).putLong("start_time", System.currentTimeMillis()).apply()
        }
    }

    val workStart: Long?
        get() = if (p.getString("start_date", null) == today()) p.getLong("start_time", 0) else null

    fun isPeak(minuteOfDay: Int) = minuteOfDay in peakStart until peakEnd

    /** (🟢の基準, 🟡の基準) */
    fun thresholds(minuteOfDay: Int): Pair<Int, Int> =
        if (isPeak(minuteOfDay)) goodPeak to okPeak else goodNormal to okNormal

    companion object {
        fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.JAPAN).format(Date())

        fun nowMinute(): Int {
            val c = Calendar.getInstance()
            return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        }

        fun minuteOf(millis: Long): Int {
            val c = Calendar.getInstance().apply { timeInMillis = millis }
            return c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        }

        fun hm(min: Int) = String.format(Locale.JAPAN, "%d:%02d", (min / 60) % 24, min % 60)

        fun parseHm(s: String): Int? {
            val m = Regex("""^\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*$""").find(s) ?: return null
            val h = m.groupValues[1].toInt()
            val mi = m.groupValues[2].toInt()
            return if (h < 24 && mi < 60) h * 60 + mi else null
        }
    }
}
