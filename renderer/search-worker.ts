import { searchFiles, type SearchableFile } from './file-search.ts';

type IndexedFile = SearchableFile & { index: number };
type Inbound = { files: IndexedFile[] } | { id: number; query: string; files?: undefined };

let files: IndexedFile[] = [];
self.onmessage = ({ data }: MessageEvent<Inbound>) => {
  if (data.files) files = data.files;
  else {
    const matches = searchFiles(files, data.query);
    self.postMessage({
      id: data.id,
      matches: matches.map(({ file, positions }) => ({ index: file.index, positions })),
    });
  }
};
