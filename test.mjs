import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {initTaskUI} from './app.mjs';

class FakeElement {
  constructor(value = '') {
    this.value = value;
    this.textContent = '';
    this.children = [];
    this.listeners = {};
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  replaceChildren(...children) { this.children = children; }
  async emit(type, event = {}) { return this.listeners[type]({ preventDefault() {}, ...event }); }
}

function makeUI(fetchImpl) {
  const elements = {
    '#task-form': new FakeElement(),
    '#title': new FakeElement('Write docs'),
    '#priority': new FakeElement('normal'),
    '#priority-filter': new FakeElement('all'),
    '#error': new FakeElement(),
    '#tasks': new FakeElement()
  };
  const doc = {
    querySelector: selector => elements[selector],
    createElement: tag => Object.assign(new FakeElement(), {tagName: tag})
  };
  return {elements, ui: initTaskUI(doc, fetchImpl)};
}

const response = (data, ok = true) => ({ok, json: async () => data});

test('UI keeps accessible labels and renders task content as text', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');
  assert.match(html, /label for="title"/);
  assert.match(html, /label for="priority"/);
  assert.match(html, /label for="priority-filter"/);
  assert.match(html, /<option value="normal" selected>Normal<\/option>/);
  assert.match(html, /role="alert"/);
  assert.match(app, /item\.textContent/);
  assert.doesNotMatch(app, /innerHTML/);
});

test('creation defaults to normal priority and uses same-origin API paths', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({path, options});
    return options ? response({title: 'Write docs', priority: 'normal'}) : response([]);
  };
  const {elements, ui} = makeUI(fetchImpl);
  await ui.ready;
  await elements['#task-form'].emit('submit');
  assert.deepEqual(calls.map(call => call.path), ['/api/tasks', '/api/tasks', '/api/tasks']);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), {title: 'Write docs', priority: 'normal'});
  assert.equal(calls[2].options, undefined, 'successful creation refreshes the task list');
  assert.equal(elements['#title'].value, '');
});

test('creation sends explicitly selected low and high priorities', async () => {
  for (const priority of ['low', 'high']) {
    const bodies = [];
    const fetchImpl = async (_path, options) => {
      if (options) bodies.push(JSON.parse(options.body));
      return response([]);
    };
    const {elements, ui} = makeUI(fetchImpl);
    await ui.ready;
    elements['#priority'].value = priority;
    await elements['#task-form'].emit('submit');
    assert.deepEqual(bodies, [{title: 'Write docs', priority}]);
  }
});

test('priority filters include legacy records as normal and retain selection after create', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({path, options});
    if (options) return response({title: 'New', priority: 'high'});
    return response([
      {title: 'Old task'},
      {title: 'Low task', priority: 'low'},
      {title: 'High task', priority: 'high'}
    ]);
  };
  const {elements, ui} = makeUI(fetchImpl);
  await ui.ready;
  assert.deepEqual(elements['#tasks'].children.map(item => item.textContent), [
    'Old task (normal priority)', 'Low task (low priority)', 'High task (high priority)'
  ]);
  elements['#priority-filter'].value = 'low';
  await elements['#priority-filter'].emit('change');
  assert.deepEqual(elements['#tasks'].children.map(item => item.textContent), ['Low task (low priority)']);
  elements['#priority-filter'].value = 'high';
  await elements['#priority-filter'].emit('change');
  assert.deepEqual(elements['#tasks'].children.map(item => item.textContent), ['High task (high priority)']);
  elements['#priority-filter'].value = 'normal';
  await elements['#priority-filter'].emit('change');
  assert.deepEqual(elements['#tasks'].children.map(item => item.textContent), ['Old task (normal priority)']);
  elements['#priority'].value = 'high';
  await elements['#task-form'].emit('submit');
  assert.equal(elements['#priority-filter'].value, 'normal');
  assert.deepEqual(elements['#tasks'].children.map(item => item.textContent), ['Old task (normal priority)']);
});

test('load and submit failures show useful errors, then successful operations clear them', async () => {
  let failLoad = true;
  let failCreate = true;
  const fetchImpl = async (path, options) => {
    if (options) {
      if (failCreate === 'network') throw new Error('Network unavailable');
      if (failCreate === 'malformed') return {ok: false, json: async () => { throw new Error('Invalid JSON'); }};
      return failCreate ? response({error: 'Title is too short'}, false) : response({});
    }
    return failLoad ? response({}, false) : response([{title: 'Loaded', priority: 'normal'}]);
  };
  const {elements, ui} = makeUI(fetchImpl);
  await ui.ready;
  assert.match(elements['#error'].textContent, /Unable to load tasks/);
  failLoad = false;
  await ui.loadTasks();
  assert.equal(elements['#error'].textContent, '');
  failCreate = true;
  await elements['#task-form'].emit('submit');
  assert.equal(elements['#error'].textContent, 'Title is too short');
  failCreate = 'malformed';
  await elements['#task-form'].emit('submit');
  assert.match(elements['#error'].textContent, /Unable to create task/);
  failCreate = 'network';
  await elements['#task-form'].emit('submit');
  assert.equal(elements['#error'].textContent, 'Network unavailable');
  failCreate = false;
  await elements['#task-form'].emit('submit');
  assert.equal(elements['#error'].textContent, '');
});
