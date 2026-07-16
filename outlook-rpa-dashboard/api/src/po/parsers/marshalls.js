import {
  parseMarshallsSingleDc
} from './marshallsSingleDc.js';

import {
  parseMarshalls as parseMarshallsMultiDc,
  parseMarshallsOrders as parseMarshallsMultiDcOrders
} from './marshallsMultiDc.js';

function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function marshallsDistributionCenterCodes(
  text = ''
) {
  return [
    ...new Set(
      [...String(text).matchAll(
        /\bDC\s*#\s*:?\s*([A-Z0-9-]+)/gi
      )]
        .map(match =>
          clean(match[1]).toUpperCase()
        )
        .filter(Boolean)
    )
  ];
}

export function marshallsDocumentMode(text = '') {
  const codes = marshallsDistributionCenterCodes(
    text
  );

  if (codes.length > 1) {
    return {
      mode: 'MULTI_DC',
      dc_codes: codes
    };
  }

  if (codes.length === 1) {
    return {
      mode: 'SINGLE_DC',
      dc_codes: codes
    };
  }

  return {
    mode: 'NO_DC',
    dc_codes: []
  };
}

export function parseMarshallsOrders(input) {
  const routing = marshallsDocumentMode(
    input?.text
  );

  if (routing.mode === 'MULTI_DC') {
    return parseMarshallsMultiDcOrders(input);
  }

  return [
    parseMarshallsSingleDc(input)
  ];
}

export function parseMarshalls(input) {
  const routing = marshallsDocumentMode(
    input?.text
  );

  if (routing.mode === 'MULTI_DC') {
    return parseMarshallsMultiDc(input);
  }

  return parseMarshallsSingleDc(input);
}
