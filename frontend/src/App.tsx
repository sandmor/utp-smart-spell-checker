import { useEffect, useRef, useState } from 'react';
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import { loadFileContent } from './lib/fileLoaders';
import './index.css';

interface Misspelling {
  word: string;
  start: number;
  end: number;
  candidates: string[];
}

type DocumentStatus = 'idle' | 'checking' | 'saved' | 'dirty' | 'error';

interface TextStats {
  characters: number;
  words: number;
  issues: number;
}

interface WritableFileLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface FileHandleLike {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileLike>;
}

interface FilePickerWindow extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileHandleLike>;
}

interface AndroidFilesBridge {
  isAvailable(): boolean;
  openTextFile(): void;
  saveTextFile(fileName: string, text: string): void;
  saveTextFileAs(fileName: string, text: string): void;
}

interface AndroidBridgeWindow extends Window {
  AndroidFiles?: AndroidFilesBridge;
}

const CHECK_DELAY_MS = 500;
const DEFAULT_CHUNK_SIZE = 1024;
const TEXT_FILE_TYPES = [
  {
    description: 'Documentos soportados',
    accept: {
      'text/plain': ['.txt', '.log'],
      'text/markdown': ['.md', '.markdown'],
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    },
  },
];

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('es-CO').format(value);
}

function getStats(text: string, issues: number): TextStats {
  const words = text.trim().match(/[^\s]+/g)?.length ?? 0;
  return {
    characters: text.length,
    words,
    issues,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function getPickerWindow(): FilePickerWindow {
  return window as FilePickerWindow;
}

function getAndroidFiles(): AndroidFilesBridge | null {
  const bridge = (window as AndroidBridgeWindow).AndroidFiles;
  if (!bridge) {
    return null;
  }

  try {
    return bridge.isAvailable() ? bridge : null;
  } catch {
    return null;
  }
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

function insertPlainText(text: string): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStart(textNode, textNode.length);
  range.collapse(true);
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

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename || 'documento.txt';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   SVG Icons — inline for zero-dependency Android WebView
   ============================================================ */

function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function IconFilePlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

/* ============================================================
   App Component
   ============================================================ */


function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  );
}

function App() {
  const editorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileHandleRef = useRef<FileHandleLike | null>(null);
  const revisionRef = useRef(0);
  const latestTextRef = useRef('');
  const isComposingRef = useRef(false);
  const touchHandledRef = useRef(false);
  const chunkSizeRef = useRef(DEFAULT_CHUNK_SIZE);

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [documentName, setDocumentName] = useState('Sin titulo.txt');
  const [documentStatus, setDocumentStatus] = useState<DocumentStatus>('idle');
  const [statusMessage, setStatusMessage] = useState('Documento nuevo');
  const [stats, setStats] = useState<TextStats>(getStats('', 0));
  const [isDragActive, setIsDragActive] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isRichText, setIsRichText] = useState(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'emerald');
  const [language, setLanguage] = useState(() => localStorage.getItem('language') || 'es');
  const [recentFiles, setRecentFiles] = useState<Array<{name: string, text: string, date: string}>>(() => {
    try { return JSON.parse(localStorage.getItem('recentFiles') || '[]'); } catch { return []; }
  });

  useEffect(() => {
    document.body.className = `theme-${theme}`;
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('language', language);
  }, [language]);

  useEffect(() => {
    runSpellcheck(currentText(), revisionRef.current);
  }, [language]);

  // Fetch chunk size from backend config on mount
  useEffect(() => {
    fetch('/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.chunkSize && typeof data.chunkSize === 'number') {
          chunkSizeRef.current = data.chunkSize;
        }
      })
      .catch(() => {/* keep default */});
  }, []);

  function saveRecentFile(name: string, text: string) {
    if (!name || name === 'Sin titulo.txt') return;
    setRecentFiles(prev => {
      const filtered = prev.filter(f => f.name !== name);
      const updated = [{name, text, date: new Date().toLocaleDateString()}, ...filtered].slice(0, 10);
      localStorage.setItem('recentFiles', JSON.stringify(updated));
      return updated;
    });
  }

  const { floatingStyles, refs } = useFloating({
    placement: 'bottom-start',
    strategy: 'fixed',
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
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, { animationFrame: true }),
  });

  function closePopup() {
    setAnchorEl(null);
    setCandidates([]);
  }

  function currentText(): string {
    return editorRef.current?.innerText ?? latestTextRef.current;
  }

  function updateStats(text: string, issues: number = stats.issues) {
    setStats(getStats(text, issues));
  }

  function markDirty(text: string) {
    latestTextRef.current = text;
    updateStats(text);
    setDocumentStatus('dirty');
    setStatusMessage('Cambios sin guardar');
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

  function splitIntoChunks(text: string, maxSize: number): { text: string; offset: number }[] {
    if (text.length <= maxSize) {
      return [{ text, offset: 0 }];
    }

    const chunks: { text: string; offset: number }[] = [];
    let start = 0;

    while (start < text.length) {
      let end = Math.min(start + maxSize, text.length);

      // If we're not at the end, find the nearest paragraph/newline boundary
      if (end < text.length) {
        const newlinePos = text.lastIndexOf('\n', end);
        if (newlinePos > start) {
          end = newlinePos + 1;
        } else {
          // Fallback: find the nearest space
          const spacePos = text.lastIndexOf(' ', end);
          if (spacePos > start) {
            end = spacePos + 1;
          }
          // Otherwise just cut at maxSize
        }
      }

      chunks.push({ text: text.slice(start, end), offset: start });
      start = end;
    }

    return chunks;
  }

  async function checkChunk(
    chunkText: string,
    chunkOffset: number,
    lang: string,
    signal: AbortSignal,
  ): Promise<Misspelling[]> {
    const response = await fetch('/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunkText, language: lang }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Spell check failed with status ${response.status}`);
    }

    const results: Misspelling[] = await response.json();

    // Adjust offsets so they reference positions in the original full text
    if (chunkOffset > 0) {
      for (const m of results) {
        m.start += chunkOffset;
        m.end += chunkOffset;
      }
    }

    return results;
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
      setStats(getStats('', 0));
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setDocumentStatus((status) => (status === 'dirty' ? 'dirty' : 'checking'));

    try {
      const chunks = splitIntoChunks(snapshotText, chunkSizeRef.current);

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          checkChunk(chunk.text, chunk.offset, language, controller.signal),
        ),
      );

      if (
        controller.signal.aborted ||
        revision !== revisionRef.current ||
        snapshotText !== latestTextRef.current
      ) {
        return;
      }

      const misspellings = chunkResults.flat();
      updateStats(snapshotText, misspellings.length);
      applyHighlights(editor, snapshotText, misspellings);
      setDocumentStatus((status) => (status === 'dirty' ? 'dirty' : 'saved'));
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error('Spell-check request failed:', error);
      setDocumentStatus('error');
      setStatusMessage('No se pudo revisar el texto');
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

  function setEditorText(text: string, nextName: string, handle: FileHandleLike | null) {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    closePopup();
    setIsSheetOpen(false);
    fileHandleRef.current = handle;
    setDocumentName(nextName || 'Sin titulo.txt');
    editor.textContent = text;
    latestTextRef.current = text;
    saveRecentFile(nextName, text);
    setStats(getStats(text, 0));
    setDocumentStatus('saved');
    setStatusMessage(handle ? 'Archivo abierto' : 'Texto importado');
    scheduleCheck(text, 120);
    editor.focus();
    setCaretOffset(editor, 0);
  }

  async function loadFile(file: File, handle: FileHandleLike | null) {
    try {
      const { text, isRichText: rich } = await loadFileContent(file);
      setIsRichText(rich);
      setEditorText(text, file.name, handle);
    } catch (error) {
      console.error(error);
      setDocumentStatus('error');
      setStatusMessage('Error al cargar archivo');
    }
  }

  async function openTextFile() {
    const androidFiles = getAndroidFiles();
    if (androidFiles) {
      setDocumentStatus('checking');
      setStatusMessage('Seleccionando archivo...');
      setIsSheetOpen(false);
      androidFiles.openTextFile();
      return;
    }

    const picker = getPickerWindow();

    if (picker.showOpenFilePicker) {
      try {
        const [handle] = await picker.showOpenFilePicker({
          multiple: false,
          types: TEXT_FILE_TYPES,
        });
        if (!handle) {
          return;
        }
        const file = await handle.getFile();
        await loadFile(file, handle);
      } catch (error) {
        if (!isAbortError(error)) {
          console.error('File open failed:', error);
          setDocumentStatus('error');
          setStatusMessage('No se pudo abrir el archivo');
        }
      }
      return;
    }

    fileInputRef.current?.click();
  }

  async function saveToHandle(handle: FileHandleLike, text: string) {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    fileHandleRef.current = handle;
    setDocumentName(handle.name);
    saveRecentFile(handle.name, text);
    setDocumentStatus('saved');
    setStatusMessage('Archivo guardado');
  }

  async function saveAsTextFile() {
    const text = currentText();
    const androidFiles = getAndroidFiles();

    if (androidFiles) {
      setDocumentStatus('checking');
      setStatusMessage('Seleccionando destino...');
      setIsSheetOpen(false);
      androidFiles.saveTextFileAs(documentName, text);
      return;
    }

    const picker = getPickerWindow();

    try {
      if (picker.showSaveFilePicker) {
        const handle = await picker.showSaveFilePicker({
          suggestedName: documentName,
          types: TEXT_FILE_TYPES,
        });
        await saveToHandle(handle, text);
        setIsSheetOpen(false);
        return;
      }

      downloadTextFile(documentName, text);
      setDocumentStatus('saved');
      setStatusMessage('Copia descargada');
      setIsSheetOpen(false);
    } catch (error) {
      if (!isAbortError(error)) {
        console.error('File save failed:', error);
        setDocumentStatus('error');
        setStatusMessage('No se pudo guardar el archivo');
      }
    }
  }

  async function saveTextFile() {
    const text = currentText();
    const androidFiles = getAndroidFiles();

    if (androidFiles) {
      setDocumentStatus('checking');
      setStatusMessage('Guardando archivo...');
      setIsSheetOpen(false);
      androidFiles.saveTextFile(documentName, text);
      return;
    }

    if (fileHandleRef.current) {
      try {
        await saveToHandle(fileHandleRef.current, text);
        setIsSheetOpen(false);
      } catch (error) {
        console.error('Direct file save failed:', error);
        setDocumentStatus('error');
        setStatusMessage('No se pudo actualizar el archivo');
      }
      return;
    }

    await saveAsTextFile();
  }

  function newDocument() {
    setIsRichText(false);
    setEditorText('', 'Sin titulo.txt', null);
    setDocumentStatus('idle');
    setStatusMessage('Documento nuevo');
    setIsSheetOpen(false);
  }

  function syncEditorText() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const nextText = editor.innerText;
    markDirty(nextText);

    if (isComposingRef.current) {
      return;
    }

    scheduleCheck(nextText);
  }

  function handlePaste(event: ReactClipboardEvent<HTMLDivElement>) {
    const text = event.clipboardData.getData('text/plain');
    if (!text) {
      return;
    }

    event.preventDefault();
    insertPlainText(text);
    syncEditorText();
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
    const nextText = editor.innerText;
    markDirty(nextText);
    scheduleCheck(nextText, 150);
  }

  function handleEditorClick(event: ReactMouseEvent<HTMLDivElement>) {
    // If touch already handled it, skip the click
    if (touchHandledRef.current) {
      touchHandledRef.current = false;
      return;
    }

    const target = event.target as HTMLElement;
    if (!target.classList.contains('misspelled')) {
      closePopup();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openPopup(target);
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragActive(true);
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsDragActive(false);
    }
  }

  async function handleDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragActive(false);

    const [file] = Array.from(event.dataTransfer.files);
    if (file) {
      await loadFile(file, null);
    }
  }

  // --- Android bridge event listeners ---
  useEffect(() => {
    function onAndroidFileOpened(event: Event) {
      const detail = (event as CustomEvent<{ name: string; text?: string; textBase64?: string }>).detail;
      try {
        const text = detail.textBase64 
          ? decodeURIComponent(escape(atob(detail.textBase64))) 
          : detail.text || '';
        setEditorText(text, detail.name, null);
        setStatusMessage('Archivo abierto');
      } catch (e) {
        setDocumentStatus('error');
        setStatusMessage('Error al procesar el archivo');
      }
    }

    function onAndroidFileSaved(event: Event) {
      const detail = (event as CustomEvent<{ name: string; mode: string }>).detail;
      setDocumentName(prev => detail.name || prev);
      setDocumentStatus('saved');
      setStatusMessage(
        detail.mode === 'update' ? 'Archivo actualizado' : 'Archivo guardado',
      );
      setIsSheetOpen(false);
    }

    function onAndroidFileError(event: Event) {
      const detail = (event as CustomEvent<{ message: string }>).detail;
      const message = detail.message || 'Operacion cancelada';
      if (message.toLowerCase().includes('cancelada')) {
        setDocumentStatus(currentText().trim() ? 'dirty' : 'idle');
        setStatusMessage('Operacion cancelada');
        return;
      }

      setDocumentStatus('error');
      setStatusMessage(message);
    }

    function onAndroidDebug(event: Event) {
      const msg = (event as CustomEvent<{message: string}>).detail.message;
      setStatusMessage('DBG: ' + msg);
    }

    window.addEventListener('android-file-opened', onAndroidFileOpened);
    window.addEventListener('android-file-saved', onAndroidFileSaved);
    window.addEventListener('android-file-error', onAndroidFileError);
    window.addEventListener('android-debug', onAndroidDebug);

    return () => {
      window.removeEventListener('android-file-opened', onAndroidFileOpened);
      window.removeEventListener('android-file-saved', onAndroidFileSaved);
      window.removeEventListener('android-file-error', onAndroidFileError);
      window.removeEventListener('android-debug', onAndroidDebug);
    };
  }, []);

  // --- Touch handler for misspelled words ---
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
      touchHandledRef.current = true;
      openPopup(target);
    }

    editor.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => editor.removeEventListener('touchend', onTouchEnd);
  }, []);

  // --- Dismiss popup on outside click/touch ---
  useEffect(() => {
    function onDismiss(event: Event) {
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

    document.addEventListener('mousedown', onDismiss);
    document.addEventListener('touchstart', onDismiss, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDismiss);
      document.removeEventListener('touchstart', onDismiss);
    };
  }, [anchorEl]);

  // --- Viewport height for virtual keyboard ---
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

  // --- Cleanup timers on unmount ---
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      abortControllerRef.current?.abort();
    };
  }, []);

  return (
    <div className="app-shell">
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".txt,.md,.markdown,.csv,.log,.docx,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void loadFile(file, null);
          }
          event.currentTarget.value = '';
        }}
      />

      {/* ---- Top Bar ---- */}
      <header className="top-bar">
        <div className="top-bar-info">
          <p className="top-bar-eyebrow">UTP Smart Spell Checker</p>
          <h1 className="top-bar-title" title={documentName}>{documentName}</h1>
        </div>

        <button
          className="menu-toggle"
          style={{ width: '40px', height: '40px', marginRight: '4px' }}
          onClick={() => setIsSettingsOpen(true)}
          title="Ajustes"
          type="button"
        >
          <IconSettings />
        </button>

        <button
          type="button"
          className={`menu-toggle ${isSheetOpen ? 'is-open' : ''}`}
          onClick={() => setIsSheetOpen(!isSheetOpen)}
          aria-label={isSheetOpen ? 'Cerrar menú' : 'Abrir menú'}
          aria-expanded={isSheetOpen}
        >
          <div className="menu-toggle-icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </button>
      </header>

      {/* ---- Editor ---- */}
      <div
        className={`editor-stage ${isDragActive ? 'is-drag-active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => {
          void handleDrop(event);
        }}
      >
        <div className={`editor-toolbar ${documentStatus === 'dirty' ? 'has-changes' : ''}`}>
          <span className="editor-toolbar-dot" aria-hidden="true" />
          <span>{documentStatus === 'dirty' ? 'Sin guardar' : statusMessage}</span>
        </div>

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
            onPaste={handlePaste}
            onClick={handleEditorClick}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              syncEditorText();
            }}
            data-placeholder="Escribe o abre un archivo de texto..."
          />
        </div>
      </div>

      {/* ---- Suggestion Popup ---- */}
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
              <li className="no-suggestions">Sin sugerencias</li>
            ) : (
              candidates.slice(0, 7).map((candidate, index) => (
                <li key={`${candidate}-${index}`}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => replaceWord(candidate)}
                  >
                    {candidate}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}

      {/* ---- Bottom Sheet Backdrop ---- */}
      <div
        className={`sheet-backdrop ${isSheetOpen ? 'is-visible' : ''}`}
        onClick={() => setIsSheetOpen(false)}
        onTouchEnd={() => setIsSheetOpen(false)}
        aria-hidden="true"
      />

      {/* ---- Bottom Sheet ---- */}
      <div
        className={`bottom-sheet ${isSheetOpen ? 'is-open' : ''}`}
        role="dialog"
        aria-label="Opciones del documento"
      >
        <div className="sheet-handle" aria-hidden="true" />

        {/* File info */}
        <div className="sheet-section">
          <p className="sheet-section-label">Documento</p>
          <div className="sheet-file-info">
            <h2 className="sheet-file-name">{documentName}</h2>
            <p className="sheet-file-status">{statusMessage}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="sheet-section">
          <p className="sheet-section-label">Acciones</p>
          <div className="sheet-actions">
            <button
              type="button"
              className="sheet-action-btn"
              onClick={openTextFile}
            >
              <IconFolder />
              Abrir
            </button>
            {!isRichText && (
              <button
                type="button"
                className="sheet-action-btn primary"
                onClick={() => void saveTextFile()}
              >
                <IconSave />
                Guardar
              </button>
            )}
            <button
              type="button"
              className="sheet-action-btn"
              onClick={() => void saveAsTextFile()}
            >
              <IconCopy />
              Guardar copia
            </button>
            <button
              type="button"
              className="sheet-action-btn"
              onClick={newDocument}
            >
              <IconFilePlus />
              Nuevo
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="sheet-section">
          <p className="sheet-section-label">Estadísticas</p>
          <div className="sheet-stats">
            <div className="stat-card">
              <strong>{formatCount(stats.words)}</strong>
              <span>palabras</span>
            </div>
            <div className="stat-card">
              <strong>{formatCount(stats.characters)}</strong>
              <span>caracteres</span>
            </div>
            <div className={`stat-card ${stats.issues > 0 ? 'has-issues' : ''}`}>
              <strong>{formatCount(stats.issues)}</strong>
              <span>marcas</span>
            </div>
          </div>
        </div>
      </div>
      {/* --- Settings Modal --- */}
      {isSettingsOpen && (
        <div className="settings-modal">
          <div className="settings-header">
            <h2>Ajustes</h2>
            <button className="settings-close-btn" onClick={() => setIsSettingsOpen(false)}>
              ✕
            </button>
          </div>
          <div className="settings-content">
            
            <div className="settings-section">
              <h3>Tema de Color</h3>
              <div className="theme-swatches">
                {[
                  { id: 'emerald', color: '#10b981' },
                  { id: 'sapphire', color: '#3b82f6' },
                  { id: 'amethyst', color: '#8b5cf6' },
                  { id: 'ruby', color: '#f43f5e' },
                  { id: 'amber', color: '#f59e0b' }
                ].map(t => (
                  <button 
                    key={t.id}
                    className={`swatch ${theme === t.id ? 'is-active' : ''}`}
                    style={{ background: t.color, borderColor: theme === t.id ? `var(--ink)` : 'transparent' }}
                    onClick={() => setTheme(t.id)}
                    title={t.id}
                  />
                ))}
              </div>
            </div>

            <div className="settings-section">
              <h3>Idioma / Language</h3>
              <select className="select-input" value={language} onChange={e => setLanguage(e.target.value)}>
                <option value="es">Español (Norvig)</option>
                <option value="en">English (Norvig)</option>
              </select>
            </div>

            <div className="settings-section">
              <h3>Archivos Recientes</h3>
              {recentFiles.length === 0 ? (
                <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem' }}>No hay archivos recientes.</p>
              ) : (
                <div className="recent-files-list">
                  {recentFiles.map((file, idx) => (
                    <div key={idx} className="recent-file-item" onClick={() => { setEditorText(file.text, file.name, null); setIsSettingsOpen(false); }}>
                      <div className="recent-file-name">{file.name}</div>
                      <div className="recent-file-date">{file.date}</div>
                    </div>
                  ))}
                  <button 
                    className="clear-recent-btn" 
                    onClick={() => { setRecentFiles([]); localStorage.removeItem('recentFiles'); }}
                  >
                    Limpiar Historial
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

export default App;
