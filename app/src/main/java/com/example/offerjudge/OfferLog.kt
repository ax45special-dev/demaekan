package com.example.offerjudge

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** 1件のオファー */
class OfferRecord(val time: Long, val yen: Int, val km: Double) {
    var minutes: Int? = null
    var perHour: Int? = null
    var realPerHour: Int? = null
    var deadKm: Double? = null
    var returnKm: Double? = null
    var storeName = ""
    var storeAddr = ""
    var destAddr = ""
    var label = ""
    var accepted = false
    var frames = 0
}

/** オファーの記録（アプリ内の offers.csv に1行ずつ追記）と集計 */
object OfferLog {
    private const val FILE = "offers.csv"
    private const val HEADER =
        "日時,金額,距離km,所要分,時給,実質時給,回送km,戻りkm,店名,受取住所,お届け住所,判定,受けた"

    private fun file(ctx: Context) = File(ctx.filesDir, FILE)
    private fun clean(s: String) = s.replace(",", "、").replace("\n", " ")
    private fun num(d: Double?) = d?.let { String.format(Locale.JAPAN, "%.1f", it) } ?: ""

    fun append(ctx: Context, r: OfferRecord) {
        val f = file(ctx)
        if (!f.exists()) f.writeText(HEADER + "\n")
        val cols = listOf(
            SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.JAPAN).format(Date(r.time)),
            r.yen.toString(), num(r.km),
            r.minutes?.toString() ?: "", r.perHour?.toString() ?: "", r.realPerHour?.toString() ?: "",
            num(r.deadKm), num(r.returnKm),
            clean(r.storeName), clean(r.storeAddr), clean(r.destAddr), clean(r.label),
            if (r.accepted) "1" else "0"
        )
        f.appendText(cols.joinToString(",") + "\n")
    }

    fun csv(ctx: Context): String? = file(ctx).takeIf { it.exists() }?.readText()

    private class Row(
        val date: String, val minuteOfDay: Int, val yen: Int, val minutes: Int?,
        val realPerHour: Int?, val store: String, val label: String, val accepted: Boolean
    )

    private fun rows(ctx: Context): List<Row> {
        val f = file(ctx)
        if (!f.exists()) return emptyList()
        return f.readLines().drop(1).mapNotNull { line ->
            val c = line.split(",")
            if (c.size < 13 || c[0].length < 16) return@mapNotNull null
            val h = c[0].substring(11, 13).toIntOrNull() ?: return@mapNotNull null
            val mi = c[0].substring(14, 16).toIntOrNull() ?: 0
            Row(
                date = c[0].substring(0, 10),
                minuteOfDay = h * 60 + mi,
                yen = c[1].toIntOrNull() ?: 0,
                minutes = c[3].toIntOrNull(),
                realPerHour = c[5].toIntOrNull() ?: c[4].toIntOrNull(),
                store = c[8].ifEmpty { c[9] },
                label = c[11],
                accepted = c[12] == "1"
            )
        }
    }

    fun summary(ctx: Context, s: JudgeSettings): String {
        val all = rows(ctx)
        if (all.isEmpty()) return "まだ記録がありません。読み取り中に来たオファーが自動で記録されます。"
        val sb = StringBuilder()

        // 今日
        val today = JudgeSettings.today()
        val t = all.filter { it.date == today }
        val acc = t.filter { it.accepted }
        val total = acc.sumOf { it.yen }
        sb.append("【今日】オファー${t.size}件 / 受けた${acc.size}件 / 合計${total}円\n")
        val start = s.workStart?.let { JudgeSettings.minuteOf(it) } ?: t.minOfOrNull { it.minuteOfDay }
        val end = (acc.map { it.minuteOfDay + (it.minutes ?: 0) } + t.map { it.minuteOfDay }).maxOrNull()
        if (start != null && end != null && end > start) {
            sb.append("稼働 ${JudgeSettings.hm(start)}〜${JudgeSettings.hm(end)}")
            sb.append(" → 実績時給 ${total * 60 / (end - start)}円\n")
        }

        // 時間帯別（直近14日）
        val cutoff = SimpleDateFormat("yyyy-MM-dd", Locale.JAPAN)
            .format(Calendar.getInstance().apply { add(Calendar.DAY_OF_MONTH, -13) }.time)
        val recent = all.filter { it.date >= cutoff }
        val days = recent.map { it.date }.distinct().size.coerceAtLeast(1)
        sb.append("\n【時間帯別（直近14日・${days}日分）】\n")
        recent.groupBy { it.minuteOfDay / 60 }.toSortedMap().forEach { (h, rs) ->
            val rates = rs.mapNotNull { it.realPerHour }
            val avg = if (rates.isEmpty()) "-" else "${rates.sum() / rates.size}円"
            val greens = rs.count { it.label.startsWith("🟢") } * 100 / rs.size
            sb.append(String.format(Locale.JAPAN, "%d時台: 1日%.1f件 平均実質時給%s 🟢%d%%\n",
                h, rs.size.toDouble() / days, avg, greens))
        }

        // よく来るお店（全期間）
        val stores = all.filter { it.store.isNotEmpty() }.groupBy { it.store }
            .entries.sortedByDescending { it.value.size }.take(8)
        if (stores.isNotEmpty()) {
            sb.append("\n【よく来るお店】\n")
            stores.forEach { (name, rs) ->
                val rates = rs.mapNotNull { it.realPerHour }
                val avg = if (rates.isEmpty()) "-" else "${rates.sum() / rates.size}円"
                sb.append("${name.take(14)}: ${rs.size}件 平均${rs.sumOf { it.yen } / rs.size}円 実質時給$avg\n")
            }
        }
        return sb.toString().trimEnd()
    }
}
