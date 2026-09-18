import type { ImageResult, ImageSearchProvider } from '../types';

interface UnsplashPhoto {
  id: string;
  urls: { thumb: string; regular: string; full: string };
  links: { html: string };
}

interface UnsplashSearchResponse {
  results: UnsplashPhoto[];
}

/**
 * Unsplash-backed ImageSearchProvider (crmex.md §6), calling
 * GET https://api.unsplash.com/search/photos per Unsplash's documented API.
 * Never exercised by tests with a real key — tests use
 * providers/image-search/fake.ts via IMAGE_SEARCH_PROVIDER=fake.
 */
export function createUnsplashImageSearchProvider(accessKey: string): ImageSearchProvider {
  async function search(query: string, limit = 10): Promise<ImageResult[]> {
    const url = new URL('https://api.unsplash.com/search/photos');
    url.searchParams.set('query', query);
    url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 30)));

    const response = await fetch(url, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });
    if (!response.ok) {
      throw new Error(`Unsplash search failed: ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as UnsplashSearchResponse;
    return body.results.map((photo) => ({
      id: photo.id,
      thumbUrl: photo.urls.thumb,
      sourceUrl: photo.urls.regular,
      source: 'unsplash',
    }));
  }

  return { search };
}
