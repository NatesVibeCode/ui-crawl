import { describe, it, expect } from 'vitest';
import { dedupeRequests } from '../src/capture.js';

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
