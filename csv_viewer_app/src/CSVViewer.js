import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Download, FileText, Loader2 } from 'lucide-react';
import * as Papa from 'papaparse';
import pako from 'pako';
import JSZip from 'jszip';
import limits from './config/limits.json';
import headerCrosswalkFallback from './generated/headerCrosswalk.json';

const MAX_INDEX_SEARCH_RESULTS = 500;
const PARTIAL_PREVIEW_ROW_LIMIT = typeof limits?.partialPreviewRowLimit === 'number'
  ? limits.partialPreviewRowLimit
  : 50000;

const BINARY_INDEX_MAGIC = 'TVIDXB';
const BINARY_INDEX_HEADER_SIZE = 112;
const TYPE_UINT16 = 1;
const TYPE_UINT32 = 2;
const binaryTextDecoder = new TextDecoder('utf-8');

const tokenizeQuery = (value = '') => Array.from(new Set(
  value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
));

const intersectSortedArrays = (arrA, arrB) => {
  if (!arrA || !arrB) {
    return [];
  }

  const result = [];
  let i = 0;
  let j = 0;

  while (i < arrA.length && j < arrB.length) {
    const valueA = arrA[i];
    const valueB = arrB[j];

    if (valueA === valueB) {
      result.push(valueA);
      i += 1;
      j += 1;
      continue;
    }

    if (valueA < valueB) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return result;
};

const normalizeIndexPayload = (raw = {}) => {
  const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  const defaultLookup = Object.fromEntries(tokens.map((token, index) => [token, index]));

  const inferUintArray = (value, Type) => {
    if (!value || (Array.isArray(value) && value.length === 0)) {
      return new Type(0);
    }
    if (value instanceof Type) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return new Type(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (Array.isArray(value)) {
      return Type.from(value);
    }
    return new Type(0);
  };

  let rowOffsets = null;
  if (raw.rowOffsets) {
    rowOffsets = inferUintArray(raw.rowOffsets, Uint32Array);
  }

  let rowData = null;
  if (raw.rowData) {
    rowData = inferUintArray(raw.rowData, Uint32Array);
  }

  let rowFiles = null;
  const rowFilesTypeValue = raw.rowFilesType === TYPE_UINT32 ? TYPE_UINT32 : TYPE_UINT16;
  if (raw.rowFiles) {
    const Type = rowFilesTypeValue === TYPE_UINT32 ? Uint32Array : Uint16Array;
    rowFiles = inferUintArray(raw.rowFiles, Type);
  }

  let rowPositions = null;
  if (raw.rowPositions) {
    rowPositions = inferUintArray(raw.rowPositions, Uint32Array);
  }

  let postingOffsets = null;
  if (raw.postingOffsets) {
    postingOffsets = inferUintArray(raw.postingOffsets, Uint32Array);
  }

  let postingsData = null;
  if (raw.postingsData) {
    postingsData = inferUintArray(raw.postingsData, Uint32Array);
  }

  const hasTypedLayout = Boolean(rowOffsets && rowData && rowFiles && rowPositions && postingOffsets && postingsData);

  let rows = Array.isArray(raw.rows) ? raw.rows : [];
  if (!hasTypedLayout && rows.length) {
    const offsets = new Uint32Array(rows.length + 1);
    let totalCells = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      offsets[index] = totalCells;
      totalCells += row.length;
    }
    offsets[offsets.length - 1] = totalCells;
    rowOffsets = offsets;
    rowData = new Uint32Array(totalCells);
    let cursor = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
        rowData[cursor] = row[cellIndex] >>> 0;
        cursor += 1;
      }
    }
    rowFiles = inferUintArray(raw.rowFiles, Uint16Array);
    rowPositions = inferUintArray(raw.rowPositions, Uint32Array);
  }

  let postings = [];
  if (Array.isArray(raw.postings)) {
    postings = raw.postings.map((posting) => new Uint32Array(posting));
  }

  const dataset = raw.dataset || null;
  const generatedAt = raw.generatedAt || null;
  const totalRows = typeof raw.totalRows === 'number' ? raw.totalRows : 0;
  const maxColumns = typeof raw.maxColumns === 'number' ? raw.maxColumns : 0;
  const valueColumnLimit = typeof raw.valueColumnLimit === 'number' ? raw.valueColumnLimit : 0;
  const files = Array.isArray(raw.files) ? raw.files : [];
  const dictionary = Array.isArray(raw.dictionary) ? raw.dictionary : [];
  const tokenLookup = raw.tokenLookup && typeof raw.tokenLookup === 'object'
    ? raw.tokenLookup
    : defaultLookup;

  return {
    dataset,
    generatedAt,
    totalRows,
    maxColumns,
    valueColumnLimit,
    files,
    dictionary,
    rows,
    rowOffsets: rowOffsets || new Uint32Array(0),
    rowData: rowData || new Uint32Array(0),
    rowFiles: rowFiles || new Uint16Array(0),
    rowFilesType: rowFilesTypeValue,
    rowPositions: rowPositions || new Uint32Array(0),
    tokens,
    tokenLookup,
    postings,
    postingOffsets: postingOffsets || new Uint32Array(0),
    postingsData: postingsData || new Uint32Array(0),
    format: hasTypedLayout ? 'json-typed' : 'json',
  };
};

const toArrayBuffer = (input) => {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  throw new Error('Unsupported buffer type.');
};

const readLengthPrefixedStrings = (arrayBuffer, offset, count, totalBytes) => {
  const values = new Array(count);
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > offset + totalBytes) {
      throw new Error('Corrupted string section.');
    }
    const length = new DataView(arrayBuffer, cursor, 4).getUint32(0, true);
    cursor += 4;
    if (cursor + length > offset + totalBytes) {
      throw new Error('Corrupted string payload.');
    }
    const bytes = new Uint8Array(arrayBuffer, cursor, length);
    values[index] = binaryTextDecoder.decode(bytes);
    cursor += length;
  }
  return { values, nextOffset: offset + totalBytes };
};

const readFilesMetadata = (arrayBuffer, offset, count, totalBytes) => {
  const files = new Array(count);
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > offset + totalBytes) {
      throw new Error('Corrupted files metadata section.');
    }
    const nameLength = new DataView(arrayBuffer, cursor, 4).getUint32(0, true);
    cursor += 4;
    if (cursor + nameLength + 4 > offset + totalBytes) {
      throw new Error('Corrupted file metadata payload.');
    }
    const nameBytes = new Uint8Array(arrayBuffer, cursor, nameLength);
    cursor += nameLength;
    const rowCount = new DataView(arrayBuffer, cursor, 4).getUint32(0, true);
    cursor += 4;
    files[index] = {
      name: binaryTextDecoder.decode(nameBytes),
      rowCount,
    };
  }
  return { files, nextOffset: offset + totalBytes };
};

const decodeBinaryIndex = (rawBuffer) => {
  const arrayBuffer = toArrayBuffer(rawBuffer);
  if (!arrayBuffer || arrayBuffer.byteLength < BINARY_INDEX_HEADER_SIZE) {
    throw new Error('Binary index payload is too small.');
  }

  const headerView = new DataView(arrayBuffer, 0, BINARY_INDEX_HEADER_SIZE);
  const magic = String.fromCharCode(
    headerView.getUint8(0),
    headerView.getUint8(1),
    headerView.getUint8(2),
    headerView.getUint8(3),
    headerView.getUint8(4),
    headerView.getUint8(5),
  );
  if (magic !== BINARY_INDEX_MAGIC) {
    throw new Error('Unrecognised binary index payload.');
  }

  const version = headerView.getUint8(6);
  if (version !== 1) {
    throw new Error(`Unsupported binary index version: ${version}`);
  }

  let headerOffset = 8;
  const readUint32 = () => {
    const value = headerView.getUint32(headerOffset, true);
    headerOffset += 4;
    return value;
  };

  const datasetLength = readUint32();
  const generatedAtLength = readUint32();
  const dictionaryCount = readUint32();
  const dictionaryBytes = readUint32();
  const tokensCount = readUint32();
  const tokensBytes = readUint32();
  const filesCount = readUint32();
  const filesBytes = readUint32();
  const totalRows = readUint32();
  const maxColumns = readUint32();
  const valueColumnLimit = readUint32();
  const totalCells = readUint32();
  const postingsCount = readUint32();
  const postingOffsetsCount = readUint32();
  const rowOffsetsCount = readUint32();
  const rowFilesCount = readUint32();
  const rowPositionsCount = readUint32();
  const rowFilesType = headerView.getUint8(headerOffset);
  headerOffset += 1;
  const rowPositionsType = headerView.getUint8(headerOffset);
  headerOffset += 1;
  const rowDataType = headerView.getUint8(headerOffset);
  headerOffset += 1;
  const postingsType = headerView.getUint8(headerOffset);
  headerOffset += 1;
  const rowOffsetsBytes = readUint32();
  const rowDataBytes = readUint32();
  const rowFilesBytes = readUint32();
  const rowPositionsBytes = readUint32();
  const postingOffsetsBytes = readUint32();
  const postingsBytes = readUint32();

  let cursor = BINARY_INDEX_HEADER_SIZE;

  const datasetBytes = new Uint8Array(arrayBuffer, cursor, datasetLength);
  const dataset = binaryTextDecoder.decode(datasetBytes);
  cursor += datasetLength;

  const generatedAtBytes = new Uint8Array(arrayBuffer, cursor, generatedAtLength);
  const generatedAt = binaryTextDecoder.decode(generatedAtBytes);
  cursor += generatedAtLength;

  const { values: dictionary, nextOffset: afterDictionary } = readLengthPrefixedStrings(
    arrayBuffer,
    cursor,
    dictionaryCount,
    dictionaryBytes,
  );
  cursor = afterDictionary;

  const { values: tokens, nextOffset: afterTokens } = readLengthPrefixedStrings(
    arrayBuffer,
    cursor,
    tokensCount,
    tokensBytes,
  );
  cursor = afterTokens;

  const { files, nextOffset: afterFiles } = readFilesMetadata(
    arrayBuffer,
    cursor,
    filesCount,
    filesBytes,
  );
  cursor = afterFiles;

  const rowOffsets = rowOffsetsBytes
    ? new Uint32Array(arrayBuffer.slice(cursor, cursor + rowOffsetsBytes))
    : new Uint32Array(0);
  cursor += rowOffsetsBytes;

  let rowData;
  if (rowDataType !== TYPE_UINT32) {
    throw new Error('Unsupported row data encoding.');
  }
  rowData = rowDataBytes
    ? new Uint32Array(arrayBuffer.slice(cursor, cursor + rowDataBytes))
    : new Uint32Array(0);
  cursor += rowDataBytes;

  let rowFiles;
  if (rowFilesType === TYPE_UINT16) {
    rowFiles = rowFilesBytes
      ? new Uint16Array(arrayBuffer.slice(cursor, cursor + rowFilesBytes))
      : new Uint16Array(0);
  } else if (rowFilesType === TYPE_UINT32) {
    rowFiles = rowFilesBytes
      ? new Uint32Array(arrayBuffer.slice(cursor, cursor + rowFilesBytes))
      : new Uint32Array(0);
  } else {
    throw new Error('Unsupported row file encoding.');
  }
  cursor += rowFilesBytes;

  if (rowPositionsType !== TYPE_UINT32) {
    throw new Error('Unsupported row position encoding.');
  }
  const rowPositions = rowPositionsBytes
    ? new Uint32Array(arrayBuffer.slice(cursor, cursor + rowPositionsBytes))
    : new Uint32Array(0);
  cursor += rowPositionsBytes;

  if (postingsType !== TYPE_UINT32) {
    throw new Error('Unsupported postings encoding.');
  }
  const postingOffsets = postingOffsetsBytes
    ? new Uint32Array(arrayBuffer.slice(cursor, cursor + postingOffsetsBytes))
    : new Uint32Array(0);
  cursor += postingOffsetsBytes;

  const postingsData = postingsBytes
    ? new Uint32Array(arrayBuffer.slice(cursor, cursor + postingsBytes))
    : new Uint32Array(0);
  cursor += postingsBytes;

  if (postingOffsets.length !== postingOffsetsCount) {
    throw new Error('Posting offsets metadata mismatch.');
  }
  if (rowOffsets.length !== rowOffsetsCount) {
    throw new Error('Row offsets metadata mismatch.');
  }
  if (rowFiles.length !== rowFilesCount) {
    throw new Error('Row files metadata mismatch.');
  }
  if (rowPositions.length !== rowPositionsCount) {
    throw new Error('Row positions metadata mismatch.');
  }
  if (postingsData.length !== postingsCount) {
    throw new Error('Postings metadata mismatch.');
  }

  const tokenLookup = Object.fromEntries(tokens.map((token, index) => [token, index]));

  return {
    version,
    dataset,
    generatedAt,
    totalRows,
    maxColumns,
    valueColumnLimit,
    totalCells,
    files,
    dictionary,
    tokens,
    tokenLookup,
    postingOffsets,
    postingsData,
    rowOffsets,
    rowData,
    rowFiles,
    rowFilesType,
    rowPositions,
    format: 'binary',
  };
};

const buildIndexSearchResults = (query, searchIndex, limit = MAX_INDEX_SEARCH_RESULTS) => {
  if (!searchIndex) {
    return {
      rows: [],
      matchCount: 0,
      truncated: false,
    };
  }

  const normalizedQuery = query.trim().toLowerCase();
  const terms = tokenizeQuery(normalizedQuery);

  if (!terms.length) {
    return {
      rows: [],
      matchCount: 0,
      truncated: false,
    };
  }

  const getPostingForToken = (tokenIndex) => {
    if (tokenIndex === null || tokenIndex === undefined || Number.isNaN(tokenIndex)) {
      return null;
    }
    if (Array.isArray(searchIndex.postings)) {
      return searchIndex.postings[tokenIndex] || null;
    }
    if (searchIndex.postingOffsets && ArrayBuffer.isView(searchIndex.postingsData)) {
      const offsets = searchIndex.postingOffsets;
      if (tokenIndex < 0 || tokenIndex >= offsets.length - 1) {
        return null;
      }
      const start = offsets[tokenIndex];
      const end = offsets[tokenIndex + 1];
      return searchIndex.postingsData.subarray(start, end);
    }
    return null;
  };

  const getRowValues = (rowIndex) => {
    if (Array.isArray(searchIndex.rows)) {
      const encodedRow = searchIndex.rows[rowIndex];
      if (!Array.isArray(encodedRow)) {
        return [];
      }
      return encodedRow.map((valueIndex) => searchIndex.dictionary[valueIndex] ?? '');
    }

    if (searchIndex.rowOffsets && ArrayBuffer.isView(searchIndex.rowData)) {
      const offsets = searchIndex.rowOffsets;
      if (rowIndex < 0 || rowIndex >= offsets.length - 1) {
        return [];
      }
      const start = offsets[rowIndex];
      const end = offsets[rowIndex + 1];
      const values = new Array(end - start);
      let pointer = 0;
      for (let i = start; i < end; i += 1) {
        const dictionaryIndex = searchIndex.rowData[i];
        values[pointer] = searchIndex.dictionary[dictionaryIndex] ?? '';
        pointer += 1;
      }
      return values;
    }

    return [];
  };

  const getRowFileIndex = (rowIndex) => {
    const rowFiles = searchIndex.rowFiles;
    if (!rowFiles) {
      return 0;
    }
    if (Array.isArray(rowFiles) || ArrayBuffer.isView(rowFiles)) {
      return rowFiles[rowIndex] ?? 0;
    }
    return 0;
  };

  const getRowPosition = (rowIndex) => {
    const rowPositions = searchIndex.rowPositions;
    if (!rowPositions) {
      return 0;
    }
    if (Array.isArray(rowPositions) || ArrayBuffer.isView(rowPositions)) {
      return rowPositions[rowIndex] ?? 0;
    }
    return 0;
  };

  let candidateRows = null;

  for (const term of terms) {
    const tokenIndex = searchIndex.tokenLookup?.[term];
    const directPostings = typeof tokenIndex === 'number'
      ? getPostingForToken(tokenIndex)
      : null;

    const shouldExpandPartials = !directPostings
      || (term.length >= 3 && directPostings.length < limit);

    let termPostings;

    if (shouldExpandPartials) {
      const rowSet = new Set();

      if (directPostings) {
        for (let i = 0; i < directPostings.length; i += 1) {
          rowSet.add(directPostings[i]);
        }
      }

      for (let i = 0; i < searchIndex.tokens.length; i += 1) {
        const token = searchIndex.tokens[i];
        if (!token || !token.includes(term)) {
          continue;
        }

        if (directPostings && typeof tokenIndex === 'number' && i === tokenIndex) {
          continue;
        }

        const posting = getPostingForToken(i);
        for (let j = 0; j < posting.length; j += 1) {
          rowSet.add(posting[j]);
        }
      }

      if (!rowSet.size) {
        return {
          rows: [],
          matchCount: 0,
          truncated: false,
        };
      }

      termPostings = Array.from(rowSet).sort((a, b) => a - b);
    } else {
      termPostings = directPostings;
    }

    if (!termPostings || !termPostings.length) {
      return {
        rows: [],
        matchCount: 0,
        truncated: false,
      };
    }

    if (candidateRows === null) {
      candidateRows = termPostings;
    } else {
      candidateRows = intersectSortedArrays(candidateRows, termPostings);
    }

    if (!candidateRows.length) {
      return {
        rows: [],
        matchCount: 0,
        truncated: false,
      };
    }
  }

  const matches = [];
  const dictionary = searchIndex.dictionary;
  const lowerQuery = normalizedQuery;

  for (let i = 0; i < candidateRows.length; i += 1) {
    const rowIndex = candidateRows[i];
    const rowValues = getRowValues(rowIndex);
    if (!rowValues.length) {
      continue;
    }
    const rowText = rowValues.join(' ').toLowerCase();

    if (!rowText.includes(lowerQuery)) {
      continue;
    }

    matches.push({
      rowIndex,
      values: rowValues,
      fileIndex: getRowFileIndex(rowIndex),
      rowPosition: getRowPosition(rowIndex),
    });

    if (matches.length >= limit) {
      break;
    }
  }

  return {
    rows: matches,
    matchCount: candidateRows.length,
    truncated: candidateRows.length > matches.length,
  };
};

export { buildIndexSearchResults };

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

export default function CSVViewer() {
  const baseDomain = 'https://tuva-public-resources.s3.amazonaws.com';
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
        { folder: default_folder, type: 'versioned', indexFolder: 'terminology_indices' },
        { folder: provider_folder, type: 'versioned', indexFolder: 'provider_indices' }
      ]
    },
    {
      id: 'value-sets',
      label: 'Value Sets',
      versionLabel: 'Value set version',
      sources: [
        { folder: value_sets_folder, type: 'versioned', indexFolder: 'value_set_indices' }
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
          excludedPrefixes: [`${reference_data_folder}/2022 Census Shapefiles/`],
          indexFolder: 'reference_data_indices'
        }
      ]
    }
  ]), [default_folder, provider_folder, value_sets_folder, reference_data_folder]);

  const versionedFolders = useMemo(() => new Set(
    dataCategories.flatMap((category) =>
      category.sources.filter((source) => source.type === 'versioned').map((source) => source.folder)
    )
  ), [dataCategories]);

  const indexFolderMap = useMemo(() => {
    const map = new Map();
    dataCategories.forEach((category) => {
      category.sources.forEach((source) => {
        if (source.indexFolder) {
          map.set(source.folder, source.indexFolder);
        }
      });
    });
    return map;
  }, [dataCategories]);

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
  const [activeCategoryId, setActiveCategoryId] = useState(dataCategories[0].id);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [versionLoadError, setVersionLoadError] = useState(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [fileLoadError, setFileLoadError] = useState(null);
  const userSelectedVersionRef = useRef(false);
  const listingBaseRef = useRef(null);
  const indexCacheRef = useRef(new Map());
  const [searchIndex, setSearchIndex] = useState(null);
  const [isLoadingIndex, setIsLoadingIndex] = useState(false);
  const [indexError, setIndexError] = useState(null);

  const activeCategory = useMemo(
    () => dataCategories.find((category) => category.id === activeCategoryId) || dataCategories[0],
    [dataCategories, activeCategoryId]
  );
  const versionedSources = useMemo(
    () => activeCategory.sources.filter((source) => source.type === 'versioned'),
    [activeCategory]
  );
  const hasVersionedSources = versionedSources.length > 0;

  useEffect(() => {
    setFileGroups([]);
    setSelectedGroupId(null);
    setCurrentFileName(null);
    setCurrentFileFolder(activeCategory.sources[0]?.folder || default_folder);
    setCsvData([]);
    setHeaders([]);
    setSearchTerm('');
    setFilterTerm('');
    setCurrentPage(1);
    setIsPartialData(false);
    setError(null);
    setFileLoadError(null);
    setLoading(false);
  }, [activeCategory]);

  const determineListingBase = useCallback(() => {
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
    if (base === '/s3-proxy') {
      return `${base}/?${params}`;
    }

    const baseUrl = `${base.replace(/\/$/, '')}/`;
    const url = new URL(baseUrl);
    url.search = params;
    return url.toString();
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

  const toBaseCsvName = useCallback((fileName = '') => {
    if (typeof fileName !== 'string') {
      return '';
    }

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

    if (normalized.endsWith('.zip')) {
      return normalized.replace(/\.zip$/i, '.csv');
    }

    return normalized;
  }, []);

  const isLatestVersion = useCallback((value = '') => normalizeKey(value) === 'latest', []);

  const toVersionParts = useCallback((value = '') => {
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
  }, []);

  const compareVersionStrings = useCallback((a = '', b = '') => {
    if (isLatestVersion(a) && isLatestVersion(b)) {
      return 0;
    }
    if (isLatestVersion(a)) {
      return 1;
    }
    if (isLatestVersion(b)) {
      return -1;
    }

    const partsA = toVersionParts(a);
    const partsB = toVersionParts(b);
    const maxLength = Math.max(partsA.length, partsB.length);
    for (let index = 0; index < maxLength; index += 1) {
      const valueA = index < partsA.length ? partsA[index] : 0;
      const valueB = index < partsB.length ? partsB[index] : 0;

      if (valueA === valueB) {
        continue;
      }

      if (typeof valueA === 'number' && typeof valueB === 'number') {
        return valueA < valueB ? -1 : 1;
      }

      return String(valueA).localeCompare(String(valueB), undefined, { sensitivity: 'base' });
    }

    return 0;
  }, [isLatestVersion, toVersionParts]);

  const resolveVersionMap = useCallback((folderMap, requestedVersion) => {
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
  }, [compareVersionStrings]);

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

  const resolveCrosswalkEntry = useCallback((folder, version, fileName) => {
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
  }, [headerCrosswalk, resolveVersionMap, toBaseCsvName]);


  const baseCsvName = useMemo(
    () => (currentFileName ? toBaseCsvName(currentFileName) : null),
    [currentFileName, toBaseCsvName]
  );

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
  // Generate S3 object URLs for data and index assets
  const resolveIndexFolder = useCallback((folder) => {
    if (!folder) {
      return folder;
    }
    return indexFolderMap.get(folder) || folder;
  }, [indexFolderMap]);

  const buildObjectUrl = useCallback((folder, fileName, version, { useIndexFolder = false } = {}) => {
    if (!folder || !fileName) {
      return '';
    }

    const targetFolder = useIndexFolder ? resolveIndexFolder(folder) : folder;
    if (!targetFolder) {
      return '';
    }

    const normalizedFolder = targetFolder
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const sanitizedFile = fileName.replace(/^\/+/, '');
    const base = baseDomain.replace(/\/$/, '');

    if (versionedFolders.has(folder)) {
      const normalizedVersion = (version ?? '')
        .toString()
        .trim()
        .replace(/^\/+|\/+$/g, '');
      if (!normalizedVersion) {
        return '';
      }
      return `${base}/${normalizedFolder}/${normalizedVersion}/${sanitizedFile}`;
    }

    return `${base}/${normalizedFolder}/${sanitizedFile}`;
  }, [baseDomain, resolveIndexFolder, versionedFolders]);

  const getCurrentUrl = useCallback((
    version = terminologyVersion,
    folder = currentFileFolder,
    fileName = currentFileName
  ) => {
    const targetFolder = folder || default_folder;
    return buildObjectUrl(targetFolder, fileName, version);
  }, [buildObjectUrl, currentFileFolder, currentFileName, default_folder, terminologyVersion]);

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
  }, [activeCategory, buildListingUrl, getListingBase, setListingBase, versionedSources]);

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
          if (!keyText || keyText.endsWith('/')) {
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
  }, [activeCategory, buildFileGroups, buildListingUrl, getListingBase, hasVersionedSources, setListingBase, terminologyVersion, versionedSources]);

  // Helper function to process CSV string and update state
  const processCsvString = useCallback((csvString, isPartial = false, forceLimit = false) => {
    if (!csvString.trim()) {
      throw new Error("CSV file is empty");
    }

    // Determine if we should limit rows based on file size or if it's partial data
    const shouldLimitRows = isPartial || forceLimit || csvString.length > 2000000; // 2MB threshold

    Papa.parse(csvString, {
      header: false,
      dynamicTyping: false, // Disable dynamic typing to preserve string values
      skipEmptyLines: true,
      preview: shouldLimitRows ? PARTIAL_PREVIEW_ROW_LIMIT : 0, // 0 means parse all rows
      complete: (results) => {
        if (results.data && results.data.length > 0) {
          setCsvData(results.data);

          // Determine if this is actually partial data
          const actuallyPartial = isPartial || (shouldLimitRows && results.meta.truncated);
          setIsPartialData(actuallyPartial);

          // Generate column placeholders based on the number of columns in the first row
          if (results.data[0] && Array.isArray(results.data[0])) {
            const detectedCount = results.data[0].length;
            const placeholderHeaders = Array.from({ length: detectedCount }, (_, i) => `Column ${i + 1}`);
            setColumnCount(detectedCount);
            setHeaders(placeholderHeaders);
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
          setLoading(false);
        }
      }

    } catch (err) {
      setError(`Error fetching partial data: ${err.message}`);
      setLoading(false);
    }
  }, [processCsvString]);

  const fetchAndProcessCSV = useCallback(async (url, fileName = '') => {
    setLoading(true);
    setError(null);
    setIndexError(null);
    setSearchIndex(null);
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
      setLoading(false);
    }
  }, [fetchPartialCSV, processCsvString]);

  const currentFileUrl = useMemo(() => getCurrentUrl(), [getCurrentUrl]);

  // This effect will trigger whenever terminologyVersion or currentFileName changes
  useEffect(() => {
    if (!currentFileUrl) {
      return;
    }
    fetchAndProcessCSV(currentFileUrl, currentFileName || '');
    // Reset pagination when URL changes
    setCurrentPage(1);
  }, [currentFileUrl, currentFileName, fetchAndProcessCSV]);

  useEffect(() => {
    const isVersionedFolder = currentFileFolder
      ? versionedFolders.has(currentFileFolder)
      : false;

    if (!baseCsvName || !currentFileFolder || (isVersionedFolder && !terminologyVersion)) {
      setSearchIndex(null);
      setIndexError(null);
      setIsLoadingIndex(false);
      return;
    }

    const versionKey = isVersionedFolder ? (terminologyVersion || '') : '';
    const cacheKey = `${currentFileFolder}::${versionKey.toLowerCase()}::${baseCsvName.toLowerCase()}`;

    if (indexCacheRef.current.has(cacheKey)) {
      const cached = indexCacheRef.current.get(cacheKey);
      if (cached) {
        setSearchIndex(cached);
      } else {
        setSearchIndex(null);
      }
      setIndexError(null);
      setIsLoadingIndex(false);
      return;
    }

    let cancelled = false;

    const fetchIndex = async () => {
      const candidates = [
        `${baseCsvName}.index.bin.gz`,
        `${baseCsvName}.index.bin`,
        `${baseCsvName}.index.json.gz`,
        `${baseCsvName}.index.json`
      ];

      let lastError = null;

      for (const candidate of candidates) {
        const url = buildObjectUrl(
          currentFileFolder,
          candidate,
          isVersionedFolder ? terminologyVersion : undefined,
          { useIndexFolder: true }
        );

        if (!url) {
          continue;
        }

        try {
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) {
            if (response.status === 404) {
              const notFoundError = new Error(`Index file not found: ${candidate}`);
              notFoundError.code = 'INDEX_NOT_FOUND';
              lastError = notFoundError;
              continue;
            }
            throw new Error(`Failed to fetch ${candidate}: ${response.status} ${response.statusText}`);
          }

          const arrayBuffer = await response.arrayBuffer();

          if (candidate.endsWith('.bin') || candidate.endsWith('.bin.gz')) {
            try {
              const binaryBuffer = candidate.endsWith('.gz')
                ? toArrayBuffer(pako.ungzip(new Uint8Array(arrayBuffer)))
                : arrayBuffer;
              return decodeBinaryIndex(binaryBuffer);
            } catch (binaryError) {
              lastError = new Error(`Unable to load binary index ${candidate}: ${binaryError.message}`);
              continue;
            }
          }

          let jsonText;

          if (candidate.endsWith('.gz')) {
            try {
              const decompressed = pako.ungzip(new Uint8Array(arrayBuffer), { to: 'string' });
              jsonText = typeof decompressed === 'string'
                ? decompressed
                : new TextDecoder('utf-8').decode(decompressed);
            } catch (decompressionError) {
              lastError = new Error(`Unable to decompress ${candidate}: ${decompressionError.message}`);
              continue;
            }
          } else {
            jsonText = new TextDecoder('utf-8').decode(arrayBuffer);
          }

          try {
            const parsed = JSON.parse(jsonText);
            return normalizeIndexPayload(parsed);
          } catch (jsonError) {
            lastError = new Error(`Unable to parse ${candidate}: ${jsonError.message}`);
          }
        } catch (err) {
          lastError = err;
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error('Index file not found for this dataset.');
    };

    setIsLoadingIndex(true);
    setIndexError(null);
    setSearchIndex(null);

    fetchIndex()
      .then((indexData) => {
        if (cancelled) {
          return;
        }
        indexCacheRef.current.set(cacheKey, indexData);
        setSearchIndex(indexData);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err && err.code === 'INDEX_NOT_FOUND') {
          indexCacheRef.current.set(cacheKey, null);
          console.info(`Search index not built for ${cacheKey}`);
          setIndexError(null);
          setSearchIndex(null);
          return;
        }
        console.warn(`Search index unavailable for ${cacheKey}`, err);
        setIndexError(err.message || 'Search index unavailable for this dataset.');
        setSearchIndex(null);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingIndex(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [baseCsvName, buildObjectUrl, currentFileFolder, terminologyVersion, versionedFolders]);

  useEffect(() => {
    if (!searchIndex || !searchIndex.maxColumns) {
      return;
    }

    setHeaders((current) => {
      const existing = Array.isArray(current) ? current : [];
      if (existing.length >= searchIndex.maxColumns) {
        return existing;
      }

      const next = existing.slice();
      while (next.length < searchIndex.maxColumns) {
        next.push(`Column ${next.length + 1}`);
      }
      return next;
    });
  }, [searchIndex]);

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
      if (headers.length) {
        setHeaders([]);
      }
      return;
    }

    const fallbackHeaders = Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
    const entry = resolveCrosswalkEntry(currentFileFolder, terminologyVersion, currentFileName);

    let nextHeaders = fallbackHeaders;

    if (entry && Array.isArray(entry.headers)) {
      nextHeaders = fallbackHeaders.map((placeholder, index) => {
        const candidate = entry.headers[index];
        if (candidate === null || candidate === undefined) {
          return placeholder;
        }
        const label = String(candidate).trim();
        return label || placeholder;
      });
    }

    if (!arraysEqual(headers, nextHeaders)) {
      setHeaders(nextHeaders);
    }
  }, [columnCount, currentFileFolder, currentFileName, headers, resolveCrosswalkEntry, terminologyVersion]);

  const tableComputation = useMemo(() => {
    const normalizedQuery = filterTerm.trim().toLowerCase();

    if (searchIndex && normalizedQuery) {
      const indexResult = buildIndexSearchResults(normalizedQuery, searchIndex, MAX_INDEX_SEARCH_RESULTS);
      if (indexResult.rows.length) {
        return {
          source: 'index',
          rows: indexResult.rows.map((entry) => entry.values),
          totalMatches: indexResult.rows.length,
          matchCount: indexResult.matchCount,
          truncated: indexResult.truncated,
          rowMetadata: indexResult.rows,
        };
      }
    }

    const fallbackRows = normalizedQuery
      ? csvData.filter((row) => row.some((cell) => cell && String(cell).toLowerCase().includes(normalizedQuery)))
      : csvData;

    return {
      source: normalizedQuery ? 'preview-filter' : 'preview',
      rows: fallbackRows,
      totalMatches: fallbackRows.length,
      matchCount: fallbackRows.length,
      truncated: false,
      rowMetadata: null,
    };
  }, [filterTerm, searchIndex, csvData]);

  useEffect(() => {
    const totalPagesComputed = Math.max(1, Math.ceil((tableComputation.rows.length || 1) / pageSize));
    setCurrentPage((prev) => Math.min(prev, totalPagesComputed));
  }, [tableComputation.rows.length, pageSize]);

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedRows = tableComputation.rows.slice(startIndex, endIndex);
  const totalPages = Math.max(1, Math.ceil((tableComputation.rows.length || 1) / pageSize));
  const summaryText = (() => {
    if (tableComputation.source === 'index') {
      const displayed = tableComputation.totalMatches.toLocaleString();
      const totalMatchesText = typeof tableComputation.matchCount === 'number'
        ? tableComputation.matchCount.toLocaleString()
        : null;
      const limitedText = tableComputation.truncated
        ? ` (showing first ${MAX_INDEX_SEARCH_RESULTS.toLocaleString()} matches)`
        : '';
      return `Index search: showing ${displayed}${totalMatchesText ? ` of ${totalMatchesText}` : ''} matches${limitedText}`;
    }

    if (tableComputation.source === 'preview-filter') {
      return `Filtered preview rows: ${tableComputation.totalMatches.toLocaleString()} of ${csvData.length.toLocaleString()} preview rows`;
    }

    if (isPartialData) {
      return `Partial load preview: ${csvData.length.toLocaleString()} rows`;
    }

    return `Preview rows loaded: ${csvData.length.toLocaleString()}`;
  })();
  const showIndexReady = Boolean(searchIndex && !isLoadingIndex && !indexError);
  const storedColumnLimit = searchIndex?.valueColumnLimit || 0;

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
            {!loading && !error && (
              <div style={{ marginTop: '4px' }}>
                <p style={{
                  fontSize: '14px',
                  color: '#6b7280',
                  margin: 0
                }}>
                  {summaryText}
                </p>
                {isLoadingIndex && (
                  <p style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    margin: '4px 0 0 0'
                  }}>
                    Loading search index…
                  </p>
                )}
                {indexError && !isLoadingIndex && (
                  <p style={{
                    fontSize: '12px',
                    color: '#dc2626',
                    margin: '4px 0 0 0'
                  }}>
                    {indexError}
                  </p>
                )}
                {showIndexReady && (
                  <p style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    margin: '4px 0 0 0'
                  }}>
                    Index ready · {searchIndex.totalRows.toLocaleString()} rows searchable
                  </p>
                )}
                {showIndexReady && storedColumnLimit > 0 && columnCount > storedColumnLimit && (
                  <p style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    margin: '4px 0 0 0'
                  }}>
                    Index includes the first {storedColumnLimit.toLocaleString()} column{storedColumnLimit === 1 ? '' : 's'} per row. Download to view all columns.
                  </p>
                )}
                {currentFileUrl && (
                  <p style={{
                    fontSize: '12px',
                    color: '#6b7280',
                    margin: '4px 0 0 0'
                  }}>
                    URL: {currentFileUrl}
                  </p>
                )}
              </div>
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
              {tableComputation.source === 'index' && tableComputation.truncated && (
                <div style={{
                  fontSize: '12px',
                  color: '#6b7280',
                  marginBottom: '12px'
                }}>
                  Showing first {MAX_INDEX_SEARCH_RESULTS.toLocaleString()} matches. Refine the search to narrow results.
                </div>
              )}
              {!searchIndex && !isLoadingIndex && !indexError && (
                <div style={{
                  fontSize: '12px',
                  color: '#6b7280',
                  marginBottom: '12px'
                }}>
                  Search is limited to the preview because no pre-built index was found for this dataset.
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
                    {paginatedRows.map((row, rowIndex) => {
                      const globalIndex = startIndex + rowIndex;
                      return (
                        <tr
                          key={globalIndex}
                          style={{
                            backgroundColor: globalIndex % 2 === 0 ? 'white' : '#f9fafb'
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
                      );
                    })}
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
                  <div style={{ display: 'flex', alignItems: 'center' }}
                  >
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
                  
                  <div style={{ display: 'flex', alignItems: 'center' }}
                  >
                    <button
                      onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
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

                    <span style={{ margin: '0 8px', fontSize: '14px' }}
                    >
                      Page {Math.min(currentPage, totalPages)} of {totalPages}
                    </span>

                    <button
                      onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
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
