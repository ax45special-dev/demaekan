package com.example.offerjudge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private val reqCapture = 100

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 120, 48, 48)
        }

        layout.addView(TextView(this).apply {
            text = "試作版：画面の文字が読めるかテストします。\n" +
                "①で許可 → ②で開始（「画面全体」を選択）→ 出前館を開いてください。"
            textSize = 16f
        })

        fun addButton(label: String, onClick: () -> Unit) {
            layout.addView(Button(this@MainActivity).apply {
                text = label
                setOnClickListener { onClick() }
            })
        }

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
        }

        addButton("最後のオファーの読み取り文字を共有") {
            val text = getSharedPreferences(CaptureService.PREFS, MODE_PRIVATE)
                .getString(CaptureService.KEY_LAST_OFFER, null)
            if (text == null) {
                Toast.makeText(this, "まだオファーを読み取っていません", Toast.LENGTH_SHORT).show()
            } else {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
                startActivity(Intent.createChooser(send, "読み取り文字を共有"))
            }
        }

        val perms = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(perms.toTypedArray(), 1)

        setContentView(layout)
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
