import { Check, Circle, LoaderCircle, Minus } from 'lucide-react'
import { useState } from 'react'

import { ScaffoldRow } from '../src/components/chat/scaffold-row'
import { type TodoItem, todoTree } from '../src/lib/todos'

import { tr } from './localization'

export function TaskPanel({ todos }: { todos: readonly TodoItem[] }) {
  const [open, setOpen] = useState(true)

  if (!todos.length) {
    return null
  }

  const completed = todos.filter(todo => todo.status === 'completed').length
  const labels = { completed: tr('已完成'), in_progress: tr('进行中'), pending: tr('待办'), cancelled: tr('已取消') }

  return (
    <section aria-label={tr('会话任务')} className="mobile-task-panel">
      <ScaffoldRow onToggle={() => setOpen(value => !value)} open={open}>
        <span>
          {tr('任务')} {completed}/{todos.length}
        </span>
      </ScaffoldRow>
      {open && (
        <ul>
          {todoTree(todos).map(([todo, depth]) => {
            const Icon =
              todo.status === 'completed'
                ? Check
                : todo.status === 'in_progress'
                  ? LoaderCircle
                  : todo.status === 'cancelled'
                    ? Minus
                    : Circle

            return (
              <li
                data-task-status={todo.status}
                key={todo.id}
                style={{ paddingInlineStart: `${Math.min(depth, 8) * 12}px` }}
              >
                <Icon
                  aria-label={labels[todo.status]}
                  className={todo.status === 'in_progress' ? 'task-spinner' : ''}
                  size={14}
                />
                <span>{todo.content}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
