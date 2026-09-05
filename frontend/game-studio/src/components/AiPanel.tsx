import { useStudioStore } from '../store';
import { Icon } from './Icon';
import { LevelCreatorBody } from './LevelCreator';

export function AiPanel() {
  const { aiOpen, current, setAiOpen } = useStudioStore();
  if (!aiOpen) return null;
  const design = current?.project.generatedLevels?.find((level) => level.sceneId === current.project.entryScene) || null;
  return <aside className="ai-panel level-director-panel">
    <header>
      <div className="ai-mark"><Icon name="spark"/></div>
      <div><span className="panel-kicker">Project-aware creator</span><strong>Lilly AI Game Director</strong></div>
      <button type="button" className="icon-button" onClick={() => setAiOpen(false)} aria-label="Close AI Director"><Icon name="close"/></button>
    </header>
    <div className="ai-context">
      <span><i className="status-dot"/>Reading the saved project and level topology</span>
      <code>{current?.project.name} · r{current?.project.revision}</code>
      <div>
        <small>{design?.metrics.roomCount || 0} rooms</small>
        <small>{design?.metrics.pathCount || 0} paths</small>
        <small>{design?.metrics.enemyCount || 0} guardians</small>
        <small>{design?.checksum || 'hand-authored'}</small>
      </div>
    </div>
    <LevelCreatorBody/>
    <footer><Icon name="lock" size={13}/><span>Preview first, then apply. Lilly checks model geometry and project changes before saving a new revision.</span></footer>
  </aside>;
}
