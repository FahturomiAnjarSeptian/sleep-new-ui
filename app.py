from flask import Flask, render_template, request
import numpy as np
import pickle
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64
import os

app = Flask(__name__)

# --- KONFIGURASI JALUR MUTLAK ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, 'model_sleep.pkl')

# Variabel Default (Supaya tidak crash jika model belum ada)
forest = []
X_min = np.zeros(12); X_max = np.ones(12)
feature_names = []

# Load Model Aman
try:
    with open(MODEL_PATH, 'rb') as f:
        data = pickle.load(f)
    forest = data.get('forest', [])
    X_min = data.get('X_min', np.zeros(12))
    X_max = data.get('X_max', np.ones(12))
    feature_names = data.get('feature_names', [])
except: pass 

def predict_tree(node, x):
    if not isinstance(node, dict): return 0
    if 'label' in node: return node['label']
    if node['feature'] >= len(x): return 0
    if x[node['feature']] < node['threshold']: return predict_tree(node['left'], x)
    else: return predict_tree(node['right'], x)

def get_tree_image(tree, fnames, title):
    try:
        plt.figure(figsize=(6, 4))
        ax = plt.gca(); ax.set_title(title); ax.axis("off")
        def recurse(n, x=0.5, y=1.0, dx=0.25, dy=0.15):
            if 'label' in n:
                val = int(n['label']) if not np.isnan(n['label']) else 0
                bg = "#4ade80" if val == 0 else "#f87171" # Hijau vs Merah
                ax.text(x, y, f"Hasil:{val}", ha='center', bbox=dict(boxstyle="round", fc=bg, ec="white"))
                return
            fn = str(n['feature'])
            if fnames and n['feature'] < len(fnames): fn = fnames[n['feature']]
            ax.text(x, y, f"{fn}\n<{n['threshold']:.1f}", ha='center', bbox=dict(boxstyle="round", fc="#e0f2fe"))
            ax.plot([x, x-dx], [y-0.02, y-dy+0.02], 'k-'); recurse(n['left'], x-dx, y-dy, dx*0.5, dy)
            ax.plot([x, x+dx], [y-0.02, y-dy+0.02], 'k-'); recurse(n['right'], x+dx, y-dy, dx*0.5, dy)
        recurse(tree)
        img = io.BytesIO()
        plt.savefig(img, format='png', bbox_inches='tight', transparent=True)
        img.seek(0); plt.close()
        return base64.b64encode(img.getvalue()).decode()
    except: return ""

@app.route('/', methods=['GET', 'POST'])
def index():
    prediction_text = ""
    result_class = ""
    tree_plots = []
    
    if request.method == 'POST':
        try:
            if not forest:
                return render_template('index.html', prediction_text="Error: Model belum dilatih.", result_class="error")

            # Ambil data (Urutan Wajib Sama)
            raw = [
                float(request.form.get('gender')), float(request.form.get('age')),
                float(request.form.get('occupation')), float(request.form.get('sleep_duration')),
                float(request.form.get('quality_sleep')), float(request.form.get('phys_activity')),
                float(request.form.get('stress')), float(request.form.get('bmi')),
                float(request.form.get('heart_rate')), float(request.form.get('daily_steps')),
                float(request.form.get('systolic')), float(request.form.get('diastolic'))
            ]
            
            x = (np.array(raw) - X_min) / (X_max - X_min + 1e-8)
            
            votes = []
            for t in forest:
                v = predict_tree(t, x)
                if not np.isnan(v): votes.append(v)
            
            final = 0
            if votes: final = int(np.round(np.mean(votes)))

            if final == 0:
                prediction_text = "Kondisi Tidur: NORMAL (Sehat)"
                result_class = "success"
            else:
                prediction_text = "⚠️ TERDETEKSI GANGGUAN TIDUR"
                result_class = "danger"
            
            # Gambar 1 pohon saja biar loading cepat & rapi
            if forest:
                img = get_tree_image(forest[0], feature_names, "Visualisasi Alur Keputusan AI")
                if img: tree_plots.append(img)

        except Exception as e:
            prediction_text = f"Error: {e}"
            result_class = "error"

    return render_template('index.html', prediction_text=prediction_text, result_class=result_class, tree_plots=tree_plots)