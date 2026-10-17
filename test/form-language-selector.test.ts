import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

class Radio {
  constructor(public value: string, public checked = true) {}
  matches(selector: string) { return selector === '.form-language-radio'; }
}

const makeMenu = (language: string) => {
  const label = { textContent: language };
  let focused = false;
  let change: (event: { target: unknown }) => void;
  const menu = {
    open: true,
    querySelector(selector: string) {
      return selector === 'summary' ? { focus: () => { focused = true; } } : label;
    },
    addEventListener(_name: string, listener: typeof change) { change = listener; },
  };
  return {
    menu, label, isFocused: () => focused,
    choose: (input: Radio) => change({ target: input }),
  };
};

test('Language changes update the visible code, close the menu, and keep other selectors unchanged', async () => {
  const rationale = makeMenu('en');
  const forum = makeMenu('ar');
  const source = await readFile(new URL('../public/scripts/form-language-selector.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    document: { querySelectorAll: () => [rationale.menu, forum.menu] },
    HTMLInputElement: Radio,
  });
  rationale.choose(new Radio('fr'));
  assert.equal(rationale.label.textContent, 'fr');
  assert.equal(rationale.menu.open, false);
  assert.equal(rationale.isFocused(), true);
  assert.equal(forum.label.textContent, 'ar');
  assert.equal(forum.menu.open, true);
  forum.choose(new Radio('de'));
  assert.equal(forum.label.textContent, 'de');
  rationale.choose(new Radio('en', false));
  assert.equal(rationale.label.textContent, 'fr');
});
