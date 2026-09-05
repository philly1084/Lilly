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
      <div><span className="panel-kicker">Build games, worlds and assets</span><strong>Lilly AI Game Director</strong></div>
      <button type="button" className="icon-button" onClick={() => setAiOpen(false)} aria-label="Close AI Director"><Icon name="close"/></button>
    </header>
    <div className="ai-context">
      <span><i className="status-dot"/>Current editor project · whole-game builds create a new project</span>
      <code>{current?.project.name} · r{current?.project.revision}</code>
      <div>
        <small>{design?.metrics.roomCount || 0} rooms</small>
        <small>{design?.metrics.pathCount || 0} paths</small>
        <small>{design?.metrics.enemyCount || 0} guardians</small>
        <small>{design?.checksum || 'hand-authored'}</small>
      </div>
    </div>
    <LevelCreatorBody/>
    <footer><Icon name="lock" size={13}/><span>Review your game design or asset preview. Lilly validates generated work before saving it.</span></footer>
  </aside>;
}
