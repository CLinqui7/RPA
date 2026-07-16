import {
  parseMarshalls as parseMarshallsSingleDc
} from './marshallsSingleDc.js';

import {
  parseMarshalls as parseMarshallsMultiDcGuard,
  parseMarshallsOrders as parseMarshallsMultiDcOrders
} from './marshallsMultiDc.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function distributionCenterCodes(text = '') {
  const codes = [
    ...String(text).matchAll(
      /\bDC\s*#\s*:?\s*([A-Z0-9-]+)/gi
    )
  ].map(match => clean(match[1]).toUpperCase());

  return [...new Set(codes.filter(Boolean))];
}

function distributionCenterHeadingCount(text = '') {
  return (
    String(text).match(
      /\bDistribution\s+Center\b/gi
    ) || []
  ).length;
}

export function isMarshallsMultiDc(text = '') {
  const dcCodes = distributionCenterCodes(text);
  const headingCount = distributionCenterHeadingCount(text);

  return dcCodes.length > 1 || headingCount > 1;
}

export function parseMarshallsOrders(input) {
  if (isMarshallsMultiDc(input?.text)) {
    return parseMarshallsMultiDcOrders(input);
  }

  return [parseMarshallsSingleDc(input)];
}

export function parseMarshalls(input) {
  if (isMarshallsMultiDc(input?.text)) {
    return parseMarshallsMultiDcGuard(input);
  }

  return parseMarshallsSingleDc(input);
}
