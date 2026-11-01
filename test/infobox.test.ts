import assert from 'node:assert/strict';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';
import { findInfoboxMismatches, renderInfobox } from '../src/lib/infobox-render.js';
import { fetchWikidataSnapshot, type WikidataSnapshot } from '../src/lib/wikidata.js';

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

test('Values added on Agpedia fill gaps only, and differences from Wikidata are found', async () => {
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

  assert.deepEqual(findInfoboxMismatches(snapshot, localValues), [
    { property: 'P569', agpediaValue: '1964-05-31', wikidataValue: '1964-05-30' },
  ]);
  // A date known only to the year agrees with the full date.
  assert.deepEqual(findInfoboxMismatches(snapshot, { P569: { value: '1964', citation: 'x' } }), []);
  assert.deepEqual(findInfoboxMismatches(snapshot, { P106: { value: 'Guitarist', citation: 'x' } }), []);
});

test('No box is shown without a matching box or any facts', () => {
  const empty: WikidataSnapshot = { qid: 'Q1', boxId: null, claims: {}, labels: {}, classification: [], images: {} };
  assert.equal(renderInfobox({ snapshot: empty, titleHtml: 'X', locale: 'en', t }), '');
  assert.equal(renderInfobox({ snapshot: { ...empty, boxId: 'person' }, titleHtml: 'X', locale: 'en', t }), '');
  assert.equal(renderInfobox({ snapshot: null, titleHtml: 'X', locale: 'en', t }), '');
});
