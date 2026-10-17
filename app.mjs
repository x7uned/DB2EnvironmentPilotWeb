const PRIORITIES = new Set(['low', 'normal', 'high']);

function taskPriority(task) {
  return PRIORITIES.has(task.priority) ? task.priority : 'normal';
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function initTaskUI(doc = document, fetchImpl = fetch) {
  const form = doc.querySelector('#task-form');
  const titleInput = doc.querySelector('#title');
  const priorityInput = doc.querySelector('#priority');
  const filterInput = doc.querySelector('#priority-filter');
  const error = doc.querySelector('#error');
  const list = doc.querySelector('#tasks');
  let tasks = [];

  function render() {
    const selected = filterInput.value;
    const visibleTasks = tasks.filter(task => selected === 'all' || taskPriority(task) === selected);
    list.replaceChildren(...visibleTasks.map(task => {
      const item = doc.createElement('li');
      item.textContent = `${task.title} (${taskPriority(task)} priority)`;
      return item;
    }));
  }

  async function loadTasks() {
    try {
      const response = await fetchImpl('/api/tasks');
      if (!response.ok) throw new Error('Unable to load tasks. Please try again.');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Unable to load tasks. Please try again.');
      tasks = data;
      render();
      error.textContent = '';
      return true;
    } catch (reason) {
      error.textContent = errorMessage(reason, 'Unable to load tasks. Please try again.');
      return false;
    }
  }

  filterInput.addEventListener('change', render);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const response = await fetchImpl('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: titleInput.value, priority: priorityInput.value })
      });
      if (!response.ok) {
        let message = 'Unable to create task. Please try again.';
        try {
          const payload = await response.json();
          if (typeof payload.error === 'string' && payload.error) message = payload.error;
        } catch {}
        throw new Error(message);
      }
      titleInput.value = '';
      error.textContent = '';
      await loadTasks();
    } catch (reason) {
      error.textContent = errorMessage(reason, 'Unable to create task. Please try again.');
    }
  });

  const ready = loadTasks();
  return { loadTasks, render, ready };
}
