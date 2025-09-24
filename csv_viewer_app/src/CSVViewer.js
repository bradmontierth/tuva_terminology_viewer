import { useState, useEffect, useRef } from 'react';
import { Search, Download, FileText, Loader2 } from 'lucide-react';
import * as Papa from 'papaparse';
import pako from 'pako';
import headerCrosswalkFallback from './generated/headerCrosswalk.json';

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

export default function CSVViewer() {
  const baseDomain = 'https://tuva-public-resources.s3.amazonaws.com';
  const default_folder = 'versioned_terminology';
  const provider_folder = 'versioned_provider_data';

  const [csvData, setCsvData] = useState([]);
  const [columnCount, setColumnCount] = useState(0);
  const [headers, setHeaders] = useState([]);
  const [headerCrosswalk, setHeaderCrosswalk] = useState(() => {
    if (headerCrosswalkFallback && typeof headerCrosswalkFallback === 'object') {
      return headerCrosswalkFallback;
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
  const [isPartialData, setIsPartialData] = useState(false);
  const [terminologyVersion, setTerminologyVersion] = useState(null);
  const [terminologyVersions, setTerminologyVersions] = useState([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionLoadError, setVersionLoadError] = useState(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileLoadError, setFileLoadError] = useState(null);
  const userSelectedVersionRef = useRef(false);
  const listingBaseRef = useRef(null);

  const determineListingBase = () => {
    if (typeof window === 'undefined') {
      return baseDomain;
    }

    const shouldUseProxy = typeof process !== 'undefined'
      && process.env?.REACT_APP_USE_S3_PROXY === 'true';

    if (!shouldUseProxy) {
      return baseDomain;
    }

    const hostname = window.location.hostname;
    const isLocalHost = [
      'localhost',
      '127.0.0.1',
      '::1',
      '0.0.0.0'
    ].includes(hostname);

    return isLocalHost ? '/s3-proxy' : baseDomain;
  };

  const getListingBase = () => {
    if (!listingBaseRef.current) {
      listingBaseRef.current = determineListingBase();
    }
    return listingBaseRef.current;
  };

  const setListingBase = (value) => {
    listingBaseRef.current = value;
  };

  const buildListingUrl = (folder, params, base = getListingBase()) => {
    if (base === '/s3-proxy') {
      return `${base}/?${params}`;
    }

    const baseUrl = `${base.replace(/\/$/, '')}/`;
    const url = new URL(baseUrl);
    url.search = params;
    return url.toString();
  };

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

  const toBaseCsvName = (fileName = '') => {
    const normalized = fileName.trim();
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
  };

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

  const toFriendlyLabel = (csvName = '') => {
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
  };

  const createGroupId = (folder, csvName) => `${folder}::${csvName.toLowerCase()}`;


  const buildFileGroups = (fileEntries) => {
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
  };
  // Generate the current URL based on filename and version
  const getCurrentUrl = (version = terminologyVersion, folder = currentFileFolder) => {
    if (!version || !currentFileName) {
      return '';
    }
    const targetFolder = folder || default_folder;
    return `${baseDomain}/${targetFolder}/${version}/${currentFileName}`;
  };

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
        const publicUrl = typeof process !== 'undefined'
          ? (process.env?.PUBLIC_URL || '')
          : '';

        addPath('', '/data/header-crosswalk.json');
        addPath('', 'data/header-crosswalk.json');
        addPath(publicUrl, '/data/header-crosswalk.json');
        addPath(publicUrl, 'data/header-crosswalk.json');

        if (typeof window !== 'undefined') {
          addPath(window.location.origin, '/data/header-crosswalk.json');
          addPath(`${window.location.origin}${publicUrl}`, '/data/header-crosswalk.json');
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

            console.log('Loaded header crosswalk from', requestPath);
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
        console.error('Failed to load header crosswalk map', err);
        if (isMounted) {
          setHeaderCrosswalk((previous) => (previous && typeof previous === 'object' ? previous : null));
        }
      }
    };

    fetchCrosswalk();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

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
      setIsLoadingVersions(true);
      setVersionLoadError(null);

      try {
        const [terminologyList, providerList] = await Promise.all([
          fetchVersionsForFolder(default_folder),
          fetchVersionsForFolder(provider_folder)
        ]);

        if (!isMounted) {
          return;
        }

        const uniqueVersions = Array.from(new Set([...terminologyList, ...providerList])).filter(Boolean);

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
        console.error('Failed to load terminology versions from S3', err);
        if (isMounted) {
          setVersionLoadError('Unable to load versions from S3. Displaying latest available version.');
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
  }, []);

  useEffect(() => {
    if (!terminologyVersion) {
      setFileGroups([]);
      setSelectedGroupId(null);
      setCurrentFileName(null);
      setCurrentFileFolder(default_folder);
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
    setCurrentFileFolder(default_folder);

    let listingBase = getListingBase();

    const fetchFilesForFolder = async (folder) => {
      const files = [];
      let continuationToken = null;

      do {
        const params = new URLSearchParams({
          'list-type': '2',
          prefix: `${folder}/${terminologyVersion}/`,
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
          throw new Error(`Failed to list files for ${folder}: ${response.status} ${response.statusText}`);
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
          if (!keyText || keyText.endsWith('/')) {
            return;
          }
          const relative = keyText.replace(`${folder}/${terminologyVersion}/`, '').trim();
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

    const loadFilesForVersion = async () => {
      try {
        const [terminologyFiles, providerFiles] = await Promise.all([
          fetchFilesForFolder(default_folder),
          fetchFilesForFolder(provider_folder).catch((err) => {
            console.warn('Failed to load provider files from S3', err);
            return [];
          }),
        ]);

        if (!isMounted) {
          return;
        }

        const entries = [
          ...terminologyFiles.map((fileName) => ({ folder: default_folder, fileName })),
          ...providerFiles.map((fileName) => ({ folder: provider_folder, fileName })),
        ];

        const groups = buildFileGroups(entries);

        setFileGroups(groups);

        if (!groups.length) {
          setSelectedGroupId(null);
          setCurrentFileName(null);
          setCurrentFileFolder(default_folder);
          return;
        }

        const firstGroup = groups[0];
        setSelectedGroupId(firstGroup.id);
        setCurrentFileName(firstGroup.files[0] || null);
        setCurrentFileFolder(firstGroup.folder);
      } catch (err) {
        console.error('Failed to load terminology files from S3', err);
        if (isMounted) {
          setFileLoadError('Unable to load file listing for this version.');
          setFileGroups([]);
          setSelectedGroupId(null);
          setCurrentFileName(null);
          setCurrentFileFolder(default_folder);
        }
      } finally {
        if (isMounted) {
          setIsLoadingFiles(false);
        }
      }
    };

    loadFilesForVersion();

    return () => {
      isMounted = false;
    };
  }, [terminologyVersion]);

  // Helper function to process CSV string and update state
  const processCsvString = (csvString, isPartial = false, forceLimit = false) => {
    if (!csvString.trim()) {
      throw new Error("CSV file is empty");
    }

    // Determine if we should limit rows based on file size or if it's partial data
    const shouldLimitRows = isPartial || forceLimit || csvString.length > 2000000; // 2MB threshold

    Papa.parse(csvString, {
      header: false,
      dynamicTyping: false, // Disable dynamic typing to preserve string values
      skipEmptyLines: true,
      preview: shouldLimitRows ? 50000 : 0, // 0 means parse all rows
      complete: (results) => {
        if (results.data && results.data.length > 0) {
          setCsvData(results.data);

          // Determine if this is actually partial data
          const actuallyPartial = isPartial || (shouldLimitRows && results.meta.truncated);
          setIsPartialData(actuallyPartial);

          // Generate column placeholders based on the number of columns in the first row
          if (results.data[0] && Array.isArray(results.data[0])) {
            const detectedCount = results.data[0].length;
            setColumnCount(detectedCount);
            if (!detectedCount) {
              setError('Unable to determine column structure');
            }
          } else {
            setColumnCount(0);
            setError('Unable to determine column structure');
          }
        } else {
          setColumnCount(0);
          setError('No rows found in the CSV file');
        }
        setLoading(false);
      },
      error: (error) => {
        setError(`Error parsing CSV: ${error.message}`);
        setColumnCount(0);
        setLoading(false);
      }
    });
  };

  const fetchAndProcessCSV = async (url) => {
    setLoading(true);
    setError(null);
    setColumnCount(0);
    setHeaders([]);
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status} ${response.statusText} (${url})`);
      }

      // Get the data as ArrayBuffer
      const arrayBuffer = await response.arrayBuffer();
      const fileSizeBytes = arrayBuffer.byteLength;

      // First try to decompress assuming it's gzipped
      try {
        const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
        const decoder = new TextDecoder('utf-8');
        const csvString = decoder.decode(decompressed);

        // Check if we should limit parsing due to large decompressed size
        const shouldLimit = csvString.length > 5000000; // 5MB of text

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
            const shouldLimit = fileSizeBytes > 5000000; // 5MB file size
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
  };

  // Function to fetch just a portion of a large file
  const fetchPartialCSV = async (url) => {
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
          setLoading(false);
        }
      }

    } catch (err) {
      setError(`Error fetching partial data: ${err.message}`);
      setLoading(false);
    }
  };

  // This effect will trigger whenever terminologyVersion or currentFileName changes
  useEffect(() => {
    const url = getCurrentUrl();
    if (!url) {
      return;
    }
    fetchAndProcessCSV(url);
    // Reset pagination when URL changes
    setCurrentPage(1);
  }, [currentFileName, currentFileFolder, terminologyVersion]);

  const handleGroupSelect = (groupId) => {
    const group = fileGroups.find((item) => item.id === groupId);
    if (!group) {
      return;
    }

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

    setSelectedGroupId(groupId);
    setCurrentFileName(fileName);
    setCurrentFileFolder(group.folder);
  };

  const handleVersionChange = (version) => {
    if (!version) {
      return;
    }
    userSelectedVersionRef.current = true;
    setTerminologyVersion(version);
    // The useEffect will automatically trigger and reload the current file with the new version
  };

  useEffect(() => {
    if (!columnCount) {
      setHeaders((prev) => (prev.length ? [] : prev));
      return;
    }

    const entry = resolveCrosswalkEntry(currentFileFolder, terminologyVersion, currentFileName);
    const fallbackHeaders = Array.from({ length: columnCount }, () => null);

    let nextHeaders = fallbackHeaders;

    if (entry && Array.isArray(entry.headers)) {
      if (entry.headers.length !== columnCount) {
        console.warn('Crosswalk headers length mismatch', {
          folder: currentFileFolder,
          version: terminologyVersion,
          file: currentFileName,
          expected: columnCount,
          received: entry.headers.length,
          tag: entry.tag,
          seed: entry.seed,
        });
      }

      nextHeaders = fallbackHeaders.map((_, index) => {
        const candidate = entry.headers[index];
        if (candidate === null || candidate === undefined) {
          return null;
        }
        const label = String(candidate).trim();
        return label ? label : null;
      });
    }

    console.log('Header resolution', {
      folder: currentFileFolder,
      version: terminologyVersion,
      file: currentFileName,
      columnCount,
      hasEntry: Boolean(entry),
      resolvedHeaders: nextHeaders,
    });

    setHeaders((prev) => (arraysEqual(prev, nextHeaders) ? prev : nextHeaders));
  }, [columnCount, currentFileFolder, currentFileName, headerCrosswalk, terminologyVersion]);

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

  const currentFileUrl = getCurrentUrl();

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
        zIndex: 10
      }}>
        <h1 style={{
          fontSize: '1.5rem',
          fontWeight: 'bold',
          margin: 0
        }}>Tuva Terminology Viewer</h1>

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
            Terminology version
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
        }}>Available Files - Version {terminologyVersion}</h2>

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
                {isPartialData
                  ? `Partial load: ${csvData.length} rows`
                  : `Total rows: ${csvData.length}`}
                {currentFileUrl ? `, Url: ${currentFileUrl}` : ''}
              </p>
            )}
          </div>
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
                marginBottom: '16px'
              }}>
                <input
                  type="text"
                  placeholder="Filter content..."
                  style={{
                    width: '100%',
                    padding: '8px 8px 8px 32px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '14px'
                  }}
                  value={filterTerm}
                  onChange={(e) => setFilterTerm(e.target.value)}
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
                      {headers.map((header, index) => (
                        <th 
                          key={index}
                          style={{
                            padding: '12px 24px',
                            textAlign: 'left',
                            fontSize: '12px',
                            fontWeight: 500,
                            color: '#6b7280',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            borderBottom: '1px solid #e5e7eb'
                          }}
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvData
                      .filter(row => {
                        if (!filterTerm) return true;
                        return row.some(cell => 
                          cell && String(cell).toLowerCase().includes(filterTerm.toLowerCase())
                        );
                      })
                      .slice((currentPage - 1) * pageSize, currentPage * pageSize)
                      .map((row, rowIndex) => (
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
                    ))}
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
                    </select>
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {(() => {
                      // Calculate filtered data once to avoid repeated filtering
                      const filteredData = csvData.filter(row => {
                        if (!filterTerm) return true;
                        return row.some(cell => 
                          cell && String(cell).toLowerCase().includes(filterTerm.toLowerCase())
                        );
                      });
                      const totalPages = Math.ceil(filteredData.length / pageSize) || 1;
                      
                      return (
                        <>
                          <button
                            onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                            disabled={currentPage === 1}
                            style={{
                              padding: '4px 8px',
                              border: '1px solid #d1d5db',
                              borderRadius: '4px',
                              marginRight: '8px',
                              backgroundColor: currentPage === 1 ? '#f3f4f6' : 'white',
                              cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                              color: currentPage === 1 ? '#9ca3af' : '#111827'
                            }}
                          >
                            Previous
                          </button>
                          
                          <span style={{ margin: '0 8px', fontSize: '14px' }}>
                            Page {currentPage} of {totalPages}
                          </span>
                          
                          <button
                            onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                            disabled={currentPage >= totalPages}
                            style={{
                              padding: '4px 8px',
                              border: '1px solid #d1d5db',
                              borderRadius: '4px',
                              backgroundColor: currentPage >= totalPages ? '#f3f4f6' : 'white',
                              cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
                              color: currentPage >= totalPages ? '#9ca3af' : '#111827'
                            }}
                          >
                            Next
                          </button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
