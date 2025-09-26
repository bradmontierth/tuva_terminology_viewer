import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Search, Download, FileText, Loader2, RefreshCcw } from 'lucide-react';
import SearchWorkerClient from './lib/SearchWorkerClient';
import './csvviewer.css';

const DATASET_INDEX_PATH = `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/data/sqlite/datasets.json`;
const DEFAULT_PREVIEW_LIMIT = 1000;
const SEARCH_DEBOUNCE_MS = 200;
const MAX_RESULTS = 50;

const formatHeader = (value) => {
  if (!value) {
    return '';
  }
  return value
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

const buildTableRows = (rows = [], headers = []) => {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row, index) => {
    const record = Array.isArray(row)
      ? headers.reduce((acc, header, columnIndex) => {
        acc[header] = row[columnIndex] ?? null;
        return acc;
      }, {})
      : row;
    return {
      key: index,
      values: headers.map((header) => (record?.[header] ?? null)),
      raw: record,
    };
  });
};

const useDebouncedValue = (value, delay) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
};

const emptySearchState = {
  items: [],
  total: 0,
  bytesFetched: 0,
  elapsedMs: 0,
  shardsSearched: [],
};

function CSVViewer() {
  const [datasets, setDatasets] = useState([]);
  const [datasetIndexBase, setDatasetIndexBase] = useState(null);
  const [datasetError, setDatasetError] = useState(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [manifestUrl, setManifestUrl] = useState(null);
  const [manifestError, setManifestError] = useState(null);
  const [preview, setPreview] = useState({ columns: [], rows: [], generatedAt: null });
  const [previewError, setPreviewError] = useState(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [pendingQuery, setPendingQuery] = useState('');
  const debouncedQuery = useDebouncedValue(pendingQuery, SEARCH_DEBOUNCE_MS);
  const [searchState, setSearchState] = useState(emptySearchState);
  const [searchStatus, setSearchStatus] = useState('idle');
  const [searchError, setSearchError] = useState(null);
  const [activeRequestId, setActiveRequestId] = useState(null);
  const workerClientRef = useRef(null);
  const latestRequestIdRef = useRef(null);
  const workerInitVersionRef = useRef(0);

  useEffect(() => () => {
    if (workerClientRef.current) {
      workerClientRef.current.terminate();
      workerClientRef.current = null;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadDatasets = async () => {
      try {
        const response = await fetch(DATASET_INDEX_PATH, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load dataset index (${response.status})`);
        }
        const payload = await response.json();
        if (!Array.isArray(payload)) {
          throw new Error('Dataset index format is invalid.');
        }
        if (!isMounted) {
          return;
        }
        const baseUrl = new URL('./', response.url).toString();
        setDatasetIndexBase(baseUrl);
        setDatasets(payload);
        setDatasetError(null);
        if (payload.length && !selectedDatasetId) {
          setSelectedDatasetId(payload[0].datasetId);
        }
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setDatasetError(error.message || 'Unable to load dataset index.');
        setDatasets([]);
      }
    };
    loadDatasets();
    return () => {
      isMounted = false;
    };
  }, [selectedDatasetId]);

  const selectedDataset = useMemo(
    () => datasets.find((entry) => entry.datasetId === selectedDatasetId) || null,
    [datasets, selectedDatasetId],
  );

  const resolveManifestUrl = useCallback(() => {
    if (!datasetIndexBase || !selectedDataset) {
      return null;
    }
    return new URL(selectedDataset.manifest, datasetIndexBase).toString();
  }, [datasetIndexBase, selectedDataset]);

  useEffect(() => {
    let isMounted = true;
    const loadManifest = async () => {
      const url = resolveManifestUrl();
      if (!url) {
        setManifest(null);
        setManifestUrl(null);
        return;
      }
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load manifest (${response.status})`);
        }
        const payload = await response.json();
        if (!isMounted) {
          return;
        }
        setManifest(payload);
        setManifestUrl(url);
        setManifestError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setManifest(null);
        setManifestUrl(null);
        setManifestError(error.message || 'Unable to load dataset manifest.');
      }
    };
    loadManifest();
    return () => {
      isMounted = false;
    };
  }, [resolveManifestUrl]);

  const initializeWorker = useCallback(async (currentManifest) => {
    if (!manifestUrl || !currentManifest) {
      return;
    }
    if (!workerClientRef.current) {
      workerClientRef.current = new SearchWorkerClient();
    }

    const initVersion = workerInitVersionRef.current + 1;
    workerInitVersionRef.current = initVersion;

    try {
      await workerClientRef.current.init({
        datasetId: currentManifest.datasetId,
        manifestUrl,
        manifest: currentManifest,
        bytesBudget: 12 * 1024 * 1024,
      });
      if (workerInitVersionRef.current === initVersion) {
        setSearchError(null);
      }
    } catch (error) {
      if (workerInitVersionRef.current === initVersion) {
        setSearchError(error.message || 'Failed to initialise search worker.');
      }
    }
  }, [manifestUrl]);

  useEffect(() => {
    if (!manifest) {
      setPreview({ columns: [], rows: [], generatedAt: null });
      setSearchState(emptySearchState);
      setSearchStatus('idle');
      setSearchError(null);
      return;
    }

    initializeWorker(manifest);

    let isMounted = true;
    const loadPreview = async () => {
      if (!manifest.preview?.url) {
        setPreview({ columns: manifest.narrowColumns || [], rows: [], generatedAt: null });
        return;
      }
      setIsPreviewLoading(true);
      setPreviewError(null);
      try {
        const previewUrl = new URL(manifest.preview.url, manifestUrl).toString();
        const response = await fetch(previewUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load preview (${response.status})`);
        }
        const payload = await response.json();
        if (!isMounted) {
          return;
        }
        const columns = Array.isArray(payload.columns) && payload.columns.length
          ? payload.columns
          : manifest.narrowColumns || [];
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        setPreview({
          columns,
          rows,
          generatedAt: payload.generatedAt || manifest.generatedAt || null,
        });
      } catch (error) {
        if (!isMounted) {
          return;
        }
        setPreview({ columns: manifest.narrowColumns || [], rows: [], generatedAt: null });
        setPreviewError(error.message || 'Unable to load preview data.');
      } finally {
        if (isMounted) {
          setIsPreviewLoading(false);
        }
      }
    };

    loadPreview();

    return () => {
      isMounted = false;
    };
  }, [manifest, manifestUrl, initializeWorker]);

  const handleSearch = useCallback((query) => {
    const client = workerClientRef.current;
    if (!client || !manifest) {
      return;
    }
    if (!query.trim()) {
      setSearchState(emptySearchState);
      setSearchStatus('idle');
      setSearchError(null);
      latestRequestIdRef.current = null;
      return;
    }

    setSearchStatus('loading');
    setSearchError(null);
    const { requestId, promise } = client.search(query, {
      limit: MAX_RESULTS,
      onUpdate: (data) => {
        if (latestRequestIdRef.current !== data.requestId) {
          return;
        }
        if (data.partial) {
          setSearchState({
            items: data.items,
            total: data.total,
            bytesFetched: data.bytesFetched,
            elapsedMs: data.elapsedMs,
            shardsSearched: data.shardsSearched || [],
          });
        }
      },
    });

    latestRequestIdRef.current = requestId;
    setActiveRequestId(requestId);

    promise
      .then((data) => {
        if (latestRequestIdRef.current !== data.requestId) {
          return;
        }
        setSearchState({
          items: data.items,
          total: data.total,
          bytesFetched: data.bytesFetched,
          elapsedMs: data.elapsedMs,
          shardsSearched: data.shardsSearched || [],
        });
        setSearchStatus('ready');
      })
      .catch((error) => {
        if (latestRequestIdRef.current !== requestId) {
          return;
        }
        setSearchError(error.message || 'Search failed.');
        setSearchState(emptySearchState);
        setSearchStatus('error');
      });
  }, [manifest]);

  useEffect(() => {
    if (!manifest) {
      return;
    }
    handleSearch(debouncedQuery);
  }, [debouncedQuery, manifest, handleSearch]);

  const clearDownloadedData = useCallback(() => {
    if (workerClientRef.current) {
      workerClientRef.current.clearCache();
    }
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          if (key.startsWith('sqlite-pages')) {
            caches.delete(key);
          }
        });
      });
    }
    if (navigator?.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage('clear-cache');
    }
  }, []);

  const activeColumns = useMemo(() => {
    if (searchStatus === 'ready' && searchState.items.length) {
      const sample = searchState.items[0];
      const columns = Object.keys(sample).filter((key) => key !== 'rowid');
      return columns;
    }
    return preview.columns;
  }, [searchStatus, searchState.items, preview.columns]);

  const displayHeaders = useMemo(
    () => activeColumns.map(formatHeader),
    [activeColumns],
  );

  const previewRows = useMemo(
    () => buildTableRows(preview.rows.slice(0, DEFAULT_PREVIEW_LIMIT), preview.columns),
    [preview.rows, preview.columns],
  );

  const searchRows = useMemo(
    () => buildTableRows(
      searchState.items.map((item) => {
        const row = { ...item };
        delete row.rowid;
        return row;
      }),
      activeColumns,
    ),
    [searchState.items, activeColumns],
  );

  const downloadUrl = useMemo(() => {
    if (!manifest || !manifest.resources?.length) {
      return null;
    }
    const primary = manifest.resources[0];
    return new URL(primary.url, manifestUrl).toString();
  }, [manifest, manifestUrl]);

  return (
    <div className="csv-viewer">
      <header className="csv-viewer__header">
        <div className="csv-viewer__title">
          <FileText size={20} />
          <h1>Tuva Terminology Viewer</h1>
        </div>
        <div className="csv-viewer__actions">
          {downloadUrl && (
            <a
              className="csv-viewer__button"
              href={downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={16} />
              Download Index
            </a>
          )}
          <button type="button" className="csv-viewer__button" onClick={clearDownloadedData}>
            <RefreshCcw size={16} />
            Clear Downloaded Data
          </button>
        </div>
      </header>

      <section className="csv-viewer__controls">
        <div className="csv-viewer__control">
          <label htmlFor="dataset-select">Dataset</label>
          <select
            id="dataset-select"
            value={selectedDatasetId || ''}
            onChange={(event) => setSelectedDatasetId(event.target.value)}
          >
            {datasets.map((entry) => (
              <option key={entry.datasetId} value={entry.datasetId}>
                {entry.label || entry.datasetId}
              </option>
            ))}
          </select>
        </div>
        <div className="csv-viewer__control csv-viewer__control--search">
          <label htmlFor="dataset-search">Search</label>
          <div className="csv-viewer__search-box">
            <Search size={16} />
            <input
              id="dataset-search"
              type="search"
              value={pendingQuery}
              onChange={(event) => setPendingQuery(event.target.value)}
              placeholder="Search codes, descriptions, etc."
            />
            {searchStatus === 'loading' && <Loader2 className="csv-viewer__spinner" size={14} />}
          </div>
        </div>
      </section>

      {datasetError && <div className="csv-viewer__error">{datasetError}</div>}
      {manifestError && <div className="csv-viewer__error">{manifestError}</div>}
      {previewError && <div className="csv-viewer__warning">{previewError}</div>}
      {searchError && <div className="csv-viewer__error">{searchError}</div>}

      <section className="csv-viewer__summary">
        {manifest && (
          <ul>
            <li><strong>Rows:</strong> {manifest.rowCount.toLocaleString()}</li>
            <li><strong>Columns:</strong> {displayHeaders.length}</li>
            <li><strong>Shards:</strong> {manifest.shardCount}</li>
            {searchStatus === 'ready' && (
              <>
                <li><strong>Results:</strong> {searchState.total}</li>
                <li><strong>Query Time:</strong> {searchState.elapsedMs.toFixed(1)} ms</li>
                <li><strong>Bytes:</strong> {(searchState.bytesFetched / 1024).toFixed(1)} KB</li>
              </>
            )}
          </ul>
        )}
      </section>

      <section className="csv-viewer__table">
        <table>
          <thead>
            <tr>
              {displayHeaders.map((header) => (
                <th key={header}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {searchStatus !== 'idle' && searchRows.length > 0 && (
              searchRows.map((row) => (
                <tr key={`search-${row.key}`}>
                  {row.values.map((value, index) => (
                    <td key={`search-${row.key}-${index}`}>{value}</td>
                  ))}
                </tr>
              ))
            )}
            {searchStatus === 'idle' && previewRows.length > 0 && !isPreviewLoading && (
              previewRows.map((row) => (
                <tr key={`preview-${row.key}`}>
                  {row.values.map((value, index) => (
                    <td key={`preview-${row.key}-${index}`}>{value}</td>
                  ))}
                </tr>
              ))
            )}
            {((searchStatus === 'idle' && isPreviewLoading) || (searchStatus === 'loading' && !searchRows.length)) && (
              <tr>
                <td colSpan={displayHeaders.length} className="csv-viewer__loading">
                  <Loader2 size={18} className="csv-viewer__spinner" />
                  Loading data…
                </td>
              </tr>
            )}
            {searchStatus === 'ready' && !searchRows.length && (
              <tr>
                <td colSpan={displayHeaders.length} className="csv-viewer__empty">
                  No matches for “{debouncedQuery}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default CSVViewer;
