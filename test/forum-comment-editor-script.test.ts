import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/scripts/forum.js', import.meta.url), 'utf8');

class Element {
  hidden = false;
  focused = false;
  clientHeight = 80;
  scrollHeight = 120;
  value = 'Original';
  textContent = 'en';
  open = false;
  style: { height?: string } = {};
  children: Record<string, Element> = {};
  listeners: Record<string, (event: any) => void> = {};
  querySelector(selector: string) { return this.children[selector] ?? null; }
  querySelectorAll() { return []; }
  addEventListener(name: string, handler: (event: any) => void) { this.listeners[name] = handler; }
  focus() { this.focused = true; }
  reset() { this.children.textarea.value = 'Original'; }
  fire(name: string, options = {}) {
    const event = { button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...options };
    this.listeners[name](event);
    return event;
  }
}

const makeComment = () => {
  const comment = new Element();
  const link = new Element();
  const content = new Element();
  const actions = new Element();
  const editor = new Element();
  const textarea = new Element();
  const cancel = new Element();
  editor.hidden = true;
  comment.children = {
    '[data-comment-edit-link]': link, '[data-comment-content]': content,
    '[data-comment-actions]': actions, '[data-comment-editor]': editor,
  };
  editor.children = { textarea, '[data-comment-edit-cancel]': cancel };
  return { comment, link, content, actions, editor, textarea, cancel };
};

test('Inline editing replaces only the selected comment and Cancel discards changes and restores focus', () => {
  const first = makeComment();
  const second = makeComment();
  runInNewContext(script, { document: {
    querySelectorAll: (selector: string) => selector === '[data-comment-edit]' ? [first.comment, second.comment] : [],
  } });
  assert.equal(first.link.fire('click', { ctrlKey: true }).prevented, false);
  assert.equal(first.editor.hidden, true);
  assert.equal(first.link.fire('click').prevented, true);
  assert.equal(first.content.hidden, true);
  assert.equal(first.actions.hidden, true);
  assert.equal(first.editor.hidden, false);
  assert.equal(first.textarea.focused, true);
  assert.equal(second.content.hidden, false);
  assert.equal(second.editor.hidden, true);

  first.textarea.value = 'Unsaved changes';
  assert.equal(first.cancel.fire('click').prevented, true);
  assert.equal(first.editor.hidden, true);
  assert.equal(first.content.hidden, false);
  assert.equal(first.actions.hidden, false);
  assert.equal(first.textarea.value, 'Original');
  assert.equal(first.link.focused, true);

  second.link.fire('click');
  assert.equal(second.editor.fire('keydown', { key: 'Escape' }).prevented, true);
  assert.equal(second.editor.hidden, true);
  assert.equal(second.link.focused, true);
});
