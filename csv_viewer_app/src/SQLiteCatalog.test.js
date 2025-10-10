import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CSVViewer from './CSVViewer';
import SearchWorkerClient from './lib/SearchWorkerClient';

// Mock the web worker client to avoid creating a real Worker in JSDOM
jest.mock('./lib/SearchWorkerClient', () => {
  return jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue({}),
    search: jest.fn().mockReturnValue({ requestId: 1, promise: Promise.resolve({ requestId: 1, items: [], total: 0 }) }),
    distinct: jest.fn().mockReturnValue({ requestId: 2, promise: Promise.resolve({ requestId: 2, items: [] }) }),
    count: jest.fn().mockReturnValue({ requestId: 3, promise: Promise.resolve({ requestId: 3, total: 0 }) }),
    clearCache: jest.fn(),
    terminate: jest.fn(),
  }));
});

// Minimal provider manifest + preview payloads
const providerManifest = {
  datasetId: 'provider',
  label: 'provider',
  rowCount: 1000000,
  shardCount: 1,
  pageSizeBytes: 4096,
  narrowColumns: [
    'npi',
    'entity_type_code',
    'entity_type_description',
    'primary_taxonomy_code',
  ],
  resources: [
    {
      shard: 0,
      file: 'provider.sqlite',
      size: 1024 * 1024,
      url: './provider.sqlite',
      routing: null,
      rowCount: 1000000,
    },
  ],
  preview: {
    url: './preview.json',
    rows: 10,
  },
};

const providerPreview = {
  datasetId: 'provider',
  generatedAt: new Date().toISOString(),
  columns: providerManifest.narrowColumns,
  rows: [
    ['1487222741', '2', 'Organization', '2080P0202X'],
    ['1063080208', '1', 'Individual', '235Z00000X'],
  ],
};

// Minimal S3 XML helpers
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
const listPrefixes = (bucketName, rootPrefix, prefixes) => (
  `${xmlHeader}\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n` +
  `  <Name>${bucketName}</Name>\n` +
  `  <Prefix>${rootPrefix}</Prefix>\n` +
  `  <Delimiter>/</Delimiter>\n` +
  `  <IsTruncated>false</IsTruncated>\n` +
  prefixes.map((p) => `  <CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('\n') +
  `\n</ListBucketResult>`
);

const listFiles = (bucketName, prefix, files) => (
  `${xmlHeader}\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n` +
  `  <Name>${bucketName}</Name>\n` +
  `  <Prefix>${prefix}</Prefix>\n` +
  `  <IsTruncated>false</IsTruncated>\n` +
  files.map((f) => `  <Contents><Key>${f}</Key></Contents>`).join('\n') +
  `\n</ListBucketResult>`
);

describe('SQLite catalog usage', () => {
  beforeEach(() => {
    // Mock fetch for datasets.json, provider manifest/preview, and S3 listings
    global.fetch = jest.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;

      // Local SQLite catalog
      if (url.endsWith('/data/sqlite/datasets.json') || url.includes('data/sqlite/datasets.json')) {
        return new Response(JSON.stringify([
          {
            datasetId: 'provider',
            label: 'provider',
            manifest: './provider/manifest.json',
            rowCount: 1000000,
            shardCount: 1,
          },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Provider manifest + preview
      if (url.endsWith('/data/sqlite/provider/manifest.json')) {
        return new Response(JSON.stringify(providerManifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/data/sqlite/provider/preview.json')) {
        return new Response(JSON.stringify(providerPreview), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      // Version listings (terminology + provider)
      if (url.includes('prefix=versioned_terminology%2F') && url.includes('delimiter=%2F')) {
        const body = listPrefixes('tuva-public-resources', 'versioned_terminology/', [
          'versioned_terminology/latest/',
          'versioned_terminology/0.14.2/',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }
      if (url.includes('prefix=versioned_provider_data%2F') && url.includes('delimiter=%2F')) {
        const body = listPrefixes('tuva-public-resources', 'versioned_provider_data/', [
          'versioned_provider_data/latest/',
          'versioned_provider_data/0.14.2/',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }

      // Files under a specific version
      if (url.includes('prefix=versioned_terminology%2F0.14.2%2F')) {
        const body = listFiles('tuva-public-resources', 'versioned_terminology/0.14.2/', [
          'versioned_terminology/0.14.2/admit_source.csv_0_0_0.csv.gz',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }
      if (url.includes('prefix=versioned_provider_data%2F0.14.2%2F')) {
        const body = listFiles('tuva-public-resources', 'versioned_provider_data/0.14.2/', [
          'versioned_provider_data/0.14.2/provider.csv_0_0_0.csv.gz',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }

      // For anything else return 404 to surface mistakes
      return new Response('', { status: 404 });
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('detects provider as SQLite-backed and loads preview rows', async () => {
    const user = userEvent.setup();
    render(<CSVViewer />);

    // Wait until version select appears to ensure listings loaded
    await screen.findByLabelText(/terminology version/i);

    // Switch to Provider group under Terminology tab
    // There should be a friendly name derived from provider.csv
    const providerButton = await screen.findByRole('button', { name: /provider/i });
    await user.click(providerButton);

    // Expect worker to be initialised for the provider dataset
    await waitFor(() => {
      expect(SearchWorkerClient).toHaveBeenCalled();
      const instance = SearchWorkerClient.mock.results[0]?.value;
      expect(instance?.init).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'provider' }));
    });

    // Expect preview rows (from provider preview) to be rendered
    await waitFor(() => {
      const tip = screen.getByText(/preview shows up to/i);
      expect(tip).toBeInTheDocument();
    });

    // Ensure at least one of the column headers or row values appears
    expect(await screen.findByText('Npi', undefined, { timeout: 3000 })).toBeInTheDocument();
  });

  it('uses the remote base when SQLITE_SOURCE=remote', async () => {
    // Force remote mode and provide a custom remote base
    process.env.REACT_APP_SQLITE_SOURCE = 'remote';
    process.env.REACT_APP_DATA_BASE_URL = 'https://my-bucket.example';

    const calls = [];
    global.fetch = jest.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);

      if (url === 'https://my-bucket.example/data/sqlite/datasets.json') {
        return new Response(JSON.stringify([
          {
            datasetId: 'provider',
            label: 'provider',
            manifest: './provider/manifest.json',
            rowCount: 1000000,
            shardCount: 1,
          },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/data/sqlite/provider/manifest.json')) {
        return new Response(JSON.stringify(providerManifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/data/sqlite/provider/preview.json')) {
        return new Response(JSON.stringify(providerPreview), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // Minimal set of version listing calls to let the UI mount
      if (url.includes('prefix=versioned_terminology%2F') && url.includes('delimiter=%2F')) {
        const body = listPrefixes('tuva-public-resources', 'versioned_terminology/', [
          'versioned_terminology/latest/',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }
      if (url.includes('prefix=versioned_provider_data%2F') && url.includes('delimiter=%2F')) {
        const body = listPrefixes('tuva-public-resources', 'versioned_provider_data/', [
          'versioned_provider_data/latest/',
        ]);
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }

      return new Response('', { status: 404 });
    });

    render(<CSVViewer />);

    // Ensure the first fetch attempt targeted the remote base
    await waitFor(() => {
      expect(calls.some((u) => u === 'https://my-bucket.example/data/sqlite/datasets.json')).toBe(true);
    });
  });
});
