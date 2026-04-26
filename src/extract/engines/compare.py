"""
Compara saídas de OCR (paddle vs glm vs tesseract) e escolhe vencedor por
heurística estrutural. Não há ground truth — pontuamos por sinais de qualidade.

Métricas por saída:
  - chars            : volume útil
  - words            : palavras alfanuméricas
  - lines            : linhas não vazias
  - headers          : # heading (markdown)
  - tables           : linhas de tabela `|...|`
  - lists            : itens de lista
  - formulas         : marcadores LaTeX
  - confidence       : engine-reportada quando disponível
  - weird_ratio      : caracteres de controle / total
  - garbled_ratio    : "palavras" sem vogal (sinal de OCR ruim)
  - score            : combinação ponderada
"""
import re


VOWELS = set("aeiouáéíóúâêôãõàèìòùAEIOU")


def metrics(text: str, confidence: float = 0.0) -> dict:
    if text is None:
        text = ""
    total = len(text) or 1
    weird = sum(1 for c in text if ord(c) < 32 and c not in "\n\t\r")
    lines = [l for l in text.splitlines() if l.strip()]
    words = re.findall(r"[A-Za-zÀ-ÿ0-9]{2,}", text)
    headers = sum(1 for l in lines if re.match(r"^#{1,6}\s+\S", l))
    tables = sum(1 for l in lines if l.count("|") >= 2)
    lists  = sum(1 for l in lines if re.match(r"^\s*[-*]\s+", l))
    formulas = text.count("$$") + len(re.findall(r"\\frac|\\sum|\\int|\\sqrt", text))
    bold = text.count("**")
    garbled = sum(1 for w in words if len(w) >= 3 and not any(c.lower() in VOWELS for c in w))
    garbled_ratio = garbled / max(1, len(words))

    score = (
        len(text) * 0.01
        + headers * 8
        + tables * 12
        + lists * 2
        + formulas * 6
        + bold * 1.5
        + confidence * 50
        - (weird / total) * 500
        - garbled_ratio * 80
    )

    return {
        "chars": len(text),
        "words": len(words),
        "lines": len(lines),
        "headers": headers,
        "tables": tables,
        "lists": lists,
        "formulas": formulas,
        "bold": bold,
        "weird_ratio": round(weird / total, 4),
        "garbled_ratio": round(garbled_ratio, 4),
        "confidence": round(confidence, 4),
        "score": round(score, 2),
    }


def pick_winner(candidates: dict) -> str:
    """
    candidates: { "paddle": {"text": ..., "metrics": {...}}, "glm": {...}, ... }
    retorna o nome do vencedor.
    Regras:
      - descarta candidatos com text None ou chars < 20
      - escolhe maior score
      - empate técnico (delta < 5%) → preferência: glm > paddle > tesseract
    """
    valid = {k: v for k, v in candidates.items()
             if v.get("text") and v["metrics"]["chars"] >= 20}
    if not valid:
        return None
    ranked = sorted(valid.items(), key=lambda kv: kv[1]["metrics"]["score"], reverse=True)
    if len(ranked) == 1:
        return ranked[0][0]
    top, second = ranked[0], ranked[1]
    delta = (top[1]["metrics"]["score"] - second[1]["metrics"]["score"]) / max(1, abs(top[1]["metrics"]["score"]))
    if delta < 0.05:
        priority = ["glm", "paddle", "tesseract"]
        for name in priority:
            if name in valid:
                return name
    return top[0]
