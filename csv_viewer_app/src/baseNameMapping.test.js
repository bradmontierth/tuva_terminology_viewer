import { toBaseCsvNamePure } from './CSVViewer';

describe('toBaseCsvNamePure mapping', () => {
  const cases = [
    ['provider.csv_0_0_0.csv.gz', 'provider.csv'],
    ['provider.csv_12_34.csv.gz', 'provider.csv'],
    ['provider.csv.gz', 'provider.csv'],
    ['provider_compressed.csv.gz', 'provider.csv'],
    ['provider_compressed.csv', 'provider.csv'],
    ['admit_source.csv_0_1.csv.gz', 'admit_source.csv'],
    ['icd_10_cm.csv', 'icd_10_cm.csv'],
    ['value_set.csv', 'value_set.csv'],
    ['NoExt', 'NoExt'],
    ['MIXED_Case_Compressed.csv.GZ', 'MIXED_Case_Compressed.csv'],
  ];

  it.each(cases)('maps %s -> %s', (input, expected) => {
    expect(toBaseCsvNamePure(input)).toBe(expected);
  });
});

