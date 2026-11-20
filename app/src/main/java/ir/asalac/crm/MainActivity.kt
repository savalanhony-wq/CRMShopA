package ir.asalac.crm

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.text.InputType
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import java.io.File

/**
 * Asalac CRM - thin Android shell around the CRM that runs on the shop computer (run.bat, LAN=1).
 * It only shows the CRM web page, so every feature and all data stay on the computer.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var bar: ProgressBar
    private var fileCb: ValueCallback<Array<Uri>>? = null
    private val reqFile = 11

    private val prefs by lazy { getSharedPreferences("asalac", MODE_PRIVATE) }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_LONG).show()
    private fun baseUrl(): String = prefs.getString("url", "") ?: ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(-1, -1))

        bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal)
        bar.max = 100
        bar.visibility = View.GONE
        root.addView(bar, FrameLayout.LayoutParams(-1, dp(3)))

        val gear = TextView(this)
        gear.text = "\u2699"
        gear.textSize = 18f
        gear.setTextColor(Color.WHITE)
        gear.gravity = Gravity.CENTER
        gear.alpha = 0.6f
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(0x99000000.toInt())
        gear.background = bg
        val lp = FrameLayout.LayoutParams(dp(36), dp(36), Gravity.BOTTOM or Gravity.START)
        lp.setMargins(dp(10), 0, 0, dp(10))
        root.addView(gear, lp)
        gear.setOnClickListener { showMenu() }

        setContentView(root)

        if (Build.VERSION.SDK_INT in 23..28) {
            requestPermissions(arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
        }

        setupWebView()
        loadStart()
    }

    private fun mode(): String = prefs.getString("mode", "local") ?: "local"
    private val localUrl = "file:///android_asset/index.html"

    /** standalone = the CRM is inside the APK and keeps its data on this phone; pc = optional connection to run.bat on the shop computer */
    @Suppress("DEPRECATION")
    private fun loadStart() {
        if (mode() == "pc" && baseUrl().isEmpty()) { askUrl(true); return }
        web.settings.allowUniversalAccessFromFileURLs = (mode() == "local")
        web.loadUrl(if (mode() == "pc") baseUrl() else localUrl)
    }

    private fun setMode(m: String) {
        prefs.edit().putString("mode", m).apply()
        loadStart()
    }

    private fun setupWebView() {
        val s: WebSettings = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.setSupportZoom(false)
        s.userAgentString = s.userAgentString + " AsalacApp/1.0"
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "Android")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                val u = r.url
                val base = Uri.parse(baseUrl())
                val sch = u.scheme ?: ""
                if (sch == "blob" || sch == "about" || sch == "data" || sch == "file") return false
                if ((sch == "http" || sch == "https") && u.host == base.host && u.port == base.port) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, u))
                } catch (e: ActivityNotFoundException) {
                    toast("\u0628\u0631\u0646\u0627\u0645\u0647\u0654 \u0645\u0646\u0627\u0633\u0628 \u0628\u0631\u0627\u06cc \u0628\u0627\u0632 \u06a9\u0631\u062f\u0646 \u067e\u06cc\u062f\u0627 \u0646\u0634\u062f")
                }
                return true
            }

            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                if (r.isForMainFrame) showError()
            }

            override fun onPageFinished(v: WebView, url: String?) {
                // the CRM prints invoices with window.print(); route it to Android's print / save-as-PDF dialog
                v.evaluateJavascript("window.print=function(){Android.print()};", null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(v: WebView, p: Int) {
                bar.progress = p
                bar.visibility = if (p in 1..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                v: WebView,
                cb: ValueCallback<Array<Uri>>,
                p: WebChromeClient.FileChooserParams
            ): Boolean {
                fileCb?.onReceiveValue(null)
                fileCb = cb
                return try {
                    startActivityForResult(p.createIntent(), reqFile)
                    true
                } catch (e: Exception) {
                    fileCb = null
                    false
                }
            }
        }

        web.setDownloadListener(DownloadListener { url, ua, cd, mime, _ ->
            if (url.startsWith("blob:")) {
                fetchBlob(url, mime)
            } else {
                try {
                    val req = DownloadManager.Request(Uri.parse(url))
                    req.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    req.addRequestHeader("User-Agent", ua)
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    req.setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, cd, mime)
                    )
                    (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                    toast("\u062f\u0627\u0646\u0644\u0648\u062f \u0634\u0631\u0648\u0639 \u0634\u062f (\u067e\u0648\u0634\u0647\u0654 Downloads)")
                } catch (e: Exception) {
                    toast("\u062f\u0627\u0646\u0644\u0648\u062f \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f")
                }
            }
        })
    }

    /** Blob downloads (Excel / PDF exports made in the page) cannot go through DownloadManager: read them in JS and hand them to Android. */
    private fun fetchBlob(url: String, mime: String?) {
        val m = if (mime.isNullOrEmpty()) "application/octet-stream" else mime
        val ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(m) ?: "bin"
        val name = "asalac-" + System.currentTimeMillis() + "." + ext
        val js = "(function(){var x=new XMLHttpRequest();x.open('GET','" + url + "',true);" +
            "x.responseType='blob';x.onload=function(){var r=new FileReader();" +
            "r.onloadend=function(){Android.saveBase64('" + name + "','" + m + "',r.result.split(',')[1])};" +
            "r.readAsDataURL(x.response)};x.send()})()"
        web.evaluateJavascript(js, null)
    }

    private fun showError() {
        val html = "<html dir='rtl'><body style='font-family:sans-serif;background:#1a1033;color:#fff;padding:24px;text-align:center'>" +
            "<h2>اتصال به کامپیوتر برقرار نشد</h2>" +
            "<p>کامپیوتر روشن و <b>run.bat</b> اجرا شده باشد، گوشی به همان وای‌فای وصل باشد و آدرس درست باشد.</p>" +
            "<p><button style='font-size:18px;padding:10px 20px' onclick='Android.retry()'>تلاش دوباره</button></p>" +
            "<p><button style='font-size:18px;padding:10px 20px' onclick='Android.settings()'>تغییر آدرس کامپیوتر</button></p>" +
            "<p><button style='font-size:18px;padding:10px 20px;background:#ffc83d' onclick='Android.local()'>کار در حالت مستقل (بدون کامپیوتر)</button></p></body></html>"
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun askUrl(first: Boolean) {
        val et = EditText(this)
        et.hint = "http://192.168.1.10:3000"
        et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        et.textDirection = View.TEXT_DIRECTION_LTR
        et.setText(baseUrl())
        val b = AlertDialog.Builder(this)
            .setTitle("اتصال به کامپیوتر")
            .setMessage("فقط وقتی لازم است: کامپیوتر روشن، run.bat اجرا و گوشی در همان وای‌فای باشد. آدرس را مثل http://192.168.1.10:3000 بنویسید. اطلاعات این حالت روی کامپیوتر می‌ماند و جدا از اطلاعات حالت مستقل گوشی است.")
            .setView(et)
            .setPositiveButton("اتصال") { _, _ ->
                var u = et.text.toString().trim()
                if (u.isNotEmpty()) {
                    if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://$u"
                    prefs.edit().putString("url", u).apply()
                    setMode("pc")
                } else if (first) {
                    setMode("local")
                }
            }
            .setNegativeButton(if (first) "حالت مستقل" else "انصراف") { _, _ -> if (first) setMode("local") }
        b.setOnCancelListener { if (first) setMode("local") }
        b.show()
    }

    private fun showMenu() {
        val pc = mode() == "pc"
        val items = if (pc) arrayOf("بازگشت به حالت مستقل (روی همین گوشی)", "تغییر آدرس کامپیوتر", "بارگذاری مجدد")
        else arrayOf("اتصال به کامپیوتر (هم‌شبکه با run.bat)…", "بارگذاری مجدد")
        AlertDialog.Builder(this)
            .setTitle(if (pc) "حالت: متصل به کامپیوتر" else "حالت: مستقل (روی همین گوشی)")
            .setItems(items) { _, i ->
                if (pc) {
                    when (i) {
                        0 -> setMode("local")
                        1 -> askUrl(false)
                        else -> loadStart()
                    }
                } else {
                    when (i) {
                        0 -> askUrl(false)
                        else -> loadStart()
                    }
                }
            }.show()
    }

    inner class Bridge {
        @JavascriptInterface
        fun saveBase64(name: String, mime: String, b64: String) {
            try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                var uri: Uri? = null
                if (Build.VERSION.SDK_INT >= 29) {
                    val cv = ContentValues()
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name)
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime)
                    cv.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv)
                    uri?.let { u -> contentResolver.openOutputStream(u)?.use { o -> o.write(bytes) } }
                } else {
                    val f = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name)
                    f.parentFile?.mkdirs()
                    f.writeBytes(bytes)
                }
                runOnUiThread {
                    toast("\u0641\u0627\u06cc\u0644 \u062f\u0631 \u067e\u0648\u0634\u0647\u0654 Downloads \u0630\u062e\u06cc\u0631\u0647 \u0634\u062f: $name")
                    val u = uri
                    if (u != null) {
                        try {
                            val i = Intent(Intent.ACTION_VIEW)
                            i.setDataAndType(u, mime)
                            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(i)
                        } catch (e: Exception) { /* no viewer installed: file is still in Downloads */ }
                    }
                }
            } catch (e: Exception) {
                runOnUiThread { toast("\u0630\u062e\u06cc\u0631\u0647\u0654 \u0641\u0627\u06cc\u0644 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f") }
            }
        }

        @JavascriptInterface
        fun print() {
            runOnUiThread {
                val pm = getSystemService(PRINT_SERVICE) as PrintManager
                pm.print("Asalac", web.createPrintDocumentAdapter("Asalac"), PrintAttributes.Builder().build())
            }
        }

        @JavascriptInterface
        fun retry() {
            runOnUiThread { loadStart() }
        }

        @JavascriptInterface
        fun local() {
            runOnUiThread { setMode("local") }
        }

        @JavascriptInterface
        fun settings() {
            runOnUiThread { askUrl(false) }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == reqFile) {
            fileCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCb = null
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }
}
