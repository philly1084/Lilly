import { useEffect, useMemo, useState } from 'react';
import { useStudioStore } from '../store';
import { Icon } from './Icon';

export function CommandPalette({ open, onClose }: { open: boolean; onClose(): void }) {
  const [query, setQuery] = useState('');
  const store = useStudioStore();
  useEffect(() => { if (open) setQuery(''); }, [open]);
  const commands = useMemo(() => [
    { label: 'Play in editor', hint: 'F6', icon: 'play' as const, run: () => store.setPlayState('playing') },
    { label: 'Pause simulation', hint: 'F6', icon: 'pause' as const, run: () => store.setPlayState('paused') },
    { label: 'Run automated playtest', hint: '', icon: 'test' as const, run: store.runPlaytest },
    { label: 'Build immutable player', hint: 'Ctrl+B', icon: 'build' as const, run: store.build },
    { label: 'Open Blueprint workspace', hint: '', icon: 'blueprint' as const, run: () => store.setBottomTab('blueprints') },
    { label: 'Open TypeScript sandbox', hint: '', icon: 'code' as const, run: () => store.setBottomTab('typescript') },
    { label: 'Ask Lilly AI Director', hint: '', icon: 'spark' as const, run: () => store.setAiOpen(true) },
    { label: 'Undo command batch', hint: 'Ctrl+Z', icon: 'undo' as const, run: store.undo },
    { label: 'Redo command batch', hint: 'Ctrl+Shift+Z', icon: 'redo' as const, run: store.redo },
  ].filter((command) => command.label.toLowerCase().includes(query.toLowerCase())), [query, store]);
  if (!open) return null;
  return <div className="command-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette"><div className="command-search"><Icon name="search"/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search editor commands…"/><kbd>Esc</kbd></div><div className="command-results"><span className="menu-label">Commands</span>{commands.map((command) => <button type="button" key={command.label} onClick={() => { command.run(); onClose(); }}><Icon name={command.icon}/><span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}</button>)}{!commands.length && <div className="command-empty">No matching command</div>}</div><footer><span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span>Project r{store.current?.project.revision}</span></footer></div></div>;
}
