#!/usr/bin/env python3
import argparse
import unicodedata
from collections import Counter
from pathlib import Path


DEFAULT_INPUT = Path("backend/CREA_total.TXT")
DEFAULT_OUTPUT = Path("backend/crea_processed.txt")


def is_word(text):
    return text and all(char.isalpha() for char in text)


def parse_crea(path):
    frequencies = Counter()
    skipped = 0

    with path.open("r", encoding="latin-1") as file:
        for line in file:
            columns = line.strip().split()
            if len(columns) < 3 or not columns[0].endswith("."):
                skipped += 1
                continue

            word = unicodedata.normalize("NFC", columns[1].lower())
            if not is_word(word):
                skipped += 1
                continue

            try:
                frequency = int(columns[2].replace(",", ""))
            except ValueError:
                skipped += 1
                continue

            if frequency > 0:
                frequencies[word] += frequency
            else:
                skipped += 1

    return frequencies, skipped


def write_frequency_list(frequencies, path, min_count):
    path.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    with path.open("w", encoding="utf-8", newline="\n") as file:
        for word, frequency in sorted(
            frequencies.items(),
            key=lambda item: (-item[1], item[0]),
        ):
            if frequency < min_count:
                continue

            file.write(f"{word} {frequency}\n")
            written += 1

    return written


def main():
    parser = argparse.ArgumentParser(
        description="Convert CREA_total.TXT into the spellchecker's UTF-8 frequency list."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--min-count",
        type=int,
        default=1,
        help="Minimum absolute frequency to write to the processed corpus.",
    )
    args = parser.parse_args()

    frequencies, skipped = parse_crea(args.input)
    written = write_frequency_list(frequencies, args.output, args.min_count)

    print(f"input={args.input}")
    print(f"output={args.output}")
    print(f"parsed_words={len(frequencies)}")
    print(f"written_words={written}")
    print(f"skipped_lines={skipped}")


if __name__ == "__main__":
    main()
