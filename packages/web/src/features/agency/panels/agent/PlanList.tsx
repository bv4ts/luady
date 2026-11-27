import type { TodoItem } from '@luady/shared';

const STATUS_WORDS: Readonly<Record<TodoItem['status'], string>> = Object.freeze({
  completed: 'done', in_progress: 'in progress', pending: 'to do',
});

/** The agent's to-do list as a checklist: empty, half and checked marks. Not rendered at all when there is none. */
export function PlanList({ todos }: { todos: readonly TodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <section className="agent-section">
      <h3 className="agent-section__title">Plan</h3>
      <ol className="agent-plan" data-testid="plan-list">
        {todos.map((todo, index) => (
          <li key={todo.id ?? `todo-${index}`} className={`agent-plan__item agent-plan__item--${todo.status}`} data-status={todo.status}>
            <span className="agent-plan__mark" aria-hidden="true" />
            <span className="agent-plan__text" dir="auto">{todo.subject}</span>
            <span className="visually-hidden">{`, ${STATUS_WORDS[todo.status]}`}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
