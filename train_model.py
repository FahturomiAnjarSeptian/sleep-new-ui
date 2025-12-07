import pandas as pd
import numpy as np
import pickle
import os

# --- KONFIGURASI JALUR MUTLAK (Agar tidak error di server manapun) ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_DIR, 'Sleep_health_and_lifestyle_dataset.csv')
MODEL_PATH = os.path.join(BASE_DIR, 'model_sleep.pkl')

print("=== MEMULAI TRAINING ===")

# 1. LOAD DATA
try:
    df = pd.read_csv(DATA_PATH)
except FileNotFoundError:
    print("Error: Dataset tidak ditemukan."); exit()

# 2. BERSIH-BERSIH DATA
if 'Person ID' in df.columns: df = df.drop(columns=['Person ID'])
try:
    if 'Blood Pressure' in df.columns:
        bp = df['Blood Pressure'].str.split('/', expand=True).astype(float)
        df['systolic'] = bp[0]; df['diastolic'] = bp[1]
    else: df['systolic'] = 120.0; df['diastolic'] = 80.0
except: df['systolic'] = 120.0; df['diastolic'] = 80.0

# Encoding
df['Gender'] = df['Gender'].replace({'Male': 1, 'Female': 0}).astype(float)
df['Occupation'] = df['Occupation'].astype('category').cat.codes.astype(float)
df['BMI Category'] = df['BMI Category'].astype('category').cat.codes.astype(float)
df['Sleep Disorder'] = df['Sleep Disorder'].replace({'None': 0, 'Sleep Apnea': 1, 'Insomnia': 1}).fillna(0).astype(int)

# --- TEKNIK OVERSAMPLING (Supaya tidak Normal terus) ---
df_sehat = df[df['Sleep Disorder'] == 0]
df_sakit = df[df['Sleep Disorder'] == 1]
# Kita perbanyak data sakit (kali 2) agar seimbang
df_final = pd.concat([df_sehat, df_sakit, df_sakit], axis=0).reset_index(drop=True)

# Urutan Fitur Baku
features = ['Gender', 'Age', 'Occupation', 'Sleep Duration', 'Quality of Sleep', 
            'Physical Activity Level', 'Stress Level', 'BMI Category', 'Heart Rate', 
            'Daily Steps', 'systolic', 'diastolic']

for f in features:
    if f not in df_final.columns: df_final[f] = 0.0

X = df_final[features].values.astype(float)
y = df_final['Sleep Disorder'].values

# Simpan Info Scaling
X_min = X.min(axis=0)
X_max = X.max(axis=0)

# 3. RANDOM FOREST MANUAL
def split(X, y, f, t):
    m = X[:, f] < t
    return X[m], y[m], X[~m], y[~m]
def gini(y):
    if len(y)==0: return 0
    p = np.mean(y); return 2*p*(1-p)
def best_split(X, y):
    bg, bf, bt = 1, None, None
    for f in range(X.shape[1]):
        ts = np.unique(X[:, f])
        if len(ts)>20: ts = np.percentile(ts, np.linspace(0,100,20))
        for t in ts:
            xl, yl, xr, yr = split(X, y, f, t)
            if len(yl)==0 or len(yr)==0: continue
            g = (len(yl)*gini(yl) + len(yr)*gini(yr))/len(y)
            if g < bg: bg, bf, bt = g, f, t
    return bf, bt
def build(X, y, d=0):
    if len(set(y))==1 or d==5 or len(y)<2: return {'label': np.round(np.mean(y))}
    f, t = best_split(X, y)
    if f is None: return {'label': np.round(np.mean(y))}
    xl, yl, xr, yr = split(X, y, f, t)
    return {'feature': f, 'threshold': t, 'left': build(xl, yl, d+1), 'right': build(xr, yr, d+1)}

forest = []
print("Melatih Model...", end="")
for i in range(7): # 7 Pohon
    idx = np.random.choice(len(X), len(X), replace=True)
    forest.append(build(X[idx], y[idx]))
    print(".", end="")

# 4. SIMPAN
data = {'forest': forest, 'X_min': X_min, 'X_max': X_max, 'feature_names': features}
with open(MODEL_PATH, 'wb') as f:
    pickle.dump(data, f)

print(f"\nSUKSES! Model tersimpan di: {MODEL_PATH}")