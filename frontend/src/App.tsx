import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import './index.css';

interface Misspelling {
  word: string;
  start: number;
  end: number;
  candidates: string[];
}

const CHECK_DELAY_MS = 500;

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCaretOffset(container: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return 0;
  }

  const range = selection.getRangeAt(0);
  const prefix = range.cloneRange();
  prefix.selectNodeContents(container);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

function setCaretOffset(container: HTMLElement, targetOffset: number): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  let charIndex = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const nextIndex = charIndex + node.length;
    if (nextIndex >= targetOffset) {
      const range = document.createRange();
      range.setStart(node, targetOffset - charIndex);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    charIndex = nextIndex;
  }

  const range = document.createRange();
  range.selectNodeContents(container);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function renderHighlightedHtml(text: string, misspellings: Misspelling[]): string {
  if (!text) {
    return '';
  }

  let html = '';
  let lastIndex = 0;
  const sorted = [...misspellings].sort((a, b) => a.start - b.start);

  for (const misspelling of sorted) {
    html += escapeHtml(text.slice(lastIndex, misspelling.start));
    const word = escapeHtml(text.slice(misspelling.start, misspelling.end));
    const data = encodeURIComponent(JSON.stringify(misspelling.candidates));
    html += `<span class="misspelled" data-candidates="${data}">${word}</span>`;
    lastIndex = misspelling.end;
  }

  html += escapeHtml(text.slice(lastIndex));
  return html;
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const revisionRef = useRef(0);
  const latestTextRef = useRef('');
  const isComposingRef = useRef(false);

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);

  const { floatingStyles, refs } = useFloating({
    placement: 'bottom-start',
    elements: { reference: anchorEl },
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(120, availableHeight)}px`,
          });
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  function closePopup() {
    setAnchorEl(null);
    setCandidates([]);
  }

  function applyHighlights(
    editor: HTMLElement,
    text: string,
    misspellings: Misspelling[],
  ) {
    const nextHtml = renderHighlightedHtml(text, misspellings);
    if (editor.innerHTML === nextHtml) {
      return;
    }

    const savedOffset = getCaretOffset(editor);
    const savedScrollTop = editor.scrollTop;

    editor.innerHTML = nextHtml;
    setCaretOffset(editor, savedOffset);
    editor.scrollTop = savedScrollTop;
  }

  async function runSpellcheck(snapshotText: string, revision: number) {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    if (!snapshotText.trim()) {
      abortControllerRef.current?.abort();
      if (editor.innerHTML !== '') {
        editor.innerHTML = '';
      }
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch('/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: snapshotText }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Spell check failed with status ${response.status}`);
      }

      const misspellings: Misspelling[] = await response.json();
      if (
        controller.signal.aborted ||
        revision !== revisionRef.current ||
        snapshotText !== latestTextRef.current
      ) {
        return;
      }

      applyHighlights(editor, snapshotText, misspellings);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Spell-check request failed:', error);
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }

  function scheduleCheck(nextText: string, delayMs = CHECK_DELAY_MS) {
    latestTextRef.current = nextText;
    revisionRef.current += 1;
    const revision = revisionRef.current;

    closePopup();

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      void runSpellcheck(nextText, revision);
    }, delayMs);
  }

  function syncEditorText() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const nextText = editor.innerText;
    latestTextRef.current = nextText;

    if (isComposingRef.current) {
      return;
    }

    scheduleCheck(nextText);
  }

  function openPopup(span: HTMLElement) {
    const rawCandidates = span.dataset.candidates ?? '[]';
    const parsedCandidates: string[] = JSON.parse(
      decodeURIComponent(rawCandidates),
    );
    setCandidates(parsedCandidates);
    setAnchorEl(span);
  }

  function replaceWord(newWord: string) {
    const editor = editorRef.current;
    if (!anchorEl || !editor) {
      return;
    }

    const textNode = document.createTextNode(newWord);
    anchorEl.replaceWith(textNode);
    closePopup();

    const range = document.createRange();
    range.setStart(textNode, textNode.length);
    range.collapse(true);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    editor.focus();
    scheduleCheck(editor.innerText, 150);
  }

  function handleEditorClick(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains('misspelled')) {
      closePopup();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openPopup(target);
  }

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    function onTouchEnd(event: TouchEvent) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains('misspelled')) {
        return;
      }

      event.preventDefault();
      openPopup(target);
    }

    editor.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => editor.removeEventListener('touchend', onTouchEnd);
  }, []);

  useEffect(() => {
    function onDocumentMouseDown(event: globalThis.MouseEvent) {
      const target = event.target as Node;
      if (
        anchorEl &&
        editorRef.current &&
        !editorRef.current.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        closePopup();
      }
    }

    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [anchorEl]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    function syncViewportHeight() {
      document.documentElement.style.setProperty(
        '--vh',
        `${viewport?.height ? viewport.height * 0.01 : window.innerHeight * 0.01}px`,
      );
    }

    syncViewportHeight();
    viewport.addEventListener('resize', syncViewportHeight);
    viewport.addEventListener('scroll', syncViewportHeight);

    return () => {
      viewport.removeEventListener('resize', syncViewportHeight);
      viewport.removeEventListener('scroll', syncViewportHeight);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  return (
    <div className="app-container">
      <header>
        <h1>Corrector Inteligente</h1>
        <p>
          Escribe tu texto en español. Los errores se resaltarán y podrás
          tocarlos para ver sugerencias de corrección.
        </p>
      </header>

      <main>
        <div className="editor-wrapper">
          <div
            id="editor"
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            // @ts-expect-error autocomplete is valid on contenteditable in browsers
            autoComplete="off"
            inputMode="text"
            onInput={syncEditorText}
            onClick={handleEditorClick}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              syncEditorText();
            }}
            data-placeholder="Empieza a escribir aquí..."
          />
        </div>

        {anchorEl && (
          <div
            ref={(node) => {
              popupRef.current = node;
              refs.setFloating(node);
            }}
            style={floatingStyles}
            className="popup"
          >
            <div className="popup-header">Sugerencias</div>
            <ul className="suggestion-list">
              {candidates.length === 0 ? (
                <li className="no-suggestions">No hay sugerencias</li>
              ) : (
                candidates.slice(0, 7).map((candidate, index) => (
                  <li
                    key={`${candidate}-${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => replaceWord(candidate)}
                  >
                    {candidate}
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
