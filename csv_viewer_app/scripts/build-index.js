#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const zlib = require('zlib');
const Papa = require('papaparse');
const limits = require('../src/config/limits.json');

const DEFAULT_MIN_ROWS = limits && typeof limits.partialPreviewRowLimit === 'number'
  ? limits.partialPreviewRowLimit
  : 50000;

const BINARY_MAGIC = Buffer.from('TVIDXB');
const BINARY_VERSION = 1;
const HEADER_SIZE = 112;
const TYPE_UINT16 = 1;
const TYPE_UINT32 = 2;
const JSON_ROW_THRESHOLD = 200000;
const DEFAULT_INDEX_VALUE_COLUMN_LIMIT = typeof limits?.indexValueColumnLimit === 'number'
  ? Math.max(0, Math.floor(limits.indexValueColumnLimit))
  : 8;

const INDEX_VALUE_COLUMN_OVERRIDES = limits && typeof limits === 'object'
  ? limits.indexValueColumnLimitOverrides || {}
  : {};

const INDEX_DATASET_EXCLUSIONS = new Set(
  Array.isArray(limits?.indexDatasetExclusions)
    ? limits.indexDatasetExclusions
        .map((name) => (typeof name === 'string' ? name.trim().toLowerCase() : ''))
        .filter(Boolean)
    : [],
);

const resolveValueColumnLimit = (datasetName = '') => {
  if (datasetName && typeof INDEX_VALUE_COLUMN_OVERRIDES === 'object') {
    const override = INDEX_VALUE_COLUMN_OVERRIDES[datasetName];
    if (Number.isFinite(override) && override >= 0) {
      return Math.floor(override);
    }
  }
  return DEFAULT_INDEX_VALUE_COLUMN_LIMIT;
};
const MAX_IN_MEMORY_POSTING_PAIRS = 1000000;

const ensureDirectoryRemoved = async (targetPath) => {
  if (!targetPath) {
    return;
  }
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Warning: unable to remove temporary directory ${targetPath}:`, error.message);
  }
};

const bufferFromTypedArray = (view) => {
  if (!view || view.length === 0) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(view)) {
    return view;
  }
  if (ArrayBuffer.isView(view)) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(view)) {
    const temp = new Uint32Array(view);
    return Buffer.from(temp.buffer, temp.byteOffset, temp.byteLength);
  }
  return Buffer.alloc(0);
};

class PostingAccumulator {
  constructor(tempDir, options = {}) {
    this.tempDir = tempDir;
    this.maxPairs = options.maxPairs || MAX_IN_MEMORY_POSTING_PAIRS;
    this.pairs = [];
    this.chunkIndex = 0;
    this.chunkFiles = [];
    this.flushInProgress = Promise.resolve();
  }

  async addTokens(tokens, rowIndex) {
    if (!tokens || !tokens.length) {
      return;
    }
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (!token) {
        continue;
      }
      this.pairs.push({ token, rowIndex });
      if (this.pairs.length >= this.maxPairs) {
        // Queue flush sequentially to avoid concurrent writes.
        this.flushInProgress = this.flushInProgress.then(() => this.flush());
        await this.flushInProgress;
      }
    }
  }

  async flush() {
    if (!this.pairs.length) {
      return;
    }

    const pairsToWrite = this.pairs;
    this.pairs = [];

    pairsToWrite.sort((a, b) => {
      if (a.token === b.token) {
        return a.rowIndex - b.rowIndex;
      }
      return a.token.localeCompare(b.token);
    });

    const chunkPath = path.join(this.tempDir, `postings_${this.chunkIndex}.txt`);
    this.chunkIndex += 1;
    this.chunkFiles.push(chunkPath);

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(chunkPath, { encoding: 'utf8' });

      stream.on('error', (error) => {
        reject(error);
      });

      stream.on('finish', resolve);

      for (let i = 0; i < pairsToWrite.length; i += 1) {
        const pair = pairsToWrite[i];
        stream.write(`${pair.token}\t${pair.rowIndex}\n`);
      }

      stream.end();
    });
  }

  async finish() {
    await this.flushInProgress;
    await this.flush();
    return this.chunkFiles.slice();
  }
}

class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.values = [];
  }

  isEmpty() {
    return this.values.length === 0;
  }

  push(value) {
    this.values.push(value);
    this.bubbleUp(this.values.length - 1);
  }

  pop() {
    if (this.values.length === 0) {
      return null;
    }
    const top = this.values[0];
    const end = this.values.pop();
    if (this.values.length > 0) {
      this.values[0] = end;
      this.bubbleDown(0);
    }
    return top;
  }

  bubbleUp(index) {
    let i = index;
    while (i > 0) {
      const parentIndex = Math.floor((i - 1) / 2);
      if (this.compare(this.values[i], this.values[parentIndex]) >= 0) {
        break;
      }
      [this.values[i], this.values[parentIndex]] = [this.values[parentIndex], this.values[i]];
      i = parentIndex;
    }
  }

  bubbleDown(index) {
    let i = index;
    const length = this.values.length;
    while (true) {
      const left = (2 * i) + 1;
      const right = (2 * i) + 2;
      let smallest = i;

      if (left < length && this.compare(this.values[left], this.values[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.values[right], this.values[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === i) {
        break;
      }
      [this.values[i], this.values[smallest]] = [this.values[smallest], this.values[i]];
      i = smallest;
    }
  }
}

const parsePostingLine = (line) => {
  if (!line) {
    return null;
  }
  const separatorIndex = line.indexOf('\t');
  if (separatorIndex === -1) {
    return null;
  }
  const token = line.slice(0, separatorIndex);
  const rowIndexText = line.slice(separatorIndex + 1);
  const rowIndex = Number.parseInt(rowIndexText, 10);
  if (!Number.isFinite(rowIndex)) {
    return null;
  }
  return { token, rowIndex };
};

const mergePostingChunks = async (chunkFiles, options = {}) => {
  const collectForJson = Boolean(options.collectForJson);
  const includeTokenLookup = options.includeTokenLookup !== undefined
    ? Boolean(options.includeTokenLookup)
    : collectForJson;

  if (!chunkFiles.length) {
    return {
      tokens: [],
      tokenLookup: includeTokenLookup ? {} : null,
      postingOffsets: new Uint32Array([0]),
      postingsData: new Uint32Array(0),
      postingsForJson: collectForJson ? [] : null,
    };
  }

  const readers = await Promise.all(chunkFiles.map(async (filePath) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const iterator = rl[Symbol.asyncIterator]();
    const first = await iterator.next();
    const current = first.done ? null : parsePostingLine(first.value);
    return {
      filePath,
      rl,
      iterator,
      current,
    };
  }));

  const heap = new MinHeap((a, b) => {
    const entryA = a.current;
    const entryB = b.current;
    if (entryA.token === entryB.token) {
      return entryA.rowIndex - entryB.rowIndex;
    }
    return entryA.token.localeCompare(entryB.token);
  });

  for (const reader of readers) {
    if (reader.current) {
      heap.push(reader);
    }
  }

  const tokens = [];
  const postingOffsetsList = [0];
  const postingsVector = new TypedVector(Uint32Array, 4096);
  const postingsForJson = collectForJson ? [] : null;

  let currentToken = null;
  let currentPosting = [];

  while (!heap.isEmpty()) {
    const reader = heap.pop();
    const { token, rowIndex } = reader.current;

    if (token !== currentToken) {
      if (currentToken !== null) {
        tokens.push(currentToken);
        postingOffsetsList.push(postingsVector.length);
        if (postingsForJson) {
          postingsForJson.push(currentPosting);
        }
      }
      currentToken = token;
      currentPosting = [];
    }

    postingsVector.push(rowIndex >>> 0);
    currentPosting.push(rowIndex >>> 0);

    const next = await reader.iterator.next();
    if (!next.done) {
      const parsed = parsePostingLine(next.value);
      if (parsed) {
        reader.current = parsed;
        heap.push(reader);
      }
    }
  }

  if (currentToken !== null) {
    tokens.push(currentToken);
    postingOffsetsList.push(postingsVector.length);
    if (postingsForJson) {
      postingsForJson.push(currentPosting);
    }
  }

  for (const reader of readers) {
    reader.rl.close();
  }

  const postingOffsets = postingOffsetsList.length
    ? new Uint32Array(postingOffsetsList)
    : new Uint32Array([0]);
  const postingsData = postingsVector.toTypedArray();
  const tokenLookup = includeTokenLookup
    ? Object.fromEntries(tokens.map((token, index) => [token, index]))
    : null;

  return {
    tokens,
    tokenLookup,
    postingOffsets,
    postingsData,
    postingsForJson,
  };
};

class TypedVector {
  constructor(Type, initialCapacity = 1024) {
    this.Type = Type;
    this.capacity = Math.max(initialCapacity, 1);
    this.buffer = new Type(this.capacity);
    this.length = 0;
  }

  push(value) {
    if (this.length >= this.capacity) {
      this.grow();
    }
    this.buffer[this.length] = value >>> 0;
    this.length += 1;
  }

  grow() {
    const nextCapacity = this.capacity * 2;
    const nextBuffer = new this.Type(nextCapacity);
    nextBuffer.set(this.buffer.subarray(0, this.length));
    this.buffer = nextBuffer;
    this.capacity = nextCapacity;
  }

  toTypedArray() {
    return this.buffer.subarray(0, this.length);
  }
}

function ensureArrayLike(values) {
  if (!values) {
    return [];
  }
  if (Array.isArray(values)) {
    return values;
  }
  if (ArrayBuffer.isView(values)) {
    return Array.from(values);
  }
  return Array.from(values);
}

function bufferFromUint16Array(values) {
  const array = ensureArrayLike(values);
  if (!array.length) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(array.length * 2);
  for (let index = 0; index < array.length; index += 1) {
    buffer.writeUInt16LE(array[index] >>> 0, index * 2);
  }
  return buffer;
}

function bufferFromUint32Array(values) {
  const array = ensureArrayLike(values);
  if (!array.length) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(array.length * 4);
  for (let index = 0; index < array.length; index += 1) {
    buffer.writeUInt32LE(array[index] >>> 0, index * 4);
  }
  return buffer;
}

function encodeLengthPrefixedStrings(strings) {
  const array = ensureArrayLike(strings);
  if (!array.length) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  for (const value of array) {
    const safeValue = value === null || value === undefined ? '' : String(value);
    const bytes = Buffer.from(safeValue, 'utf8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(bytes.length >>> 0, 0);
    chunks.push(lengthBuffer, bytes);
  }
  return Buffer.concat(chunks);
}

function encodeFilesMetadata(files) {
  const array = Array.isArray(files) ? files : [];
  if (!array.length) {
    return Buffer.alloc(0);
  }
  const chunks = [];
  for (const file of array) {
    const name = file && file.name ? String(file.name) : '';
    const rowCount = file && typeof file.rowCount === 'number' ? file.rowCount : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const nameLengthBuffer = Buffer.alloc(4);
    nameLengthBuffer.writeUInt32LE(nameBytes.length >>> 0, 0);
    const rowCountBuffer = Buffer.alloc(4);
    rowCountBuffer.writeUInt32LE(rowCount >>> 0, 0);
    chunks.push(nameLengthBuffer, nameBytes, rowCountBuffer);
  }
  return Buffer.concat(chunks);
}

function assembleBinaryIndex(payload) {
  const datasetBuffer = Buffer.from(payload.dataset || '', 'utf8');
  const generatedAtBuffer = Buffer.from(payload.generatedAt || '', 'utf8');
  const dictionarySection = encodeLengthPrefixedStrings(payload.dictionary || []);
  const tokensSection = encodeLengthPrefixedStrings(payload.tokens || []);
  const filesSection = encodeFilesMetadata(payload.files || []);

  const rowOffsets = payload.rowOffsets || new Uint32Array(0);
  const rowData = payload.rowData || new Uint32Array(0);
  const rowFiles = payload.rowFiles || new Uint16Array(0);
  const rowPositions = payload.rowPositions || new Uint32Array(0);
  const postingOffsets = payload.postingOffsets || new Uint32Array(0);
  const postingsData = payload.postingsData || new Uint32Array(0);

  const totalCells = typeof payload.totalCells === 'number' ? payload.totalCells : rowData.length;
  const totalEntries = typeof payload.totalEntries === 'number' ? payload.totalEntries : postingsData.length;

  const rowOffsetsBuffer = bufferFromTypedArray(rowOffsets);
  const rowDataBuffer = bufferFromTypedArray(rowData);
  const rowFilesBuffer = bufferFromTypedArray(rowFiles);
  const rowPositionsBuffer = bufferFromTypedArray(rowPositions);
  const postingOffsetsBuffer = bufferFromTypedArray(postingOffsets);
  const postingsBuffer = bufferFromTypedArray(postingsData);

  const header = Buffer.alloc(HEADER_SIZE);
  BINARY_MAGIC.copy(header, 0);
  header.writeUInt8(BINARY_VERSION, 6);
  header.writeUInt8(0, 7);

  let offset = 8;
  const writeUInt32 = (value) => {
    header.writeUInt32LE((value >>> 0), offset);
    offset += 4;
  };

  writeUInt32(datasetBuffer.length);
  writeUInt32(generatedAtBuffer.length);
  writeUInt32((payload.dictionary || []).length);
  writeUInt32(dictionarySection.length);
  writeUInt32((payload.tokens || []).length);
  writeUInt32(tokensSection.length);
  writeUInt32((payload.files || []).length);
  writeUInt32(filesSection.length);
  writeUInt32(payload.totalRows >>> 0);
  writeUInt32(payload.maxColumns >>> 0);
  writeUInt32((payload.valueColumnLimit || 0) >>> 0);
  writeUInt32(totalCells >>> 0);
  writeUInt32(totalEntries >>> 0);
  writeUInt32(postingOffsets.length >>> 0);
  writeUInt32(rowOffsets.length >>> 0);
  writeUInt32(rowFiles.length >>> 0);
  writeUInt32(rowPositions.length >>> 0);
  header.writeUInt8(payload.rowFilesType || TYPE_UINT16, offset);
  offset += 1;
  header.writeUInt8(TYPE_UINT32, offset); // rowPositions type
  offset += 1;
  header.writeUInt8(TYPE_UINT32, offset); // rowData type
  offset += 1;
  header.writeUInt8(TYPE_UINT32, offset); // postings type
  offset += 1;
  writeUInt32(rowOffsetsBuffer.length);
  writeUInt32(rowDataBuffer.length);
  writeUInt32(rowFilesBuffer.length);
  writeUInt32(rowPositionsBuffer.length);
  writeUInt32(postingOffsetsBuffer.length);
  writeUInt32(postingsBuffer.length);

  while (offset < HEADER_SIZE) {
    header.writeUInt8(0, offset);
    offset += 1;
  }

  return Buffer.concat([
    header,
    datasetBuffer,
    generatedAtBuffer,
    dictionarySection,
    tokensSection,
    filesSection,
    rowOffsetsBuffer,
    rowDataBuffer,
    rowFilesBuffer,
    rowPositionsBuffer,
    postingOffsetsBuffer,
    postingsBuffer,
  ]);
}

async function writeIndexArtifacts(payload, options = {}) {
  const baseOutputPath = options.baseOutputPath;
  if (!baseOutputPath) {
    throw new Error('Missing base output path for index artifacts.');
  }

  const binaryBuffer = assembleBinaryIndex(payload);
  const binaryCompressed = zlib.gzipSync(binaryBuffer, { level: 9 });
  const binaryPath = `${baseOutputPath}.bin.gz`;
  await fs.promises.writeFile(binaryPath, binaryCompressed);

  let jsonPath = null;
  const totalRowCount = typeof options.totalRowCount === 'number'
    ? options.totalRowCount
    : payload.totalRows;

  if (totalRowCount <= JSON_ROW_THRESHOLD) {
    try {
      const jsonPayload = {
        version: payload.version,
        generatedAt: payload.generatedAt,
        dataset: payload.dataset,
        totalRows: payload.totalRows,
        maxColumns: payload.maxColumns,
        valueColumnLimit: payload.valueColumnLimit || 0,
        files: payload.files,
        dictionary: payload.dictionary,
        tokens: payload.tokens,
        tokenLookup: payload.tokenLookup,
        rowOffsets: Array.from(payload.rowOffsets || []),
        rowData: Array.from(payload.rowData || []),
        rowFilesType: payload.rowFilesType,
        rowFiles: Array.from(payload.rowFiles || []),
        rowPositions: Array.from(payload.rowPositions || []),
        postingOffsets: Array.from(payload.postingOffsets || []),
        postingsData: Array.from(payload.postingsData || []),
      };

      if (Array.isArray(payload.postingsForJson)) {
        jsonPayload.postings = payload.postingsForJson.map((posting) => Array.from(posting || []));
      }

      const json = JSON.stringify(jsonPayload);
      const jsonCompressed = zlib.gzipSync(Buffer.from(json), { level: 9 });
      jsonPath = `${baseOutputPath}.json.gz`;
      await fs.promises.writeFile(jsonPath, jsonCompressed);
    } catch (error) {
      console.warn(`  • Skipped JSON index (uncompressed payload too large): ${error.message}`);
    }
  } else {
    console.log('  • Skipping JSON index (above row threshold)');
  }

  return { binaryPath, jsonPath };
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or',
  'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'will', 'with'
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value && !value.startsWith('--')) {
      args[name] = value;
      i += 1;
    } else {
      args[name] = true;
      i -= 1;
    }
  }
  return args;
}

function toBaseCsvName(fileName = '') {
  const normalized = fileName.trim();
  if (!normalized) {
    return '';
  }

  const multiPartMatch = normalized.match(/^(.*?\.csv)(?:_[0-9]+(?:_[0-9]+)*)?\.csv\.gz$/i);
  if (multiPartMatch) {
    return multiPartMatch[1];
  }

  if (/\.csv\.gz$/i.test(normalized)) {
    return normalized.replace(/\.csv\.gz$/i, '.csv');
  }

  if (/\.csv$/i.test(normalized)) {
    return normalized;
  }

  return `${normalized}.csv`;
}

async function walkDirectory(rootDir) {
  const result = [];
  async function walk(currentDir) {
    const entries = await fs.promises.readdir(path.join(rootDir, currentDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }

      if (!/^.*\.csv(\.gz)?$/i.test(entry.name)) {
        continue;
      }

      if (/[_-]compressed\.csv(\.gz)?$/i.test(entry.name)) {
        continue;
      }

      result.push(relativePath);
    }
  }

  await walk('.');
  return result.map((relativePath) => relativePath.replace(/^\.\//, ''));
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function extractTokensFromRow(cells) {
  const tokens = new Set();
  for (const rawValue of cells) {
    const value = normalizeCellValue(rawValue).trim();
    if (!value) {
      continue;
    }

    const lowered = value.toLowerCase();
    const matches = lowered.match(/[a-z0-9]+/g);
    if (!matches) {
      continue;
    }

    for (const token of matches) {
      if (!token) {
        continue;
      }

      if (STOP_WORDS.has(token)) {
        continue;
      }

      if (token.length === 1 && isNaN(Number(token))) {
        continue;
      }

      tokens.add(token);
    }
  }
  return tokens;
}

function createDictionary() {
  const values = [''];
  const indexByValue = new Map();
  indexByValue.set('', 0);

  function getId(rawValue) {
    const value = normalizeCellValue(rawValue);
    if (indexByValue.has(value)) {
      return indexByValue.get(value);
    }
    const id = values.length;
    values.push(value);
    indexByValue.set(value, id);
    return id;
  }

  return {
    getId,
    values,
  };
}

function intersectSortedArrays(arrA, arrB) {
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
    } else if (valueA < valueB) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return result;
}

async function buildIndexForGroup(rootDir, outputDir, groupKey, fileList, options = {}) {
  const rowThreshold = typeof options.rowThreshold === 'number'
    ? options.rowThreshold
    : null;
  const dictionary = createDictionary();
  const filesMeta = [];
  const rowOffsetsVector = new TypedVector(Uint32Array, 1024);
  rowOffsetsVector.push(0);
  const rowDataVector = new TypedVector(Uint32Array, 4096);
  const rowFilesVector = new TypedVector(Uint32Array, 1024);
  const rowPositionsVector = new TypedVector(Uint32Array, 1024);
  let totalRowCount = 0;
  let maxColumns = 0;
  let maxFileIndex = 0;
  let truncatedColumnDetected = false;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tuva-index-chunks-'));
  const postingsAccumulator = new PostingAccumulator(tempDir, { maxPairs: MAX_IN_MEMORY_POSTING_PAIRS });
  let tokenFlushChain = Promise.resolve();
  const valueColumnLimit = resolveValueColumnLimit(groupKey?.baseName);

  try {
    for (let fileIndex = 0; fileIndex < fileList.length; fileIndex += 1) {
      const relativePath = fileList[fileIndex];
      const absolutePath = path.join(rootDir, relativePath);
      const fileName = path.basename(relativePath);
      let rowWithinFile = 0;

      await new Promise((resolve, reject) => {
        const enqueueTokens = (tokensArray, rowIndex) => {
          if (!tokensArray.length) {
            return;
          }
          tokenFlushChain = tokenFlushChain.then(() => postingsAccumulator.addTokens(tokensArray, rowIndex));
        };

        const handleRow = (rawRow) => {
          let normalizedRow;

          if (Array.isArray(rawRow)) {
            normalizedRow = rawRow;
          } else if (rawRow && Array.isArray(rawRow.data)) {
            normalizedRow = rawRow.data;
          } else if (rawRow && typeof rawRow === 'object') {
            normalizedRow = Object.values(rawRow);
          } else {
            normalizedRow = [];
          }

          if (!normalizedRow || normalizedRow.length === 0) {
            return;
          }

          const rowIndex = totalRowCount;
          const tokens = extractTokensFromRow(normalizedRow);
          const storedRow = valueColumnLimit > 0
            ? normalizedRow.slice(0, valueColumnLimit)
            : normalizedRow;
          if (!truncatedColumnDetected && storedRow.length < normalizedRow.length) {
            truncatedColumnDetected = true;
          }
          const encodedRow = storedRow.map((cell) => dictionary.getId(cell));

          maxColumns = Math.max(maxColumns, encodedRow.length);

          for (let i = 0; i < encodedRow.length; i += 1) {
            rowDataVector.push(encodedRow[i]);
          }
          const nextOffset = rowDataVector.length;
          rowOffsetsVector.push(nextOffset);

          rowFilesVector.push(fileIndex);
          rowPositionsVector.push(rowWithinFile);
          if (fileIndex > maxFileIndex) {
            maxFileIndex = fileIndex;
          }

          if (tokens.size) {
            enqueueTokens(Array.from(tokens), rowIndex);
          }

          rowWithinFile += 1;
          totalRowCount += 1;
        };

        const papaStream = Papa.parse(Papa.NODE_STREAM_INPUT, {
          header: false,
          skipEmptyLines: true,
        });

        let resolved = false;
        const settle = (fn) => {
          if (resolved) {
            return;
          }
          resolved = true;
          tokenFlushChain
            .then(fn)
            .then(resolve)
            .catch(reject);
        };

        papaStream.on('data', handleRow);
        papaStream.on('error', (error) => {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        });
        papaStream.on('end', () => {
          settle(() => {
            filesMeta.push({
              name: fileName,
              rowCount: rowWithinFile,
            });
          });
        });
        papaStream.on('finish', () => {
          settle(() => {
            filesMeta.push({
              name: fileName,
              rowCount: rowWithinFile,
            });
          });
        });

        const fileStream = fs.createReadStream(absolutePath);
        fileStream.on('error', (error) => {
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        });

        let csvStream = fileStream;
        if (/\.gz$/i.test(fileName)) {
          const gunzip = zlib.createGunzip();
          gunzip.on('error', (error) => {
            if (!resolved) {
              resolved = true;
              reject(error);
            }
          });
          csvStream = fileStream.pipe(gunzip);
        }

        csvStream.setEncoding('utf8');
        csvStream.pipe(papaStream);
      });
    }

    await tokenFlushChain;

    if (rowThreshold !== null && totalRowCount <= rowThreshold) {
      return {
        skipped: true,
        reason: 'row-count-below-threshold',
        totalRows: totalRowCount,
        filesProcessed: fileList.length,
        rowThreshold,
      };
    }

    const chunkFiles = await postingsAccumulator.finish();
    const shouldEmitJson = totalRowCount <= JSON_ROW_THRESHOLD;
    const {
      tokens,
      tokenLookup,
      postingOffsets,
      postingsData,
      postingsForJson,
    } = await mergePostingChunks(chunkFiles, {
      collectForJson: shouldEmitJson,
      includeTokenLookup: shouldEmitJson,
    });

    const rowOffsets = rowOffsetsVector.toTypedArray();
    const rowData = rowDataVector.toTypedArray();
    const rowPositions = rowPositionsVector.toTypedArray();
    const rowFilesBase = rowFilesVector.toTypedArray();
    const rowFilesType = maxFileIndex <= 0xffff ? TYPE_UINT16 : TYPE_UINT32;
    const rowFiles = rowFilesType === TYPE_UINT16
      ? Uint16Array.from(rowFilesBase)
      : rowFilesBase;

    const indexData = {
      version: 1,
      generatedAt: new Date().toISOString(),
      dataset: groupKey.baseName,
      totalRows: totalRowCount,
      maxColumns,
      files: filesMeta,
      dictionary: dictionary.values,
      tokens,
      tokenLookup: shouldEmitJson ? tokenLookup : null,
      rowOffsets,
      rowData,
      rowFiles,
      rowFilesType,
      rowPositions,
      postingOffsets,
      postingsData,
      totalCells: rowData.length,
      totalEntries: postingsData.length,
      postingsForJson,
      valueColumnLimit,
    };

    const baseOutputPath = path.join(outputDir, groupKey.relativeDir, `${groupKey.baseName}.index`);
    await fs.promises.mkdir(path.dirname(baseOutputPath), { recursive: true });

    const { binaryPath, jsonPath } = await writeIndexArtifacts(indexData, {
      baseOutputPath,
      totalRowCount,
    });

    if (truncatedColumnDetected) {
      console.warn(`  • Index row values limited to first ${valueColumnLimit} column(s)`);
    }

    return {
      outputPath: jsonPath || binaryPath,
      binaryPath,
      jsonPath,
      totalRows: totalRowCount,
      filesProcessed: fileList.length,
      tokens: tokens.length,
      dictionarySize: dictionary.values.length,
    };
  } finally {
    await ensureDirectoryRemoved(tempDir);
  }
}

function groupFilesByDataset(relativePaths) {
  const groups = new Map();

  for (const relativePath of relativePaths) {
    const normalized = relativePath.replace(/\\/g, '/');
    const dirName = path.dirname(normalized);
    const baseName = toBaseCsvName(path.basename(normalized));
    const groupKey = `${dirName}::${baseName}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        relativeDir: dirName === '.' ? '' : dirName,
        baseName,
        files: [],
      });
    }

    groups.get(groupKey).files.push(normalized);
  }

  for (const group of groups.values()) {
    group.files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  return Array.from(groups.values());
}

async function main() {
  const args = parseArgs(process.argv);
  const inputDir = args.input || args.i;
  const outputDir = args.output || args.o;
  const datasetFilter = args.dataset || args.d;
  const minRowsArg = args['min-rows'] || args.minRows;

  const minRowThreshold = minRowsArg !== undefined
    ? Number(minRowsArg)
    : DEFAULT_MIN_ROWS;

  if (!Number.isFinite(minRowThreshold) || minRowThreshold < 0) {
    console.error('Invalid value provided for --min-rows. Expected a non-negative number.');
    process.exit(1);
  }

  if (!inputDir) {
    console.error('Missing required --input argument');
    process.exit(1);
  }

  if (!outputDir) {
    console.error('Missing required --output argument');
    process.exit(1);
  }

  const resolvedInput = path.resolve(process.cwd(), inputDir);
  const resolvedOutput = path.resolve(process.cwd(), outputDir);

  const files = await walkDirectory(resolvedInput);
  if (!files.length) {
    console.warn('No CSV files found under input directory.');
    return;
  }

  const groups = groupFilesByDataset(files);
  const selectedGroups = datasetFilter
    ? groups.filter((group) => group.baseName === datasetFilter)
    : groups;

  if (!selectedGroups.length) {
    console.warn('No matching CSV groups found for the provided criteria.');
    return;
  }

  console.log(`Found ${selectedGroups.length} dataset group(s) to process.`);
  console.log(`Row threshold for indexing: ${minRowThreshold.toLocaleString()} rows.`);

  for (const group of selectedGroups) {
    const displayName = group.relativeDir ? `${group.relativeDir}/${group.baseName}` : group.baseName;

    if (INDEX_DATASET_EXCLUSIONS.has((group.baseName || '').toLowerCase())) {
      console.log(`\nSkipping ${displayName} (dataset excluded from indexing).`);
      continue;
    }

    console.log(`\nGenerating index for ${displayName} (${group.files.length} file(s))...`);

    try {
      const stats = await buildIndexForGroup(
        resolvedInput,
        resolvedOutput,
        group,
        group.files,
        { rowThreshold: minRowThreshold },
      );

      if (stats && stats.skipped) {
        const rowCountText = typeof stats.totalRows === 'number'
          ? stats.totalRows.toLocaleString()
          : 'unknown';
        console.log(`  • Skipped (row count ${rowCountText} <= ${minRowThreshold.toLocaleString()})`);
        continue;
      }

      console.log(`  • Rows indexed: ${stats.totalRows}`);
      console.log(`  • Unique tokens: ${stats.tokens}`);
      console.log(`  • Dictionary entries: ${stats.dictionarySize}`);
      if (stats.binaryPath) {
        console.log(`  • Binary index: ${path.relative(process.cwd(), stats.binaryPath)}`);
      }
      if (stats.jsonPath) {
        console.log(`  • JSON index: ${path.relative(process.cwd(), stats.jsonPath)}`);
      }
    } catch (error) {
      console.error(`Failed to build index for ${displayName}:`, error.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = {
  extractTokensFromRow,
  intersectSortedArrays,
};
