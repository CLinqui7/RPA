function text(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function classifyA2000RuntimeError(error) {
  const rawMessage = text(error?.message || error);
  const httpMatch = rawMessage.match(/\bHTTP\s+(\d{3})\b/i);
  const httpStatus = httpMatch ? Number(httpMatch[1]) : null;
  const serviceUnavailable = (
    [502, 503, 504].includes(httpStatus)
    || /no backend server available|failure of web server bridge|service unavailable|gateway timeout/i.test(rawMessage)
  );

  if (serviceUnavailable) {
    return {
      code: 'A2000_SERVICE_UNAVAILABLE',
      stage: 'a2000_connectivity',
      name: error?.name || 'Error',
      message: 'A2000 AMEXTEST está temporalmente fuera de servicio. No se envió ORDER_HD ni ORDER_LI. Intenta la validación nuevamente cuando el servicio responda.',
      raw_message: rawMessage,
      http_status: httpStatus || 503,
      transient: true,
      write_performed: false
    };
  }

  return {
    code: 'PREFLIGHT_EXCEPTION',
    stage: 'live_preflight',
    name: error?.name || 'Error',
    message: rawMessage,
    raw_message: rawMessage,
    http_status: httpStatus,
    transient: false,
    write_performed: false
  };
}

export function isTransientNoWriteJob(job = {}) {
  const error = job.last_error || {};
  const status = Number(error.http_status || 0);
  const message = text(error.raw_message || error.message);
  const unavailable = (
    error.code === 'A2000_SERVICE_UNAVAILABLE'
    || [502, 503, 504].includes(status)
    || /no backend server available|failure of web server bridge/i.test(message)
  );

  const hasWriteEvidence = Boolean(
    job.a2000_seq_order_no
    || job.a2000_ctrl_no
    || job.header_request
    || job.lines_request
    || job.header_response_json
    || job.lines_response_json
  );

  return unavailable && !hasWriteEvidence;
}
