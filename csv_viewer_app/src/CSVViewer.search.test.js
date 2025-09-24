import { buildIndexSearchResults } from './CSVViewer';

describe('buildIndexSearchResults', () => {
  const dictionary = [
    '',
    'Acetaminophen 100 MG/ML Oral Solution [Uni-Ace]',
    'Ambra grisea ... Cuprum acet ...',
  ];

  const baseIndex = {
    tokens: ['acet', 'acetaminophen'],
    tokenLookup: {
      acet: 0,
      acetaminophen: 1,
    },
    postings: [
      new Uint32Array([1]),
      new Uint32Array([0]),
    ],
    rows: [
      [1],
      [2],
    ],
    dictionary,
    rowFiles: new Uint16Array([0, 0]),
    rowPositions: new Uint32Array([0, 1]),
  };

  it('includes partial matches when an exact token exists', () => {
    const result = buildIndexSearchResults('acet', baseIndex, 10);

    expect(result.matchCount).toBe(2);
    expect(result.rows.map((entry) => entry.values[0])).toEqual(expect.arrayContaining([
      'Acetaminophen 100 MG/ML Oral Solution [Uni-Ace]',
      'Ambra grisea ... Cuprum acet ...',
    ]));
  });

  it('preserves exact matches for fully specified terms', () => {
    const result = buildIndexSearchResults('acetaminophen', baseIndex, 10);

    expect(result.matchCount).toBe(1);
    expect(result.rows.map((entry) => entry.values[0])).toEqual([
      'Acetaminophen 100 MG/ML Oral Solution [Uni-Ace]',
    ]);
  });
});
