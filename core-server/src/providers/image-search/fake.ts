import type { ImageResult, ImageSearchProvider } from '../types';

export interface FakeImageSearchOptions {
  onSearch?: (query: string) => void;
  failWith?: Error;
  results?: (query: string, limit: number) => ImageResult[];
}

export function createFakeImageSearchProvider(opts: FakeImageSearchOptions = {}): ImageSearchProvider & {
  searchCalls: string[];
} {
  const searchCalls: string[] = [];

  async function search(query: string, limit = 10): Promise<ImageResult[]> {
    searchCalls.push(query);
    opts.onSearch?.(query);
    if (opts.failWith) throw opts.failWith;
    if (opts.results) return opts.results(query, limit);
    return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
      id: `fake-${query}-${i}`,
      thumbUrl: `https://fake.example/thumb/${query}/${i}`,
      sourceUrl: `https://fake.example/full/${query}/${i}`,
      source: 'fake',
    }));
  }

  return { search, searchCalls };
}
