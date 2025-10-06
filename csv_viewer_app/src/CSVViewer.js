import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Download, FileText, Loader2 } from 'lucide-react';
import * as Papa from 'papaparse';
import pako from 'pako';
import JSZip from 'jszip';
import SearchWorkerClient from './lib/SearchWorkerClient';
import headerCrosswalkFallback from './generated/headerCrosswalk.json';
import fileIdentityCrosswalkFallback from './generated/fileIdentityCrosswalk.json';

const normalizeKey = (value = '') => value.trim().toLowerCase();

const arraysEqual = (a = [], b = []) => {
  if (a === b) {
    return true;
  }

  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
};

const CSV_TEXT_LIMIT = 5000000; // 5MB of text before limiting rows
const SQLITE_SEARCH_RESULT_LIMIT = 50;
// Increase default cache budget to reduce eviction churn on large shards
const SQLITE_BYTES_BUDGET = 128 * 1024 * 1024; // 128MB
const DEFAULT_BASE_DOMAIN = 'https://tuva-public-resources.s3.amazonaws.com';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const isPrivateIPv4 = (octets) => {
  if (!Array.isArray(octets) || octets.length !== 4) {
    return false;
  }
  const [a, b] = octets;
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return false;
  }
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
};

const isLocalHostname = (hostname = '') => {
  if (!hostname) {
    return false;
  }

  const normalised = hostname.trim().toLowerCase();
  if (!normalised) {
    return false;
  }

  if (LOCAL_HOSTNAMES.has(normalised)) {
    return true;
  }

  if (normalised.endsWith('.localhost') || normalised.endsWith('.local') || normalised.endsWith('.lan')) {
    return true;
  }

  if (normalised.includes(':')) {
    return normalised === '::1' || normalised.startsWith('fe80:') || normalised.startsWith('fd');
  }

  const ipv4Match = normalised.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((part) => Number(part));
    return isPrivateIPv4(octets);
  }

  return false;
};

const rawPublicUrl = (process.env.PUBLIC_URL || '').trim();

const resolvePublicPath = () => {
  if (!rawPublicUrl) {
    return '';
  }

  const normalise = (value) => value.replace(/\/$/, '');

  try {
    const base = typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'http://localhost';
    const absolute = new URL(rawPublicUrl, base);
    const path = absolute.pathname.replace(/\/+$/, '');
    return path === '/' ? '' : path;
  } catch (error) {
    const withLeading = rawPublicUrl.startsWith('/') ? rawPublicUrl : `/${rawPublicUrl}`;
    const trimmed = normalise(withLeading);
    return trimmed === '/' ? '' : trimmed;
  }
};

// Controls where the search worker fetches SQLite shards from while developing.
// Values:
//   - 'remote' – always use the remote manifest/shards (S3)
//   - 'local'  – always use local manifest/shards (public/data/sqlite)
//   - missing/other – default behaviour (prefer local on localhost)
const getSqliteSourceMode = () => {
  const mode = (process.env.REACT_APP_SQLITE_SOURCE || '').trim().toLowerCase();
  if (mode === 'remote' || mode === 'local') {
    return mode;
  }
  const forceRemote = (process.env.REACT_APP_SQLITE_FORCE_REMOTE || '').trim().toLowerCase();
  if (forceRemote === 'true' || forceRemote === '1' || forceRemote === 'yes') {
    return 'remote';
  }
  return 'auto';
};

const resolveBaseDomain = () => {
  const override = (process.env.REACT_APP_DATA_BASE_URL || '').trim();
  if (override) {
    try {
      if (override.startsWith('http://') || override.startsWith('https://')) {
        return new URL(override).toString().replace(/\/$/, '');
      }
      if (typeof window !== 'undefined') {
        return new URL(override, window.location.origin).toString().replace(/\/$/, '');
      }
    } catch (error) {
      // fall through to returning the raw override without crashing
    }
    return override.replace(/\/$/, '');
  }

  if (typeof window !== 'undefined' && window.location) {
    const { hostname, origin } = window.location;
    if (isLocalHostname(hostname)) {
      return origin.replace(/\/$/, '');
    }
  }

  return DEFAULT_BASE_DOMAIN;
};

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

const useDebouncedValue = (value, delay, resetKey = null, resetTo = undefined) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  // If resetKey changes (e.g., dataset switch), flush immediately to current value.
  useEffect(() => {
    if (resetTo !== undefined) {
      setDebounced(resetTo);
    } else {
      setDebounced(value);
    }
  }, [resetKey]);
  return debounced;
};

const isZipFileName = (fileName = '') => fileName.toLowerCase().endsWith('.zip');

const hasZipSignature = (arrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 4));
  if (bytes.length < 4) {
    return false;
  }
  const matchesPK = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!matchesPK) {
    return false;
  }
  return [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3]);
};

const extractCsvFromZip = async (arrayBuffer, preferredName = '') => {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);

  if (!entries.length) {
    throw new Error('ZIP archive has no files');
  }

  const csvEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.csv'));
  if (!csvEntries.length) {
    throw new Error('ZIP archive does not contain CSV files');
  }

  const preferredBase = preferredName.replace(/\.zip$/i, '').toLowerCase();
  const matchedEntry = preferredBase
    ? csvEntries.find((entry) => entry.name.toLowerCase().includes(preferredBase))
    : null;

  const targetEntry = matchedEntry || csvEntries[0];
  const csvString = await targetEntry.async('string');
  return { csvString, entryName: targetEntry.name };
};

const deriveDatasetId = (fileName) => {
  if (!fileName) {
    return null;
  }
  let base = fileName;
  if (base.endsWith('.gz')) {
    base = base.slice(0, -3);
  }
  if (base.endsWith('.zip')) {
    base = base.slice(0, -4);
  }
  while (base.endsWith('.csv')) {
    base = base.slice(0, -4);
  }
  const chunkMatch = base.match(/(.+?)_\d+_\d+_\d+$/);
  if (chunkMatch) {
    base = chunkMatch[1];
  }
  if (base.endsWith('.csv')) {
    base = base.slice(0, -4);
  }
  return base || null;
};

export default function CSVViewer() {
  const baseDomain = useMemo(resolveBaseDomain, []);
  const default_folder = 'versioned_terminology';
  const provider_folder = 'versioned_provider_data';
  const value_sets_folder = 'versioned_value_sets';
  const reference_data_folder = 'reference-data';

  const dataCategories = useMemo(() => ([
    {
      id: 'terminology',
      label: 'Terminology',
      versionLabel: 'Terminology version',
      sources: [
        { folder: default_folder, type: 'versioned' },
        { folder: provider_folder, type: 'versioned' }
      ]
    },
    {
      id: 'value-sets',
      label: 'Value Sets',
      versionLabel: 'Value set version',
      sources: [
        { folder: value_sets_folder, type: 'versioned' }
      ]
    },
    {
      id: 'reference-data',
      label: 'Reference Data',
      versionLabel: null,
      sources: [
        {
          folder: reference_data_folder,
          type: 'unversioned',
          excludedPrefixes: [`${reference_data_folder}/2022 Census Shapefiles/`]
        }
      ]
    }
  ]), [default_folder, provider_folder, value_sets_folder, reference_data_folder]);

  const versionedFolders = useMemo(() => new Set(
    dataCategories.flatMap((category) =>
      category.sources.filter((source) => source.type === 'versioned').map((source) => source.folder)
    )
  ), [dataCategories]);

  const [csvData, setCsvData] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [columnCount, setColumnCount] = useState(0);
  const [defaultHeaders, setDefaultHeaders] = useState([]);
  const [headerCrosswalk, setHeaderCrosswalk] = useState(() => {
    if (headerCrosswalkFallback && typeof headerCrosswalkFallback === 'object') {
      return headerCrosswalkFallback;
    }
    return null;
  });
  const [identityCrosswalk, setIdentityCrosswalk] = useState(() => {
    if (fileIdentityCrosswalkFallback && typeof fileIdentityCrosswalkFallback === 'object') {
      return fileIdentityCrosswalkFallback;
    }
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentFileName, setCurrentFileName] = useState(null);
  const [currentFileFolder, setCurrentFileFolder] = useState(default_folder);
  const [fileGroups, setFileGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTerm, setFilterTerm] = useState('');
  const [pageSize, setPageSize] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortColumnIndex, setSortColumnIndex] = useState(null);
  const [sortDirection, setSortDirection] = useState(null); // 'asc' | 'desc' | null
  const [isPartialData, setIsPartialData] = useState(false);
  const [terminologyVersion, setTerminologyVersion] = useState(null);
  const [terminologyVersions, setTerminologyVersions] = useState([]);
  const [activeCategoryId, setActiveCategoryId] = useState(dataCategories[0].id);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionLoadError, setVersionLoadError] = useState(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileLoadError, setFileLoadError] = useState(null);
  const [searchMode, setSearchMode] = useState('inMemory');
  const [searchStatus, setSearchStatus] = useState('idle');
  const [searchError, setSearchError] = useState(null);
  const [searchSummary, setSearchSummary] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [isCrosswalkOpen, setIsCrosswalkOpen] = useState(false);
  const [manifest, setManifest] = useState(null);
  const [manifestUrl, setManifestUrl] = useState(null);
  const [sqliteCatalogError, setSqliteCatalogError] = useState(null);
  const [sqliteCatalogVersion, setSqliteCatalogVersion] = useState(0);
  const [sqliteCatalogReady, setSqliteCatalogReady] = useState(false);
  const [sqlitePreview, setSqlitePreview] = useState({ columns: [], rows: [], generatedAt: null });
  // Control whether to fetch crosswalk JSONs from network; default prod-only
  const shouldFetchCrosswalks = useMemo(() => {
    const raw = (process.env.REACT_APP_FETCH_CROSSWALKS || '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes') return true;
    if (raw === '0' || raw === 'false' || raw === 'no') return false;
    return process.env.NODE_ENV === 'production';
  }, []);
  const offlineMode = useMemo(() => {
    const raw = (process.env.REACT_APP_OFFLINE_MODE || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
  }, []);
  const identityLiveEnabled = useMemo(() => {
    const raw = (process.env.REACT_APP_IDENTITY_LIVE || '').trim().toLowerCase();
    if (offlineMode) return false;
    if (raw === '0' || raw === 'false' || raw === 'no') return false;
    if (raw === '1' || raw === 'true' || raw === 'yes') return true;
    // Default: if we are fetching crosswalks, prefer not to do live identity checks
    return !shouldFetchCrosswalks;
  }, [offlineMode, shouldFetchCrosswalks]);
  // Cache for S3 object ETags and sizes keyed by full key path
  const etagCacheRef = useRef(new Map());
  // Tracks sameness across versions for the selected file
  const [fileIdentity, setFileIdentity] = useState({ status: 'idle', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
  const userSelectedVersionRef = useRef(false);
  const listingBaseRef = useRef(null);
  const workerClientRef = useRef(null);
  const workerInitVersionRef = useRef(0);
  const latestSearchRequestRef = useRef(null);
  const sqliteCatalogRef = useRef(new Map());
  const suppressNextAutoSearchRef = useRef(false);

  const activeCategory = useMemo(
    () => dataCategories.find((category) => category.id === activeCategoryId) || dataCategories[0],
    [dataCategories, activeCategoryId]
  );
  const versionedSources = useMemo(
    () => activeCategory.sources.filter((source) => source.type === 'versioned'),
    [activeCategory]
  );
  const hasVersionedSources = versionedSources.length > 0;

  const currentDatasetId = useMemo(() => deriveDatasetId(currentFileName), [currentFileName]);
  const debouncedFilterTerm = useDebouncedValue(filterTerm, 250, currentDatasetId, '');
  const sqliteEntry = useMemo(() => {
    if (!currentDatasetId) {
      return null;
    }
    return sqliteCatalogRef.current.get(currentDatasetId) || null;
  }, [currentDatasetId, sqliteCatalogVersion]);

  // Identify the most recent concrete version (excluding symbolic 'latest') for the active folder
  const latestConcreteVersion = useMemo(() => {
    const isLatest = (v) => String(v || '').trim().toLowerCase() === 'latest';
    if (!currentFileFolder || !identityCrosswalk) {
      return null;
    }
    const folderEntry = identityCrosswalk[currentFileFolder];
    const fromFolder = (folderEntry && Array.isArray(folderEntry.versions))
      ? folderEntry.versions
      : (identityCrosswalk?._meta?.versionsPerFolder?.[currentFileFolder] || []);
    const versions = Array.isArray(fromFolder) ? fromFolder : [];
    const firstConcrete = versions.find((v) => !isLatest(v));
    return firstConcrete || null;
  }, [currentFileFolder, identityCrosswalk]);

  // Determine if the SQLite index (built on latest content) matches the selected version's content
  const sqliteIndexCompatible = useMemo(() => {
    const isLatest = (v) => String(v || '').trim().toLowerCase() === 'latest';
    const normalizeBaseCsv = (name = '') => {
      const normalized = String(name || '').trim();
      if (!normalized) return '';
      const m = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
      if (m) return m[1].toLowerCase();
      if (/\.csv\.gz$/i.test(normalized)) return normalized.replace(/\.csv\.gz$/i, '.csv').toLowerCase();
      return normalized.toLowerCase();
    };
    if (!sqliteEntry) {
      return false;
    }
    if (!versionedFolders.has(currentFileFolder)) {
      return true;
    }
    if (!terminologyVersion) {
      return true;
    }
    if (isLatest(terminologyVersion)) {
      return true;
    }
    const folderEntry = identityCrosswalk && identityCrosswalk[currentFileFolder];
    const baseName = normalizeBaseCsv(currentFileName);
    const group = folderEntry && folderEntry.groups && folderEntry.groups[baseName];
    if (!group) {
      // No identity info – be permissive to avoid blocking
      return true;
    }
    const latestV = latestConcreteVersion;
    if (!latestV) {
      return true;
    }
    const history = Array.isArray(group.history) ? group.history : [];
    const selectedEntry = history.find((h) => h && h.version === terminologyVersion);
    const latestEntry = history.find((h) => h && h.version === latestV);
    if (selectedEntry?.signature && latestEntry?.signature) {
      return selectedEntry.signature === latestEntry.signature;
    }
    const runs = Array.isArray(group.runs) ? group.runs : [];
    if (runs.length) {
      const run = runs.find((r) => Array.isArray(r.versions) && r.versions.includes(terminologyVersion));
      if (run && Array.isArray(run.versions)) {
        return run.versions.includes(latestV);
      }
    }
    return true;
  }, [sqliteEntry, versionedFolders, currentFileFolder, terminologyVersion, identityCrosswalk, currentFileName, latestConcreteVersion]);

  const initializeWorker = useCallback(async (manifestPayload, manifestHref) => {
    if (!manifestPayload || !manifestHref) {
      return;
    }

    if (!workerClientRef.current) {
      workerClientRef.current = new SearchWorkerClient();
    }

    const initVersion = workerInitVersionRef.current + 1;
    workerInitVersionRef.current = initVersion;

    try {
      // Use env to control whether we use local or remote shards in dev.
      // Default behaviour (auto): on localhost, prefer local shards; otherwise keep remote.
      const sourceMode = getSqliteSourceMode();
      let effectiveManifestHref = manifestHref;
      if (sourceMode !== 'remote' && typeof window !== 'undefined' && isLocalHostname(window.location.hostname)) {
        // Prefer local shards on localhost unless explicitly forcing remote.
        const pathBase = `${resolvePublicPath() || ''}`.replace(/\/$/, '');
        const localHref = `${window.location.origin}${pathBase}/data/sqlite/${manifestPayload.datasetId}/manifest.json`;
        try {
          // Ensure we build a valid absolute URL
          effectiveManifestHref = new URL(localHref, window.location.origin).toString();
        } catch (_) {
          effectiveManifestHref = localHref;
        }
      }
      await workerClientRef.current.init({
        datasetId: manifestPayload.datasetId,
        manifestUrl: effectiveManifestHref,
        manifest: manifestPayload,
        bytesBudget: SQLITE_BYTES_BUDGET,
      });
      if (workerInitVersionRef.current === initVersion) {
        setSearchError(null);
      }
    } catch (initError) {
      if (workerInitVersionRef.current === initVersion) {
        setSearchError(initError.message || 'Failed to initialise search backend.');
      }
    }
  }, []);

  // Load precomputed file identity crosswalk if available
  useEffect(() => {
    let isMounted = true;

    const fetchIdentity = async () => {
      const uniquePaths = new Set();
      const addPath = (base, suffix) => {
        if (!suffix) {
          return;
        }
        const normalizedBase = base ? base.replace(/\/$/, '') : '';
        const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
        const candidate = `${normalizedBase}${normalizedSuffix}` || normalizedSuffix;
        if (candidate) {
          uniquePaths.add(candidate);
        }
      };

      try {
        const publicPath = resolvePublicPath();
        const origin = typeof window !== 'undefined' ? window.location.origin : '';

        // Always prefer local candidates (no remote domains here)
        addPath(publicPath, '/data/file-identity-crosswalk.json');
        addPath(publicPath, 'data/file-identity-crosswalk.json');
        addPath('', '/data/file-identity-crosswalk.json');
        addPath('', 'data/file-identity-crosswalk.json');
        if (origin) {
          addPath(origin, `${publicPath || ''}/data/file-identity-crosswalk.json`);
          addPath(origin, '/data/file-identity-crosswalk.json');
        }

        let parsed = null;
        let lastError = null;
        for (const requestPath of uniquePaths) {
          try {
            const response = await fetch(requestPath, { cache: 'no-store' });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('json')) {
              const text = await response.clone().text();
              if (/^\s*</.test(text)) {
                throw new Error('Received non-JSON response (likely HTML).');
              }
              parsed = JSON.parse(text);
            } else {
              parsed = await response.json();
            }

            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!parsed) {
          throw lastError || new Error('Unable to load identity crosswalk map.');
        }

        if (isMounted) {
          setIdentityCrosswalk(parsed);
        }
      } catch (err) {
        console.warn('Failed to load identity crosswalk map', err);
        if (isMounted) {
          setIdentityCrosswalk((previous) => (previous && typeof previous === 'object' ? previous : (fileIdentityCrosswalkFallback || null)));
        }
      }
    };

    // Only perform fetch if (a) production or (b) offline mode requests local JSON
    if (shouldFetchCrosswalks || offlineMode) {
      fetchIdentity();
    }

    return () => {
      isMounted = false;
    };
  }, [shouldFetchCrosswalks, offlineMode]);

  const executeSqliteSearch = useCallback((query) => {
    if (searchMode !== 'sqlite' || !manifest || !workerClientRef.current) {
      return;
    }

    const trimmed = query.trim();
    // If the debounced query does not match the current input, skip.
    // This avoids firing a search with a stale value just after dataset switches.
    if (trimmed && trimmed !== filterTerm.trim()) {
      return;
    }
    if (!trimmed) {
      latestSearchRequestRef.current = null;
      setSearchStatus('idle');
      setSearchError(null);
      setSearchSummary(null);
      setCsvData(sqlitePreview.rows);
      setColumnCount(sqlitePreview.columns.length);
      setDefaultHeaders(sqlitePreview.columns.map((name, index) => (name ? formatHeader(name) : `Column ${index + 1}`)));
      setIsPartialData(true);
      return;
    }

    const client = workerClientRef.current;
    if (!client) {
      return;
    }

    setSearchStatus('loading');
    setSearchError(null);

    const isLikelyNpi = (() => {
      const digitsOnly = trimmed.replace(/\D+/g, '');
      return digitsOnly.length === 10;
    })();

    const dynamicLimit = isLikelyNpi ? 1 : SQLITE_SEARCH_RESULT_LIMIT;

    const { requestId, promise } = client.search(trimmed, {
      limit: dynamicLimit,
    });
    latestSearchRequestRef.current = requestId;

    promise
      .then((data) => {
        if (latestSearchRequestRef.current !== data.requestId) {
          return;
        }

        const baseColumns = sqlitePreview.columns.length
          ? sqlitePreview.columns
          : (Array.isArray(manifest.narrowColumns) ? manifest.narrowColumns : []);
        const sampleItem = data.items?.[0] || {};
        const dynamicColumns = Object.keys(sampleItem).filter((key) => key !== 'rowid');
        const effectiveColumns = baseColumns.length ? baseColumns : dynamicColumns;
        const fallback = effectiveColumns.map((name, index) => (name ? formatHeader(name) : `Column ${index + 1}`));

        const rows = Array.isArray(data.items)
          ? data.items.map((item) => effectiveColumns.map((column) => item?.[column] ?? null))
          : [];

        setDefaultHeaders(fallback);
        setColumnCount(effectiveColumns.length);
        setCsvData(rows);
        setCurrentPage(1);
        setIsPartialData(typeof data.total === 'number' ? data.total > rows.length : true);
        setSearchStatus('ready');
        setSearchSummary({
          total: typeof data.total === 'number' ? data.total : rows.length,
          returned: rows.length,
          elapsedMs: data.elapsedMs ?? null,
          bytesFetched: data.bytesFetched ?? null,
        });
      })
      .catch((error) => {
        if (latestSearchRequestRef.current !== requestId) {
          return;
        }
        setSearchError(error.message || 'Search failed.');
        setSearchStatus('error');
        setSearchSummary(null);
        setCsvData([]);
      });
  }, [manifest, searchMode, sqlitePreview, setCurrentPage, filterTerm]);

  useEffect(() => {
    setFileGroups([]);
    setSelectedGroupId(null);
    setCurrentFileName(null);
    setCurrentFileFolder(activeCategory.sources[0]?.folder || default_folder);
    setCsvData([]);
    setHeaders([]);
    setDefaultHeaders([]);
    setSearchTerm('');
    setFilterTerm('');
    setCurrentPage(1);
    setIsPartialData(false);
    setError(null);
    setFileLoadError(null);
    setLoading(false);
    setSearchStatus('idle');
    setSearchError(null);
    setSearchSummary(null);
    setPreviewError(null);
  }, [activeCategory]);

  useEffect(() => () => {
    if (workerClientRef.current) {
      workerClientRef.current.terminate();
      workerClientRef.current = null;
    }
  }, []);

  // Ensure worker is terminated when leaving SQLite mode
  useEffect(() => {
    if (searchMode !== 'sqlite' && workerClientRef.current) {
      try { workerClientRef.current.terminate(); } catch (_) { /* noop */ }
      workerClientRef.current = null;
    }
  }, [searchMode]);

  useEffect(() => {
    latestSearchRequestRef.current = null;
    if (sqliteEntry && sqliteIndexCompatible) {
      // Switching to a SQLite-backed dataset: ensure we don't auto-search using
      // the previous dataset's query.
      suppressNextAutoSearchRef.current = true;
      setSearchMode('sqlite');
      setSearchStatus('idle');
      setSearchError(null);
      setSearchSummary(null);
      return;
    }

    setSearchMode('inMemory');
    setManifest(null);
    setManifestUrl(null);
    setSqlitePreview({ columns: [], rows: [], generatedAt: null });
    setPreviewError(null);
    setPreviewLoading(false);
    setSearchStatus('idle');
    setSearchError(null);
    setSearchSummary(null);
  }, [sqliteEntry, sqliteIndexCompatible]);

  // Compute sameness across older versions for the currently selected file.
  useEffect(() => {
    let alive = true;
    const run = async () => {
      setFileIdentity({ status: 'loading', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
      try {
        if (!currentFileName || !currentFileFolder) {
          if (alive) setFileIdentity({ status: 'idle', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
          return;
        }
        if (!versionedFolders.has(currentFileFolder)) {
          if (alive) setFileIdentity({ status: 'idle', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
          return;
        }
        const currentVersion = terminologyVersion;
        if (!currentVersion) {
          if (alive) setFileIdentity({ status: 'idle', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
          return;
        }

        // Prefer precomputed identity crosswalk when available
        try {
          const folderEntry = identityCrosswalk && identityCrosswalk[currentFileFolder];
          const groups = folderEntry && folderEntry.groups;
          const baseName = toBaseCsvName(currentFileName).toLowerCase();
          const group = groups && groups[baseName];
          if (group && Array.isArray(group.runs)) {
            // Resolve 'latest' against crosswalk history so we can avoid live checks
            let targetVersion = currentVersion;
            if (isLatestVersion(currentVersion)) {
              const fromGroup = group.history?.[0]?.version || null;
              if (fromGroup) targetVersion = fromGroup;
              else if (Array.isArray(folderEntry?.versions)) {
                const firstConcrete = folderEntry.versions.find((v) => !isLatestVersion(v));
                if (firstConcrete) targetVersion = firstConcrete;
              } else if (identityCrosswalk?._meta?.versionsPerFolder?.[currentFileFolder]) {
                const candidates = identityCrosswalk._meta.versionsPerFolder[currentFileFolder];
                const firstConcrete = candidates.find((v) => !isLatestVersion(v));
                if (firstConcrete) targetVersion = firstConcrete;
              }
            }
            const runInfo = group.runs.find((r) => Array.isArray(r.versions) && r.versions.includes(targetVersion));
            if (runInfo) {
              const sameSince = runInfo.versions[runInfo.versions.length - 1] || currentVersion;
              // Compute nearest newer version where content changes (if any)
              let newerChangedAt = null;
              let changedAt = null;
              const orderedVersions = Array.isArray(folderEntry?.versions)
                ? folderEntry.versions.filter((v) => !isLatestVersion(v))
                : (identityCrosswalk?._meta?.versionsPerFolder?.[currentFileFolder] || []).filter((v) => !isLatestVersion(v));
              if (orderedVersions.length) {
                const start = runInfo.versions[0];
                const end = runInfo.versions[runInfo.versions.length - 1];
                const startIdx = orderedVersions.indexOf(start);
                const endIdx = orderedVersions.indexOf(end);
                if (startIdx > 0) {
                  newerChangedAt = orderedVersions[startIdx - 1] || null;
                }
                if (endIdx !== -1 && endIdx + 1 < orderedVersions.length) {
                  changedAt = orderedVersions[endIdx + 1] || null;
                }
              }
              if (alive) {
                setFileIdentity({ status: 'ready', sameSince, changedAt, newerChangedAt, error: null, compared: runInfo.versions });
              }
              return;
            }
            // Fallback for legacy crosswalks: derive contiguous versions from history
            const history = Array.isArray(group.history) ? group.history : [];
            const thisVersion = history.find((h) => h && h.version === targetVersion);
            if (thisVersion && thisVersion.signature) {
              const sig = thisVersion.signature;
              const members = history.filter((h) => h && h.signature === sig).map((h) => h.version);
              members.sort((a, b) => compareVersionStrings(b, a));
              const sameSince = members[members.length - 1] || currentVersion;
              // Compute newer/older change boundaries from folder version ordering
              let newerChangedAt = null;
              let changedAt = null;
              const orderedVersions = Array.isArray(folderEntry?.versions)
                ? folderEntry.versions.filter((v) => !isLatestVersion(v))
                : (identityCrosswalk?._meta?.versionsPerFolder?.[currentFileFolder] || []).filter((v) => !isLatestVersion(v));
              if (orderedVersions.length) {
                const start = members[0];
                const end = members[members.length - 1];
                const startIdx = orderedVersions.indexOf(start);
                const endIdx = orderedVersions.indexOf(end);
                if (startIdx > 0) {
                  newerChangedAt = orderedVersions[startIdx - 1] || null;
                }
                if (endIdx !== -1 && endIdx + 1 < orderedVersions.length) {
                  changedAt = orderedVersions[endIdx + 1] || null;
                }
              }
              if (alive) {
                setFileIdentity({ status: 'ready', sameSince, changedAt, newerChangedAt, error: null, compared: members });
              }
              return;
            }
          }
        } catch (_) {
          // fall back to live check
        }

        if (offlineMode || !identityLiveEnabled) {
          // In offline mode, skip live S3 comparisons
          if (alive) setFileIdentity({ status: 'ready', sameSince: null, changedAt: null, newerChangedAt: null, error: null, compared: [] });
          return;
        }

        // Fallback to live ETag comparisons against older versions
        const currentMeta = await fetchEtagForFile(currentFileFolder, currentVersion, currentFileName);
        if (!currentMeta || !currentMeta.etag) {
          if (alive) setFileIdentity({ status: 'error', sameSince: null, changedAt: null, error: 'No metadata for current file', compared: [] });
          return;
        }

        const versions = terminologyVersions || [];
        const idx = versions.indexOf(currentVersion);
        const older = idx === -1 ? versions.slice(1) : versions.slice(idx + 1);

        let sameSince = currentVersion;
        let changedAt = null;
        const compared = [];

        for (const v of older) {
          // Skip symbolic labels like 'latest' if encountered in older list
          if (!v || v.toLowerCase() === 'latest') {
            continue;
          }
          const meta = await fetchEtagForFile(currentFileFolder, v, currentFileName);
          compared.push(v);
          if (!meta || !meta.etag) {
            // Missing file or metadata; treat as change boundary and stop
            changedAt = v;
            break;
          }
          // Compare on ETag primarily; include size as a minor guard
          if (meta.etag === currentMeta.etag && (meta.size == null || currentMeta.size == null || meta.size === currentMeta.size)) {
            sameSince = v;
            continue;
          }
          changedAt = v;
          break;
        }

        if (alive) {
          setFileIdentity({ status: 'ready', sameSince, changedAt, newerChangedAt: null, error: null, compared });
        }
      } catch (err) {
        if (alive) {
          setFileIdentity({ status: 'error', sameSince: null, changedAt: null, newerChangedAt: null, error: err?.message || 'Failed to compute file history', compared: [] });
        }
      }
    };

    run();
    return () => { alive = false; };
  }, [currentFileFolder, currentFileName, terminologyVersion, terminologyVersions, versionedFolders, identityCrosswalk, offlineMode, identityLiveEnabled]);

  useEffect(() => {
    if (searchMode !== 'sqlite' || !sqliteEntry) {
      return;
    }

    let isMounted = true;

    const loadSqliteDataset = async () => {
      // Kill any in-flight searches from the previous dataset by
      // fully terminating the worker before we proceed.
      try {
        if (workerClientRef.current) {
          workerClientRef.current.terminate();
        }
      } catch (e) {
        // ignore termination errors
      } finally {
        workerClientRef.current = null;
        latestSearchRequestRef.current = null;
      }

      setLoading(true);
      setPreviewLoading(true);
      setPreviewError(null);
      setError(null);
      setIsPartialData(true);
      setSearchStatus('idle');
      setSearchError(null);
      setSearchSummary(null);
      setDefaultHeaders([]);
      setColumnCount(0);
      setFilterTerm('');
      // Prevent the manifest-triggered search effect from reusing the
      // previous dataset's debounced query value.
      suppressNextAutoSearchRef.current = true;
      setCurrentPage(1);

      try {
        const response = await fetch(sqliteEntry.manifestUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to load dataset manifest (${response.status})`);
        }
        const payload = await response.json();
        if (!isMounted) {
          return;
        }

        setManifest(payload);
        setManifestUrl(sqliteEntry.manifestUrl);

        await initializeWorker(payload, sqliteEntry.manifestUrl);

        let previewColumns = Array.isArray(payload.narrowColumns) && payload.narrowColumns.length
          ? payload.narrowColumns
          : [];
        let previewRows = [];
        let generatedAt = payload.generatedAt || null;

        if (payload.preview?.url) {
          try {
            const previewUrl = new URL(payload.preview.url, sqliteEntry.manifestUrl).toString();
            const previewResponse = await fetch(previewUrl, { cache: 'no-store' });
            if (!previewResponse.ok) {
              throw new Error(`Failed to load preview (${previewResponse.status})`);
            }
            const previewPayload = await previewResponse.json();
            if (!isMounted) {
              return;
            }
            if (Array.isArray(previewPayload.columns) && previewPayload.columns.length) {
              previewColumns = previewPayload.columns;
            }
            if (Array.isArray(previewPayload.rows)) {
              previewRows = previewPayload.rows;
            }
            generatedAt = previewPayload.generatedAt || generatedAt;
          } catch (previewErr) {
            if (!isMounted) {
              return;
            }
            setPreviewError(previewErr.message || 'Unable to load preview data.');
          }
        } else if (Array.isArray(payload.preview?.rows)) {
          previewRows = payload.preview.rows;
        }

        const columns = previewColumns.length ? previewColumns : Array.from({ length: previewRows[0]?.length || 0 }, (_, index) => `Column ${index + 1}`);
        const fallback = columns.map((name, index) => (name ? formatHeader(name) : `Column ${index + 1}`));

        setSqlitePreview({ columns, rows: Array.isArray(previewRows) ? previewRows : [], generatedAt });
        setDefaultHeaders(fallback);
        setColumnCount(columns.length);
        setCsvData(Array.isArray(previewRows) ? previewRows : []);
        setIsPartialData(true);
      } catch (manifestError) {
        if (!isMounted) {
          return;
        }
        setManifest(null);
        setManifestUrl(null);
        setSqlitePreview({ columns: [], rows: [], generatedAt: null });
        setDefaultHeaders([]);
        setColumnCount(0);
        setCsvData([]);
        setSearchError(manifestError.message || 'Unable to load SQLite dataset.');
        setPreviewError(manifestError.message || 'Unable to load SQLite dataset.');
      } finally {
        if (isMounted) {
          setLoading(false);
          setPreviewLoading(false);
        }
      }
    };

    loadSqliteDataset();

    return () => {
      isMounted = false;
    };
  }, [initializeWorker, searchMode, sqliteEntry]);

  useEffect(() => {
    if (searchMode !== 'sqlite' || !manifest) {
      return;
    }
    // When switching datasets we clear the input but the debounced value
    // may still hold the previous query for a moment. Suppress the first
    // auto-search after a dataset change to avoid firing a stale query.
    if (suppressNextAutoSearchRef.current) {
      suppressNextAutoSearchRef.current = false;
      return;
    }
    executeSqliteSearch(debouncedFilterTerm);
  }, [searchMode, manifest, debouncedFilterTerm, executeSqliteSearch]);

  useEffect(() => {
    let isMounted = true;

    const fetchCrosswalk = async () => {
      const uniquePaths = new Set();
      const addPath = (base, suffix) => {
        if (!suffix) {
          return;
        }
        const normalizedBase = base ? base.replace(/\/$/, '') : '';
        const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
        const candidate = `${normalizedBase}${normalizedSuffix}` || normalizedSuffix;
        if (candidate) {
          uniquePaths.add(candidate);
        }
      };

      try {
        const publicPath = resolvePublicPath();
        const origin = typeof window !== 'undefined' ? window.location.origin : '';

        // Always prefer local candidates (no remote domains here)
        addPath(publicPath, '/data/header-crosswalk.json');
        addPath(publicPath, 'data/header-crosswalk.json');
        addPath('', '/data/header-crosswalk.json');
        addPath('', 'data/header-crosswalk.json');
        if (origin) {
          addPath(origin, `${publicPath || ''}/data/header-crosswalk.json`);
          addPath(origin, '/data/header-crosswalk.json');
        }

        let parsed = null;
        let lastError = null;
        for (const requestPath of uniquePaths) {
          try {
            const response = await fetch(requestPath, { cache: 'no-store' });
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('json')) {
              const text = await response.clone().text();
              if (/^\s*</.test(text)) {
                throw new Error('Received non-JSON response (likely HTML).');
              }
              parsed = JSON.parse(text);
            } else {
              parsed = await response.json();
            }

            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!parsed) {
          throw lastError || new Error('Unable to load header crosswalk map.');
        }

        if (isMounted) {
          setHeaderCrosswalk(parsed);
        }
      } catch (err) {
        console.warn('Failed to load header crosswalk map', err);
        if (isMounted) {
          setHeaderCrosswalk((previous) => (previous && typeof previous === 'object' ? previous : (headerCrosswalkFallback || null)));
        }
      }
    };

    if (shouldFetchCrosswalks || offlineMode) {
      fetchCrosswalk();
    }

    return () => {
      isMounted = false;
    };
  }, [shouldFetchCrosswalks, offlineMode]);

  useEffect(() => {
    let isMounted = true;
    const seen = new Set();
    const candidates = [];

    const addCandidate = (value) => {
      if (!value) {
        return;
      }
      const normalised = value.replace(/\/+$/, '/');
      const trimmed = normalised.replace(/\/+data\/sqlite\/datasets\.json$/, '');
      const target = value.endsWith('datasets.json') ? value : `${normalised}data/sqlite/datasets.json`;
      if (!seen.has(target)) {
        seen.add(target);
        candidates.push(target);
      }
    };

    const publicUrl = typeof process !== 'undefined' ? (process.env?.PUBLIC_URL || '') : '';
    const publicPath = resolvePublicPath();
    const normalisedPublic = publicUrl.replace(/\/$/, '');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    const prefersLocalCatalog = typeof window !== 'undefined'
      && isLocalHostname(window.location.hostname);

    // If explicitly forcing remote, prioritise the remote catalog first.
    const sourceMode = getSqliteSourceMode();
    if (sourceMode === 'remote') {
      try {
        const base = (typeof baseDomain === 'string' ? baseDomain : DEFAULT_BASE_DOMAIN).replace(/\/$/, '');
        // Prefer standard app layout first (data/sqlite) for our bucket
        addCandidate(base);
        // Also try the legacy public layout for compatibility
        addCandidate(`${base}/terminology_viewer_sqlite/datasets.json`);
      } catch (_) {
        // fall through; the hard-coded fallback is still appended below
      }
    }

    addCandidate('data/sqlite/datasets.json');
    addCandidate('/data/sqlite/datasets.json');
    if (publicPath) {
      addCandidate(publicPath);
      if (origin) {
        addCandidate(`${origin}${publicPath}`);
      }
    }
    if (normalisedPublic.startsWith('http://') || normalisedPublic.startsWith('https://')) {
      addCandidate(normalisedPublic);
    }
    if (origin) {
      addCandidate(`${origin}/data/sqlite/datasets.json`);
    }
    // Always include a remote fallback at the end to recover when local paths serve HTML.
    addCandidate('https://tuva-public-resources.s3.amazonaws.com/terminology_viewer_sqlite/datasets.json');

    const loadCatalog = async () => {
      let lastError = null;
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate, { cache: 'no-store' });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          const payload = await response.json();
          if (!Array.isArray(payload)) {
            throw new Error('SQLite catalog response is malformed.');
          }

          const baseUrl = new URL('./', response.url).toString();
          const datasetMap = new Map();
          payload.forEach((entry) => {
            if (!entry || typeof entry !== 'object') {
              return;
            }
            const datasetId = entry.datasetId || entry.id;
            if (!datasetId || !entry.manifest) {
              return;
            }
            const manifestHref = new URL(entry.manifest, baseUrl).toString();
            datasetMap.set(datasetId, { ...entry, manifestUrl: manifestHref });
          });

          if (!isMounted) {
            return;
          }

          sqliteCatalogRef.current = datasetMap;
          console.log('SQLite Catalog:', datasetMap);
          setSqliteCatalogError(null);
          setSqliteCatalogVersion((value) => value + 1);
          setSqliteCatalogReady(true);
          return;
        } catch (catalogError) {
          lastError = catalogError;
        }
      }

      if (isMounted) {
        sqliteCatalogRef.current = new Map();
        setSqliteCatalogError(lastError?.message || 'Unable to load SQLite catalog.');
        setSqliteCatalogVersion((value) => value + 1);
        setSqliteCatalogReady(true);
      }
    };

    loadCatalog();

    return () => {
      isMounted = false;
    };
  }, []);

  const determineListingBase = useCallback(() => {
    if (typeof window === 'undefined') {
      return baseDomain;
    }

    const hostname = window.location.hostname;
    const isLocalHost = isLocalHostname(hostname);

    if (!isLocalHost) {
      return baseDomain;
    }

    // Default to using the dev proxy on localhost to avoid HTML index responses.
    const useProxyEnv = typeof process !== 'undefined' ? process.env?.REACT_APP_USE_S3_PROXY : undefined;
    if (useProxyEnv === 'false') {
      return window.location.origin.replace(/\/$/, '');
    }
    return '/s3-proxy';
  }, [baseDomain]);

  const getListingBase = useCallback(() => {
    if (!listingBaseRef.current) {
      listingBaseRef.current = determineListingBase();
    }
    return listingBaseRef.current;
  }, [determineListingBase]);

  const setListingBase = useCallback((value) => {
    listingBaseRef.current = value;
  }, []);

  const buildListingUrl = useCallback((folder, params, baseOverride) => {
    const base = baseOverride ?? getListingBase();
    const trimmedParams = params.toString();
    if (!base) {
      return `/?${trimmedParams}`;
    }

    if (base === '/s3-proxy') {
      return `${base}/?${trimmedParams}`;
    }

    try {
      const baseUrl = `${base.replace(/\/$/, '')}/`;
      const url = new URL(baseUrl);
      url.search = trimmedParams;
      return url.toString();
    } catch (error) {
      const normalised = base.replace(/\/$/, '');
      return `${normalised}/?${trimmedParams}`;
    }
  }, [getListingBase]);

  const getElementsByTag = (context, tag) => {
    if (!context) {
      return [];
    }

    const directMatches = typeof context.getElementsByTagName === 'function'
      ? Array.from(context.getElementsByTagName(tag))
      : [];

    if (directMatches.length) {
      return directMatches;
    }

    const namespaceLookup = typeof context.lookupNamespaceURI === 'function'
      ? context.lookupNamespaceURI(null)
      : undefined;

    if (typeof context.getElementsByTagNameNS === 'function') {
      const namespace = namespaceLookup || context.documentElement?.namespaceURI || context.namespaceURI || '*';
      const nsMatches = Array.from(context.getElementsByTagNameNS(namespace, tag));
      if (nsMatches.length) {
        return nsMatches;
      }

      const wildcardMatches = namespace !== '*'
        ? Array.from(context.getElementsByTagNameNS('*', tag))
        : [];
      if (wildcardMatches.length) {
        return wildcardMatches;
      }
    }

    if (typeof tag === 'string') {
      const loweredTag = tag.toLowerCase();
      if (loweredTag !== tag && typeof context.getElementsByTagName === 'function') {
        const lowerMatches = Array.from(context.getElementsByTagName(loweredTag));
        if (lowerMatches.length) {
          return lowerMatches;
        }
      }
    }

    return [];
  };

  // Fetch the ETag and Size for a single S3 object via a ListObjectsV2 call scoped to the object key.
  // This avoids downloading file content and works with the existing listing proxy.
  const fetchEtagForFile = useCallback(async (folder, version, fileName, baseOverride = null) => {
    if (!folder || !fileName) {
      return null;
    }
    const isVersionedFolder = versionedFolders.has(folder);
    const key = isVersionedFolder ? `${folder}/${version}/${fileName}` : `${folder}/${fileName}`;
    if (!key) {
      return null;
    }

    const cacheKey = key;
    if (etagCacheRef.current.has(cacheKey)) {
      return etagCacheRef.current.get(cacheKey);
    }

    const params = new URLSearchParams({ 'list-type': '2', prefix: key });
    const url = buildListingUrl(folder, params, baseOverride);

    const requestOptions = {
      cache: 'no-store',
      headers: { Accept: 'application/xml,text/xml;q=0.9' },
    };

    let response = await fetch(url, requestOptions);
    if (response.status === 304) {
      response = await fetch(url, { ...requestOptions, cache: 'reload' });
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata for ${key}: ${response.status} ${response.statusText}`);
    }
    const xmlText = await response.text();
    if (!xmlText.trim()) {
      throw new Error('Empty response while fetching object metadata.');
    }

    const parser = new DOMParser();
    const xmlDocument = parser.parseFromString(xmlText, 'application/xml');
    const hasParseError = (
      xmlDocument.querySelector?.('parsererror') ||
      xmlDocument.querySelector?.('ParserError') ||
      getElementsByTag(xmlDocument, 'parsererror')[0] ||
      getElementsByTag(xmlDocument, 'ParserError')[0]
    );
    if (hasParseError) {
      throw new Error('Unable to parse object metadata response.');
    }

    const contents = getElementsByTag(xmlDocument, 'Contents');
    let etag = null;
    let size = null;
    for (const node of contents) {
      const keyNode = getElementsByTag(node, 'Key')[0];
      const keyText = keyNode?.textContent || '';
      if (keyText && keyText === key) {
        const etagNode = getElementsByTag(node, 'ETag')[0];
        const sizeNode = getElementsByTag(node, 'Size')[0];
        const rawEtag = etagNode?.textContent || '';
        etag = rawEtag.replace(/^\"|\"$/g, '');
        const rawSize = sizeNode?.textContent || '';
        const parsedSize = Number.parseInt(rawSize, 10);
        size = Number.isFinite(parsedSize) ? parsedSize : null;
        break;
      }
    }

    if (!etag) {
      // Not found; cache negative result to avoid repeated calls
      etagCacheRef.current.set(cacheKey, null);
      return null;
    }

    const result = { etag, size };
    etagCacheRef.current.set(cacheKey, result);
    return result;
  }, [buildListingUrl, versionedFolders]);

  const toBaseCsvName = useCallback((fileName = '') => {
    const normalizedInput = typeof fileName === 'string' ? fileName : '';
    const normalized = normalizedInput.trim();
    if (!normalized) {
      return '';
    }

    const match = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
    if (match) {
      return match[1];
    }

    if (normalized.endsWith('.csv.gz')) {
      return normalized.replace(/\.csv\.gz$/i, '.csv');
    }

    return normalized;
  }, []);

  const isLatestVersion = (value = '') => normalizeKey(value) === 'latest';

  const toVersionParts = (value = '') => {
    if (!value) {
      return [];
    }

    return value
      .replace(/_/g, '.')
      .split(/[^0-9A-Za-z]+/)
      .filter(Boolean)
      .map((part) => {
        const numeric = Number(part);
        return Number.isNaN(numeric) ? part.toLowerCase() : numeric;
      });
  };

  const compareVersionStrings = (a = '', b = '') => {
    if (isLatestVersion(a) && isLatestVersion(b)) {
      return 0;
    }
    if (isLatestVersion(a)) {
      return 1;
    }
    if (isLatestVersion(b)) {
      return -1;
    }

    const aParts = toVersionParts(a);
    const bParts = toVersionParts(b);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const aPart = aParts[index] ?? 0;
      const bPart = bParts[index] ?? 0;

      if (aPart === bPart) {
        continue;
      }

      if (typeof aPart === 'string' || typeof bPart === 'string') {
        const aString = String(aPart);
        const bString = String(bPart);
        if (aString > bString) {
          return 1;
        }
        if (aString < bString) {
          return -1;
        }
        continue;
      }

      if (aPart > bPart) {
        return 1;
      }
      if (aPart < bPart) {
        return -1;
      }
    }

    return 0;
  };

  const resolveVersionMap = (folderMap, requestedVersion) => {
    if (!folderMap || typeof folderMap !== 'object') {
      return null;
    }

    const normalizedRequested = requestedVersion?.trim() || '';
    const directMatch = folderMap[normalizedRequested] || folderMap[normalizeKey(normalizedRequested)];
    if (directMatch && typeof directMatch === 'object') {
      return { versionKey: normalizedRequested, map: directMatch, isFallback: false };
    }

    const versionKeys = Object.keys(folderMap);
    if (!versionKeys.length) {
      return null;
    }

    const sortedKeys = versionKeys.slice().sort((a, b) => compareVersionStrings(b, a));
    const bestKey = sortedKeys.find((key) => compareVersionStrings(key, normalizedRequested) <= 0)
      || sortedKeys[0];

    const map = folderMap[bestKey];
    if (!map || typeof map !== 'object') {
      return null;
    }

    if (bestKey !== normalizedRequested) {
      console.warn('Crosswalk missing version, using fallback', {
        requestedVersion: normalizedRequested,
        fallbackVersion: bestKey,
      });
    }

    return { versionKey: bestKey, map, isFallback: bestKey !== normalizedRequested };
  };

  const resolveCrosswalkEntry = (folder, version, fileName) => {
    if (!headerCrosswalk || typeof headerCrosswalk !== 'object') {
      return null;
    }

    const normalizedFolder = normalizeKey(folder);
    const baseName = normalizeKey(toBaseCsvName(fileName));
    const requestedVersion = version || '';

    if (!normalizedFolder || !baseName) {
      return null;
    }

    const folderMap = headerCrosswalk[normalizedFolder];
    if (!folderMap || typeof folderMap !== 'object') {
      return null;
    }

    const versionResult = resolveVersionMap(folderMap, requestedVersion);
    if (!versionResult) {
      return null;
    }

    const { map: versionMap, versionKey, isFallback } = versionResult;
    const entry = versionMap[baseName];

    if (!entry) {
      return null;
    }

    if (Array.isArray(entry)) {
      return { headers: entry, _resolvedVersion: versionKey, _isFallbackVersion: isFallback };
    }

    if (entry && Array.isArray(entry.headers)) {
      return { ...entry, _resolvedVersion: versionKey, _isFallbackVersion: isFallback };
    }

    return null;
  };

  const toFriendlyLabel = useCallback((csvName = '') => {
    const base = csvName.replace(/\.csv$/i, '');
    if (!base) {
      return csvName;
    }

    return base
      .split(/[_-]+/)
      .filter(Boolean)
      .map((word) => {
        if (/^[a-z0-9]+$/i.test(word) && word.length <= 3) {
          return word.toUpperCase();
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }, []);

  const createGroupId = useCallback((folder, csvName) => `${folder}::${csvName.toLowerCase()}`, []);


  const buildFileGroups = useCallback((fileEntries) => {
    const groups = new Map();

    fileEntries.forEach(({ folder, fileName }) => {
      const csvName = toBaseCsvName(fileName);
      const id = createGroupId(folder, csvName);

      if (!groups.has(id)) {
        groups.set(id, {
          id,
          folder,
          csvName,
          displayName: toFriendlyLabel(csvName),
          files: [],
        });
      }

      const group = groups.get(id);
      group.files.push(fileName);
    });

    const sortedGroups = Array.from(groups.values()).map((group) => ({
      ...group,
      files: group.files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    }));

    sortedGroups.sort((a, b) => {
      if (a.folder === b.folder) {
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
      }
      if (a.folder === default_folder) {
        return -1;
      }
      if (b.folder === default_folder) {
        return 1;
      }
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
    });

    return sortedGroups;
  }, [createGroupId, toBaseCsvName, toFriendlyLabel, default_folder]);
  // Generate the current URL based on filename and version
  const getCurrentUrl = useCallback((
    version = terminologyVersion,
    folder = currentFileFolder,
    fileName = currentFileName
  ) => {
    if (!fileName) {
      return '';
    }
    const targetFolder = folder || default_folder;
    const isVersionedFolder = versionedFolders.has(targetFolder);
    // Prefer the same base used for listings; on localhost this is /s3-proxy.
    let base = getListingBase();
    if (!base) {
      base = baseDomain;
    }
    const normalisedBase = base.replace(/\/$/, '');

    if (isVersionedFolder) {
      if (!version) {
        return '';
      }
      return `${normalisedBase}/${targetFolder}/${version}/${fileName}`;
    }

    return `${normalisedBase}/${targetFolder}/${fileName}`;
  }, [baseDomain, currentFileFolder, currentFileName, default_folder, terminologyVersion, versionedFolders, getListingBase]);

  useEffect(() => {
    let isMounted = true;

    userSelectedVersionRef.current = false;
    setTerminologyVersion(null);
    setTerminologyVersions([]);
    setVersionLoadError(null);

    if (!versionedSources.length) {
      setIsLoadingVersions(false);
      return () => {
        isMounted = false;
      };
    }

    setIsLoadingVersions(true);

    let listingBase = getListingBase();

    const extractVersionsFromDocument = (xmlDocument, folder) => {
      const decodeValue = (value) => {
        try {
          return decodeURIComponent(value);
        } catch (err) {
          return value;
        }
      };

      const normalizePrefix = (rawPrefix) => {
        const prefix = decodeValue(rawPrefix || '');
        return prefix
          .replace(`${folder}/`, '')
          .replace(/\/+$/, '')
          .trim();
      };

      const commonPrefixNodes = getElementsByTag(xmlDocument, 'CommonPrefixes');
      const fromCommonPrefixes = commonPrefixNodes.reduce((acc, group) => {
        getElementsByTag(group, 'Prefix')
          .map((node) => normalizePrefix(node.textContent || ''))
          .filter(Boolean)
          .forEach((value) => acc.push(value));
        return acc;
      }, []);

      if (fromCommonPrefixes.length) {
        return fromCommonPrefixes;
      }

      const keyNodes = getElementsByTag(xmlDocument, 'Key');
      const fromKeys = keyNodes
        .map((node) => normalizePrefix(node.textContent || ''))
        .map((value) => value.split('/')[0] || '')
        .filter(Boolean);

      return fromKeys;
    };

    const fetchVersionsForFolder = async (folder) => {
      const versions = [];
      let continuationToken = null;

      do {
        const params = new URLSearchParams({
          'list-type': '2',
          prefix: `${folder}/`,
          delimiter: '/',
        });

        if (continuationToken) {
          params.append('continuation-token', continuationToken);
        }

        const url = buildListingUrl(folder, params.toString(), listingBase);
        const requestOptions = {
          cache: 'no-store',
          headers: {
            Accept: 'application/xml,text/xml;q=0.9',
          },
        };

        let response = await fetch(url, requestOptions);

        if (response.status === 304) {
          response = await fetch(url, { ...requestOptions, cache: 'reload' });
        }

        if (!response.ok) {
          throw new Error(`Failed to list versions for ${folder}: ${response.status} ${response.statusText}`);
        }

        if (typeof DOMParser === 'undefined') {
          throw new Error('DOMParser is not available in this environment.');
        }

        const xmlText = await response.text();

        if (!xmlText.trim()) {
          throw new Error('Received empty version listing response.');
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('xml') && /^\s*<!doctype\s+html/i.test(xmlText)) {
          if (listingBase !== baseDomain) {
            listingBase = baseDomain;
            setListingBase(baseDomain);
            continue;
          }
          throw new Error('Received HTML instead of XML when listing versions.');
        }

        const parser = new DOMParser();
        const xmlDocument = parser.parseFromString(xmlText, 'application/xml');

        const hasParseError = (
          xmlDocument.querySelector?.('parsererror') ||
          xmlDocument.querySelector?.('ParserError') ||
          getElementsByTag(xmlDocument, 'parsererror')[0] ||
          getElementsByTag(xmlDocument, 'ParserError')[0]
        );

        if (hasParseError) {
          throw new Error('Unable to parse version listing response.');
        }

        const errorNode = getElementsByTag(xmlDocument, 'Error')[0];
        if (errorNode) {
          const code = getElementsByTag(errorNode, 'Code')[0]?.textContent || 'UnknownCode';
          const message = getElementsByTag(errorNode, 'Message')[0]?.textContent || 'Unknown error';
          throw new Error(`S3 error while listing ${folder}: ${code} - ${message}`);
        }

        const pageVersions = extractVersionsFromDocument(xmlDocument, folder);
        versions.push(...pageVersions);

        const isTruncated = getElementsByTag(xmlDocument, 'IsTruncated')[0]?.textContent === 'true';
        continuationToken = isTruncated
          ? getElementsByTag(xmlDocument, 'NextContinuationToken')[0]?.textContent || null
          : null;
      } while (continuationToken);

      return versions;
    };

    const loadAvailableVersions = async () => {
      if (offlineMode) {
        try {
          const versionSets = versionedSources.map((source) => {
            const folderEntry = identityCrosswalk && identityCrosswalk[source.folder];
            const fromFolder = (folderEntry && Array.isArray(folderEntry.versions))
              ? folderEntry.versions
              : (identityCrosswalk?._meta?.versionsPerFolder?.[source.folder] || []);
            return Array.isArray(fromFolder) ? fromFolder : [];
          });
          const uniqueVersions = Array.from(new Set(versionSets.flat())).filter(Boolean);
          const latestLabel = 'latest';
          const withoutLatest = uniqueVersions.filter((v) => String(v).toLowerCase() !== latestLabel);
          const normalizeForSort = (value) => value.replace(/_/g, '.');
          const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
          if (withoutLatest.length > 1) {
            withoutLatest.sort((a, b) => collator.compare(normalizeForSort(b), normalizeForSort(a)));
          }
          const hasLatest = uniqueVersions.some((v) => String(v).toLowerCase() === latestLabel);
          const orderedVersions = hasLatest ? [...withoutLatest, latestLabel] : withoutLatest;
          if (!isMounted) return;
          setTerminologyVersions(orderedVersions);
          if (orderedVersions.length) {
            setTerminologyVersion((current) => (current && orderedVersions.includes(current)) ? current : orderedVersions[0]);
          }
          return;
        } finally {
          if (isMounted) setIsLoadingVersions(false);
        }
      }
      setIsLoadingVersions(true);

      try {
        const versionLists = await Promise.all(
          versionedSources.map((source) => fetchVersionsForFolder(source.folder))
        );

        if (!isMounted) {
          return;
        }

        const uniqueVersions = Array.from(new Set(versionLists.flat())).filter(Boolean);

        const normalizeForSort = (value) => value.replace(/_/g, '.');
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

        const latestLabel = 'latest';
        const withoutLatest = uniqueVersions.filter((version) => version.toLowerCase() !== latestLabel);
        if (withoutLatest.length > 1) {
          withoutLatest.sort((a, b) => collator.compare(normalizeForSort(b), normalizeForSort(a)));
        }

        const hasLatest = uniqueVersions.some((version) => version.toLowerCase() === latestLabel);
        const orderedVersions = hasLatest ? [...withoutLatest, latestLabel] : withoutLatest;

        setTerminologyVersions(orderedVersions);

        if (orderedVersions.length) {
          setTerminologyVersion((current) => {
            if (!userSelectedVersionRef.current) {
              return orderedVersions[0];
            }

            if (current && orderedVersions.includes(current)) {
              return current;
            }

            return orderedVersions[0];
          });
        }
      } catch (err) {
        console.error('Failed to load terminology versions', err);
        if (isMounted) {
          setVersionLoadError('Unable to load versions from the local catalog. Displaying latest available version.');
        }
      } finally {
        if (isMounted) {
          setIsLoadingVersions(false);
        }
      }
    };

    loadAvailableVersions();

    return () => {
      isMounted = false;
    };
  }, [activeCategory, buildListingUrl, getListingBase, setListingBase, versionedSources, offlineMode, identityCrosswalk]);

  useEffect(() => {
    if (hasVersionedSources && !terminologyVersion) {
      setFileGroups([]);
      setSelectedGroupId(null);
      setCurrentFileName(null);
      setCurrentFileFolder(versionedSources[0]?.folder || activeCategory.sources[0]?.folder || default_folder);
      setIsLoadingFiles(false);
      setFileLoadError(null);
      return;
    }

    let isMounted = true;
    setIsLoadingFiles(true);
    setFileLoadError(null);
    setFileGroups([]);
    setSelectedGroupId(null);
    setCurrentFileName(null);
    setCurrentFileFolder(activeCategory.sources[0]?.folder || default_folder);

    let listingBase = getListingBase();

    const fetchFilesForSource = async (source) => {
      if (offlineMode) {
        // Build from identity crosswalk locally
        const files = [];
        try {
          const folderEntry = identityCrosswalk && identityCrosswalk[source.folder];
          if (!folderEntry || !folderEntry.groups) {
            return files;
          }
          // Resolve effective version (map 'latest' to the newest concrete version)
          const versionList = Array.isArray(folderEntry.versions) ? folderEntry.versions : [];
          const concreteLatest = versionList.find((v) => String(v).toLowerCase() !== 'latest') || null;
          const targetVersion = (String(terminologyVersion || '').toLowerCase() === 'latest')
            ? (concreteLatest || terminologyVersion)
            : terminologyVersion;
          Object.values(folderEntry.groups).forEach((group) => {
            const matches = (group.history || []).find((h) => h.version === targetVersion);
            if (!matches || !Array.isArray(matches.segments)) {
              return;
            }
            matches.segments.forEach((seg) => {
              if (seg && seg.file && !String(seg.file).includes('_compressed')) {
                files.push(seg.file);
              }
            });
          });
        } catch (_) {
          // ignore
        }
        return files;
      }
      const files = [];
      let continuationToken = null;
      const isVersioned = source.type === 'versioned';
      const excludedPrefixes = Array.isArray(source.excludedPrefixes) ? source.excludedPrefixes : [];
      const prefixBase = isVersioned
        ? `${source.folder}/${terminologyVersion}/`
        : `${source.folder}/`;

      do {
        const params = new URLSearchParams({
          'list-type': '2',
          prefix: prefixBase,
        });

        if (continuationToken) {
          params.append('continuation-token', continuationToken);
        }

        const url = buildListingUrl(source.folder, params.toString(), listingBase);
        const requestOptions = {
          cache: 'no-store',
          headers: {
            Accept: 'application/xml,text/xml;q=0.9',
          },
        };

        let response = await fetch(url, requestOptions);

        if (response.status === 304) {
          response = await fetch(url, { ...requestOptions, cache: 'reload' });
        }

        if (!response.ok) {
          throw new Error(`Failed to list files for ${source.folder}: ${response.status} ${response.statusText}`);
        }

        if (typeof DOMParser === 'undefined') {
          throw new Error('DOMParser is not available in this environment.');
        }

        const xmlText = await response.text();

        if (!xmlText.trim()) {
          throw new Error('Received empty file listing response.');
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('xml') && /^\s*<!doctype\s+html/i.test(xmlText)) {
          if (listingBase !== baseDomain) {
            listingBase = baseDomain;
            setListingBase(baseDomain);
            continue;
          }
          throw new Error('Received HTML instead of XML when listing files.');
        }

        const parser = new DOMParser();
        const xmlDocument = parser.parseFromString(xmlText, 'application/xml');

        const hasParseError = (
          xmlDocument.querySelector?.('parsererror') ||
          xmlDocument.querySelector?.('ParserError') ||
          getElementsByTag(xmlDocument, 'parsererror')[0] ||
          getElementsByTag(xmlDocument, 'ParserError')[0]
        );

        if (hasParseError) {
          throw new Error('Unable to parse file listing response.');
        }

        const contentsNodes = getElementsByTag(xmlDocument, 'Contents');
        contentsNodes.forEach((node) => {
          const keyNode = getElementsByTag(node, 'Key')[0];
          const keyText = keyNode?.textContent || '';
          if (!keyText || keyText.endsWith('/') || keyText.includes('_compressed')) {
            return;
          }
          if (excludedPrefixes.some((prefix) => keyText.startsWith(prefix))) {
            return;
          }
          let relative = keyText;
          if (relative.startsWith(prefixBase)) {
            relative = relative.slice(prefixBase.length);
          }
          relative = relative.trim();
          if (relative) {
            files.push(relative);
          }
        });

        const isTruncated = getElementsByTag(xmlDocument, 'IsTruncated')[0]?.textContent === 'true';
        continuationToken = isTruncated
          ? getElementsByTag(xmlDocument, 'NextContinuationToken')[0]?.textContent || null
          : null;
      } while (continuationToken);

      return files;
    };

    const loadFilesForSelection = async () => {
      try {
        const fileLists = await Promise.all(
          activeCategory.sources.map((source) => {
            if (source.type === 'versioned' && !terminologyVersion) {
              return [];
            }
            return fetchFilesForSource(source).catch((err) => {
              console.warn(`Failed to load files from S3 for ${source.folder}`, err);
              return [];
            });
          })
        );

        if (!isMounted) {
          return;
        }

        const entries = activeCategory.sources.flatMap((source, index) =>
          fileLists[index].map((fileName) => ({ folder: source.folder, fileName }))
        );

        const groups = buildFileGroups(entries);

        setFileGroups(groups);

        if (!groups.length) {
          setSelectedGroupId(null);
          setCurrentFileName(null);
          setCurrentFileFolder(activeCategory.sources[0]?.folder || default_folder);
          return;
        }

        const firstGroup = groups[0];
        setSelectedGroupId(firstGroup.id);
        setCurrentFileName(firstGroup.files[0] || null);
        setCurrentFileFolder(firstGroup.folder);
      } catch (err) {
        console.error('Failed to load files from S3', err);
        if (isMounted) {
          setFileLoadError('Unable to load file listing for this selection.');
          setFileGroups([]);
          setSelectedGroupId(null);
          setCurrentFileName(null);
          setCurrentFileFolder(activeCategory.sources[0]?.folder || default_folder);
        }
      } finally {
        if (isMounted) {
          setIsLoadingFiles(false);
        }
      }
    };

    loadFilesForSelection();

    return () => {
      isMounted = false;
    };
  }, [activeCategory, buildFileGroups, buildListingUrl, getListingBase, hasVersionedSources, setListingBase, terminologyVersion, versionedSources, offlineMode, identityCrosswalk]);

  // Helper function to process CSV string and update state
  const processCsvString = useCallback((csvString, isPartial = false, forceLimit = false) => {
    if (!csvString.trim()) {
      throw new Error('CSV file is empty');
    }

    const shouldLimitRows = isPartial || forceLimit || csvString.length > CSV_TEXT_LIMIT;

    Papa.parse(csvString, {
      header: false,
      dynamicTyping: false,
      skipEmptyLines: true,
      preview: shouldLimitRows ? 50000 : 0,
      complete: (results) => {
        if (Array.isArray(results.data) && results.data.length > 0) {
          setCsvData(results.data);
          const actuallyPartial = isPartial || (shouldLimitRows && results.meta?.truncated);
          setIsPartialData(actuallyPartial);

          const firstRow = Array.isArray(results.data[0]) ? results.data[0] : null;
          const detectedCount = firstRow ? firstRow.length : 0;
          setColumnCount(detectedCount);
          setDefaultHeaders(Array.from({ length: detectedCount }, (_, index) => `Column ${index + 1}`));

          if (!detectedCount) {
            setError('Unable to determine column structure');
          }
        } else {
          setColumnCount(0);
          setDefaultHeaders([]);
          setError('No rows found in the CSV file');
        }
        setLoading(false);
      },
      error: (parseError) => {
        setError(`Error parsing CSV: ${parseError.message}`);
        setColumnCount(0);
        setDefaultHeaders([]);
        setLoading(false);
      },
    });
  }, []);

  // Function to fetch just a portion of a large file
  const fetchPartialCSV = useCallback(async (url) => {
    try {
      // Fetch with range header to get just the start of the file
      const response = await fetch(url, {
        headers: {
          'Range': 'bytes=0-150000' // Get first 150KB which should be enough for headers and some rows
        }
      });

      if (!response.ok && response.status !== 206) {
        throw new Error(`Failed to fetch partial data: ${response.status} ${response.statusText}`);
      }

      // Get the data as ArrayBuffer
      const arrayBuffer = await response.arrayBuffer();

      // Try decompression first
      try {
        const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
        const decoder = new TextDecoder('utf-8');
        const csvString = decoder.decode(decompressed);

        processCsvString(csvString, true);

      } catch (decompressionError) {
        console.log("Partial decompression failed, trying as plain text", decompressionError);

        // If decompression fails, try as plain text
        try {
          const decoder = new TextDecoder('utf-8');
          const csvString = decoder.decode(arrayBuffer);

          if (csvString.includes(',') || csvString.includes('\n')) {
            processCsvString(csvString, true);
          } else {
            throw new Error("Partial file doesn't appear to be valid CSV");
          }

        } catch (textReadError) {
          setError(`Unable to process this file format: ${textReadError.message}`);
          setColumnCount(0);
          setLoading(false);
        }
      }

    } catch (err) {
      setError(`Error fetching partial data: ${err.message}`);
      setColumnCount(0);
      setLoading(false);
    }
  }, [processCsvString]);

  const fetchAndProcessCSV = useCallback(async (url, fileName = '') => {
    setLoading(true);
    setError(null);
    setColumnCount(0);
    setHeaders([]);
    setDefaultHeaders([]);
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status} ${response.statusText} (${url})`);
      }

      // Get the data as ArrayBuffer
      const arrayBuffer = await response.arrayBuffer();
      const fileSizeBytes = arrayBuffer.byteLength;

      const zipLikely = isZipFileName(fileName) || hasZipSignature(arrayBuffer);
      if (zipLikely) {
        try {
          const { csvString } = await extractCsvFromZip(arrayBuffer, fileName);
          const shouldLimit = csvString.length > CSV_TEXT_LIMIT; // 5MB of text
          processCsvString(csvString, false, shouldLimit);
          return;
        } catch (zipError) {
          setError(`Unable to extract ZIP archive: ${zipError.message}`);
          setLoading(false);
          setColumnCount(0);
          return;
        }
      }

      // First try to decompress assuming it's gzipped
      try {
        const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
        const decoder = new TextDecoder('utf-8');
        const csvString = decoder.decode(decompressed);

        // Check if we should limit parsing due to large decompressed size
        const shouldLimit = csvString.length > CSV_TEXT_LIMIT; // 5MB of text

        // Process the decompressed CSV
        processCsvString(csvString, false, shouldLimit);

      } catch (decompressionError) {
        console.log("Decompression failed, trying to read as plain text CSV", decompressionError);

        // If decompression fails, try to read as plain text CSV
        try {
          const decoder = new TextDecoder('utf-8');
          const csvString = decoder.decode(arrayBuffer);

          // Check if it looks like a CSV (has commas or typical CSV structure)
          if (csvString.includes(',') || csvString.includes('\n')) {
            // For uncompressed files, check if we should limit based on size
            const shouldLimit = fileSizeBytes > CSV_TEXT_LIMIT; // 5MB file size
            processCsvString(csvString, false, shouldLimit);
          } else {
            throw new Error("File doesn't appear to be a valid CSV or compressed CSV");
          }

        } catch (textReadError) {
          console.error("Failed to read as plain text CSV", textReadError);
          // If both decompression and plain text reading fail, try partial fetch
          await fetchPartialCSV(url);
        }
      }

    } catch (err) {
      setError(`Error: ${err.message}`);
      setColumnCount(0);
      setLoading(false);
    }
  }, [fetchPartialCSV, processCsvString]);

  const currentFileUrl = useMemo(() => getCurrentUrl(), [getCurrentUrl]);

  // This effect will trigger whenever terminologyVersion or currentFileName changes
  useEffect(() => {
    if (!currentFileUrl) {
      return;
    }
    // If SQLite is active, CSV fetch is not needed
    if (searchMode === 'sqlite') {
      return;
    }
    // If we have a dataset id, wait for the SQLite catalog decision
    if (currentDatasetId && !sqliteCatalogReady) {
      return;
    }
    // If there is a compatible SQLite entry for this dataset, avoid CSV fetch
    if (sqliteEntry && sqliteIndexCompatible) {
      return;
    }
    fetchAndProcessCSV(currentFileUrl, currentFileName || '');
    // Reset pagination when URL changes
    setCurrentPage(1);
  }, [currentFileUrl, currentFileName, fetchAndProcessCSV, searchMode, currentDatasetId, sqliteCatalogReady, sqliteEntry, sqliteIndexCompatible]);

  const handleGroupSelect = (groupId) => {
    const group = fileGroups.find((item) => item.id === groupId);
    if (!group) {
      return;
    }

    // Prevent stale auto-search on dataset switch
    suppressNextAutoSearchRef.current = true;
    setSelectedGroupId(groupId);
    const nextFile = group.files[0] || null;
    setCurrentFileName(nextFile);
    setCurrentFileFolder(group.folder);
  };

  const handleFileSegmentSelect = (groupId, fileName) => {
    const group = fileGroups.find((item) => item.id === groupId);
    if (!group) {
      return;
    }

    if (!group.files.includes(fileName)) {
      return;
    }

    // Prevent stale auto-search on dataset switch
    suppressNextAutoSearchRef.current = true;
    setSelectedGroupId(groupId);
    setCurrentFileName(fileName);
    setCurrentFileFolder(group.folder);
  };

  const handleVersionChange = (version) => {
    if (!version) {
      return;
    }
    userSelectedVersionRef.current = true;
    // Prevent stale auto-search when version changes underneath
    suppressNextAutoSearchRef.current = true;
    setTerminologyVersion(version);
    // The useEffect will automatically trigger and reload the current file with the new version
  };

  useEffect(() => {
    if (!columnCount) {
      setHeaders((previous) => (previous.length ? [] : previous));
      return;
    }

    const entry = resolveCrosswalkEntry(currentFileFolder, terminologyVersion, currentFileName);
    const fallbackHeaders = Array.from({ length: columnCount }, (_, index) => {
      const candidate = defaultHeaders[index];
      return candidate ?? `Column ${index + 1}`;
    });

    let nextHeaders = fallbackHeaders;

    if (entry && Array.isArray(entry.headers)) {
      if (entry.headers.length !== columnCount) {
        console.warn('Crosswalk headers length mismatch', {
          folder: currentFileFolder,
          version: terminologyVersion,
          file: currentFileName,
          expected: columnCount,
          received: entry.headers.length,
        });
      }

      nextHeaders = fallbackHeaders.map((defaultLabel, index) => {
        const candidate = entry.headers[index];
        if (candidate === null || candidate === undefined) {
          return defaultLabel;
        }
        const label = String(candidate).trim();
        return label || defaultLabel;
      });
    }

    setHeaders((previous) => (arraysEqual(previous, nextHeaders) ? previous : nextHeaders));
  }, [columnCount, currentFileFolder, currentFileName, defaultHeaders, headerCrosswalk, terminologyVersion]);

  const handleCategoryChange = (categoryId) => {
    if (!categoryId || categoryId === activeCategoryId) {
      return;
    }
    setActiveCategoryId(categoryId);
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredGroups = fileGroups.filter((group) => {
    if (!normalizedSearch) {
      return true;
    }

    const haystack = [group.displayName, group.csvName, ...group.files].join(' ').toLowerCase();
    return haystack.includes(normalizedSearch);
  });

  const selectedGroup = fileGroups.find((group) => group.id === selectedGroupId) || null;

  const availableVersions = terminologyVersions.length
    ? terminologyVersions
    : (terminologyVersion ? [terminologyVersion] : []);

  const versionLabelText = activeCategory.versionLabel || 'Version';
  const filePanelHeading = hasVersionedSources && terminologyVersion
    ? `Available Files - Version ${terminologyVersion}`
    : 'Available Files';

  const isSqliteMode = searchMode === 'sqlite';
  const normalizedFilterTerm = filterTerm.trim().toLowerCase();

  const filteredData = useMemo(() => {
    if (isSqliteMode) {
      return csvData;
    }
    if (!normalizedFilterTerm) {
      return csvData;
    }
    return csvData.filter((row) =>
      row.some((cell) => cell && String(cell).toLowerCase().includes(normalizedFilterTerm))
    );
  }, [csvData, isSqliteMode, normalizedFilterTerm]);

  const sortedData = useMemo(() => {
    if (sortColumnIndex == null || !Array.isArray(filteredData) || !filteredData.length) {
      return filteredData;
    }
    const idx = sortColumnIndex;
    const direction = sortDirection === 'desc' ? -1 : 1;
    const isEmpty = (v) => v == null || v === '';
    const toNumber = (v) => {
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      if (!s) return NaN;
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    };
    const copy = filteredData.slice();
    copy.sort((a, b) => {
      const av = a?.[idx];
      const bv = b?.[idx];
      const aEmpty = isEmpty(av);
      const bEmpty = isEmpty(bv);
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // empty last
      if (bEmpty) return -1;
      const an = toNumber(av);
      const bn = toNumber(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) {
        if (an < bn) return -1 * direction;
        if (an > bn) return 1 * direction;
        return 0;
      }
      const as = String(av).toLowerCase();
      const bs = String(bv).toLowerCase();
      if (as < bs) return -1 * direction;
      if (as > bs) return 1 * direction;
      return 0;
    });
    return copy;
  }, [filteredData, sortColumnIndex, sortDirection]);

  const totalRows = sortedData.length;

  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, currentPage, pageSize]);

  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  const filterInputPlaceholder = isSqliteMode ? 'Search dataset…' : 'Filter content...';
  const filterInputDisabled = isSqliteMode ? previewLoading : loading;

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const dataSummaryText = useMemo(() => {
    if (isSqliteMode) {
      if (searchSummary) {
        return `Showing ${searchSummary.returned.toLocaleString()} of ${searchSummary.total.toLocaleString()} matches`;
      }
      if (manifest?.rowCount) {
        return `Showing ${csvData.length.toLocaleString()} preview rows of ${manifest.rowCount.toLocaleString()} total`;
      }
      return `Preview rows: ${csvData.length.toLocaleString()} (partial)`;
    }
    if (isPartialData) {
      return `Partial load: ${csvData.length.toLocaleString()} rows`;
    }
    return `Total rows: ${csvData.length.toLocaleString()}`;
  }, [csvData.length, isPartialData, isSqliteMode, searchSummary, manifest]);

  const handleDownloadSubset = useCallback(() => {
    try {
      if (!Array.isArray(headers) || !headers.length) {
        return;
      }
      const rows = Array.isArray(sortedData) ? sortedData : [];
      if (!rows.length) {
        return;
      }
      const csvString = Papa.unparse({ fields: headers, data: rows });
      const base = toBaseCsvName(currentFileName || '') || 'subset';
      const normalizedFilter = (filterTerm || '').trim();
      let suffix = 'subset';
      if (isSqliteMode) {
        suffix = normalizedFilter ? 'search' : 'preview';
      } else if (isPartialData) {
        suffix = 'partial';
      }
      const filename = `${base}-${suffix}.csv`;
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('Failed to download subset', e);
      try { alert('Failed to download subset CSV.'); } catch (_) { /* ignore */ }
    }
  }, [headers, sortedData, currentFileName, isSqliteMode, isPartialData, filterTerm, toBaseCsvName]);

  // History panel no longer displays header crosswalk; only identity ranges.

  const identityDetails = useMemo(() => {
    const result = { run: null, signature: null, versions: [], available: false };
    if (!currentFileName || !currentFileFolder) return result;
    const baseName = toBaseCsvName(currentFileName).toLowerCase();
    const folderEntry = identityCrosswalk && identityCrosswalk[currentFileFolder];
    const group = folderEntry && folderEntry.groups && folderEntry.groups[baseName];
    if (!group) return result;

    // Identity data present for this group
    result.available = true;

    const runs = Array.isArray(group.runs) ? group.runs : [];

    // 1) Preferred: a run that explicitly lists versions
    const listedRun = runs.find((r) => Array.isArray(r.versions) && r.versions.includes(terminologyVersion));
    if (listedRun) {
      result.run = listedRun;
      result.signature = listedRun.signature || null;
      result.versions = Array.isArray(listedRun.versions) ? listedRun.versions : [];
      return result;
    }

    // 2) Fallback for legacy crosswalks: use history to derive versions for this signature
    const history = Array.isArray(group.history) ? group.history : [];
    const thisVersion = history.find((h) => h && h.version === terminologyVersion);
    if (thisVersion && thisVersion.signature) {
      const sig = thisVersion.signature;
      const members = history.filter((h) => h && h.signature === sig).map((h) => h.version);
      // Ensure descending order just in case
      members.sort((a, b) => compareVersionStrings(b, a));
      result.signature = sig;
      result.versions = members;
      result.run = {
        start: members[0] || null,
        end: members[members.length - 1] || null,
        signature: sig,
        versions: members,
      };
      return result;
    }

    // 3) Last resort: check run start/end range when versions list is missing
    const byRange = runs.find((r) => (
      r && typeof r.start === 'string' && typeof r.end === 'string'
        && compareVersionStrings(r.start, terminologyVersion) >= 0
        && compareVersionStrings(terminologyVersion, r.end) >= 0
    ));
    if (byRange) {
      result.run = byRange;
      result.signature = byRange.signature || null;
      // If history is available, derive explicit version list for display
      if (history.length && byRange.signature) {
        const members = history.filter((h) => h && h.signature === byRange.signature).map((h) => h.version);
        members.sort((a, b) => compareVersionStrings(b, a));
        result.versions = members;
      }
    }

    return result;
  }, [currentFileFolder, currentFileName, terminologyVersion, identityCrosswalk, toBaseCsvName]);

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      width: '100%',
      padding: '16px',
      boxSizing: 'border-box',
      overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: 'calc(100% - 32px)',
        zIndex: 10,
        gap: '16px'
      }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '8px',
          maxWidth: '100%'
        }}>
          <h1 style={{
            fontSize: '1.5rem',
            fontWeight: 'bold',
            margin: 0
          }}>Tuva Terminology Viewer</h1>
          {sqliteCatalogError && (
            <span style={{ fontSize: '12px', color: '#dc2626' }}>
              Large dataset search is unavailable: {sqliteCatalogError}
            </span>
          )}
          <div
            role="tablist"
            aria-label="Data category"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px'
            }}
          >
            {dataCategories.map((category) => {
              const isActive = category.id === activeCategoryId;
              return (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleCategoryChange(category.id)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '9999px',
                    border: `1px solid ${isActive ? '#1d4ed8' : '#d1d5db'}`,
                    backgroundColor: isActive ? '#1d4ed8' : 'white',
                    color: isActive ? '#ffffff' : '#1f2937',
                    fontSize: '14px',
                    fontWeight: isActive ? 600 : 500,
                    cursor: 'pointer',
                    transition: 'background-color 0.2s ease, color 0.2s ease'
                  }}
                >
                  {category.label}
                </button>
              );
            })}
          </div>
        </div>

        {hasVersionedSources && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            maxWidth: '100%'
          }}>
            <label htmlFor="terminology-version" style={{
              fontSize: '12px',
              fontWeight: 600,
              color: '#4b5563',
              marginBottom: '4px'
            }}>
              {versionLabelText}
            </label>
            <select
              id="terminology-version"
              value={terminologyVersion ?? ''}
              onChange={(event) => handleVersionChange(event.target.value)}
              disabled={isLoadingVersions || !availableVersions.length}
              style={{
                minWidth: '200px',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                fontWeight: 500,
                color: '#111827',
                backgroundColor: isLoadingVersions ? '#f9fafb' : 'white'
              }}
            >
              {isLoadingVersions ? (
                <option value="" disabled>Loading versions…</option>
              ) : (
                <>
                  {!terminologyVersion && <option value="" disabled>Choose a version</option>}
                  {availableVersions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </>
              )}
            </select>
            {!isLoadingVersions && !availableVersions.length && !versionLoadError && (
              <span style={{ marginTop: '4px', fontSize: '12px', color: '#dc2626' }}>
                No versions available
              </span>
            )}
            {versionLoadError && (
              <span style={{ marginTop: '4px', fontSize: '12px', color: '#dc2626' }}>
                {versionLoadError}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Left sidebar with file list */}
      <div style={{
        width: '25%',
        minWidth: '250px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        padding: '16px',
        marginRight: '16px',
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 80px)',
        marginTop: '48px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden'
      }}>
        <h2 style={{
          fontSize: '1.125rem',
          fontWeight: 600,
          marginBottom: '12px'
        }}>{filePanelHeading}</h2>

        <div style={{
          position: 'relative',
          marginBottom: '16px'
        }}>
          <input
            type="text"
            placeholder="Search files..."
            style={{
              width: '100%',
              padding: '8px 8px 8px 32px',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '14px'
            }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <Search style={{
            position: 'absolute',
            left: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#9ca3af',
            width: '16px',
            height: '16px'
          }} />
        </div>

        <div style={{
          overflowY: 'auto',
          flexGrow: 1
        }}>
          {isLoadingFiles ? (
            <div style={{ padding: '16px', color: '#6b7280', fontSize: '14px' }}>
              Loading file list...
            </div>
          ) : fileLoadError ? (
            <div style={{ padding: '16px', color: '#dc2626', fontSize: '14px' }}>
              {fileLoadError}
            </div>
          ) : filteredGroups.length ? (
            filteredGroups.map((group) => (
              <div
                key={group.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px',
                  cursor: 'pointer',
                  borderRadius: '6px',
                  marginBottom: '2px',
                  backgroundColor: selectedGroupId === group.id ? '#dbeafe' : 'transparent'
                }}
                onClick={() => handleGroupSelect(group.id)}
              >
                <FileText style={{
                  width: '16px',
                  height: '16px',
                  marginRight: '8px',
                  color: '#3b82f6'
                }} />
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }}>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: selectedGroupId === group.id ? 600 : 500,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {group.displayName}
                  </span>
                  <span style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {group.csvName}
                    {group.folder === provider_folder ? ' · Provider data' : ''}
                    {group.files.length > 1 ? ' · ' + group.files.length + ' files' : ''}
                  </span>
                </div>
              </div>
            ))
          ) : (
            <div style={{ padding: '16px', color: '#6b7280', fontSize: '14px' }}>
              No files match your search.
            </div>
          )}
        </div>
      </div>

      {/* Right side with file content */}
      <div style={{
        width: '75%',
        backgroundColor: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        height: 'calc(100vh - 80px)',
        marginTop: '48px',
        overflow: 'hidden'
      }}>
        <div style={{
          padding: '16px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            <h2 style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              margin: 0
            }}>
              {selectedGroup ? selectedGroup.displayName : (currentFileName || 'Select a file')}
            </h2>
            {selectedGroup && (
              <p style={{
                fontSize: '13px',
                color: '#6b7280',
                marginTop: '4px',
                marginBottom: selectedGroup.files.length ? 8 : 0
              }}>
                {selectedGroup.csvName}
                {selectedGroup.folder === provider_folder ? ' · Provider data' : ''}
              </p>
            )}
            {versionedFolders.has(currentFileFolder) && currentFileName && (
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px', marginBottom: '4px' }}>
                {fileIdentity.status === 'loading' && (
                  <span>Checking file history…</span>
                )}
                {fileIdentity.status === 'error' && (
                  <span>History unavailable: {fileIdentity.error}</span>
                )}
                {fileIdentity.status === 'ready' && (
                  fileIdentity.newerChangedAt
                    ? <span>Newer content in {fileIdentity.newerChangedAt}.</span>
                    : (
                      <span>
                        {`Content is latest available.${fileIdentity.sameSince ? ` Unchanged since ${fileIdentity.sameSince}.` : ''}`}
                      </span>
                    )
                )}
              </div>
            )}
            {/* Simple in-app history viewer toggle */}
            {currentFileName && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setIsCrosswalkOpen((v) => !v)}
                  style={{
                    appearance: 'none',
                    border: '1px solid #d1d5db',
                    backgroundColor: '#ffffff',
                    color: '#111827',
                    borderRadius: 6,
                    padding: '6px 10px',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  {isCrosswalkOpen ? 'Hide History' : 'View History'}
                </button>
              </div>
            )}
            {selectedGroup && selectedGroup.files.length > 0 && (
              <div style={{ marginBottom: '8px' }}>
                <span style={{
                  fontSize: '12px',
                  color: '#6b7280',
                  display: 'block',
                  marginBottom: '4px'
                }}>
                  Files included:
                </span>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px'
                }}>
                  {selectedGroup.files.map((file) => (
                    <button
                      key={file}
                      type="button"
                      onClick={() => handleFileSegmentSelect(selectedGroup.id, file)}
                      style={{
                        border: '1px solid ' + (file === currentFileName ? '#2563eb' : '#d1d5db'),
                        backgroundColor: file === currentFileName ? '#dbeafe' : '#f9fafb',
                        color: file === currentFileName ? '#1d4ed8' : '#374151',
                        borderRadius: '9999px',
                        padding: '4px 10px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        lineHeight: 1,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {file}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!loading && !error && currentFileUrl && (
              <p style={{
                fontSize: '14px',
                color: '#6b7280',
                marginTop: '4px',
                marginBottom: 0
              }}>
                {dataSummaryText}
                {currentFileUrl ? ` · ${currentFileUrl}` : ''}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              type="button"
              onClick={handleDownloadSubset}
              disabled={!headers.length || !sortedData.length}
              style={{
                appearance: 'none',
                border: '1px solid #d1d5db',
                backgroundColor: '#ffffff',
                color: (!headers.length || !sortedData.length) ? '#9ca3af' : '#2563eb',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 14,
                cursor: (!headers.length || !sortedData.length) ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <FileText style={{ width: '16px', height: '16px', marginRight: 6 }} />
              Download subset
            </button>
            <a
              href={currentFileUrl || undefined}
              download
              style={{
                display: 'flex',
                alignItems: 'center',
                color: '#2563eb',
                fontSize: '14px',
                textDecoration: 'none'
              }}
              aria-disabled={!currentFileUrl}
            >
              <Download style={{
                width: '16px',
                height: '16px',
                marginRight: '4px'
              }} />
              Download
            </a>
          </div>
        </div>
        
        <div style={{
          padding: '16px',
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          {loading ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '256px'
            }}>
              <Loader2 style={{
                width: '32px',
                height: '32px',
                color: '#3b82f6',
                animation: 'spin 1s linear infinite'
              }} />
              <p style={{
                marginTop: '8px',
                color: '#6b7280'
              }}>Loading CSV data...</p>
            </div>
          ) : error ? (
            <div style={{
              backgroundColor: '#fef2f2',
              padding: '16px',
              borderRadius: '6px'
            }}>
              <p style={{
                color: '#dc2626'
              }}>{error}</p>
            </div>
          ) : (
            <>
              <div style={{
                position: 'relative',
                marginBottom: isSqliteMode ? '8px' : '16px'
              }}>
                <input
                  type="text"
                  placeholder={filterInputPlaceholder}
                  style={{
                    width: '100%',
                    padding: '8px 8px 8px 32px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '14px'
                  }}
                  value={filterTerm}
                  onChange={(e) => setFilterTerm(e.target.value)}
                  disabled={filterInputDisabled}
                />
                <Search style={{
                  position: 'absolute',
                  left: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#9ca3af',
                  width: '16px',
                  height: '16px'
                }} />
              </div>

              {sqliteEntry && !sqliteIndexCompatible && (isSqliteMode || isPartialData) && (
                <div style={{
                  marginTop: '4px',
                  marginBottom: '8px',
                  fontSize: '12px',
                  color: '#b45309',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #f59e0b',
                  borderRadius: '6px',
                  padding: '8px'
                }}>
                  This version differs from the indexed content. Full-text search is disabled for historical versions. To search values beyond the preview, switch to the most recent version.
                  {latestConcreteVersion && (
                    <div style={{ marginTop: 4, color: '#92400e' }}>
                      Index covers version: {latestConcreteVersion}
                    </div>
                  )}
                </div>
              )}

              {isSqliteMode && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '12px',
                  minHeight: '20px'
                }}>
                  {searchStatus === 'loading' && (
                    <Loader2 style={{
                      width: '16px',
                      height: '16px',
                      color: '#3b82f6',
                      animation: 'spin 1s linear infinite'
                    }} />
                  )}
                  {searchStatus === 'ready' && searchSummary && (
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>
                      Showing {searchSummary.returned.toLocaleString()} of {searchSummary.total.toLocaleString()} matches
                      {typeof searchSummary.elapsedMs === 'number' ? ` (${(searchSummary.elapsedMs / 1000).toFixed(1)}s)` : ''}
                      {typeof searchSummary.bytesFetched === 'number' ? ` · ${(searchSummary.bytesFetched / (1024 * 1024)).toFixed(2)}MB fetched` : ''}
                    </span>
                  )}
                  {searchStatus === 'idle' && !searchError && !previewError && (
                    <span style={{ fontSize: '12px', color: '#6b7280' }}>
                      Showing preview data. Enter a term above to search the full dataset.
                    </span>
                  )}
                  {searchStatus === 'error' && searchError && (
                    <span style={{ fontSize: '12px', color: '#dc2626' }}>{searchError}</span>
                  )}
                  {!searchError && previewError && (
                    <span style={{ fontSize: '12px', color: '#dc2626' }}>{previewError}</span>
                  )}
                </div>
              )}
              
              <div style={{
                overflowY: 'auto',
                flexGrow: 1
              }}>
                <table style={{
                  minWidth: '100%',
                  borderCollapse: 'separate',
                  borderSpacing: 0
                }}>
                  <thead style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    backgroundColor: '#f9fafb'
                  }}>
                    <tr>
                      {headers.map((header, index) => {
                        const active = sortColumnIndex === index && sortDirection;
                        const indicator = active === 'asc' ? ' ▲' : active === 'desc' ? ' ▼' : '';
                        return (
                          <th
                            key={index}
                            onClick={() => {
                              setCurrentPage(1);
                              setSortColumnIndex((prevIdx) => {
                                if (prevIdx !== index) {
                                  setSortDirection('asc');
                                  return index;
                                }
                                // cycle asc -> desc -> none
                                setSortDirection((prevDir) => {
                                  if (prevDir === 'asc') return 'desc';
                                  if (prevDir === 'desc') {
                                    // clear sort
                                    return null;
                                  }
                                  return 'asc';
                                });
                                return index;
                              });
                            }}
                            aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                            role="columnheader button"
                            style={{
                              padding: '12px 24px',
                              textAlign: 'left',
                              fontSize: '12px',
                              fontWeight: 500,
                              color: '#6b7280',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              borderBottom: '1px solid #e5e7eb',
                              cursor: 'pointer',
                              userSelect: 'none'
                            }}
                            title="Click to sort"
                          >
                            {header}{indicator}
                          </th>
                        );
                      })}
                  </tr>
                </thead>
                <tbody>
                    {paginatedRows.length ? paginatedRows.map((row, rowIndex) => (
                      <tr 
                        key={rowIndex}
                        style={{
                          backgroundColor: rowIndex % 2 === 0 ? 'white' : '#f9fafb'
                        }}
                      >
                        {row.map((cell, cellIndex) => (
                          <td 
                            key={cellIndex}
                            style={{
                              padding: '8px 24px',
                              whiteSpace: 'nowrap',
                              fontSize: '14px',
                              color: '#6b7280',
                              borderBottom: '1px solid #e5e7eb'
                            }}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    )) : (
                      <tr>
                        <td
                          colSpan={Math.max(headers.length, 1)}
                          style={{
                            padding: '16px',
                            textAlign: 'center',
                            color: '#6b7280'
                          }}
                        >
                          No data available for this selection.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                
                {/* Pagination controls */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '16px 0',
                  borderTop: '1px solid #e5e7eb',
                  marginTop: '16px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ marginRight: '8px', fontSize: '14px' }}>Rows per page:</span>
                    <select 
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setCurrentPage(1);
                      }}
                      style={{
                        padding: '4px 8px',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        fontSize: '14px'
                      }}
                    >
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={250}>250</option>
                      <option value={500}>500</option>
                      <option value={1000}>1000</option>
                    </select>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <>
                      <button
                        onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                        disabled={currentPage === 1}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: '4px',
                          marginRight: '8px',
                          backgroundColor: (currentPage === 1) ? '#f3f4f6' : 'white',
                          cursor: (currentPage === 1) ? 'not-allowed' : 'pointer',
                          color: (currentPage === 1) ? '#9ca3af' : '#111827'
                        }}
                      >
                        Previous
                      </button>

                      <span style={{ margin: '0 8px', fontSize: '14px' }}>
                        Page {Math.min(currentPage, totalPages)} of {totalPages}
                      </span>

                      <button
                        onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                        disabled={currentPage >= totalPages}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: '4px',
                          backgroundColor: (currentPage >= totalPages) ? '#f3f4f6' : 'white',
                          cursor: (currentPage >= totalPages) ? 'not-allowed' : 'pointer',
                          color: (currentPage >= totalPages) ? '#9ca3af' : '#111827'
                        }}
                      >
                        Next
                      </button>
                    </>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {/* History side panel */}
      {isCrosswalkOpen && currentFileName && (
        <div style={{
          position: 'absolute',
          top: 72,
          right: 16,
          bottom: 16,
          width: 420,
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
          zIndex: 20,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}>
          <div style={{
            padding: '12px 16px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <strong style={{ fontSize: 14 }}>History</strong>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                {currentFileFolder} · {currentFileName}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsCrosswalkOpen(false)}
              aria-label="Close"
              style={{
                appearance: 'none',
                border: '1px solid #d1d5db',
                backgroundColor: '#f9fafb',
                borderRadius: 6,
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 12,
                color: '#111827'
              }}
            >
              Close
            </button>
          </div>

          <div style={{ padding: 16, overflow: 'auto' }}>
            <div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Same-content ranges</div>
              {versionedFolders.has(currentFileFolder) ? (
                (() => {
                  const folderEntry = identityCrosswalk && identityCrosswalk[currentFileFolder];
                  const baseName = toBaseCsvName(currentFileName).toLowerCase();
                  const group = folderEntry && folderEntry.groups && folderEntry.groups[baseName];
                  const runs = group && Array.isArray(group.runs) ? group.runs : [];
                  const history = group && Array.isArray(group.history) ? group.history : [];

                  if (!runs.length && !history.length) {
                    return (
                      <div style={{ fontSize: 12, color: '#9ca3af' }}>
                        History data not available.
                      </div>
                    );
                  }

                  // Build ranges; prefer runs if present
                  const ranges = (runs.length ? runs : [])
                    .map((r, idx) => ({
                      start: r.start || (Array.isArray(r.versions) ? r.versions[0] : null),
                      end: r.end || (Array.isArray(r.versions) ? r.versions[r.versions.length - 1] : null),
                      versions: Array.isArray(r.versions) ? r.versions : [],
                      signature: r.signature || null,
                      key: `${r.signature || 'sig'}-${idx}`,
                    }))
                    .filter((r) => r.start || r.end || r.versions.length);

                  // If we have no runs (legacy), derive single range for current signature
                  if (!ranges.length && history.length) {
                    const current = history.find((h) => h.version === terminologyVersion);
                    if (current && current.signature) {
                      const members = history.filter((h) => h.signature === current.signature).map((h) => h.version);
                      members.sort((a, b) => compareVersionStrings(b, a));
                      ranges.push({ start: members[0], end: members[members.length - 1], versions: members, signature: current.signature, key: `legacy-${current.signature}` });
                    }
                  }

                  if (!ranges.length) {
                    return (
                      <div style={{ fontSize: 12, color: '#9ca3af' }}>
                        No matching history for this version.
                      </div>
                    );
                  }

                  return (
                    <div style={{ fontSize: 12 }}>
                      <div style={{ marginBottom: 6 }}>Same-content ranges ({ranges.length}):</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {ranges.map((r) => {
                          const contains = (r.versions && r.versions.includes(terminologyVersion))
                            || (
                              r.start && r.end
                              && compareVersionStrings(r.start, terminologyVersion) >= 0
                              && compareVersionStrings(terminologyVersion, r.end) >= 0
                            );
                          const label = (r.start && r.end && r.start !== r.end)
                            ? `${r.start} – ${r.end}`
                            : (r.start || r.end || (r.versions?.[0] ?? 'unknown'));
                          return (
                            <div key={r.key} style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              border: '1px solid #e5e7eb',
                              background: contains ? '#eef2ff' : '#f9fafb',
                              color: '#111827',
                              borderRadius: 6,
                              padding: '6px 10px'
                            }}>
                              <div>{label}</div>
                              {r.signature && (
                                <div style={{ color: '#6b7280', marginLeft: 8 }}>sig: {r.signature.slice(0, 12)}…</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>History not applicable for this folder.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
