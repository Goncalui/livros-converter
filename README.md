# livros-converter

Converte livros didáticos (PDF nativo, PDF escaneado, pastas de imagens) em Markdown estruturado para RAG, página por página, com retomada automática.

## Stack

- **Node.js** (orquestração + chamadas LLM)
- **Python** (extração de texto, OCR, extração de imagens)
- **Claude CLI** primário · **Gemini API** fallback / visão · **Ollama** local fallback
- **OCR plugável**: PaddleOCR · GLM-OCR (zai-org) · Tesseract — modo `compare` roda os dois principais e escolhe vencedor por métrica
- **LLM-vision** (Gemini/Ollama) escala para páginas com OCR ruim

## Setup

```bash
# 1. Instalar deps Node
npm install

# 2. Instalar deps Python (recomendado em venv)
python -m venv .venv
.venv\Scripts\activate           # Windows
pip install -r requirements.txt

# 3. Tesseract (Windows) — instalar de https://github.com/UB-Mannheim/tesseract/wiki
#    e baixar pacote de idioma `por` (Portuguese).

# 4. Claude CLI — já instalado e logado.

# 5. Ollama — opcional. baixar de https://ollama.com e rodar:
#    ollama pull llama3.1:8b
#    ollama pull llava:13b   (se quiser visão local)

# 6. Configurar variáveis
cp .env.example .env
# editar .env e preencher GEMINI_API_KEY e caminho do Tesseract
```

## Uso

```bash
# Conversão completa (extrai → OCR → batch → LLM → split → valida → indexa)
node src/cli.js convert ./caminho/livro.pdf

# Pasta de imagens
node src/cli.js convert ./pasta-com-paginas/

# Retomar do último checkpoint
node src/cli.js resume <slug-do-livro>

# Rodar etapa específica
node src/cli.js extract ./livro.pdf
node src/cli.js batch <slug>
node src/cli.js convert-batches <slug>
node src/cli.js postprocess <slug>
```

## Estrutura do workspace

```
workspace/<slug-livro>/
├── raw/             # texto + imagens extraídas, manifest.json
├── batches/         # lotes de páginas a enviar ao LLM
├── output/
│   ├── index.md     # sumário do livro
│   ├── cap-NN-*.md  # um arquivo por capítulo
│   └── assets/      # imagens organizadas por capítulo
└── .state.json      # checkpoint de progresso (resume)
```

## Modos de OCR (`OCR_MODE` no .env)

| Modo | Comportamento |
|---|---|
| `paddle` | PaddleOCR; Tesseract se confiança baixa |
| `glm` | GLM-OCR; Paddle se vazio |
| `paddle-then-glm` | Paddle → escala para GLM se confiança < min |
| `glm-then-paddle` | GLM → fallback Paddle |
| **`compare`** | roda Paddle + GLM, gera relatório `page-NNN.compare.json` com métricas (chars, headers, tabelas, fórmulas, garbled_ratio, score) e escolhe vencedor. Visualizável na aba "Comparação OCR" da UI. |

## Pipeline

1. **classify** — detecta páginas nativas vs escaneadas
2. **extract** — texto nativo + OCR (modo configurável) + imagens
3. **estimate** — estimativa de tokens/custo, pede confirmação
4. **batch** — agrupa páginas (lotes de 3–6 com 1 de overlap)
5. **convert** — chama LLM com `prompt-conversao-livros.md` por lote (retry/fallback)
6. **postprocess** — concatena, divide em capítulos, valida YAML/IDs/LaTeX, gera index.md
