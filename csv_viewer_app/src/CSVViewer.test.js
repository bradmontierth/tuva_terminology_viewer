import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CSVViewer from './CSVViewer';
import SearchWorkerClient from './lib/SearchWorkerClient';

jest.mock('./lib/SearchWorkerClient');

describe('CSVViewer', () => {
  const datasetIndexUrl = `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/data/sqlite/datasets.json`;
  const datasetIndexAbsoluteUrl = new URL(datasetIndexUrl, 'http://localhost').toString();

  const datasetIndex = [
    {
      datasetId: 'sample',
      label: 'Sample Dataset',
      manifest: './sample/manifest.json',
      generatedAt: '2025-01-01T00:00:00.000Z',
      rowCount: 4,
      shardCount: 1,
    },
  ];

  const manifest = {
    datasetId: 'sample',
    label: 'Sample Dataset',
    rowCount: 4,
    shardCount: 1,
    pageSizeBytes: 4096,
    narrowColumns: ['code', 'name', 'city'],
    resources: [
      {
        shard: 0,
        file: 'sample.sqlite',
        url: './sample.sqlite',
        routing: null,
        size: 1024,
        sha256: 'abc',
      },
    ],
    preview: {
      url: './preview.json',
      rows: 4,
    },
  };

  const preview = {
    datasetId: 'sample',
    generatedAt: '2025-01-01T00:00:00.000Z',
    columns: ['code', 'name', 'city'],
    rows: [
      ['1001', 'Alpha Clinic', 'Seattle'],
      ['1002', 'Beta Health', 'Portland'],
    ],
  };

  beforeEach(() => {
    SearchWorkerClient.__reset();
    global.fetch = jest.fn((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('datasets.json') || url === datasetIndexUrl || url === datasetIndexAbsoluteUrl) {
        const response = new window.Response(JSON.stringify(datasetIndex), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        Object.defineProperty(response, 'url', { value: datasetIndexAbsoluteUrl });
        return Promise.resolve(response);
      }
      if (url.endsWith('manifest.json')) {
        const response = new window.Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        const manifestUrl = new URL('./sample/manifest.json', datasetIndexAbsoluteUrl).toString();
        Object.defineProperty(response, 'url', { value: manifestUrl });
        return Promise.resolve(response);
      }
      if (url.endsWith('preview.json')) {
        const response = new window.Response(JSON.stringify(preview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        const previewUrl = new URL('./sample/preview.json', datasetIndexAbsoluteUrl).toString();
        Object.defineProperty(response, 'url', { value: previewUrl });
        return Promise.resolve(response);
      }
      return Promise.resolve(new window.Response('', { status: 404 }));
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
    SearchWorkerClient.__reset();
  });

  it('renders preview data after loading manifest', async () => {
    render(<CSVViewer />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(await screen.findByLabelText(/dataset/i)).toBeInTheDocument();
    expect(await screen.findByText('Alpha Clinic')).toBeInTheDocument();
    expect(await screen.findByText('Beta Health')).toBeInTheDocument();
  });

  it('executes search and displays streamed results', async () => {
    render(<CSVViewer />);

    await waitFor(() => expect(screen.getByLabelText(/dataset/i)).toBeInTheDocument());
    await screen.findByText('Alpha Clinic');

    const searchInput = screen.getByRole('searchbox');
    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, 'Zeta');

    // Allow debounce window
    await new Promise((resolve) => setTimeout(resolve, 250));

    const client = SearchWorkerClient.__getLatestInstance();
    expect(client).toBeTruthy();
    const [requestId] = Array.from(client.requestHandlers.keys());

    client.emitPartial(requestId, {
      items: [
        {
          rowid: 42,
          code: '9999',
          name: 'Zeta Clinic',
          city: 'Boise',
        },
      ],
      total: 1,
      bytesFetched: 8192,
      elapsedMs: 120,
      shardsSearched: [0],
    });

    client.resolve(requestId, {
      items: [
        {
          rowid: 42,
          code: '9999',
          name: 'Zeta Clinic',
          city: 'Boise',
        },
      ],
      total: 1,
      bytesFetched: 8192,
      elapsedMs: 120,
      shardsSearched: [0],
    });

    await waitFor(() => expect(screen.getByText('Zeta Clinic')).toBeInTheDocument());
    expect(screen.queryByText('Alpha Clinic')).not.toBeInTheDocument();
  });
});
