import { render, screen, waitFor } from '@testing-library/react';
import CSVViewer from './CSVViewer';

describe('CSVViewer version loading', () => {
  const terminologyListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_terminology/</Prefix>
    <Delimiter>/</Delimiter>
    <IsTruncated>false</IsTruncated>
    <CommonPrefixes><Prefix>versioned_terminology/0.14.1/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>versioned_terminology/0.14.2/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>versioned_terminology/latest/</Prefix></CommonPrefixes>
  </ListBucketResult>`;

  const providerListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_provider_data/</Prefix>
    <Delimiter>/</Delimiter>
    <IsTruncated>false</IsTruncated>
    <CommonPrefixes><Prefix>versioned_provider_data/0.14.2/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>versioned_provider_data/latest/</Prefix></CommonPrefixes>
  </ListBucketResult>`;

  const terminologyFilesListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_terminology/0.14.2/</Prefix>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>versioned_terminology/0.14.2/admit_source.csv_0_0_0.csv.gz</Key></Contents>
    <Contents><Key>versioned_terminology/0.14.2/admit_source.csv_0_0_1.csv.gz</Key></Contents>
  </ListBucketResult>`;

  const providerFilesListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_provider_data/0.14.2/</Prefix>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>versioned_provider_data/0.14.2/provider.csv_0_0_0.csv.gz</Key></Contents>
  </ListBucketResult>`;

  beforeEach(() => {
    const csvBuffer = Uint8Array.from(Buffer.from('col1,col2\n1,2', 'utf-8')).buffer;

    if (typeof TextDecoder === 'undefined') {
      global.TextDecoder = require('util').TextDecoder;
    }

    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(terminologyListing, { status: 200, headers: { 'Content-Type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(providerListing, { status: 200, headers: { 'Content-Type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(terminologyFilesListing, { status: 200, headers: { 'Content-Type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(providerFilesListing, { status: 200, headers: { 'Content-Type': 'application/xml' } }))
      .mockResolvedValue(new Response(csvBuffer, { status: 200 }));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders available versions from S3 listings', async () => {
    render(<CSVViewer />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(5));

    const select = await screen.findByLabelText(/terminology version/i);
    const versionOption = await screen.findByRole('option', { name: '0.14.2' });

    expect(select).toBeEnabled();
    expect(versionOption).toBeInTheDocument();
    expect(Array.from(select.querySelectorAll('option')).map((option) => option.value)).toContain('latest');

    const friendlyLabels = await screen.findAllByText('Admit Source');
    expect(friendlyLabels.length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'admit_source.csv_0_0_0.csv.gz' })).toBeInTheDocument();

    const downloadLink = await screen.findByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', expect.stringContaining('versioned_terminology/0.14.2/admit_source.csv_0_0_0.csv.gz'));
  });
});
