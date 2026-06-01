import backend.config as config
from flask import Flask, request, jsonify, send_from_directory
from backend.spellchecker import check_text, CHUNK_SIZE
import os

# Point to the frontend/dist folder
dist_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist'))

app = Flask(__name__, static_folder=dist_dir, static_url_path='/')

@app.route('/')
def index():
    if os.path.exists(os.path.join(dist_dir, 'index.html')):
        return send_from_directory(dist_dir, 'index.html')
    return "Editor UI is still building or missing.", 200

@app.route('/config', methods=['GET'])
def get_config():
    return jsonify({
        'chunkSize': CHUNK_SIZE,
    })

@app.route('/check', methods=['POST'])
def check():
    data = request.json
    text = data.get('text', '')
    language = data.get('language', 'es')
    if not text:
        return jsonify([])
    
    results = check_text(text, lang=language)
    return jsonify(results)

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=config.DEBUG_NOTIFICATIONS)
