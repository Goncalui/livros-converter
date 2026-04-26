# Rodar livros-converter no Google Colab Free

Guia passo a passo para executar a pipeline (Paddle + GLM-OCR + LLM) no Colab usando GPU T4 (16 GB) gratuita.

> **Por que Colab?** Linux nativo evita os bugs do Paddle/Win, T4 tem o dobro de VRAM da RTX 3060 Ti, e GLM-OCR via transformers vai voar.

---

## 0. Resumo das diferenças vs. local

| | Local (Windows) | Colab Free |
|---|---|---|
| OS | Windows 11 | Linux |
| GPU | RTX 3060 Ti 8 GB | T4 16 GB |
| Paddle bug PIR/OneDNN | Sim | **Não** |
| Claude CLI | Funciona | Não recomendado |
| LLM converter | Claude CLI | **Gemini API** (free tier) ou Ollama local |
| Sessão | Ilimitada | **12 h** (free) |
| PDFs | Disco local | **Google Drive** |

No Colab vamos trocar Claude CLI por **Gemini 2.5 Pro** (free tier dá 50 reqs/dia, basta para um capítulo).

---

## 1. Antes de começar

### 1.1. Pegue uma chave Gemini API
- Acesse https://aistudio.google.com/apikey
- Clique em **Create API key**
- Copie a chave (formato `AIza...`)

### 1.2. Coloque o(s) PDF(s) no Google Drive
- Crie a pasta `MyDrive/livros-input/`
- Suba `Biologia - Volume 1.pdf` (ou outros)

### 1.3. Suba o código do `livros-converter` para o Drive ou GitHub
**Opção A — Drive:** zipa a pasta local `livros-converter/` (sem `node_modules` e `workspace/`) e sobe para `MyDrive/`.

**Opção B — GitHub:** cria um repo privado e empurra. Recomendado.

```bash
# no seu Windows, dentro de livros-converter:
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/<seu-user>/livros-converter.git
git push -u origin main
```

---

## 2. Notebook Colab — célula por célula

> Crie um novo notebook em https://colab.new e **ative GPU**: `Editar → Configurações do notebook → Acelerador de hardware: T4 GPU`.

Cole as células abaixo, em ordem. Cada bloco ` ```bash` ou ` ```python` é uma célula.

---

### Célula 1 — Verificar GPU

```python
!nvidia-smi
import torch
print("torch:", torch.__version__, "cuda:", torch.cuda.is_available(), "device:", torch.cuda.get_device_name(0))
```

Você deve ver algo como `Tesla T4` e `cuda: True`.

---

### Célula 2 — Montar Google Drive

```python
from google.colab import drive
drive.mount('/content/drive')

import os
os.makedirs('/content/drive/MyDrive/livros-input', exist_ok=True)
os.makedirs('/content/drive/MyDrive/livros-output', exist_ok=True)
print("Drive montado.")
```

Confirme o popup de autorização.

---

### Célula 3 — Trazer o código

**Se subiu via GitHub** (recomendado):
```bash
%cd /content
!git clone https://github.com/<seu-user>/livros-converter.git
%cd livros-converter
```

**Se subiu como zip no Drive:**
```bash
%cd /content
!cp /content/drive/MyDrive/livros-converter.zip .
!unzip -q livros-converter.zip
%cd livros-converter
```

---

### Célula 4 — Instalar Node + dependências Python

```bash
%%bash
# Node 22 (vem com nvm) — se já não tiver
which node || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)
node --version

# Deps Node
npm install --silent

# Deps Python — Linux não tem o bug PIR; instala tudo certo
pip install -q PyMuPDF Pillow pytesseract \
  paddlepaddle-gpu==3.0.0 paddleocr==3.5.0 \
  glmocr transformers accelerate sentencepiece pypdfium2 opencv-python-headless

# Tesseract com pacote PT
apt-get install -y -q tesseract-ocr tesseract-ocr-por
tesseract --version | head -1
```

> **Nota Paddle:** se o `paddlepaddle-gpu==3.0.0` falhar pelo CDN chinês, tente:
> `pip install paddlepaddle-gpu==3.0.0 -i https://pypi.tuna.tsinghua.edu.cn/simple`
> ou caia para CPU: `pip install paddlepaddle==3.0.0`

---

### Célula 5 — Criar `.env` com chaves e config

```python
%%writefile .env
# OCR
OCR_MODE=compare
PADDLE_OCR_LANG=pt
PADDLE_OCR_VERSION=PP-OCRv5
PADDLE_FORCE_MOBILE=1
TESSERACT_CMD=/usr/bin/tesseract
TESSERACT_LANG=por
COMPARE_INCLUDE_TESSERACT=1
OCR_MIN_CONFIDENCE=0.80

# GLM-OCR (transformers direct, não vLLM)
GLM_OCR_MODE=selfhosted
CUDA_VISIBLE_DEVICES=0
GLM_LAYOUT_DEVICE=cuda
GLM_OCR_MAX_NEW_TOKENS=4096

# LLM — usar Gemini (free tier ~50 reqs/dia em 2.5 pro)
LLM_ORDER_TEXT=gemini,ollama
LLM_ORDER_VISION=gemini,ollama
GEMINI_API_KEY=COLE_AQUI_SUA_CHAVE_AIza...
GEMINI_TEXT_MODEL=gemini-2.5-pro
GEMINI_VISION_MODEL=gemini-2.5-pro

# Pipeline
BATCH_SIZE=5
BATCH_OVERLAP=1
PYTHON_BIN=python3
```

> ⚠️ **Substitua** `COLE_AQUI_SUA_CHAVE_AIza...` pela chave real, depois roda a célula.

---

### Célula 6 — Recortar o capítulo desejado do PDF

Ajuste o caminho do PDF e o intervalo de páginas conforme seu sumário.

```python
import fitz, os

PDF = '/content/drive/MyDrive/livros-input/Biologia - Volume 1.pdf'
OUT_DIR = '/content/livros-converter/input-bio-cap1'
PAGE_FROM = 15   # 1-indexado: primeira página do capítulo
PAGE_TO   = 40   # inclusive

os.makedirs(OUT_DIR, exist_ok=True)
doc = fitz.open(PDF)
for i in range(PAGE_FROM - 1, PAGE_TO):
    pix = doc[i].get_pixmap(dpi=200)
    pix.save(f'{OUT_DIR}/page-{i - PAGE_FROM + 2:03d}.png')
print(f'OK — {PAGE_TO - PAGE_FROM + 1} páginas em {OUT_DIR}')

# para descobrir o intervalo do capítulo automaticamente:
print('--- sumário do PDF ---')
for level, title, page in doc.get_toc():
    print(f'L{level} pág{page:>4}  {title}')
```

A última instrução imprime o sumário; copie os números e ajuste `PAGE_FROM`/`PAGE_TO`.

---

### Célula 7 — Rodar pipeline

```bash
%%bash
cd /content/livros-converter
PYTHONIOENCODING=utf-8 node src/cli.js convert ./input-bio-cap1 2>&1 | tee workspace/run.log
```

Vai imprimir progresso de cada página de OCR e cada lote LLM. Tempo estimado:
- OCR Paddle: ~30s (T4 voa)
- OCR GLM-OCR: ~8 min (47s/pág local → ~18s/pág na T4 = ~8 min)
- Conversão Gemini: ~3 min (7 lotes × ~25s)
- **Total: ~12 min**

> Se o Gemini bater no rate limit (50 req/dia free), espere ou troque pra `gemini-2.5-flash` no `.env`.

---

### Célula 8 — Acompanhar UI (opcional, com tunnel)

Colab não expõe portas direto. Use `pyngrok`:

```bash
!pip install -q pyngrok
```

```python
from pyngrok import ngrok
# pegue um auth token grátis em https://dashboard.ngrok.com/get-started/your-authtoken
ngrok.set_auth_token('SEU_TOKEN_NGROK')

import subprocess
subprocess.Popen(['node', 'src/cli.js', 'ui', '5173'],
                 cwd='/content/livros-converter')

import time; time.sleep(3)
public = ngrok.connect(5173)
print('UI:', public.public_url)
```

Abre o link, seleciona `input-bio-cap1`. (Roda em paralelo com a Célula 7.)

---

### Célula 9 — Copiar resultado pro Drive

```bash
%%bash
SLUG=input-bio-cap1
SRC=/content/livros-converter/workspace/$SLUG/output
DST=/content/drive/MyDrive/livros-output/$SLUG
mkdir -p "$DST"
cp -rv "$SRC"/* "$DST"/
ls "$DST"
```

Pronto — markdowns, `index.md`, comparação OCR e logs ficam salvos no Drive.

---

## 3. Dicas e soluções

### Persistência incremental no Drive (recomendado)
Aponte `WORKSPACE_ROOT` direto para uma pasta no Drive e o pipeline grava `manifest.json`, `page-NNN.txt`, `batch-NNN.md` e `.state.json` **com fsync por página/lote**. Sessão pode cair a qualquer momento sem perder trabalho.

Na célula que roda o pipeline:
```bash
!cd /content/livros-converter && \
  WORKSPACE_ROOT=/content/drive/MyDrive/livros-output \
  PYTHONIOENCODING=utf-8 \
  node src/cli.js convert ./input-bio-completo
```

### Sessão expirou (12h) — retomar
Com `WORKSPACE_ROOT` no Drive, basta:
```bash
!cd /content/livros-converter && \
  WORKSPACE_ROOT=/content/drive/MyDrive/livros-output \
  node src/cli.js resume input-bio-completo
```
- O OCR pula páginas com `text_source` no manifest (granular por página).
- O conversor pula lotes em `stages.convert.batchesDone` no `.state.json`.
- Variável `OCR_FORCE=1` reprocessa tudo se precisar.

### GLM-OCR baixando lento (~3GB)
A primeira execução baixa pesos. Cache ele no Drive:
```bash
!mkdir -p /content/drive/MyDrive/hf_cache
!ln -sf /content/drive/MyDrive/hf_cache /root/.cache/huggingface
```
Coloque essa célula **antes** da Célula 4. Próximas sessões reusam o cache.

### Limite Gemini free
- `gemini-2.5-pro`: ~50 req/dia, qualidade alta
- `gemini-2.5-flash`: ~250 req/dia, mais rápido — troca no `.env` se precisar
- Para grandes livros, considere upgrade pago ($1.25 / 1M tokens input)

### Quero rodar livro inteiro
Edite Célula 6 para usar `PAGE_FROM=1, PAGE_TO=len(doc)`. Para Biologia Vol 1 (367 págs):
- OCR: ~2 h (T4)
- Gemini: ~75 lotes × 25s = ~30 min  
- **Cabe em uma sessão** se ngrok+UI não atrapalhar

### Erro `paddlepaddle-gpu` indisponível
Cai pro CPU sem perda significativa de qualidade no Linux:
```bash
!pip uninstall -y paddlepaddle-gpu
!pip install paddlepaddle==3.0.0
```

---

## 4. Estrutura final no Drive

```
MyDrive/
├── livros-input/
│   └── Biologia - Volume 1.pdf
├── livros-output/
│   ├── input-bio-cap1/
│   │   ├── index.md
│   │   ├── cap-01-*.md
│   │   ├── _full.md
│   │   ├── _validation.json
│   │   └── batch-NNN.md
│   └── _workspace_backup/   (raw OCR, comparações, etc)
└── hf_cache/                 (modelos GLM-OCR cacheados)
```

---

## 5. Próximos passos

- Para rodar capítulos em paralelo, abra **dois notebooks Colab simultâneos** (cada um em conta diferente — limite Gemini é por chave).
- Para auditar comparação OCR, abra `workspace/<slug>/raw/page-NNN.compare.json` — traz métricas (chars, headers, tables, formulas, garbled_ratio, score) das três engines.
- Para ajustar threshold de "vai pra vision", mexe `OCR_MIN_CONFIDENCE` (default 0.80).
