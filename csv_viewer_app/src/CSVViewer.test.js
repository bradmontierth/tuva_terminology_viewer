import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  const valueSetsListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_value_sets/</Prefix>
    <Delimiter>/</Delimiter>
    <IsTruncated>false</IsTruncated>
    <CommonPrefixes><Prefix>versioned_value_sets/2023.01/</Prefix></CommonPrefixes>
  </ListBucketResult>`;

  const valueSetsFilesListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>versioned_value_sets/2023.01/</Prefix>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>versioned_value_sets/2023.01/value_set.csv.gz</Key></Contents>
  </ListBucketResult>`;

  const referenceListing = `<?xml version="1.0" encoding="UTF-8"?>
  <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>tuva-public-resources</Name>
    <Prefix>reference-data/</Prefix>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>reference-data/reference.csv.gz</Key></Contents>
  </ListBucketResult>`;

  beforeEach(() => {
    const csvBuffer = Uint8Array.from(Buffer.from('col1,col2\n1,2', 'utf-8')).buffer;

    if (typeof TextDecoder === 'undefined') {
      global.TextDecoder = require('util').TextDecoder;
    }

    const xmlResponse = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/xml' } });

    global.fetch = jest.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;

      if (url.includes('prefix=versioned_terminology%2F') && url.includes('delimiter=%2F')) {
        return xmlResponse(terminologyListing);
      }

      if (url.includes('prefix=versioned_provider_data%2F') && url.includes('delimiter=%2F')) {
        return xmlResponse(providerListing);
      }

      if (url.includes('prefix=versioned_value_sets%2F') && url.includes('delimiter=%2F')) {
        return xmlResponse(valueSetsListing);
      }

      if (url.includes('prefix=versioned_terminology%2F0.14.2%2F')) {
        return xmlResponse(terminologyFilesListing);
      }

      if (url.includes('prefix=versioned_provider_data%2F0.14.2%2F')) {
        return xmlResponse(providerFilesListing);
      }

      if (url.includes('prefix=versioned_value_sets%2F2023.01%2F')) {
        return xmlResponse(valueSetsFilesListing);
      }

      if (url.includes('prefix=reference-data%2F')) {
        return xmlResponse(referenceListing);
      }

      if (url.includes('versioned_terminology/0.14.2/admit_source.csv_0_0_0.csv.gz')) {
        return new Response(csvBuffer, { status: 200 });
      }

      if (url.includes('versioned_value_sets/2023.01/value_set.csv.gz')) {
        return new Response(csvBuffer, { status: 200 });
      }

      if (url.includes('reference-data/reference.csv.gz')) {
        return new Response(csvBuffer, { status: 200 });
      }

      return new Response('', { status: 404 });
    });
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders terminology data with versions and files', async () => {
    render(<CSVViewer />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    const terminologyTab = await screen.findByRole('tab', { name: /terminology/i });
    expect(terminologyTab).toHaveAttribute('aria-selected', 'true');

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

  it('allows switching to value sets and loads data', async () => {
    const user = userEvent.setup();
    render(<CSVViewer />);

    await screen.findByLabelText(/terminology version/i);

    await user.click(await screen.findByRole('tab', { name: /value sets/i }));

    const valueSetSelect = await screen.findByLabelText(/value set version/i);
    expect(valueSetSelect).toBeInTheDocument();

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('prefix=versioned_value_sets%2F'),
      expect.objectContaining({ headers: expect.any(Object) })
    ));

    const friendlyLabel = await screen.findByText('Value Set');
    expect(friendlyLabel).toBeInTheDocument();

    const downloadLink = await screen.findByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', expect.stringContaining('versioned_value_sets/2023.01/value_set.csv.gz'));
  });

  it('loads reference data without versions', async () => {
    const user = userEvent.setup();
    render(<CSVViewer />);

    await screen.findByLabelText(/terminology version/i);

    await user.click(await screen.findByRole('tab', { name: /reference data/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('prefix=reference-data%2F'),
      expect.objectContaining({ headers: expect.any(Object) })
    ));

    await waitFor(() => expect(screen.queryByLabelText(/version/i)).toBeNull());
    expect(await screen.findByText('Available Files')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'reference.csv.gz' })).toBeInTheDocument();

    const downloadLink = await screen.findByRole('link', { name: /download/i });
    expect(downloadLink).toHaveAttribute('href', expect.stringContaining('reference-data/reference.csv.gz'));
  });
});
