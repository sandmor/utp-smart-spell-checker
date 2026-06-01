from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.label import Label
from kivy.uix.button import Button
from kivy.clock import Clock
from kivy.utils import platform
import threading
import webbrowser

# Import our Flask app and config
import backend.config as config
from backend.server import app as flask_app

class MainLayout(BoxLayout):
    def __init__(self, **kwargs):
        super().__init__(orientation="vertical", padding=20, spacing=15, **kwargs)
        
        self.header = Label(
            text="Corrector Inteligente",
            font_size="28sp",
            size_hint=(1, 0.2),
            bold=True
        )
        self.add_widget(self.header)
        
        self.status = Label(
            text="Cargando el editor de texto...",
            font_size="16sp",
            size_hint=(1, 0.4),
            halign="center"
        )
        self.add_widget(self.status)

        self.btn = Button(
            text="Abrir Editor manualmente",
            size_hint=(1, 0.4),
            font_size="20sp",
            background_color=(0.1, 0.5, 0.8, 1)
        )
        self.btn.bind(on_press=self.open_webview)
        self.add_widget(self.btn)
        
        # Start server in background thread
        self.server_thread = threading.Thread(target=self.run_flask)
        self.server_thread.daemon = True
        self.server_thread.start()
        
        # Open the UI automatically after a short delay
        Clock.schedule_once(lambda dt: self.open_webview(None), 1.5)
        
    def run_flask(self):
        # We run it without reloader to prevent creating multiple threads/processes
        flask_app.run(host='127.0.0.1', port=5000, debug=config.DEBUG_NOTIFICATIONS, use_reloader=False)

    def open_webview(self, instance):
        url = "http://127.0.0.1:5000/"
        if platform == 'android':
            try:
                from jnius import autoclass
                from android.runnable import run_on_ui_thread
                
                WebView = autoclass('android.webkit.WebView')
                WebViewClient = autoclass('android.webkit.WebViewClient')
                FileAwarePythonActivity = autoclass(
                    'com.sandmor.utp_smartspellchecker.FileAwarePythonActivity'
                )
                activity = autoclass('org.kivy.android.PythonActivity').mActivity
                
                @run_on_ui_thread
                def create_webview():
                    webview = WebView(activity)
                    settings = webview.getSettings()
                    settings.setJavaScriptEnabled(True)
                    settings.setDomStorageEnabled(True)
                    # Disable the WebView's built-in text correction
                    settings.setSaveFormData(False)
                    # This prevents the WebView from opening an external browser
                    webview.setWebViewClient(WebViewClient())
                    FileAwarePythonActivity.setDebugEnabled(config.DEBUG_NOTIFICATIONS)
                    FileAwarePythonActivity.attachWebView(webview)
                    webview.loadUrl(url)
                    # Replace the entire Kivy UI with the WebView
                    activity.setContentView(webview)
                    
                create_webview()
            except Exception as e:
                print(f"Failed to load Android WebView: {e}")
                self.status.text = "Error cargando WebView interno."
        else:
            # On Desktop, we still open the default browser
            webbrowser.open(url)

class CorrectorApp(App):
    def build(self):
        return MainLayout()

if __name__ == "__main__":
    CorrectorApp().run()
