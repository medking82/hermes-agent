import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'

import { ScaffoldRow } from '../src/components/chat/scaffold-row'
import { isCardTool, isSilentTool } from '../src/lib/tool-render-class'

import type { Message } from './conversation'
import { tr } from './localization'

export function toolRecord(message: Message): Record<string, unknown> {
  const value = message.result ?? message.text

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function failedTool(message: Message): boolean {
  const record = toolRecord(message)

  return Boolean(
    record.error ||
    record.is_error ||
    record.success === false ||
    (typeof record.exit_code === 'number' && record.exit_code !== 0)
  )
}

export function toolRuns(messages: Message[]): Message[][] {
  const groups: Message[][] = []

  for (const message of messages) {
    const previous = groups.at(-1)

    const routine =
      message.role === 'tool' &&
      !isCardTool(message.name || '') &&
      !isSilentTool(message.name || '') &&
      !failedTool(message)

    const last = previous?.at(-1)

    if (
      routine &&
      last?.role === 'tool' &&
      !isCardTool(last.name || '') &&
      !isSilentTool(last.name || '') &&
      !failedTool(last)
    ) {
      previous!.push(message)
    } else {
      groups.push([message])
    }
  }

  return groups
}

export function ToolActivity({ messages }: { messages: Message[] }) {
  const failed = messages.some(failedTool)
  const [open, setOpen] = useState(failed)
  useEffect(() => {
    if (failed) {
      setOpen(true)
    }
  }, [failed])
  const reduced = useReducedMotion()
  const running = messages.some(message => message.streaming)

  if (messages.length === 0) {
    return null
  }

  const label = messages.length > 1 ? `${messages.length} ${tr('项工具调用')}` : messages[0].name || tr('工具调用')

  return (
    <section className="mobile-tool-run" data-conversation-scaffold="" data-tool-group="">
      <ScaffoldRow onToggle={() => setOpen(value => !value)} open={open}>
        <span
          aria-hidden="true"
          className={running ? 'activity-dot pulsing' : failed ? 'tool-error-mark' : 'tool-check'}
        >
          {running ? '' : failed ? '!' : '✓'}
        </span>
        <span>{label}</span>
        <span className="mobile-tool-meta">{running ? tr('执行中') : failed ? tr('执行失败') : tr('工具记录')}</span>
      </ScaffoldRow>
      <motion.div
        animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
        aria-hidden={!open}
        className="mobile-tool-body"
        inert={!open}
        initial={false}
        transition={{ duration: reduced ? 0 : 0.18 }}
      >
        {open &&
          messages.map(message => (
            <div className="mobile-tool-detail" key={message.id}>
              {messages.length > 1 && <span className="mobile-tool-name">{message.name || tr('工具调用')}</span>}
              {message.args !== undefined && <pre aria-label={tr('参数')}>{JSON.stringify(message.args, null, 2)}</pre>}
              <pre>
                {message.text.trim() || (message.streaming ? tr('等待工具输出…') : tr('此历史记录未保存工具输出'))}
              </pre>
            </div>
          ))}
      </motion.div>
    </section>
  )
}
