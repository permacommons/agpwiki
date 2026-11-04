import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import { parseLocalDate, renderInfobox } from '../src/lib/infobox-render.js';
import { GREGORIAN_CALENDAR, type WikidataSnapshot } from '../src/lib/wikidata.js';
import { fetchWikidataSnapshot } from '../src/services/wikidata-service.js';

const t = i18next.t.bind(i18next);

const item = (id: string, rank = 'normal', qualifiers?: Record<string, unknown[]>) => ({
  mainsnak: { snaktype: 'value', datatype: 'wikibase-item', datavalue: { type: 'wikibase-entityid', value: { id } } },
  rank,
  ...(qualifiers ? { qualifiers } : {}),
});
const time = (value: string, precision = 11) => ({
  mainsnak: {
    snaktype: 'value',
    datatype: 'time',
    datavalue: { type: 'time', value: { time: value, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' } },
  },
  rank: 'normal',
});
const string = (value: string, datatype = 'string', qualifiers?: Record<string, unknown[]>) => ({
  mainsnak: { snaktype: 'value', datatype, datavalue: { type: 'string', value } },
  rank: 'normal',
  ...(qualifiers ? { qualifiers } : {}),
});

const PERSON_CLAIMS = {
  P31: [item('Q5')],
  P569: [time('+1964-05-30T00:00:00Z')],
  P19: [item('Q1')],
  P106: [item('Q855091'), item('Q639669'), item('Q488205'), item('Q177220'), item('Q36834'), item('Q99', 'deprecated')],
  P1303: [item('Q6607')],
  P18: [
    string('Tom Morello.jpg', 'commonsMedia', {
      P2096: [{ snaktype: 'value', datavalue: { type: 'monolingualtext', value: { text: 'On stage', language: 'en' } } }],
    }),
  ],
  P856: [string('https://www.tommorello.com/', 'url')],
  P1449: [{ mainsnak: { snaktype: 'somevalue', datatype: 'monolingualtext' }, rank: 'normal' }],
};

const LABELS: Record<string, string> = {
  Q1: 'Harlem',
  Q855091: 'guitarist',
  Q639669: 'musician',
  Q488205: 'singer-songwriter',
  Q177220: 'singer',
  Q36834: 'composer',
  Q6607: 'guitar',
  Q43229: 'organization',
  Q36732: 'kingdom',
  Q729: 'Animalia',
  Q127960: 'Panthera',
  Q34740: 'genus',
};

/** A fake Wikidata: answers the API and SPARQL requests from fixed data, and records them. */
const fakeWikidata = (claimsById: Record<string, Record<string, unknown[]>>, sparqlRows: Record<string, string>[] = []) => {
  const requests: Array<{ url: URL; userAgent: string | null }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') });
    if (url.hostname === 'query.example') {
      const bindings = sparqlRows.map(row =>
        Object.fromEntries(Object.entries(row).map(([key, id]) => [key, { value: key === "name" ? id : `http://www.wikidata.org/entity/${id}` }]))
      );
      return new Response(JSON.stringify({ results: { bindings } }));
    }
    const ids = (url.searchParams.get('ids') ?? '').split('|');
    const entities: Record<string, unknown> = {};
    for (const id of ids) {
      entities[id] =
        url.searchParams.get('props') === 'labels'
          ? { id, labels: LABELS[id] ? { en: { language: 'en', value: LABELS[id] } } : {} }
          : claimsById[id]
            ? { id, claims: claimsById[id] }
            : { id, missing: '' };
    }
    return new Response(JSON.stringify({ entities }));
  }) as typeof fetch;
  return { fetchImpl, requests };
};

const fetchOptions = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  apiBaseUrl: 'https://api.example/w/api.php',
  sparqlUrl: 'https://query.example/sparql',
  userAgent: 'AgpWiki-test/1.0 (infobox tests)',
  timeoutMs: 1000,
  languages: ['en', 'mul'],
  fetchImage: async (file: string) => ({
    file,
    thumbnailUrl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(file)}/960px-${encodeURIComponent(file)}`,
    commonsPageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    author: 'Dario De Marco',
    license: 'Public domain',
    licenseUrl: null,
  }),
});

test('A human gets the Person box, with only its properties and the labels it needs', async () => {
  const { fetchImpl, requests } = fakeWikidata({ Q297552: PERSON_CLAIMS });
  const snapshot = await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));

  assert.equal(snapshot.boxId, 'person');
  // Chosen from "instance of" directly, so no SPARQL query.
  assert.ok(requests.every(request => request.url.hostname === 'api.example'));
  assert.ok(requests.every(request => request.userAgent === 'AgpWiki-test/1.0 (infobox tests)'));
  assert.equal(snapshot.claims.P106.length, 5, 'deprecated statements are dropped');
  assert.equal(snapshot.claims.P1449, undefined, '"unknown value" is not a value');
  assert.deepEqual(snapshot.claims.P18[0].qualifiers?.P2096, [{ type: 'monolingual', text: 'On stage', language: 'en' }]);
  assert.equal(snapshot.labels.Q855091.en, 'guitarist');
  assert.equal(snapshot.images['Tom Morello.jpg'].author, 'Dario De Marco');
});

test('Organisations are matched through subclasses, species get a classification, other items no box', async () => {
  const org = fakeWikidata({ Q2283: { P31: [item('Q4830453')], P571: [time('+1975-04-04T00:00:00Z')] } }, [
    { root: 'Q43229' },
  ]);
  const company = await fetchWikidataSnapshot('Q2283', fetchOptions(org.fetchImpl));
  assert.equal(company.boxId, 'organisation');
  const sparql = org.requests.find(request => request.url.hostname === 'query.example');
  assert.match(sparql?.url.searchParams.get('query') ?? '', /wd:Q2283 wdt:P31\/wdt:P279\* \?root/);

  const lion = fakeWikidata({ Q140: { P31: [item('Q16521')], P225: [string('Panthera leo')] } }, [
    { taxon: 'Q127960', rank: 'Q34740', name: 'Panthera' },
    { taxon: 'Q729', rank: 'Q36732' },
  ]);
  const species = await fetchWikidataSnapshot('Q140', fetchOptions(lion.fetchImpl));
  assert.equal(species.boxId, 'species');
  assert.deepEqual(species.classification, [
    { rank: 'Q36732', taxon: 'Q729' },
    { rank: 'Q34740', taxon: 'Q127960', name: 'Panthera' },
  ]);
  const html = renderInfobox({ snapshot: species, titleHtml: 'Lion', locale: 'en', t });
  assert.match(html, /<th scope="row">Kingdom<\/th><td>Animalia<\/td>/);
  assert.match(html, /<th scope="row">Genus<\/th><td><i>Panthera<\/i><\/td>/);
  assert.match(html, /<th scope="row">Scientific name<\/th><td><i>Panthera leo<\/i><\/td>/);

  const city = fakeWikidata({ Q90: { P31: [item('Q515')] } }, []);
  const none = await fetchWikidataSnapshot('Q90', fetchOptions(city.fetchImpl));
  assert.equal(none.boxId, null);
  assert.deepEqual(none.claims, {});
});

const personSnapshot = async (): Promise<WikidataSnapshot> => {
  const { fetchImpl } = fakeWikidata({ Q297552: PERSON_CLAIMS });
  return fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));
};

test('The Person box shows known facts only, shortens long lists and links to Wikidata', async () => {
  const html = renderInfobox({
    snapshot: await personSnapshot(),
    titleHtml: 'Tom Morello',
    locale: 'en',
    t,
    now: new Date('2026-11-01T12:00:00Z'),
  });
  assert.match(html, /<div class="infobox-title">Tom Morello<\/div>/);
  assert.match(html, /<th scope="row">Born<\/th><td>May 30, 1964 <span class="infobox-age">\(age 62\)<\/span><br>Harlem<\/td>/);
  assert.doesNotMatch(html, />Died</, 'rows Wikidata has nothing for are left out');
  assert.match(html, /<td>Guitarist, musician, singer-songwriter and <a href="https:\/\/www\.wikidata\.org\/wiki\/Q297552#P106"[^>]*>2 more<\/a><\/td>/);
  assert.match(html, /Musical career/);
  assert.match(html, /<th scope="row">Instruments<\/th><td>Guitar<\/td>/);
  assert.doesNotMatch(html, /Political career/);
  assert.match(html, /<a href="https:\/\/www\.tommorello\.com\/"[^>]*>tommorello\.com<\/a>/);
  assert.match(html, /<img src="[^"]*\/250px-Tom%20Morello\.jpg" srcset="[^"]*\/500px-Tom%20Morello\.jpg 2x" alt="Tom Morello"/);
  assert.match(html, /<figcaption>On stage<\/figcaption>/);
  assert.match(html, /Image: <a href="https:\/\/commons\.wikimedia\.org\/wiki\/File:Tom%20Morello\.jpg"[^>]*>Dario De Marco, Public domain<\/a>/);
  assert.match(html, /<a href="https:\/\/www\.wikidata\.org\/wiki\/Q297552"[^>]*>Facts and sources on Wikidata<\/a>/);
  assert.doesNotMatch(html, /infobox-note/);
});

test('Values added on Agpedia fill gaps only', async () => {
  const snapshot = await personSnapshot();
  const localValues = {
    P1477: { value: 'Thomas Baptist Morello', citation: 'morello-bio' },
    P569: { value: '1964-05-31', citation: 'morello-bio' },
    P27: { value: 'United States', citation: 'morello-bio' },
  };
  const html = renderInfobox({ snapshot, localValues, titleHtml: 'Tom Morello', locale: 'en', t, isOldRevision: true });
  assert.match(
    html,
    /<th scope="row">Birth name<\/th><td>Thomas Baptist Morello <span class="infobox-local">\(<a href="\/cite\/morello-bio"[^>]*>added on Agpedia<\/a>\)<\/span><\/td>/
  );
  // Wikidata has a date of birth, so the Agpedia one is not shown.
  assert.match(html, /<td>May 30, 1964/);
  assert.doesNotMatch(html, /May 31/);
  assert.match(html, /<p class="infobox-note">You are viewing an older version/);
});

test('No box is shown without a matching box or any facts', () => {
  const empty: WikidataSnapshot = { qid: 'Q1', boxId: null, claims: {}, labels: {}, classification: [], images: {} };
  assert.equal(renderInfobox({ snapshot: empty, titleHtml: 'X', locale: 'en', t }), '');
  assert.equal(renderInfobox({ snapshot: { ...empty, boxId: 'person' }, titleHtml: 'X', locale: 'en', t }), '');
  assert.equal(renderInfobox({ snapshot: null, titleHtml: 'X', locale: 'en', t }), '');
});


test('Local instruments and labels reveal the musical career group', async () => {
  const snapshot = await personSnapshot();
  delete snapshot.claims.P1303;
  delete snapshot.claims.P264;
  const render = (localValues = {}) => renderInfobox({ snapshot, localValues, titleHtml: 'Person', locale: 'en', t });
  assert.doesNotMatch(render(), /Musical career/);
  for (const property of ['P1303', 'P264']) {
    const html = render({ [property]: { value: 'Local music fact', citation: 'music-bio' } });
    assert.match(html, /Musical career/);
    assert.match(html, /Local music fact/);
    assert.match(html, /href="\/cite\/music-bio"/);
  }
});

test('Monolingual facts select one language in preference order and keep its values', () => {
  const snapshot: WikidataSnapshot = {
    qid: 'Q1', boxId: 'species', labels: {}, classification: [], images: {},
    claims: { P1843: [
      { value: { type: 'monolingual', language: 'en', text: 'English name' } },
      { value: { type: 'monolingual', language: 'pt', text: 'Portuguese name' } },
      { value: { type: 'monolingual', language: 'pt', text: 'Another Portuguese name' } },
      { value: { type: 'monolingual', language: 'fr', text: 'French name' } },
    ] },
  };
  const render = (locale: string) => renderInfobox({ snapshot, titleHtml: 'Species', locale, t });
  const portuguese = render('pt-PT');
  assert.match(portuguese, /Portuguese name/);
  assert.match(portuguese, /Another Portuguese name/);
  assert.doesNotMatch(portuguese, /English name|French name/);
  const englishFallback = render('de');
  assert.match(englishFallback, /English name/);
  assert.doesNotMatch(englishFallback, /Portuguese name|French name/);
  const french = render('fr');
  assert.match(french, /French name/);
  assert.doesNotMatch(french, /English name|Portuguese name/);
});

test('Key people retain local gap filling for properties absent from Wikidata', () => {
  const snapshot: WikidataSnapshot = {
    qid: 'Q1',
    boxId: 'organisation',
    claims: { P169: [{ value: { type: 'item', id: 'Q2' } }] },
    labels: { Q2: { en: 'Wikidata CEO' } },
    classification: [],
    images: {},
  };
  const html = renderInfobox({
    snapshot,
    localValues: {
      P169: { value: 'Local CEO', citation: 'company-source' },
      P488: { value: 'Local chairperson', citation: 'company-source' },
    },
    titleHtml: 'Company',
    locale: 'en',
    t,
  });
  const row = html.match(/<th scope="row">Key people<\/th><td>(.*?)<\/td>/)?.[1] ?? '';
  assert.match(row, /Wikidata CEO/);
  assert.doesNotMatch(row, /Local CEO/);
  assert.match(row, /Local chairperson/);
  assert.match(row, /class="infobox-local"/);
  assert.match(row, /href="\/cite\/company-source"/);
});


test('BCE years retain Wikidata historical numbering for remote and local dates', () => {
  for (const [year, expected] of [['-0044', '44 BC'], ['-0001', '1 BC'], ['+0001', '1']]) {
    const snapshot: WikidataSnapshot = {
      qid: 'Q1', boxId: 'organisation', labels: {}, classification: [], images: {},
      claims: { P571: [{ value: { type: 'time', calendarModel: GREGORIAN_CALENDAR, time: `${year}-00-00T00:00:00Z`, precision: 9 } }] },
    };
    const render = (localValues = {}) => renderInfobox({ snapshot, localValues, titleHtml: 'Organisation', locale: 'en', t });
    assert.ok(render().includes(`<th scope="row">Founded</th><td>${expected}</td>`));
    snapshot.claims = {};
    const local = render({ P571: { value: String(Number(year)), citation: 'history' } });
    assert.ok(local.includes(`<th scope="row">Founded</th><td>${expected} <span class="infobox-local">`));
  }
});

test('Ages across BCE and CE skip year zero and respect birthdays', () => {
  const cases = [
    ['-0001-06-15', '+0001-06-15', 1],
    ['-0004-06-15', '+0004-06-15', 7],
    ['-0004-06-15', '+0004-06-14', 6],
    ['-0004-06-15', '-0001-06-15', 3],
    ['+0001-06-15', '+0004-06-15', 3],
  ] as const;
  for (const [birth, death, age] of cases) {
    const snapshot: WikidataSnapshot = {
      qid: 'Q1', boxId: 'person', labels: {}, classification: [], images: {},
      claims: {
        P569: [{ value: { type: 'time', calendarModel: GREGORIAN_CALENDAR, time: `${birth}T00:00:00Z`, precision: 11 } }],
        P570: [{ value: { type: 'time', calendarModel: GREGORIAN_CALENDAR, time: `${death}T00:00:00Z`, precision: 11 } }],
      },
    };
    const html = renderInfobox({ snapshot, titleHtml: 'Person', locale: 'en', t });
    assert.ok(html.includes(`(aged ${age})`), `${birth} to ${death} should be ${age} years`);
  }
});

test('An unknown death date suppresses present-day age', async () => {
  const { fetchImpl } = fakeWikidata({
    Q297552: {
      ...PERSON_CLAIMS,
      P570: [{ mainsnak: { snaktype: 'somevalue', datatype: 'time' }, rank: 'normal' }],
    },
  });
  const snapshot = await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));
  assert.equal(snapshot.deathDateUnknown, true);
  const html = renderInfobox({
    snapshot: JSON.parse(JSON.stringify(snapshot)),
    titleHtml: 'Person with unknown death date',
    locale: 'en',
    t,
    now: new Date('2026-11-01T12:00:00Z'),
  });
  assert.match(html, /<th scope="row">Born<\/th><td>May 30, 1964/);
  assert.doesNotMatch(html, /class="infobox-age"/, 'a person known to have died has no present-day age');
});


test('Unknown death dates follow statement ranks and no-value does not indicate death', async () => {
  const cases = [
    { snaktype: 'somevalue', rank: 'deprecated', hasAge: true },
    { snaktype: 'somevalue', rank: 'preferred', hasAge: false },
    { snaktype: 'novalue', rank: 'normal', hasAge: true },
  ];
  for (const { snaktype, rank, hasAge } of cases) {
    const { fetchImpl } = fakeWikidata({
      Q297552: {
        ...PERSON_CLAIMS,
        P570: [{ mainsnak: { snaktype, datatype: 'time' }, rank }],
      },
    });
    const snapshot = await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));
    const html = renderInfobox({ snapshot, titleHtml: 'Person', locale: 'en', t, now: new Date('2026-11-01T12:00:00Z') });
    assert.equal(html.includes('class="infobox-age"'), hasAge, `${rank} ${snaktype}`);
  }
  const { fetchImpl } = fakeWikidata({
    Q297552: {
      ...PERSON_CLAIMS,
      P570: [
        { mainsnak: { snaktype: 'somevalue', datatype: 'time' }, rank: 'normal' },
        { mainsnak: { snaktype: 'novalue', datatype: 'time' }, rank: 'preferred' },
      ],
    },
  });
  const snapshot = await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));
  assert.equal(snapshot.deathDateUnknown, false, 'preferred statements take precedence over normal statements');
});

test('Image captions prefer the reader language over an earlier English caption', async () => {
  const snapshot = await personSnapshot();
  snapshot.claims.P18[0].qualifiers = {
    P2096: [
      { type: 'monolingual', language: 'en', text: 'On stage' },
      { type: 'monolingual', language: 'fr', text: 'Sur scène' },
    ],
  };
  const render = (locale: string) => renderInfobox({ snapshot, titleHtml: 'Person', locale, t });
  const fallback = render('de');
  assert.match(fallback, /<figcaption>On stage<\/figcaption>/);
  const french = render('fr');
  assert.match(french, /<figcaption>Sur scène<\/figcaption>/);
  assert.doesNotMatch(french, /<figcaption>On stage<\/figcaption>/);
});


test('Local dates reject impossible calendar dates without normalizing them', () => {
  for (const value of ['1964-13-40', '2024-00', '2024-01-00', '2024-04-31', '2023-02-29', '1900-02-29', '0000', 'May 30, 1964']) {
    assert.equal(parseLocalDate(value), null, value);
  }
  for (const value of ['1964', '1964-05', '1964-05-30', '2024-02-29', '2000-02-29', '0001-01-01', '-0044', '-0044-03-15']) {
    assert.ok(parseLocalDate(value), value);
  }
  const snapshot: WikidataSnapshot = { qid: 'Q1', boxId: 'person', claims: {}, labels: {}, classification: [], images: {} };
  const html = renderInfobox({
    snapshot, titleHtml: 'Person', locale: 'en', t,
    localValues: { P569: { value: '1964-13-40', citation: 'history' } },
  });
  assert.match(html, /1964-13-40/);
  assert.doesNotMatch(html, /class="infobox-age"/);
});

test('Julian dates retain their calendar and do not produce mixed-calendar ages', async () => {
  const birth = time('+1900-03-01T00:00:00Z');
  birth.mainsnak.datavalue.value.calendarmodel = 'http://www.wikidata.org/entity/Q1985786';
  const { fetchImpl } = fakeWikidata({
    Q297552: {
      P31: [item('Q5')],
      P569: [birth],
      P570: [time('+1980-03-05T00:00:00Z')],
    },
  });
  const snapshot = await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl));
  assert.equal(snapshot.claims.P569[0].value.type, 'time');
  assert.equal((snapshot.claims.P569[0].value as { calendarModel?: string }).calendarModel, birth.mainsnak.datavalue.value.calendarmodel);
  const html = renderInfobox({ snapshot, titleHtml: 'Historical person', locale: 'en', t });
  const born = html.match(/<th scope="row">Born<\/th><td>(.*?)<\/td>/)?.[1] ?? '';
  assert.match(born, /March 1, 1900/);
  assert.match(born, /Julian/, 'the original calendar must be explicit');
  assert.doesNotMatch(html, /class="infobox-age"/, 'Julian birth and Gregorian death must not be compared directly');
});


test('Calendar labels preserve Julian leap days and missing calendars suppress ages', async () => {
  const birth = time('+1900-02-29T00:00:00Z');
  birth.mainsnak.datavalue.value.calendarmodel = 'http://www.wikidata.org/entity/Q1985786';
  const death = time('+1980-03-01T00:00:00Z');
  death.mainsnak.datavalue.value.calendarmodel = birth.mainsnak.datavalue.value.calendarmodel;
  const { fetchImpl } = fakeWikidata({ Q297552: { P31: [item('Q5')], P569: [birth], P570: [death] } });
  const snapshot = JSON.parse(JSON.stringify(await fetchWikidataSnapshot('Q297552', fetchOptions(fetchImpl)))) as WikidataSnapshot;
  const render = () => renderInfobox({ snapshot, titleHtml: 'Person', locale: 'en', t, now: new Date('2026-03-01T12:00:00Z') });
  const html = render();
  assert.match(html, /February 29, 1900 \(Julian calendar\)/);
  assert.match(html, /March 1, 1980 \(Julian calendar\)/);
  assert.match(html, /\(aged 80\)/);
  delete snapshot.claims.P570;
  assert.doesNotMatch(render(), /class="infobox-age"/, 'Julian dates cannot be compared with Gregorian today');
  const value = snapshot.claims.P569[0].value;
  if (value.type !== 'time') assert.fail('expected time');
  delete value.calendarModel;
  assert.match(render(), /calendar unknown/);
  assert.doesNotMatch(render(), /class="infobox-age"/, 'legacy snapshots must not assume a Gregorian calendar');
});


test('Death evidence suppresses present-day ages independently of date formatting', () => {
  const cases = [
    { name: 'Wikidata death place', claims: { P20: [{ value: { type: 'item' as const, id: 'Q2' } }] }, localValues: {} },
    { name: 'local death place', claims: {}, localValues: { P20: { value: 'Paris', citation: 'biography' } } },
    { name: 'local death date', claims: {}, localValues: { P570: { value: '2020', citation: 'biography' } } },
    { name: 'unparseable stored death date', claims: {}, localValues: { P570: { value: 'date unknown', citation: 'biography' } } },
  ];
  for (const { name, claims, localValues } of cases) {
    const snapshot: WikidataSnapshot = {
      qid: 'Q1', boxId: 'person', labels: { Q2: { en: 'Paris' } }, classification: [], images: {},
      claims: { P569: [{ value: { type: 'time', time: '+1964-05-30T00:00:00Z', precision: 11, calendarModel: GREGORIAN_CALENDAR } }], ...claims },
    };
    const html = renderInfobox({ snapshot, localValues, titleHtml: 'Person', locale: 'en', t, now: new Date('2026-11-01T12:00:00Z') });
    assert.match(html, /<th scope="row">Born<\/th><td>May 30, 1964/, name);
    assert.match(html, /<th scope="row">Died<\/th>/, name);
    assert.doesNotMatch(html, /class="infobox-age"/, name);
  }
});
