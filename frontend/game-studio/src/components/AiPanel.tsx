import { useState } from 'react';
import { useStudioStore } from '../store';
import { Icon } from './Icon';

export function AiPanel() {
  const { aiOpen, aiRun, aiStatus, current } = useStudioStore();
  const { setAiOpen, proposeAi, applyAi, rejectAi } = useStudioStore();
  const [prompt, setPrompt] = useState('Make the energy shards glow and add a violet rim light behind the player.');
  if (!aiOpen) return null;
  return <aside className="ai-panel">
    <header><div className="ai-mark"><Icon name="spark"/></div><div><span className="panel-kicker">Project-aware assistant</span><strong>Lilly AI Director</strong></div><button type="button" className="icon-button" onClick={() => setAiOpen(false)} aria-label="Close AI Director"><Icon name="close"/></button></header>
    <div className="ai-context"><span><i className="status-dot"/>Inspecting saved project</span><code>{current?.project.name} · r{current?.project.revision}</code><div><small>{current?.project.scenes[0]?.entities.length || 0} entities</small><small>{current?.project.blueprints.length || 0} graphs</small><small>{current?.project.assets.length || 0} assets</small></div></div>
    <div className="ai-compose"><label htmlFor="ai-prompt">Describe a gameplay or scene change</label><textarea id="ai-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5}/><div className="ai-scope"><span>Mutation policy</span><strong>LillyCommand/v1 · review required</strong></div><button className="ai-propose" type="button" onClick={() => proposeAi(prompt)} disabled={!prompt.trim() || aiStatus === 'thinking'}>{aiStatus === 'thinking' ? <><span className="spinner-small"/>Inspecting scene and graphs…</> : <><Icon name="spark"/>Propose command batch</>}</button></div>
    {aiStatus === 'error' && <div className="ai-error"><strong>Proposal failed</strong><span>Open Console for the exact validation error.</span></div>}
    {aiRun && <div className="ai-review">
      <div className="review-heading"><div><span className="panel-kicker">Review before apply</span><strong>{aiRun.commands.length} proposed commands</strong></div><span className="revision-chip">base r{aiRun.baseRevision}</span></div>
      <div className="affected-list">{aiRun.affected.map((affected, index) => <div key={`${affected.operation}-${index}`}><span className="command-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{affected.operation}</strong><small>{affected.entityId || affected.graphId || affected.sceneId || 'Project settings'}</small></div><span className="valid-command">validated</span></div>)}</div>
      <details className="command-json"><summary>Inspect command payload</summary><pre>{JSON.stringify(aiRun.commands, null, 2)}</pre></details>
      <div className="ai-validation"><span>✓ Typed components</span><span>✓ Hierarchy valid</span><span>✓ Base revision current</span></div>
      <div className="ai-review-actions"><button type="button" onClick={rejectAi}>Reject</button><button type="button" className="primary-small" onClick={applyAi} disabled={aiStatus === 'applying'}>{aiStatus === 'applying' ? 'Applying transaction…' : 'Apply command batch'}</button></div>
    </div>}
    <footer><Icon name="lock" size={13}/><span>AI cannot bypass validation, mutate a stale revision, or access player credentials.</span></footer>
  </aside>;
}
