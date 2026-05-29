import re
import math
import os
import unicodedata
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

SPANISH_NORVIG_FEATURES = os.getenv("SPANISH_NORVIG_FEATURES", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}

LETTERS = "abcdefghijklmnopqrstuvwxyzñáéíóúü"
WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)
DIACRITIC_FOLD = str.maketrans("áéíóúü", "aeiouu")
ORTHOGRAPHIC_FOLD = str.maketrans("áéíóúüñ", "aeiouun")
PHONETIC_GROUPS = (
    frozenset(("b", "v")),
    frozenset(("c", "s", "z")),
)
PHONETIC_MULTI_REPLACEMENTS = (
    ("ll", "y", 0.2),
    ("y", "ll", 0.2),
)
DISTANCE_PENALTY = 4.0
AFFIX_BACKOFF = 0.18
MIN_KNOWN_COUNT = int(os.getenv("SPELLCHECKER_MIN_KNOWN_COUNT", "10"))
TYPO_FREQUENCY_RATIO = int(os.getenv("SPELLCHECKER_TYPO_FREQUENCY_RATIO", "50"))
ORTHOGRAPHIC_FREQUENCY_RATIO = int(os.getenv("SPELLCHECKER_ORTHOGRAPHIC_FREQUENCY_RATIO", "20"))

MIN_AFFIX_LEMMA_COUNT = 3

class AffixRule(NamedTuple):
    suffix: str
    replacements: tuple[str, ...]
    confidence: float
    generate_candidate: bool = True
    min_lemma_length: int = 4

SPANISH_SUFFIX_RULES = (
    AffixRule("aciones", ("ación",), 0.8),
    AffixRule("uciones", ("ución",), 0.8),
    AffixRule("idades", ("idad",), 0.65),
    AffixRule("mente", ("",), 0.45),
    AffixRule("amiento", ("ar",), 0.65),
    AffixRule("imiento", ("er", "ir"), 0.65),
    AffixRule("amientos", ("ar",), 0.55),
    AffixRule("imientos", ("er", "ir"), 0.55),
    AffixRule("ándonos", ("ar",), 0.7),
    AffixRule("iéndonos", ("er", "ir"), 0.7),
    AffixRule("ándose", ("ar",), 0.7),
    AffixRule("iéndose", ("er", "ir"), 0.7),
    AffixRule("ando", ("ar",), 0.7),
    AffixRule("iendo", ("er", "ir"), 0.7),
    AffixRule("ado", ("ar",), 0.55),
    AffixRule("ido", ("er", "ir"), 0.55),
    AffixRule("aremos", ("ar",), 0.75),
    AffixRule("eremos", ("er",), 0.75),
    AffixRule("iremos", ("ir",), 0.75),
    AffixRule("aríamos", ("ar",), 0.75),
    AffixRule("eríamos", ("er",), 0.75),
    AffixRule("iríamos", ("ir",), 0.75),
    AffixRule("aría", ("ar",), 0.75),
    AffixRule("ería", ("er",), 0.75),
    AffixRule("iría", ("ir",), 0.75),
    AffixRule("aron", ("ar",), 0.65),
    AffixRule("ieron", ("er", "ir"), 0.65),
    AffixRule("aba", ("ar",), 0.65),
    AffixRule("aban", ("ar",), 0.65),
    AffixRule("ías", ("er", "ir"), 0.65),
    AffixRule("ía", ("er", "ir"), 0.65),
    AffixRule("ces", ("z",), 0.6, False, 3),
    AffixRule("es", ("",), 0.35, False),
    AffixRule("s", ("",), 0.35, False),
)

def words(text):
    "Extract alphabetic words."
    return WORD_RE.findall(text.lower())

def load_frequency_list(path):
    "Load a UTF-8 '<word> <count>' frequency list."
    frequencies = Counter()

    with path.open("r", encoding="utf-8") as file:
        for line in file:
            try:
                word, count_text = line.rsplit(maxsplit=1)
            except ValueError:
                continue

            word = word.lower()
            if not WORD_RE.fullmatch(word):
                continue

            try:
                count = int(count_text)
            except ValueError:
                continue

            if count > 0:
                frequencies[word] += count

    return frequencies

# Load the corpus
CORPUS_PATH = Path(__file__).with_name("crea_processed.txt")
if not CORPUS_PATH.is_file():
    raise FileNotFoundError(
        f"Required spelling corpus was not found at {CORPUS_PATH}. "
        "Run scripts/preprocess_crea.py and make sure backend/crea_processed.txt "
        "is included in the Buildozer source package."
    )

WORDS = load_frequency_list(CORPUS_PATH)

N = sum(WORDS.values())
if N == 0:
    raise RuntimeError(f"Spelling corpus is empty or invalid: {CORPUS_PATH}")

def P(word): 
    "Probability of `word`."
    return WORDS[word] / N if N > 0 else 0

def spanish_enabled():
    return SPANISH_NORVIG_FEATURES

def correction(word): 
    "Most probable spelling correction for word."
    return max(candidates(word), key=lambda candidate: candidate_score(word, candidate))

def candidates(word): 
    "Generate possible spelling corrections for word."
    if spanish_enabled():
        return spanish_candidates(word)
    return (known([word]) or known(edits1(word)) or known(edits2(word)) or [word])

def known(words_list): 
    "The subset of `words_list` that appear in the dictionary of WORDS."
    return set(w for w in words_list if WORDS[w] >= MIN_KNOWN_COUNT)

def spanish_known(words_list):
    "Known words plus Spanish inflections whose stripped lemma is known."
    return set(w for w in words_list if is_known_word(w) or best_stem_count(w) > 0)

def is_known_word(word):
    "Return whether an exact typed word is accepted as valid."
    count = WORDS[word]
    if count <= 0:
        return False
    if not spanish_enabled():
        return True
    if has_much_more_common_orthographic_variant(word):
        return False
    if has_suspicious_low_frequency_shape(word):
        return False
    if count >= MIN_KNOWN_COUNT:
        return True
    return not is_likely_low_frequency_typo(word)

@lru_cache(maxsize=8192)
def has_much_more_common_orthographic_variant(word):
    count = WORDS[word]
    if count <= 0:
        return False

    required_count = max(MIN_KNOWN_COUNT, count * ORTHOGRAPHIC_FREQUENCY_RATIO)
    return any(WORDS[variant] >= required_count for variant in orthographic_variants(word))

def orthographic_variants(word):
    variants = set()
    for accented, plain in zip("áéíóúü", "aeiouu"):
        variants.update(replace_char(word, plain, accented))
        variants.update(replace_char(word, accented, plain))

    variants.update(replace_char(word, "n", "ñ"))
    variants.update(replace_char(word, "ñ", "n"))
    return variants

def has_suspicious_low_frequency_shape(word):
    if len(word) >= 4 and re.search(r"(.)\1{3,}", word):
        return True
    if len(word) >= 5 and len(set(word)) <= 2:
        return True
    return False

@lru_cache(maxsize=8192)
def is_likely_low_frequency_typo(word):
    count = WORDS[word]
    if count <= 0 or count >= MIN_KNOWN_COUNT:
        return False

    required_count = max(MIN_KNOWN_COUNT, count * TYPO_FREQUENCY_RATIO)
    return any(WORDS[neighbor] >= required_count for neighbor in typo_neighbors(word))

def typo_neighbors(word):
    neighbors = set()
    splits = [(word[:i], word[i:]) for i in range(len(word) + 1)]

    neighbors.update(spanish_edits(word))
    neighbors.update(L + R[1:] for L, R in splits if R and R[0] == "h")
    neighbors.update(L + "h" + R for L, R in splits)

    for index, char in enumerate(word):
        for group in PHONETIC_GROUPS:
            if char in group:
                neighbors.update(
                    word[:index] + replacement + word[index + 1:]
                    for replacement in group
                    if replacement != char
                )

    return neighbors

def spanish_candidates(word):
    "Generate Norvig candidates with Spanish phonetic and affix awareness."
    if is_known_word(word):
        return {word}

    orthographic = known(orthographic_variants(word))
    if orthographic:
        return orthographic

    near_words = edits1(word) | spanish_edits(word)
    near = known(near_words) | affix_known(near_words, generated=True)
    if near:
        return near

    distant = known(edits2(word))
    return distant or [word]

@lru_cache(maxsize=8192)
def edits1(word):
    "All edits that are one edit away from `word`."
    splits     = [(word[:i], word[i:])    for i in range(len(word) + 1)]
    deletes    = [L + R[1:]               for L, R in splits if R]
    transposes = [L + R[1] + R[0] + R[2:] for L, R in splits if len(R)>1]
    replaces   = [L + c + R[1:]           for L, R in splits if R for c in LETTERS]
    inserts    = [L + c + R               for L, R in splits for c in LETTERS]
    return set(deletes + transposes + replaces + inserts)

def edits2(word): 
    "All edits that are two edits away from `word`."
    return (e2 for e1 in edits1(word) for e2 in edits1(e1))

def spanish_edits(word):
    "Spanish-specific low-cost variants that plain one-char edits miss."
    variants = set()

    variants.update(orthographic_variants(word))

    for source, target, _cost in PHONETIC_MULTI_REPLACEMENTS:
        start = 0
        while True:
            index = word.find(source, start)
            if index == -1:
                break
            variants.add(word[:index] + target + word[index + len(source):])
            start = index + 1

    return variants

def replace_char(word, source, target):
    return {
        word[:index] + target + word[index + 1:]
        for index, char in enumerate(word)
        if char == source
    }

def candidate_score(original, candidate):
    "Frequency score adjusted by Spanish weighted edit distance when enabled."
    if not spanish_enabled():
        return P(candidate)

    probability = spanish_probability(candidate)
    if probability <= 0:
        return float("-inf") if candidate != original else -1000.0

    distance = spanish_weighted_distance(original, candidate)
    return math.log(probability) - (DISTANCE_PENALTY * distance)

def spanish_probability(word):
    direct = P(word)
    if direct:
        return direct

    stem_count = best_stem_count(word)
    if stem_count:
        return (stem_count / N) * AFFIX_BACKOFF
    return 0

def affix_known(words_list, generated=False):
    return {
        word
        for word in words_list
        if best_affix_match(word, generated=generated)[0] is not None
    }

def best_stem_count(word):
    _stem, count, confidence = best_affix_match(word)
    return count * confidence

@lru_cache(maxsize=8192)
def best_affix_match(word, generated=False):
    matches = [
        (stem, WORDS[stem], confidence)
        for stem, confidence in spanish_stems(word, generated=generated)
        if WORDS[stem] >= MIN_AFFIX_LEMMA_COUNT
    ]

    if not matches:
        return None, 0, 0.0

    return max(matches, key=lambda match: match[1] * match[2])

@lru_cache(maxsize=8192)
def spanish_stems(word, generated=False):
    "Return possible Spanish lemmas for light affix stripping."
    stems = set()
    for rule in SPANISH_SUFFIX_RULES:
        if generated and not rule.generate_candidate:
            continue

        if not word.endswith(rule.suffix):
            continue

        base = word[:-len(rule.suffix)]
        for replacement in rule.replacements:
            lemma = base + replacement
            if len(lemma) >= rule.min_lemma_length:
                stems.add((lemma, rule.confidence))

    folded = strip_diacritics(word)
    if folded != word:
        stems.add((folded, 0.9))

    return frozenset(stems)

def strip_diacritics(word):
    normalized = unicodedata.normalize("NFD", word)
    return "".join(char for char in normalized if unicodedata.category(char) != "Mn")

@lru_cache(maxsize=32768)
def spanish_weighted_distance(source, target):
    "Damerau-Levenshtein distance with Spanish phonetic and diacritic costs."
    rows = len(source) + 1
    cols = len(target) + 1
    dp = [[0.0] * cols for _ in range(rows)]

    for i in range(1, rows):
        dp[i][0] = dp[i - 1][0] + delete_cost(source[i - 1])
    for j in range(1, cols):
        dp[0][j] = dp[0][j - 1] + insert_cost(target[j - 1])

    for i in range(1, rows):
        for j in range(1, cols):
            delete = dp[i - 1][j] + delete_cost(source[i - 1])
            insert = dp[i][j - 1] + insert_cost(target[j - 1])
            replace = dp[i - 1][j - 1] + replace_cost(source[i - 1], target[j - 1])
            best = min(delete, insert, replace)

            if i > 1 and j > 1 and source[i - 2] == target[j - 1] and source[i - 1] == target[j - 2]:
                best = min(best, dp[i - 2][j - 2] + 1.0)

            for from_text, to_text, cost in PHONETIC_MULTI_REPLACEMENTS:
                if source[:i].endswith(from_text) and target[:j].endswith(to_text):
                    best = min(best, dp[i - len(from_text)][j - len(to_text)] + cost)

            dp[i][j] = best

    return dp[-1][-1]

def delete_cost(char):
    return 0.1 if char == "h" else 1.0

def insert_cost(char):
    return 0.1 if char == "h" else 1.0

def replace_cost(source_char, target_char):
    if source_char == target_char:
        return 0.0

    if source_char.translate(DIACRITIC_FOLD) == target_char.translate(DIACRITIC_FOLD):
        return 0.05

    if source_char.translate(ORTHOGRAPHIC_FOLD) == target_char.translate(ORTHOGRAPHIC_FOLD):
        return 0.05

    if any(source_char in group and target_char in group for group in PHONETIC_GROUPS):
        return 0.2

    return 1.0

def correct_text(text):
    "Parses a full string, corrects the words, and preserves formatting."
    def replace_word(match):
        word = match.group(0)
        
        # Check casing to preserve it
        is_title = word.istitle()
        is_upper = word.isupper()
        
        # Correct the lowercase version of the word
        corrected = correction(word.lower())
        
        # Restore casing
        if is_upper:
            return corrected.upper()
        elif is_title:
            return corrected.title()
        return corrected

    return WORD_RE.sub(replace_word, text)

def check_text(text):
    "Parses a full string, finds misspelled words, and returns their positions and suggestions."
    results = []
    
    for match in WORD_RE.finditer(text):
        word = match.group(0)
        word_lower = word.lower()
        
        # If the word is in the dictionary, skip it
        if is_known_word(word_lower) or (spanish_enabled() and best_affix_match(word_lower)[0]):
            continue
            
        # Get candidates sorted by probability (descending)
        cands = sorted(
            list(candidates(word_lower)),
            key=lambda candidate: candidate_score(word_lower, candidate),
            reverse=True,
        )
        
        # Maintain casing for suggestions
        is_title = word.istitle()
        is_upper = word.isupper()
        
        cased_cands = []
        for c in cands:
            if is_upper:
                cased_cands.append(c.upper())
            elif is_title:
                cased_cands.append(c.title())
            else:
                cased_cands.append(c)
                
        results.append({
            "word": word,
            "start": match.start(),
            "end": match.end(),
            "candidates": cased_cands
        })
        
    return results
