import re
from collections import Counter
import os

def words(text): 
    # Extract words including Spanish characters
    return re.findall(r'[a-zñáéíóúü]+', text.lower())

# Load the corpus
corpus_path = 'big.txt'
if os.path.exists(corpus_path):
    with open(corpus_path, 'r', encoding='utf-8') as f:
        WORDS = Counter(words(f.read()))
else:
    # Fallback
    print("Warning: big.txt not found. Using minimal fallback dictionary.")
    WORDS = Counter(words("hola mundo el la de y en un una es por para con los las"))

N = sum(WORDS.values())

def P(word): 
    "Probability of `word`."
    return WORDS[word] / N if N > 0 else 0

def correction(word): 
    "Most probable spelling correction for word."
    return max(candidates(word), key=P)

def candidates(word): 
    "Generate possible spelling corrections for word."
    return (known([word]) or known(edits1(word)) or known(edits2(word)) or [word])

def known(words_list): 
    "The subset of `words_list` that appear in the dictionary of WORDS."
    return set(w for w in words_list if w in WORDS)

def edits1(word):
    "All edits that are one edit away from `word`."
    # Added Spanish specific characters to the alphabet
    letters    = 'abcdefghijklmnopqrstuvwxyzñáéíóúü'
    splits     = [(word[:i], word[i:])    for i in range(len(word) + 1)]
    deletes    = [L + R[1:]               for L, R in splits if R]
    transposes = [L + R[1] + R[0] + R[2:] for L, R in splits if len(R)>1]
    replaces   = [L + c + R[1:]           for L, R in splits if R for c in letters]
    inserts    = [L + c + R               for L, R in splits for c in letters]
    return set(deletes + transposes + replaces + inserts)

def edits2(word): 
    "All edits that are two edits away from `word`."
    return (e2 for e1 in edits1(word) for e2 in edits1(e1))

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

    # Regex matches any valid word character in English/Spanish
    return re.sub(r'[a-zA-ZñÑáéíóúüÁÉÍÓÚÜ]+', replace_word, text)
