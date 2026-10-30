package com.example.offerjudge

import android.Manifest
import android.app.Activity
import android.app.TimePickerDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private val reqCapture = 100
    private lateinit var settings: JudgeSettings
    private lateinit var endButton: Button
    private lateinit var baseText: TextView
    private lateinit var summaryText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = JudgeSettings(this)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 120, 48, 48)
        }

        fun addText(s: String, size: Float = 15f): TextView =
            TextView(this).apply { text = s; textSize = size }.also { layout.addView(it) }

        fun addHeader(s: String) = addText("\n$s", 18f)

        fun addButton(label: String, onClick: () -> Unit): Button =
            Button(this).apply {
                text = label
                setOnClickListener { onClick() }
            }.also { layout.addView(it) }

        fun addField(label: String, value: String, number: Boolean = true): EditText {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(TextView(this).apply { text = label; textSize = 15f })
            val e = EditText(this).apply {
                setText(value)
                inputType = if (number) InputType.TYPE_CLASS_NUMBER else InputType.TYPE_CLASS_TEXT
                minEms = 4
            }
            row.addView(e)
            layout.addView(row)
            return e
        }

        addText(
            "①で許可 → ②で開始（「画面全体」を選択）→ 出前館を開いてください。\n" +
                "オファーを受けたら、画面上の判定表示をタップすると「受けた」と記録されます" +
                "（オファーが消えてから1分以内もOK）。"
        )

        addButton("① 他のアプリの上に表示を許可") {
            startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            )
        }

        addButton("② 読み取り開始") {
            if (!Settings.canDrawOverlays(this)) {
                Toast.makeText(this, "先に①を許可してください", Toast.LENGTH_SHORT).show()
            } else {
                val mpm = getSystemService(MediaProjectionManager::class.java)
                @Suppress("DEPRECATION")
                startActivityForResult(mpm.createScreenCaptureIntent(), reqCapture)
            }
        }

        addButton("停止") {
            stopService(Intent(this, CaptureService::class.java))
            refreshSummary()
        }

        // ===== 今日の終了時刻 =====
        addHeader("今日の終了時刻")
        addText("お届けがこの時刻を過ぎるオファーに⚠を出します。日付が変わると未設定に戻ります。", 13f)
        endButton = addButton("") {
            val cur = settings.endMinute ?: (12 * 60 + 50)
            TimePickerDialog(this, { _, h, m ->
                settings.endMinute = h * 60 + m
                refreshEnd()
            }, cur / 60, cur % 60, true).show()
        }
        addButton("終了時刻を解除") {
            settings.endMinute = null
            refreshEnd()
        }

        // ===== 判定基準 =====
        addHeader("判定基準（実質時給）")
        addText("実質時給 = 金額 ÷（お届けまでの時間 ＋ 待機場所までの戻り時間）", 13f)
        val goodN = addField("通常 🟢 ", settings.goodNormal.toString())
        val okN = addField("通常 🟡 ", settings.okNormal.toString())
        val peakS = addField("ピーク開始 ", JudgeSettings.hm(settings.peakStart), number = false)
        val peakE = addField("ピーク終了 ", JudgeSettings.hm(settings.peakEnd), number = false)
        val goodP = addField("ピーク 🟢 ", settings.goodPeak.toString())
        val okP = addField("ピーク 🟡 ", settings.okPeak.toString())
        val speed = addField("移動速度 km/h ", settings.speedKmh.toString())
        addButton("基準を保存") {
            val ps = JudgeSettings.parseHm(peakS.text.toString())
            val pe = JudgeSettings.parseHm(peakE.text.toString())
            val nums = listOf(goodN, okN, goodP, okP, speed).map { it.text.toString().toIntOrNull() }
            if (ps == null || pe == null || nums.any { it == null || it <= 0 }) {
                Toast.makeText(this, "入力を確認してください（時刻は 11:30 の形）", Toast.LENGTH_SHORT).show()
            } else {
                settings.goodNormal = nums[0]!!
                settings.okNormal = nums[1]!!
                settings.goodPeak = nums[2]!!
                settings.okPeak = nums[3]!!
                settings.speedKmh = nums[4]!!
                settings.peakStart = ps
                settings.peakEnd = pe
                Toast.makeText(this, "保存しました", Toast.LENGTH_SHORT).show()
            }
        }

        // ===== 待機場所 =====
        addHeader("待機場所")
        addText("配達後にここへ戻る前提で、戻りの距離を計算に入れます。", 13f)
        baseText = addText("")
        addButton("今いる場所を待機場所にする") {
            val loc = lastLocation()
            if (loc == null) {
                Toast.makeText(this, "現在地が取れません（位置情報の許可・GPSを確認）", Toast.LENGTH_SHORT).show()
            } else {
                settings.base = loc.latitude to loc.longitude
                refreshBase()
            }
        }
        addButton("待機場所を解除") {
            settings.base = null
            refreshBase()
        }

        // ===== 記録 =====
        addHeader("記録")
        summaryText = addText("", 14f)
        addButton("記録を更新") { refreshSummary() }
        addButton("記録を共有（CSV）") {
            val csv = OfferLog.csv(this)
            if (csv == null) {
                Toast.makeText(this, "まだ記録がありません", Toast.LENGTH_SHORT).show()
            } else {
                share(csv, "記録を共有")
            }
        }
        addButton("最後のオファーの読み取り文字を共有") {
            val text = getSharedPreferences(CaptureService.PREFS, MODE_PRIVATE)
                .getString(CaptureService.KEY_LAST_OFFER, null)
            if (text == null) {
                Toast.makeText(this, "まだオファーを読み取っていません", Toast.LENGTH_SHORT).show()
            } else {
                share(text, "読み取り文字を共有")
            }
        }

        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(perms.toTypedArray(), 1)

        setContentView(ScrollView(this).apply { addView(layout) })
    }

    override fun onResume() {
        super.onResume()
        refreshEnd()
        refreshBase()
        refreshSummary()
    }

    private fun refreshEnd() {
        val end = settings.endMinute
        endButton.text = if (end == null) "終了時刻：未設定（タップで設定）" else "終了時刻：${JudgeSettings.hm(end)}（タップで変更）"
    }

    private fun refreshBase() {
        val b = settings.base
        baseText.text = if (b == null) "未設定" else String.format("設定済み（%.4f, %.4f）", b.first, b.second)
    }

    private fun refreshSummary() {
        summaryText.text = OfferLog.summary(this, settings)
    }

    private fun share(text: String, title: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        startActivity(Intent.createChooser(send, title))
    }

    private fun lastLocation(): Location? {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) return null
        val lm = getSystemService(LocationManager::class.java)
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).mapNotNull {
            try {
                lm.getLastKnownLocation(it)
            } catch (e: Exception) {
                null
            }
        }.maxByOrNull { it.time }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == reqCapture && resultCode == RESULT_OK && data != null) {
            val intent = Intent(this, CaptureService::class.java)
                .putExtra(CaptureService.EXTRA_CODE, resultCode)
                .putExtra(CaptureService.EXTRA_DATA, data)
            startForegroundService(intent)
            moveTaskToBack(true)
        }
    }
}
