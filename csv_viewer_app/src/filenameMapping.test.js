import { deriveDatasetId } from './CSVViewer';

describe('deriveDatasetId mapping', () => {
  const cases = [
    ['provider.csv', 'provider'],
    ['provider.csv.gz', 'provider'],
    ['provider.csv_0_0_0.csv.gz', 'provider'],
    ['provider.csv_12_34.csv.gz', 'provider'],
    ['provider_compressed.csv', 'provider'],
    ['provider_compressed.csv.gz', 'provider'],
    ['admit_source.csv_0_1.csv.gz', 'admit_source'],
    ['icd_10_cm.csv', 'icd_10_cm'],
    ['snomed_ct_transitive_closures_compressed.csv.gz', 'snomed_ct_transitive_closures'],
    ['LOINC_compressed.csv.GZ', 'LOINC'],
  ];

  it.each(cases)('maps %s -> %s', (input, expected) => {
    expect(deriveDatasetId(input)).toBe(expected);
  });
});

