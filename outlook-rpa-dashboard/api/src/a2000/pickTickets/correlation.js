function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim().toUpperCase();
}

function exactTuple(expected, actual) {
  return clean(expected.pick_ticket_no) === clean(actual.pick_ticket_no)
    && clean(expected.control_no) === clean(actual.control_no)
    && clean(expected.order_no) === clean(actual.order_no)
    && clean(expected.store_no) === clean(actual.store_no);
}

export function correlateReportPages({ expected, pages }) {
  const remaining = [...expected];
  const matches = [];
  const rejectedPages = [];

  for (const page of pages) {
    const index = remaining.findIndex((item) => exactTuple(item, page.identifiers));
    if (index < 0) {
      rejectedPages.push({
        page_number: page.page_number,
        identifiers: page.identifiers,
        reason: 'NO_EXPECTED_PICK_TICKET_MATCH'
      });
      continue;
    }
    const [matched] = remaining.splice(index, 1);
    matches.push({
      page_number: page.page_number,
      expected: matched,
      actual: page.identifiers
    });
  }

  return {
    accepted: matches.length > 0 && rejectedPages.length === 0,
    matches,
    missing_expected: remaining,
    rejected_pages: rejectedPages
  };
}
