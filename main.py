from kivy.app import App
from kivy.uix.boxlayout import BoxLayout
from kivy.uix.label import Label
from kivy.uix.textinput import TextInput
from kivy.core.window import Window
from kivy.clock import Clock, mainthread
import threading

# Import our custom spellchecker
from spellchecker import correct_text

Window.softinput_mode = 'below_target'

class MainLayout(BoxLayout):
    def __init__(self, **kwargs):
        super().__init__(orientation="vertical", padding=20, spacing=15, **kwargs)

        self.header = Label(
            text="Corrector en Tiempo Real",
            font_size="28sp",
            size_hint=(1, 0.1),
            bold=True
        )
        self.add_widget(self.header)

        self.input_text = TextInput(
            hint_text="Escribe aquí... (se corregirá automáticamente)",
            font_size="18sp",
            size_hint=(1, 0.45),
            multiline=True
        )
        # Bind the text property to trigger our debounce method on every keystroke
        self.input_text.bind(text=self.on_text_change)
        self.add_widget(self.input_text)

        self.output_text = TextInput(
            hint_text="El texto corregido aparecerá aquí...",
            font_size="18sp",
            size_hint=(1, 0.45),
            multiline=True,
            readonly=True,
            background_color=(0.95, 0.95, 0.95, 1)
        )
        self.add_widget(self.output_text)

        self.spellcheck_event = None

    def on_text_change(self, instance, value):
        """Called every time the user types a character."""
        if self.spellcheck_event:
            self.spellcheck_event.cancel()

        # If the box is empty, clear the output immediately
        if not value.strip():
            self.output_text.text = ""
            return

        self.output_text.text = "Escribiendo..."

        # Schedule a new timer for 0.5 seconds (500ms) from now
        self.spellcheck_event = Clock.schedule_once(lambda dt: self.start_async_check(value), 0.5)

    def start_async_check(self, text_to_check):
        """Starts the background thread so the UI doesn't freeze."""
        self.output_text.text = "Revisando..."
        
        thread = threading.Thread(target=self.process_spellcheck, args=(text_to_check,))
        thread.daemon = True # Ensures thread dies if the app closes
        thread.start()

    def process_spellcheck(self, text_to_check):
        """Runs in the background thread."""
        corrected = correct_text(text_to_check)
        self.update_ui(corrected)

    @mainthread
    def update_ui(self, corrected_text):
        """
        Safely push data back to the main UI thread. 
        Kivy crashes if background threads try to update UI widgets directly!
        """
        self.output_text.text = corrected_text


class CorrectorApp(App):
    def build(self):
        return MainLayout()

if __name__ == "__main__":
    CorrectorApp().run()
