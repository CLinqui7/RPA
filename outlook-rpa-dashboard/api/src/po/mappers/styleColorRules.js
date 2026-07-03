function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function splitLastHyphen(value) {
  const raw = clean(value);
  const match = raw.match(/^(.+)-([A-Z0-9]{2,6})$/i);
  if (!match) return null;
  return {
    style_code: match[1].trim(),
    color_code: match[2].trim().toUpperCase()
  };
}

function normalizeCustomerKey(customerRaw = '', parser = '') {
  const value = `${customerRaw} ${parser}`.toLowerCase();
  if (value.includes('bealls')) return 'bealls';
  if (value.includes('gabe')) return 'gabes';
  if (value.includes('spencer')) return 'spencers';
  if (value.includes('citi')) return 'cititrends';
  if (value.includes('shoe')) return 'shoeshow';
  if (value.includes('variety')) return 'variety';
  return 'generic';
}

function beallsColor(style, color) {
  const styleUpper = clean(style).toUpperCase();
  const colorUpper = clean(color).toUpperCase();
  const split = splitLastHyphen(style);
  if (split) return split;

  if (styleUpper === '03STORMY13KP' && colorUpper === 'BLACK') {
    return { style_code: styleUpper, color_code: 'BKA' };
  }

  const generic = {
    BLACK: 'BKA',
    WHITE: 'WHA',
    PINK: 'PKA',
    RED: 'RDA',
    BLUE: 'BUA',
    BROWN: 'BNA'
  };

  return {
    style_code: clean(style) || null,
    color_code: generic[colorUpper] || (/^[A-Z0-9]{2,6}$/.test(colorUpper) ? colorUpper : null)
  };
}

export function normalizeStyleColor({ customerRaw, parser, styleRaw, colorRaw }) {
  const customer = normalizeCustomerKey(customerRaw, parser);
  const style = clean(styleRaw);
  const color = clean(colorRaw);

  if (!style) return { style_code: null, color_code: null };

  if (customer === 'bealls') return beallsColor(style, color);

  // Strict PDF-only flows. Leave A2000 mapping blank until PT/export/checklist/master supplies it.
  if (['cititrends', 'gabes', 'shoeshow'].includes(customer)) {
    return { style_code: null, color_code: null };
  }

  if (['variety', 'spencers'].includes(customer)) {
    const split = splitLastHyphen(style);
    if (split) return split;
  }

  return {
    style_code: style,
    color_code: /^[A-Z0-9]{2,6}$/i.test(color) ? color.toUpperCase() : null
  };
}
