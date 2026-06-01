import * as mammoth from 'mammoth';

export interface FileLoaderResult {
  text: string;
  isRichText: boolean;
}

export interface FileLoader {
  accepts(file: File): boolean;
  load(file: File): Promise<FileLoaderResult>;
}

export class PlainTextLoader implements FileLoader {
  accepts(file: File): boolean {
    return file.type.startsWith('text/') || file.type === '' || /\.(txt|md|markdown|csv|log|json|xml|html|yml|yaml|ini|conf)$/i.test(file.name);
  }

  async load(file: File): Promise<FileLoaderResult> {
    const text = await file.text();
    return { text, isRichText: false };
  }
}

export class DocxLoader implements FileLoader {
  accepts(file: File): boolean {
    return file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || 
           /\.docx$/i.test(file.name);
  }

  async load(file: File): Promise<FileLoaderResult> {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return { text: result.value, isRichText: true };
  }
}

// Registry of available loaders
const loaders: FileLoader[] = [
  new DocxLoader(),
  new PlainTextLoader(), // Fallback for plain text
];

export async function loadFileContent(file: File): Promise<FileLoaderResult> {
  for (const loader of loaders) {
    if (loader.accepts(file)) {
      return await loader.load(file);
    }
  }
  throw new Error(`No existe un cargador compatible para el archivo: ${file.name}`);
}
