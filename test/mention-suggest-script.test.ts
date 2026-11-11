import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/scripts/mention-suggest.js', import.meta.url), 'utf8');

class Element {
  hidden = false;
  dataset: Record<string, string> = {};
  style = {};
  children: unknown[] = [];
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener() {}
  append(...children: unknown[]) { this.children.push(...children); }
  replaceChildren(...children: unknown[]) { this.children = children; }
  querySelectorAll() { return this.children.filter(child => child instanceof Element); }
}

class Textarea extends Element {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  hasAttribute(name: string) { return name === 'data-mention-suggest'; }
  getBoundingClientRect() { return { left: 0, bottom: 100, width: 300 }; }
  setRangeText(text: string, start: number, end: number) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
  dispatchEvent() {}
  focus() {}
}

const makeSuggestions = () => {
  const listeners: Record<string, (event: any) => void> = {};
  const timers = new Map<number, () => Promise<void>>();
  let nextTimer = 0;
  let fetchCount = 0;
  let resolveResponse!: (response: unknown) => void;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const body = new Element();
  runInNewContext(script, {
    document: {
      currentScript: { dataset: { endpoint: '/tool/mentions/suggest' } },
      addEventListener(name: string, listener: (event: any) => void) { listeners[name] = listener; },
      createElement: () => new Element(),
      body,
    },
    window: { scrollX: 0, scrollY: 0, addEventListener() {} },
    HTMLTextAreaElement: Textarea,
    Event,
    setTimeout(callback: () => Promise<void>) {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id: number) { timers.delete(id); },
    fetch() { fetchCount += 1; return response; },
  });
  const field = new Textarea();
  const type = (text: string, isComposing = false) => {
    field.value = text;
    field.selectionStart = field.selectionEnd = text.length;
    listeners.input({ target: field, isComposing });
  };
  return { listeners, timers, body, field, type, resolveResponse, fetchCount: () => fetchCount };
};

for (const scenario of ['stale response', 'moved caret', 'selected text', 'changed query', 'unchanged caret']) {
  for (const key of ['Enter', 'Tab']) {
    test(`Mention suggestions handle ${scenario} on ${key}`, async () => {
      const harness = makeSuggestions();
      const { listeners, timers, body, field, type, resolveResponse } = harness;

      type('@ali');
      assert.equal(timers.size, 1);
      const pending = timers.values().next().value!();
      assert.equal(harness.fetchCount(), 1);
      if (scenario === 'stale response') type('Ordinary text');
      resolveResponse({ ok: true, json: async () => ({ users: [{ username: 'alice', name: 'Alice' }] }) });
      await pending;

      if (scenario !== 'stale response') {
        assert.equal(field.attributes.get('aria-expanded'), 'true');
        if (scenario === 'moved caret') field.selectionStart = field.selectionEnd = 0;
        if (scenario === 'selected text') field.selectionStart = 0;
        if (scenario === 'changed query') type('@bob');
      }
      const originalText = field.value;
      const originalSelection = [field.selectionStart, field.selectionEnd];
      let prevented = false;
      listeners.keydown({ target: field, key, preventDefault() { prevented = true; } });
      if (scenario === 'unchanged caret') {
        assert.equal(field.value, '@Alice ');
        assert.equal(prevented, true);
      } else {
        assert.equal(field.value, originalText, 'An outdated suggestion must not replace text');
        assert.deepEqual([field.selectionStart, field.selectionEnd], originalSelection);
        assert.equal(prevented, false, 'Normal Enter and Tab behavior must be preserved');
      }
      assert.ok(body.children.every(child => child instanceof Element && child.hidden));
    });
  }
}

for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape']) {
  test(`IME composition retains control of ${key} when mention suggestions are visible`, async () => {
    const { listeners, timers, field, type, resolveResponse } = makeSuggestions();
    type('@ali');
    const pending = timers.values().next().value!();
    resolveResponse({ ok: true, json: async () => ({ users: [
      { username: 'alice', name: 'Alice' }, { username: 'alina', name: 'Alina' },
    ] }) });
    await pending;
    assert.equal(field.attributes.get('aria-expanded'), 'true');
    const originalSelection = [field.selectionStart, field.selectionEnd];
    const originalActive = field.attributes.get('aria-activedescendant');
    let prevented = false;
    listeners.keydown({ target: field, key, isComposing: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'Autocomplete must not consume IME keystrokes');
    assert.equal(field.value, '@ali');
    assert.deepEqual([field.selectionStart, field.selectionEnd], originalSelection);
    assert.equal(field.attributes.get('aria-activedescendant'), originalActive);
  });
}

test('Composing input does not schedule mention suggestions', () => {
  const { type, timers, body } = makeSuggestions();
  type('@あ', true);
  assert.equal(timers.size, 0, 'Uncommitted IME text must not trigger a lookup');
  assert.equal(body.children.length, 0);
});

test('Composing input invalidates an outstanding mention response', async () => {
  const { type, timers, resolveResponse, body, field } = makeSuggestions();
  type('@ali');
  const pending = timers.values().next().value!();
  type('@あ', true);
  resolveResponse({ ok: true, json: async () => ({ users: [{ username: 'alice', name: 'Alice' }] }) });
  await pending;
  assert.ok(body.children.every(child => child instanceof Element && child.hidden));
  assert.notEqual(field.attributes.get('aria-expanded'), 'true');
});

test('Starting composition invalidates an outstanding response before composing input', async () => {
  const { type, timers, resolveResponse, listeners, field, body } = makeSuggestions();
  type('@ali');
  const pending = timers.values().next().value!();
  listeners.compositionstart({ target: field });
  resolveResponse({ ok: true, json: async () => ({ users: [{ username: 'alice', name: 'Alice' }] }) });
  await pending;
  assert.ok(body.children.every(child => child instanceof Element && child.hidden));
  assert.notEqual(field.attributes.get('aria-expanded'), 'true');
});

test('Committed IME input can open and accept mention suggestions', async () => {
  const { type, timers, resolveResponse, listeners, field } = makeSuggestions();
  listeners.compositionstart({ target: field });
  type('@あ', true);
  assert.equal(timers.size, 0);
  type('@あ');
  assert.equal(timers.size, 1);
  const pending = timers.values().next().value!();
  resolveResponse({ ok: true, json: async () => ({ users: [{ username: 'あき', name: 'あき' }] }) });
  await pending;
  assert.equal(field.attributes.get('aria-expanded'), 'true');
  let prevented = false;
  listeners.keydown({ target: field, key: 'Enter', isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(field.value, '@あき ');
});

test('IME key code 229 is ignored even when isComposing is false', async () => {
  const { type, timers, resolveResponse, listeners, field } = makeSuggestions();
  type('@ali');
  const pending = timers.values().next().value!();
  resolveResponse({ ok: true, json: async () => ({ users: [{ username: 'alice', name: 'Alice' }] }) });
  await pending;
  let prevented = false;
  listeners.keydown({ target: field, key: 'Enter', isComposing: false, keyCode: 229, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(field.value, '@ali');
});
