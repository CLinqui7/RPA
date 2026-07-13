function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isAmexTest(baseUrl = '') {
  const value = clean(baseUrl).toLowerCase();
  return value.includes('amextest.a2000cloud.com')
    && value.includes('/ords/amxtest');
}

function duplicateTopLevelErrors(rawBody = '') {
  const count = (String(rawBody).match(/"errors"\s*:/g) || []).length;
  return count > 1 ? ['errors'] : [];
}

function parseBody(rawBody = '') {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function escapeViewerLiteral(value) {
  return String(value).replaceAll("'", "''");
}

export class A2000RestClient {
  constructor({
    baseUrl = process.env.A2000_BASE_URL,
    clientId = process.env.A2000_CLIENT_ID,
    clientSecret = process.env.A2000_CLIENT_SECRET,
    clientName = process.env.A2000_CLIENT_NAME || 'Linqui',
    headerUploadId = process.env.A2000_ORDER_HD_UPLOAD_ID || 'ORDER_HD',
    lineUploadId = process.env.A2000_ORDER_LI_UPLOAD_ID || 'ORDER_LI',
    headerPayloadKey = process.env.A2000_ORDER_HD_PAYLOAD_KEY
      || process.env.A2000_ORDER_HD_UPLOAD_ID
      || 'ORDER_HD',
    linePayloadKey = process.env.A2000_ORDER_LI_PAYLOAD_KEY
      || process.env.A2000_ORDER_LI_UPLOAD_ID
      || 'ORDER_LI'
  } = {}) {
    this.baseUrl = clean(baseUrl).replace(/\/+$/, '');
    this.clientId = clean(clientId);
    this.clientSecret = clean(clientSecret);
    this.clientName = clean(clientName) || 'Linqui';
    this.headerUploadId = clean(headerUploadId) || 'ORDER_HD';
    this.lineUploadId = clean(lineUploadId) || 'ORDER_LI';
    this.headerPayloadKey = clean(headerPayloadKey) || this.headerUploadId;
    this.linePayloadKey = clean(linePayloadKey) || this.lineUploadId;
    this.token = '';
    this.tokenExpiresAt = 0;

    if (!this.baseUrl || !this.clientId || !this.clientSecret) {
      throw new Error(
        'Missing A2000_BASE_URL, A2000_CLIENT_ID or A2000_CLIENT_SECRET.'
      );
    }
  }

  get amexTest() {
    return isAmexTest(this.baseUrl);
  }

  get usingSharedDefaultUploadIds() {
    return this.headerUploadId === 'ORDER_HD'
      || this.lineUploadId === 'ORDER_LI';
  }

  get usingSharedDefaultLineUploadId() {
    return this.lineUploadId === 'ORDER_LI';
  }

  assertWriteEnvironment() {
    if (this.amexTest) return;

    if (
      clean(process.env.A2000_ALLOW_PRODUCTION_WRITES).toUpperCase()
      !== 'I_UNDERSTAND_PRODUCTION_A2000_WRITES'
    ) {
      throw new Error(
        'Production A2000 REST write blocked. AMEXTEST is the default safe write environment. Production requires A2000_ALLOW_PRODUCTION_WRITES=I_UNDERSTAND_PRODUCTION_A2000_WRITES plus the explicit CLI --confirm-write gate.'
      );
    }
  }

  assertProductionUploadIsolation() {
    const explicitOverride = (
      clean(process.env.A2000_ALLOW_SHARED_UPLOAD_IDS).toLowerCase()
      === 'true'
    );

    if (
      !this.amexTest
      && this.usingSharedDefaultUploadIds
      && !explicitOverride
    ) {
      throw new Error(
        'Production REST write blocked: ORDER_HD/ORDER_LI are shared default Upload IDs and pending Upload Utility rows were proven to interfere with REST. Configure dedicated Upload IDs or explicitly set A2000_ALLOW_SHARED_UPLOAD_IDS=true only after A2000/GCS confirms the operational risk.'
      );
    }
  }

  assertSharedLineUploadCleared() {
    if (!this.usingSharedDefaultLineUploadId) return;

    if (
      clean(process.env.A2000_ORDER_LI_CLEARED).toUpperCase()
      !== 'YES'
    ) {
      throw new Error(
        'Shared ORDER_LI write gate blocked. Inspect/export/CLEAR the ORDER_LI Upload Utility pending file first, then set A2000_ORDER_LI_CLEARED=YES for the controlled write process.'
      );
    }
  }

  async refreshToken() {
    const credentials = Buffer
      .from(`${this.clientId}:${this.clientSecret}`)
      .toString('base64');

    const configuredDelays = String(
      process.env.A2000_OAUTH_RETRY_DELAYS_MS || '0,1500,4000'
    )
      .split(',')
      .map(value => Number(value.trim()))
      .filter(value => Number.isFinite(value) && value >= 0);

    const delays = configuredDelays.length
      ? configuredDelays.slice(0, 5)
      : [0, 1500, 4000];

    let lastStatus = 0;
    let lastBody = '';
    let lastTransportError = null;

    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt] > 0) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }

      try {
        const response = await fetch(
          `${this.baseUrl}/api/oauth/token`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              Authorization: `Basic ${credentials}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              grant_type: 'client_credentials'
            }).toString()
          }
        );

        const rawBody = await response.text();
        const body = parseBody(rawBody);

        lastStatus = response.status;
        lastBody = rawBody;
        lastTransportError = null;

        if (response.ok && body?.access_token) {
          this.token = String(body.access_token);

          const expiresIn = Number(body.expires_in || 3600);
          this.tokenExpiresAt = (
            Date.now()
            + expiresIn * 1000
            - 60_000
          );

          return {
            token_type: body.token_type,
            expires_in: expiresIn,
            token_length: this.token.length,
            attempts: attempt + 1
          };
        }

        const transient = [502, 503, 504].includes(response.status);
        if (!transient || attempt === delays.length - 1) break;
      } catch (error) {
        lastTransportError = error;
        lastStatus = 0;
        lastBody = '';

        if (attempt === delays.length - 1) break;
      }
    }

    const transport = lastTransportError
      ? ` Transport: ${lastTransportError.message}.`
      : '';

    throw new Error(
      `A2000 OAuth failed after ${delays.length} safe attempt(s).`
      + ` HTTP ${lastStatus}.`
      + ` Body: ${lastBody.slice(0, 500)}`
      + transport
    );
  }

  async ensureFreshToken() {
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      await this.refreshToken();
    }
  }

  async request(
    method,
    path,
    payload = undefined,
    {
      retry401 = false,
      write = false
    } = {}
  ) {
    await this.ensureFreshToken();

    const execute = async () => {
      const headers = {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`
      };

      const options = {
        method,
        headers
      };

      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(payload);
      }

      try {
        const response = await fetch(
          `${this.baseUrl}${path}`,
          options
        );

        const rawBody = await response.text();

        return {
          transportOk: true,
          httpStatus: response.status,
          contentType: response.headers.get('content-type'),
          rawBody,
          body: parseBody(rawBody),
          duplicateKeys: duplicateTopLevelErrors(rawBody)
        };
      } catch (error) {
        return {
          transportOk: false,
          httpStatus: 0,
          contentType: null,
          rawBody: '',
          body: null,
          duplicateKeys: [],
          transportError: {
            name: error?.name || 'Error',
            message: error?.message || String(error)
          }
        };
      }
    };

    let result = await execute();
    let authRefreshAttempts = 0;

    // Safe read-only Viewer calls may force-refresh OAuth twice after 401.
    // Upload POSTs never enter this loop because write=true/retry401=false.
    while (
      result.httpStatus === 401
      && retry401
      && !write
      && authRefreshAttempts < 2
    ) {
      authRefreshAttempts += 1;

      // Clear the cached token explicitly before requesting a new one.
      this.token = '';
      this.tokenExpiresAt = 0;

      if (authRefreshAttempts > 1) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      await this.refreshToken();
      result = await execute();
    }

    return {
      ...result,
      authRefreshAttempts
    };
  }

  async viewer(name, {
    columns,
    filter,
    sort
  }) {
    const result = await this.request(
      'POST',
      `/api/viewers/view/${name}`,
      {
        COLUMNS: Array.isArray(columns)
          ? columns.join(', ')
          : columns,
        FILTER: filter,
        SORT: sort
      },
      {
        retry401: true,
        write: false
      }
    );

    const rows = Array.isArray(result.body?.[name])
      ? result.body[name]
      : [];

    return {
      ...result,
      rows
    };
  }

  async upload(uploadId, payload) {
    // V4.6.8: obtain a brand-new OAuth token immediately before every Upload POST.
    // This reduces stale bearer risk without ever retrying an ambiguous write.
    await this.refreshToken();

    return this.request(
      'POST',
      `/api/uploads/upload/${uploadId}`,
      payload,
      {
        retry401: false,
        write: true
      }
    );
  }

  async verifyHeader(seqOrderNo, orderNo) {
    return this.viewer('VR_ORDER_HD', {
      columns: [
        'CTRL_NO',
        'CUSTOMER',
        'ORDER_NO',
        'STORE',
        'DIV',
        'TERMS',
        'DEF_WH',
        'SHIP_VIA',
        'STATUS'
      ],
      filter: (
        `CTRL_NO = ${Number(seqOrderNo)} `
        + `AND ORDER_NO = '${escapeViewerLiteral(orderNo)}'`
      ),
      sort: 'CTRL_NO'
    });
  }

  async verifyLines(seqOrderNo) {
    return this.viewer('VR_ORDER_LI', {
      columns: [
        'CTRL_NO',
        'STYLE',
        'CLR',
        'LINE_NO',
        'WH',
        'CUSTOMER',
        'STORE',
        'ORDER_NO',
        'DIV',
        'PRICE',
        'SCALE',
        'ORDER_QTY',
        'OPEN_QTY',
        ...Array.from(
          { length: 18 },
          (_, index) => `OPEN_SZ${index + 1}`
        )
      ],
      filter: `CTRL_NO = ${Number(seqOrderNo)}`,
      sort: 'LINE_NO'
    });
  }
}
