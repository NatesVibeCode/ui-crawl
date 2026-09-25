import { describe, it, expect } from 'vitest';
import { dedupeRequests, isApiRequest, apiUrlKey } from '../src/capture.js';

describe('dedupeRequests', () => {
  it('removes exact duplicates', () => {
    expect(
      dedupeRequests([
        { url: 'http://x/api', status: 500 },
        { url: 'http://x/api', status: 500 },
      ]),
    ).toEqual([{ url: 'http://x/api', status: 500 }]);
  });

  it('preserves distinct failure reasons for the same url', () => {
    expect(
      dedupeRequests([
        { url: 'http://x/api', failure: 'net::ERR_ABORTED' },
        { url: 'http://x/api', failure: 'net::ERR_CONNECTION_REFUSED' },
      ]),
    ).toEqual([
      { url: 'http://x/api', failure: 'net::ERR_ABORTED' },
      { url: 'http://x/api', failure: 'net::ERR_CONNECTION_REFUSED' },
    ]);
  });
});

describe('isApiRequest / apiUrlKey', () => {
  it('counts xhr/fetch and non-GET documents', () => {
    expect(isApiRequest('xhr', 'GET')).toBe(true);
    expect(isApiRequest('fetch', 'POST')).toBe(true);
    expect(isApiRequest('document', 'POST')).toBe(true);
    expect(isApiRequest('document', 'GET')).toBe(false);
    expect(isApiRequest('script', 'GET')).toBe(false);
    expect(isApiRequest('image', 'GET')).toBe(false);
  });

  it('strips origin for same-origin, keeps absolute for cross-origin', () => {
    expect(apiUrlKey('https://app.test/api/v1?a=1', 'https://app.test')).toBe('/api/v1?a=1');
    expect(apiUrlKey('https://cdn.test/x', 'https://app.test')).toBe('https://cdn.test/x');
    expect(apiUrlKey('not a url', 'https://app.test')).toBe('not a url');
  });
});
