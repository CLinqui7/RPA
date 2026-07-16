function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function matches(re, value) {
  re.lastIndex = 0;
  return re.test(value);
}

function allMatch(patterns = [], value = '') {
  return patterns.every((re) => matches(re, value));
}

function noneMatch(patterns = [], value = '') {
  return patterns.every((re) => !matches(re, value));
}

function eachGroupMatches(groups = [], value = '') {
  return groups.every((group) => group.some((re) => matches(re, value)));
}

const RULES = Object.freeze([
  {
    id: 'catocorp_purchase_order', parser: 'catocorp', priority: 240,
    required: [/purchase order:/i, /cato style/i, /color\s*\/\s*size\s*\/\s*diff summary/i, /catovendors\.com/i],
    anyGroups: [[/ship to:\s*cato corporation/i, /warehouse dept:/i]]
  },
  {
    id: 'tjmaxx_routing_distribution_blocked', parser: 'known_unsupported', priority: 236,
    required: [
      /routing and distribution instructions/i,
      /po number:\s*[a-z0-9-]+/i,
      /distribution center/i,
      /pg\s*[-/]\s*l/i,
      /vendor/i,
      /tjx/i,
      /description/i,
      /total/i,
      /units/i
    ],
    predicate: (haystack) => (haystack.match(/style\s*#/gi) || []).length >= 1,
    anyGroups: [[
      /tjmaxx_distribution_instructions/i,
      /\[a2000_pdf_visual_brand:tjmaxx:/i,
      /\btj\s*maxx\b/i,
      /\btjm\s+[a-z]/i,
      /\bmaxx\s+[a-z]/i
    ]],
    forbidden: [/marshalls_distribution_instructions/i, /\[a2000_pdf_visual_brand:marshalls:/i, /\bmarshalls\b/i]
  },
  {
    id: 'marshalls_routing_distribution', parser: 'marshalls', priority: 235,
    required: [
      /routing and distribution instructions/i,
      /po number:\s*[a-z0-9-]+/i,
      /distribution center/i,
      /pg\s*[-/]\s*l/i,
      /vendor/i,
      /tjx/i,
      /description/i,
      /total/i,
      /units/i
    ],
    predicate: (haystack) => (haystack.match(/style\s*#/gi) || []).length >= 1,
    anyGroups: [[
      /marshalls_distribution_instructions/i,
      /\[a2000_pdf_visual_brand:marshalls:/i,
      /\bmarshalls\b/i,
      /\bmar(?:\s+ch)?\s+[a-z]/i
    ]],
    forbidden: [/tjmaxx_distribution_instructions/i, /\[a2000_pdf_visual_brand:tjmaxx:/i, /\btj\s*maxx\b/i, /\btjm\s+[a-z]/i, /\bmaxx\s+[a-z]/i]
  },
  {
    id: 'tjmaxx_domestic_po', parser: 'tjmaxx', priority: 230,
    required: [/domestic po\s*(?:no|#)\s*:/i, /reference\s*(?:no|#)\s*:/i, /total po units/i, /vendor style/i]
  },
  {
    id: 'mesalve_purchase_order', parser: 'mesalve', priority: 220,
    required: [/\bme\s*salve\b/i, /order number:/i, /style no\./i, /\binner\b/i, /sb-class/i]
  },
  {
    id: 'ipc_purchase_order', parser: 'ipc', priority: 220,
    required: [/integrated premium concepts/i, /p\.o\. no\./i, /customer id/i, /pickup date/i, /item\s*#/i]
  },
  {
    id: 'tillys_fineline_order', parser: 'tillys', priority: 220,
    required: [/american exchange group/i, /fineline hang tag/i, /byr\s*#/i, /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/i],
    forbidden: [/zumiez\s*#:/i]
  },
  {
    id: 'zumiez_purchase_order', parser: 'zumiez', priority: 220,
    required: [/purchase order:/i, /zumiez\s*#:/i, /vendor style:/i, /cost\s*\/\s*unit/i]
  },
  {
    id: 'macys_backstage_purchase_order', parser: 'macysbacks', priority: 220,
    required: [/macys backstage/i, /vendor style number/i, /backstage cost/i, /total units/i]
  },
  {
    id: 'colony_purchase_order', parser: 'colony', priority: 220,
    required: [/colony brands/i, /po number/i, /pln\s*#\s*\/\s*item\s*#/i, /terms of sale/i, /line status/i]
  },
  {
    id: 'ollies_purchase_order', parser: 'ollies', priority: 220,
    required: [/ollie'?s bargain outlet/i, /po\s*#:/i, /upc number/i, /model\s*#/i]
  },
  {
    id: 'carnival_purchase_order', parser: 'carnival', priority: 220,
    required: [/carnival cruise line/i, /purchase order no/i, /date ordered/i, /item number/i]
  },
  {
    id: 'tenbelow_purchase_order', parser: 'tenbelow', priority: 220,
    required: [/purchase\s*#/i, /vendor style/i, /total units/i],
    anyGroups: [[/10 below llc/i, /simply 10/i]]
  },
  {
    id: 'bealls_purchase_order', parser: 'bealls', priority: 220,
    required: [/purchase order/i],
    anyGroups: [[/beallsinc\.com/i, /bealls vendor services/i], [/(?:bulk|complex)domestic-/i, /dept\. number:.*order number:/i]]
  },
  {
    id: 'gabes_purchase_order', parser: 'gabes', priority: 220,
    required: [/gabe'?s purchase order/i, /vendor original/i, /gabrielap@gabes\.net/i, /internal item\s*#/i]
  },
  {
    id: 'spencers_purchase_order', parser: 'spencers', priority: 210,
    required: [/purchase order/i],
    anyGroups: [[/spencer gifts/i, /sgvendors\.com/i]]
  },
  {
    id: 'citi_trends_purchase_order', parser: 'cititrends', priority: 220,
    required: [/cititrends\.com/i, /purchase order/i, /vendor style/i, /item number/i, /msrp/i, /quantity/i]
  },
  {
    id: 'shoeshow_purchase_order', parser: 'shoeshow', priority: 220,
    required: [/purchase order\s*#/i, /vendor copy/i, /printed by/i],
    anyGroups: [[/shoe dept\./i, /shoe show/i, /ssirouting@shoeshow\.com/i]]
  },
  {
    id: 'variety_wholesalers_purchase_order', parser: 'variety', priority: 220,
    required: [/variety wholesalers/i, /purchase order/i, /vw sku/i, /vnd id/i, /vnd ship unit/i, /grand total/i]
  }
]);

function evidenceForRule(rule, haystack) {
  const required = (rule.required || []).filter((re) => matches(re, haystack)).map(String);
  const groups = (rule.anyGroups || []).map((group) => group.filter((re) => matches(re, haystack)).map(String));
  return { required, groups };
}

export function detectStrictCustomerPattern({ text = '', fileName = '' } = {}) {
  const normalizedText = normalize(text);
  const normalizedFile = normalize(fileName);
  const haystack = `${normalizedFile}\n${normalizedText}`;

  const matchesList = RULES
    .filter((rule) => allMatch(rule.required || [], haystack))
    .filter((rule) => eachGroupMatches(rule.anyGroups || [], haystack))
    .filter((rule) => !rule.predicate || rule.predicate(haystack))
    .filter((rule) => noneMatch(rule.forbidden || [], haystack))
    .map((rule) => ({
      id: rule.id,
      parser: rule.parser,
      priority: rule.priority || 0,
      evidence: evidenceForRule(rule, haystack)
    }))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  if (!matchesList.length) {
    const tjxRoutingFamily = (
      allMatch([
        /routing and distribution instructions/i,
        /po number:\s*[a-z0-9-]+/i,
        /distribution center/i,
        /pg\s*[-/]\s*l/i,
        /vendor/i,
        /tjx/i,
        /description/i,
        /total/i,
        /units/i
      ], haystack)
      && (haystack.match(/style\s*#/gi) || []).length >= 1
    );

    return {
      status: tjxRoutingFamily ? 'ambiguous' : 'no_match',
      parser: null,
      pattern_id: null,
      candidates: [],
      reason: tjxRoutingFamily
        ? 'TJX routing family detected, but Marshalls/TJ Maxx brand evidence was insufficient or contradictory.'
        : 'No strict customer pattern matched.'
    };
  }

  const topPriority = matchesList[0].priority;
  const top = matchesList.filter((item) => item.priority === topPriority);
  const distinctParsers = [...new Set(top.map((item) => item.parser))];

  if (distinctParsers.length !== 1) {
    return {
      status: 'ambiguous',
      parser: null,
      pattern_id: null,
      candidates: top,
      reason: 'Multiple strict customer patterns matched at the same priority.'
    };
  }

  return {
    status: 'matched',
    parser: top[0].parser,
    pattern_id: top[0].id,
    candidates: top,
    reason: 'Exactly one strict customer pattern matched.'
  };
}

export function strictCustomerPatternRules() {
  return RULES.map((rule) => ({
    id: rule.id,
    parser: rule.parser,
    priority: rule.priority
  }));
}
